// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom watch` (docs/design-agent-skills.md §2.1): the watching an agent
 * used to do by hand, made deterministic, so a model is woken only when there
 * is something to say. It reuses the wait --until progress machinery (the mark
 * in `<dir>/cursor`, progress.ts) and keeps its own bookkeeping (when it last
 * reported, when evidence last grew, which conditions it already raised) in
 * `<dir>/snapshot.json`, so nothing is reported twice across invocations.
 * Three kinds of report: `move` (important moves, batched over a window),
 * `heartbeat` (quiet for a while) and `attention` (a stop, a human is needed, a
 * stall, a budget over 80%, a repeated failure, a dead controller). Every rule
 * reads generic controller state; nothing here knows a plugin notion.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isClaimStale, loadRunState, readOwnerClaim, resolveStateDir, type DurableRunState } from "@graphloom/controller";
import { BUDGET_THRESHOLD, decodeCursor, encodeCursor, markOf, progressSince, progressSummary, type ProgressEvent, type ProgressSummary } from "./progress.js";
import { formatDuration, runStats } from "./stats.js";

export type WatchKind = "move" | "heartbeat" | "attention";

/** Moves seen within this window of the first one are one report. */
export const MOVE_BATCH_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 15 * 60_000;
/** No new evidence for this long while running (and not in a quota wait) is a stall. */
export const STALL_MS = 45 * 60_000;
export const NOTIFY_TIMEOUT_MS = 60_000;
const MESSAGE_BYTES = 1_000;
const BLOCKER_CHARS = 450;

export const RELAY_LINE = "Relay this to the user in one or two lines. Make no tool calls.";
export const ATTENTION_LINE = "Report this to the user and ask what to do next. Do not resume, fix, or answer the run's questions.";

export interface WatchReport {
  kind: WatchKind;
  at: string;
  runId: string;
  status: string;
  stage: string;
  attempt: number;
  /** What `--notify` gets on stdin and what is printed. */
  message: string;
}

/** What the watch remembers between invocations. Its fields are not an interface. */
interface WatchSnapshot {
  v: 1;
  run: string;
  /** Times are epoch milliseconds of the watcher's clock. */
  startedAt: number;
  lastReportAt: number;
  evidenceCount: number;
  lastEvidenceAt: number;
  /** Moves seen and not yet reported; `at` is when the first was seen. */
  pending?: { at: number; lines: string[] };
  quotaUntil?: string;
  /** Receipts already counted as invalidated. */
  invSeen: string[];
  /** Per stage, the requirements its latest invalidation named and how many times in a row. */
  failures: Record<string, { sig: string; count: number }>;
  /** Attention conditions that held at the last look; one is reported when it begins to hold. */
  active: string[];
  /** Each metered budget's use when something was last reported. */
  usedAtReport: Record<string, number>;
}

export interface WatchOptions {
  stateRoot?: string;
  /** Holds `cursor`, `snapshot.json` and `watch.log`. */
  dir: string;
  until: "report" | "stop";
  timeoutMs?: number;
  heartbeatMs?: number;
  /** A shell command run for each report with the message on stdin. */
  notify?: string;
  pollMs?: number;
  /** Called for each report as it is raised. */
  onReport?: (report: WatchReport) => void | Promise<void>;
}

export interface WatchDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realDeps: WatchDeps = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

export type WatchOutcome = "report" | "stopped" | "timeout" | "orphaned";

export interface WatchResult {
  runId: string;
  stateDir: string;
  outcome: WatchOutcome;
  reports: WatchReport[];
  summary: ProgressSummary;
}

const oneLine = (text: unknown, max = 200): string => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

const stageOf = (state: DurableRunState): string => `${state.current?.stageId ?? "-"}#${state.current?.attempt ?? 0}`;

/** The trigger of each supervisor episode, in the order the episodes first appear (the open one last). */
function episodeTriggers(state: DurableRunState): Array<{ id: string; trigger: string }> {
  const out: Array<{ id: string; trigger: string }> = [];
  for (const r of state.supervisorEpisodes ?? []) {
    if (out.some((e) => e.id === r.episodeId)) continue;
    const t = r.input?.trigger;
    out.push({ id: r.episodeId, trigger: t !== undefined ? `${t.code}: ${t.message}` : "" });
  }
  const open = state.status === "running" && state.mode === "recovery" ? state.recoveryEpisodeId : undefined;
  if (open !== undefined && !out.some((e) => e.id === open)) {
    const t = state.recoveryTrigger;
    out.push({ id: open, trigger: t !== undefined ? `${t.code}: ${t.message}` : "" });
  }
  return out;
}

function stageSpendingMost(state: DurableRunState, budget: string): string {
  if (budget === "agentInvocations") {
    const top = [...runStats(state).stages].sort((a, b) => b.agentInvocations - a.agentInvocations)[0];
    if (top !== undefined && top.agentInvocations > 0) return top.stageId;
  }
  return state.current?.stageId ?? "-";
}

/** The message: header, body lines, closing instruction; the body gives way when over the size cap. */
function compose(kind: WatchKind, state: DurableRunState, body: string[]): string {
  const head = `[graphloom watch] ${kind} · run ${state.runId} · ${state.status} · ${stageOf(state)}`;
  const tail = kind === "attention" ? ATTENTION_LINE : RELAY_LINE;
  const lines = body.flatMap((l) => l.split("\n"));
  const size = (ls: string[]): number => Buffer.byteLength([head, ...ls, tail].join("\n"));
  let kept = lines;
  while (kept.length > 1 && size(kept) > MESSAGE_BYTES) kept = kept.slice(0, -1);
  if (kept.length < lines.length) kept = [...kept, `… (${lines.length - kept.length} more lines; see graphloom inspect)`];
  return [head, ...kept, tail].join("\n");
}

function budgetText(b: ProgressSummary["budgets"][number]): string {
  return `${b.budget} ${b.used ?? "?"}${b.granted !== undefined ? `/${b.granted}` : ""}${b.percent !== undefined ? ` (${b.percent}%)` : ""}`;
}

/** The progress events that are moves. A stage's receipt is one only when it completes the stage. */
function moveLines(events: ProgressEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.kind === "stage_entered") lines.push(`entered stage ${e.stage}, attempt ${e.attempt}`);
    else if (e.kind === "receipt_accepted" && e.stageComplete === true) lines.push(`stage ${e.stage} accepted`);
    else if (e.kind === "episode_started" || e.kind === "episode_ended" || e.kind === "run_resumed") lines.push(e.detail);
    else if (e.kind === "quota_pause") lines.push(`quota pause started${typeof e.resetAt === "string" ? `, resets ${e.resetAt}` : ""}`);
  }
  return lines;
}

interface Evaluation {
  reports: WatchReport[];
  orphaned: boolean;
}

/**
 * One look at the run: which moves, heartbeat and attention conditions are new
 * at `now`. Changes `snap` and returns the mark that includes what it saw.
 * `ownerLost` is a detail when the run is recorded running with no live controller.
 */
export function evaluate(
  state: DurableRunState,
  snap: WatchSnapshot,
  mark: ReturnType<typeof markOf>,
  now: number,
  heartbeatMs: number,
  ownerLost: string | undefined,
): Evaluation & { mark: ReturnType<typeof markOf> } {
  const summary = progressSummary(state);
  const running = state.status === "running";
  const reports: WatchReport[] = [];
  const report = (kind: WatchKind, body: string[]): void => {
    reports.push({ kind, at: new Date(now).toISOString(), runId: state.runId, status: state.status, stage: state.current?.stageId ?? "", attempt: state.current?.attempt ?? 0, message: compose(kind, state, body) });
    snap.lastReportAt = now;
    snap.usedAtReport = Object.fromEntries(summary.budgets.filter((b) => b.used !== undefined).map((b) => [b.budget, b.used!]));
  };

  // Evidence has no timestamp: its growth is observed.
  if (state.evidence.length > snap.evidenceCount) snap.lastEvidenceAt = now;
  snap.evidenceCount = state.evidence.length;

  // Moves.
  const progress = progressSince(mark, state);
  const moves = moveLines(progress.events);
  if (summary.waiting?.kind === "quota") snap.quotaUntil = summary.waiting.until;
  else if (snap.quotaUntil !== undefined) {
    moves.push("quota pause ended");
    delete snap.quotaUntil;
  }
  const quotaEvent = progress.events.find((e) => e.kind === "quota_pause");
  if (quotaEvent !== undefined && typeof quotaEvent.resetAt === "string" && summary.waiting?.kind !== "quota") snap.quotaUntil = quotaEvent.resetAt;
  if (moves.length > 0) snap.pending = { at: snap.pending?.at ?? now, lines: [...(snap.pending?.lines ?? []), ...moves] };

  // Repeated failure: the same stage invalidated again with the same requirements.
  const seen = new Set(snap.invSeen);
  const fresh = (state.receipts ?? []).filter((r) => !r.valid && !seen.has(r.id));
  for (const stageId of new Set(fresh.map((r) => r.stageId))) {
    const sig = [...new Set(fresh.filter((r) => r.stageId === stageId).map((r) => r.requirementId))].sort().join(",");
    const before = snap.failures[stageId];
    snap.failures[stageId] = { sig, count: before?.sig === sig ? before.count + 1 : 1 };
  }
  snap.invSeen = (state.receipts ?? []).filter((r) => !r.valid).map((r) => r.id);
  for (const stage of state.definition?.stages ?? []) {
    const valid = new Set((state.receipts ?? []).filter((r) => r.valid && r.stageId === stage.id).map((r) => r.requirementId));
    if (stage.requirementIds.every((id) => valid.has(id))) delete snap.failures[stage.id];
  }

  // Attention: conditions that hold now; each is reported when it begins to hold.
  const attention = new Map<string, string[]>();
  if (!running) {
    const reason = state.stopReason ?? "";
    const retry = summary.stopRetryable === undefined ? "" : summary.stopRetryable ? " · retryable" : " · final";
    const lines = [`stopped: ${state.status}${reason !== "" ? ` (${oneLine(reason, 160)})` : ""}${retry}`];
    if (state.blocker !== undefined && state.blocker.trim() !== "") {
      const b = state.blocker.trim();
      lines.push(`blocker: "${b.length > BLOCKER_CHARS ? `${b.slice(0, BLOCKER_CHARS)}…` : b}"`);
    }
    attention.set(`stop:${state.status}@${state.stateRevision}`, lines);
  }
  if (summary.waiting?.kind === "reconcile") {
    attention.set(`reconcile:${summary.waiting.stage}`, [`waiting for a human: reconcile stage ${summary.waiting.stage} (${summary.waiting.reason})`]);
  }
  if (running && summary.waiting?.kind !== "quota" && now - snap.lastEvidenceAt >= STALL_MS) {
    attention.set(`stall:${snap.lastEvidenceAt}`, [`stalled: no new evidence for ${formatDuration(now - snap.lastEvidenceAt)} (not in a quota wait)`]);
  }
  for (const b of summary.budgets) {
    if (b.percent === undefined || b.used === undefined || b.granted === undefined || b.used / b.granted <= BUDGET_THRESHOLD) continue;
    attention.set(`budget:${b.budget}`, [`budget ${b.budget} at ${b.percent}% (${b.used} of ${b.granted}), spent in stage ${stageSpendingMost(state, b.budget)}`]);
  }
  for (const [stageId, f] of Object.entries(snap.failures)) {
    if (f.count >= 2) attention.set(`repeat-stage:${stageId}:${f.count}`, [`repeated failure: stage ${stageId} invalidated ${f.count} times with the same requirements (${f.sig})`]);
  }
  const eps = episodeTriggers(state);
  const [prev, last] = eps.slice(-2);
  if (prev !== undefined && last !== undefined && last.trigger !== "" && prev.trigger === last.trigger) {
    attention.set(`repeat-episode:${last.id}`, [`repeated failure: supervisor episodes ${prev.id} and ${last.id} had the same trigger (${oneLine(last.trigger, 160)})`]);
  }
  if (ownerLost !== undefined) attention.set("orphaned", [`controller died: the run is recorded as running but ${ownerLost}; graphloom resume takes it over`]);

  const raised = [...attention].filter(([key]) => !snap.active.includes(key));
  snap.active = [...attention.keys()];

  // Pending moves go out when their window closes, or at once before an attention report.
  if (snap.pending !== undefined && (raised.length > 0 || now - snap.pending.at >= MOVE_BATCH_MS)) {
    report("move", [...snap.pending.lines.map((l) => `- ${l}`), `${summary.stagesComplete}/${summary.stages} stages complete`]);
    delete snap.pending;
  }
  if (raised.length > 0) report("attention", raised.flatMap(([, lines]) => lines));
  if (reports.length === 0 && running && now - snap.lastReportAt >= heartbeatMs) {
    const spend = summary.budgets.find((b) => b.budget === "agentInvocations");
    const moved = summary.budgets.filter((b) => b.budget !== "agentInvocations" && b.used !== undefined && b.used !== (snap.usedAtReport[b.budget] ?? 0));
    const from = runStats(state).span?.from;
    const started = from !== undefined ? Date.parse(from) : snap.startedAt;
    report("heartbeat", [
      `elapsed ${formatDuration(Math.max(0, now - started))} · ${summary.stagesComplete}/${summary.stages} stages complete`,
      ...(spend !== undefined ? [`agentInvocations ${spend.used ?? "?"}${spend.granted !== undefined ? `/${spend.granted}` : ""}`] : []),
      ...(moved.length > 0 ? [`budgets moved: ${moved.map(budgetText).join(", ")}`] : []),
      `last evidence ${formatDuration(Math.max(0, now - snap.lastEvidenceAt))} ago`,
    ]);
  }
  return { reports, orphaned: ownerLost !== undefined, mark: progress.mark };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** Runs the notify command for one report. A failure goes to `<dir>/watch.log` and never stops the watch. */
async function notifyReport(command: string, report: WatchReport, dir: string, now: number): Promise<void> {
  const failure = await new Promise<string | undefined>((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (why?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(why);
    };
    const child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, GRAPHLOOM_WATCH_KIND: report.kind, GRAPHLOOM_RUN_ID: report.runId, GRAPHLOOM_STATUS: report.status },
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      done(`timed out after ${NOTIFY_TIMEOUT_MS}ms and was killed`);
    }, NOTIFY_TIMEOUT_MS);
    child.stderr!.on("data", (d: Buffer) => { stderr = `${stderr}${d.toString()}`.slice(-400); });
    child.once("error", (err) => done(`failed to start: ${err.message}`));
    child.once("close", (code, signal) => done(code === 0 ? undefined : `exited ${code ?? signal}${stderr.trim() !== "" ? `: ${oneLine(stderr)}` : ""}`));
    child.stdin!.on("error", () => undefined); // a command that ignores stdin
    child.stdin!.end(`${report.message}\n`);
  });
  if (failure !== undefined) await appendFile(path.join(dir, "watch.log"), `${new Date(now).toISOString()} notify (${report.kind}) ${failure}\n`).catch(() => undefined);
}

/**
 * Watches a run until a report is due (`until: report`) or the run stops
 * (`until: stop`), or the timeout. Reads the run only through the controller's
 * public loaders; the only files it writes are in `options.dir`.
 */
export async function watchRun(runRef: string, options: WatchOptions, deps: WatchDeps = realDeps): Promise<WatchResult> {
  const stateDir = await resolveStateDir(runRef, options.stateRoot);
  const dir = path.resolve(options.dir);
  await mkdir(dir, { recursive: true });
  const cursorFile = path.join(dir, "cursor");
  const snapshotFile = path.join(dir, "snapshot.json");
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pollMs = options.pollMs ?? 1_000;
  const start = deps.now();
  const deadline = options.timeoutMs === undefined ? Infinity : start + options.timeoutMs;
  const file = path.join(stateDir, "state.json");
  const signature = async (): Promise<string> => {
    const st = await stat(file).catch(() => undefined);
    return st === undefined ? "" : `${st.mtimeMs}:${st.size}:${st.ino}`;
  };

  let seen = await signature();
  let state = await loadRunState(stateDir);
  const stored = await readJson<WatchSnapshot>(snapshotFile);
  if (stored !== undefined && stored.run !== state.runId) {
    throw new Error(`${dir} holds the watch of run ${stored.run}, not ${state.runId}; use --dir for another directory`);
  }
  const cursorText = (await readFile(cursorFile, "utf8").catch(() => "")).trim();
  let mark = cursorText !== "" ? decodeCursor(cursorText) : markOf(state);
  if (mark.run !== state.runId) throw new Error(`${cursorFile} is for run ${mark.run}, not ${state.runId}; use --dir for another directory`);
  const snap: WatchSnapshot = stored ?? {
    v: 1,
    run: state.runId,
    startedAt: start,
    lastReportAt: start,
    evidenceCount: state.evidence.length,
    lastEvidenceAt: start,
    invSeen: (state.receipts ?? []).filter((r) => !r.valid).map((r) => r.id),
    failures: {},
    active: [],
    usedAtReport: Object.fromEntries(progressSummary(state).budgets.filter((b) => b.used !== undefined).map((b) => [b.budget, b.used!])),
  };
  const all: WatchReport[] = [];
  const result = (outcome: WatchOutcome): WatchResult => ({ runId: state.runId, stateDir, outcome, reports: all, summary: progressSummary(state) });

  for (;;) {
    const key = await signature();
    if (key !== seen) state = await loadRunState(stateDir);
    seen = key;
    let ownerLost: string | undefined;
    if (state.status === "running") {
      const owner = await readOwnerClaim(stateDir).catch((err: unknown) => {
        throw new Error(`cannot read owner claim in ${stateDir}: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (owner === undefined || isClaimStale(owner)) {
        // A second read separates a controller that just finished from one that died.
        state = await loadRunState(stateDir);
        if (state.status === "running") ownerLost = owner === undefined ? "no controller owns it" : `its controller (pid ${owner.controllerPid}) is no longer running`;
      }
    }
    const now = deps.now();
    const before = JSON.stringify(snap);
    const ev = evaluate(state, snap, mark, now, heartbeatMs, ownerLost);
    mark = ev.mark;
    // What was seen is kept before anything is sent: a report is at most lost, never repeated.
    await writeAtomic(cursorFile, `${encodeCursor(mark)}\n`);
    if (stored === undefined || JSON.stringify(snap) !== before) await writeAtomic(snapshotFile, `${JSON.stringify(snap, null, 2)}\n`);
    for (const r of ev.reports) {
      all.push(r);
      if (options.notify !== undefined) await notifyReport(options.notify, r, dir, now);
      await options.onReport?.(r);
    }
    if (ev.orphaned) return result("orphaned");
    if (state.status !== "running") return result("stopped");
    if (options.until === "report" && all.length > 0) return result("report");
    if (deps.now() >= deadline) return result("timeout");
    await deps.sleep(Math.min(pollMs, Math.max(1, deadline - deps.now())));
  }
}

/** The text form: the messages, blank-line separated, or the one-line timeout. */
export function formatWatch(r: WatchResult): string {
  if (r.reports.length === 0 && r.outcome === "orphaned") return `run ${r.runId}: the controller died (already reported); graphloom resume takes it over`;
  if (r.reports.length === 0) return r.outcome === "stopped" ? `run ${r.runId} is ${r.summary.status}; nothing new to report` : `run ${r.runId} still running, nothing to report`;
  return r.reports.map((x) => x.message).join("\n\n");
}
