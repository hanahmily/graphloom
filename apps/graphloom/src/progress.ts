// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom wait --until progress` (docs/design-agent-skills.md §2): returns
 * when something meaningful happened to a run, computed by diffing its durable
 * state against a mark of what was already reported. Every event derives from
 * generic controller fields (current stage, receipts, recovery mode and
 * supervisor episode records, remedies, budgets, status); nothing here knows a
 * plugin notion. The mark travels as an opaque cursor so the next wait
 * (`--since`) neither repeats nor loses an event.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { classifyStop, isClaimStale, loadRunState, readOwnerClaim, resolveStateDir, type DurableRunState } from "@graphloom/controller";
import { runStats } from "./stats.js";

export const PROGRESS_EVENT_KINDS = [
  "stage_entered",
  "receipt_accepted",
  "receipts_invalidated",
  "episode_started",
  "episode_ended",
  "quota_pause",
  "budget_threshold",
  "run_resumed",
  "run_stopped",
] as const;
export type ProgressEventKind = (typeof PROGRESS_EVENT_KINDS)[number];

/** Share of a budget whose use is worth reporting. */
export const BUDGET_THRESHOLD = 0.8;

export interface ProgressEvent {
  kind: ProgressEventKind;
  /** When the state recorded it, if it says. */
  at?: string;
  stage?: string;
  /** One line for a person. */
  detail: string;
  [key: string]: unknown;
}

/** What was already reported. Encoded into the cursor; its fields are not an interface. */
export interface ProgressMark {
  v: 1;
  run: string;
  /** `running`, or `<status>@<stateRevision>` for a reported stop. */
  st: string;
  /** `<stageId>#<attempt>`. */
  stage: string;
  /** Highest receipt number reported. */
  rs: number;
  /** Ids of the invalid receipts seen. */
  inv: string[];
  /** The open recovery episode reported as started. */
  ep?: string;
  /** Newest supervisor episode record time reported. */
  epAt: string;
  /** Newest remedy record time reported. */
  remAt: string;
  /** Budgets reported at or over the threshold. */
  hot: string[];
}

export interface ProgressSummary {
  status: string;
  stopReason?: string;
  stopRetryable?: boolean;
  mode: string;
  stage: string;
  attempt: number;
  stagesComplete: number;
  stages: number;
  budgets: Array<{ budget: string; used?: number; granted?: number; percent?: number }>;
  episodes: number;
  /** A quota hold, an ordinary executor retry backoff, or a reconciliation only the operator can settle. */
  waiting?: { kind: "quota"; until: string } | { kind: "retry"; until: string } | { kind: "reconcile"; stage: string; reason: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const oneLine = (text: unknown, max = 200): string => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};
const time = (iso: string | undefined): number => (iso === undefined || iso === "" ? -Infinity : Date.parse(iso));
const after = (iso: string | undefined, mark: string): boolean => time(iso) > time(mark);
const receiptNumber = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
};
const QUOTA = /quota|usage limit|rate limit/i;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/;

/** The recovery episode in progress; a run that left `running` (a supervisor's stop keeps `mode: recovery`) has none. */
function openEpisode(state: DurableRunState): string | undefined {
  return state.status === "running" && state.mode === "recovery" ? state.recoveryEpisodeId : undefined;
}

function stopKey(state: DurableRunState): string {
  return state.status === "running" ? "running" : `${state.status}@${state.stateRevision}`;
}

function newest(times: Array<string | undefined>): string {
  let best = "";
  for (const t of times) if (t !== undefined && time(t) > time(best)) best = t;
  return best;
}

/** Budgets at or over the threshold, with their numbers. */
function budgetLines(state: DurableRunState): Array<{ budget: string; used?: number; granted?: number; percent?: number }> {
  return runStats(state).budgets.map((b) => ({
    budget: b.budget,
    ...(b.used !== undefined ? { used: b.used } : {}),
    ...(b.granted !== undefined ? { granted: b.granted } : {}),
    ...(b.used !== undefined && b.granted !== undefined && b.granted > 0 ? { percent: Math.round((b.used / b.granted) * 100) } : {}),
  }));
}

function hotBudgets(state: DurableRunState): string[] {
  return budgetLines(state)
    .filter((b) => b.used !== undefined && b.granted !== undefined && b.granted > 0 && b.used / b.granted >= BUDGET_THRESHOLD)
    .map((b) => b.budget);
}

/** The mark of everything `state` shows: what a wait without `--since` starts from. */
export function markOf(state: DurableRunState): ProgressMark {
  const open = openEpisode(state);
  return {
    v: 1,
    run: state.runId,
    st: stopKey(state),
    stage: `${state.current?.stageId ?? ""}#${state.current?.attempt ?? 0}`,
    rs: Math.max(0, ...(state.receipts ?? []).map((r) => receiptNumber(r.id))),
    inv: (state.receipts ?? []).filter((r) => !r.valid).map((r) => r.id),
    ...(open !== undefined ? { ep: open } : {}),
    epAt: newest((state.supervisorEpisodes ?? []).map((r) => r.at)),
    remAt: newest((state.remedies ?? []).map((r) => r.at)),
    hot: hotBudgets(state),
  };
}

export function encodeCursor(mark: ProgressMark): string {
  return `p1.${Buffer.from(JSON.stringify(mark)).toString("base64url")}`;
}

export function decodeCursor(cursor: string): ProgressMark {
  const bad = (why: string) => new Error(`--since: not a graphloom wait cursor (${why}); use the cursor a previous wait --until progress --json printed`);
  if (!cursor.startsWith("p1.")) throw bad("unknown format");
  let mark: unknown;
  try {
    mark = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8"));
  } catch {
    throw bad("unreadable");
  }
  if (
    !isRecord(mark) ||
    mark.v !== 1 ||
    typeof mark.run !== "string" ||
    typeof mark.st !== "string" ||
    typeof mark.stage !== "string" ||
    typeof mark.rs !== "number" ||
    !Array.isArray(mark.inv) ||
    !mark.inv.every((id) => typeof id === "string") ||
    (mark.ep !== undefined && typeof mark.ep !== "string") ||
    typeof mark.epAt !== "string" ||
    typeof mark.remAt !== "string" ||
    !Array.isArray(mark.hot) ||
    !mark.hot.every((h) => typeof h === "string")
  ) {
    throw bad("malformed");
  }
  return mark as unknown as ProgressMark;
}

function resetAtOf(state: DurableRunState, remedyText: string): string | undefined {
  if (state.quotaHold?.until !== undefined) return state.quotaHold.until;
  const retries = Object.values(state.executorRetryAt ?? {}).filter((t) => time(t) > Date.now());
  if (retries.length > 0) return newest(retries);
  return ISO.exec(remedyText)?.[0];
}

function episodeOutcome(state: DurableRunState, episodeId: string): string {
  const records = (state.supervisorEpisodes ?? []).filter((r) => r.episodeId === episodeId);
  const last = records[records.length - 1];
  if (last === undefined) {
    const mark = state.supervisorMark;
    if (mark?.episodeId === episodeId) return oneLine(`${mark.action}: ${mark.reason}`);
    return "no record of its decision";
  }
  const proposal = last.proposal as unknown;
  if (isRecord(proposal)) {
    const action = isRecord(proposal.action) ? String(proposal.action.type ?? "decision") : String(proposal.type ?? "decision");
    const outcome = last.admission?.outcome;
    return oneLine(`${action}${outcome !== undefined && outcome !== "admitted" ? ` (${outcome})` : ""}: ${String(proposal.reason ?? "")}`);
  }
  if (last.error !== undefined) return oneLine(`${last.admission?.outcome ?? "error"}: ${last.error}`);
  return oneLine(last.admission?.outcome ?? "ended");
}

function episodeTrigger(state: DurableRunState, episodeId: string): string {
  if (openEpisode(state) === episodeId && state.recoveryTrigger !== undefined) {
    return oneLine(`${state.recoveryTrigger.code}: ${state.recoveryTrigger.message}`);
  }
  const first = (state.supervisorEpisodes ?? []).find((r) => r.episodeId === episodeId);
  const trigger = first?.input?.trigger;
  return trigger !== undefined ? oneLine(`${trigger.code}: ${trigger.message}`) : "trigger not recorded";
}

/** What happened in `state` since `mark`, oldest kind first, and the mark that includes it. */
export function progressSince(mark: ProgressMark, state: DurableRunState): { events: ProgressEvent[]; mark: ProgressMark } {
  if (mark.run !== state.runId) throw new Error(`--since: the cursor is for run ${mark.run}, not ${state.runId}`);
  const events: ProgressEvent[] = [];
  const next = markOf(state);

  if (mark.st !== "running" && state.status === "running") {
    events.push({ kind: "run_resumed", detail: `the run is running again (generation ${state.generation})` });
  }

  if (next.stage !== mark.stage && state.current !== undefined) {
    events.push({ kind: "stage_entered", stage: state.current.stageId, attempt: state.current.attempt, detail: `stage ${state.current.stageId}, attempt ${state.current.attempt}` });
  }

  const accepted = (state.receipts ?? []).filter((r) => r.valid && receiptNumber(r.id) > mark.rs);
  const byStage = new Map<string, string[]>();
  for (const r of accepted) byStage.set(r.stageId, [...(byStage.get(r.stageId) ?? []), r.requirementId]);
  for (const [stageId, requirements] of byStage) {
    const def = state.definition?.stages?.find((s) => s.id === stageId);
    const valid = new Set((state.receipts ?? []).filter((r) => r.valid && r.stageId === stageId).map((r) => r.requirementId));
    const complete = def !== undefined && def.requirementIds.every((id) => valid.has(id));
    events.push({
      kind: "receipt_accepted",
      stage: stageId,
      requirements,
      stageComplete: complete,
      detail: `${stageId}: accepted ${requirements.join(", ")}${complete ? " (stage complete)" : ""}`,
    });
  }
  const seenInvalid = new Set(mark.inv);
  const newlyInvalid = (state.receipts ?? []).filter((r) => !r.valid && !seenInvalid.has(r.id));
  if (newlyInvalid.length > 0) {
    const stages = [...new Set(newlyInvalid.map((r) => r.stageId))];
    events.push({ kind: "receipts_invalidated", count: newlyInvalid.length, stages, detail: `${newlyInvalid.length} receipt(s) invalidated (${stages.join(", ")})` });
  }

  // Episodes: the open one, and any whose records appeared since the mark.
  const open = openEpisode(state);
  const recorded = (state.supervisorEpisodes ?? []).filter((r) => after(r.at, mark.epAt)).map((r) => r.episodeId);
  const seen = [...new Set([...recorded, ...(open !== undefined ? [open] : [])])];
  if (mark.ep !== undefined && mark.ep !== open) {
    events.push({ kind: "episode_ended", episodeId: mark.ep, detail: `supervisor episode ${mark.ep} ended: ${episodeOutcome(state, mark.ep)}` });
  }
  for (const id of seen) {
    if (id === mark.ep) continue;
    events.push({ kind: "episode_started", episodeId: id, detail: `supervisor episode ${id} started: ${episodeTrigger(state, id)}` });
    if (id !== open) events.push({ kind: "episode_ended", episodeId: id, detail: `supervisor episode ${id} ended: ${episodeOutcome(state, id)}` });
  }

  for (const r of (state.remedies ?? []).filter((r) => after(r.at, mark.remAt))) {
    if (!QUOTA.test(r.condition)) continue;
    const resetAt = resetAtOf(state, `${r.remedy} ${r.detail ?? ""}`);
    events.push({
      kind: "quota_pause",
      at: r.at,
      condition: r.condition,
      ...(resetAt !== undefined ? { resetAt } : {}),
      detail: oneLine(`${r.condition}: ${r.remedy}${resetAt !== undefined ? ` (resets ${resetAt})` : ""}`),
    });
  }

  const lines = budgetLines(state);
  for (const budget of next.hot) {
    if (mark.hot.includes(budget)) continue;
    const line = lines.find((b) => b.budget === budget)!;
    events.push({ kind: "budget_threshold", budget, used: line.used, granted: line.granted, percent: line.percent, detail: `${budget} at ${line.percent}% (${line.used} of ${line.granted})` });
  }

  if (state.status !== "running" && next.st !== mark.st) {
    const cls = classifyStop(state);
    events.push({
      kind: "run_stopped",
      status: state.status,
      ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
      ...(cls !== undefined ? { retryable: cls.retryable } : {}),
      detail: oneLine(`run ${state.status}${state.stopReason !== undefined ? `: ${state.stopReason}` : ""}${cls !== undefined ? (cls.retryable ? " (retryable)" : " (final)") : ""}`),
    });
  }
  return { events, mark: next };
}

export function progressSummary(state: DurableRunState): ProgressSummary {
  const stages = state.definition?.stages ?? [];
  const valid = new Set((state.receipts ?? []).filter((r) => r.valid).map((r) => `${r.stageId}\u0000${r.requirementId}`));
  const complete = stages.filter((s) => s.requirementIds.every((id) => valid.has(`${s.id}\u0000${id}`))).length;
  const cls = state.status !== "running" ? classifyStop(state) : undefined;
  const retries = Object.values(state.executorRetryAt ?? {}).filter((t) => time(t) > Date.now());
  const retryUntil = retries.length > 0 ? newest(retries) : undefined;
  // A retry backoff is a quota wait only when the newest remedy says so; ordinary retryable failures back off too.
  const lastRemedy = (state.remedies ?? [])[(state.remedies ?? []).length - 1];
  const quotaRetry = retryUntil !== undefined && lastRemedy !== undefined && QUOTA.test(lastRemedy.condition);
  const waiting: ProgressSummary["waiting"] =
    state.status === "running" && state.quotaHold?.until !== undefined
      ? { kind: "quota", until: state.quotaHold.until }
      : state.status === "running" && retryUntil !== undefined
        ? { kind: quotaRetry ? "quota" : "retry", until: retryUntil }
        : state.reconciliationRequired !== undefined
        ? { kind: "reconcile", stage: state.reconciliationRequired.stageId, reason: oneLine(state.reconciliationRequired.reason) }
        : undefined;
  return {
    status: state.status,
    ...(state.status !== "running" && state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    ...(cls !== undefined ? { stopRetryable: cls.retryable } : {}),
    mode: state.mode,
    stage: state.current?.stageId ?? "",
    attempt: state.current?.attempt ?? 0,
    stagesComplete: complete,
    stages: stages.length,
    budgets: budgetLines(state),
    episodes: runStats(state).supervisor.episodes,
    ...(waiting !== undefined ? { waiting } : {}),
  };
}

export type ProgressOutcome = "progress" | "stopped" | "timeout" | "orphaned";

export interface ProgressResult {
  runId: string;
  stateDir: string;
  outcome: ProgressOutcome;
  /** Why the run is orphaned. */
  detail?: string;
  events: ProgressEvent[];
  summary: ProgressSummary;
  cursor: string;
}

export interface ProgressWaitOptions {
  stateRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
  since?: string;
}

/**
 * Blocks until something happened since the cursor (or since now), the run is
 * not running, its controller died, or the timeout elapsed. state.json is
 * stat'ed each poll and parsed only when it changed.
 */
export async function waitForProgress(runRef: string, options: ProgressWaitOptions = {}): Promise<ProgressResult> {
  const stateDir = await resolveStateDir(runRef, options.stateRoot);
  const pollMs = options.pollMs ?? 1_000;
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  const file = path.join(stateDir, "state.json");
  const signature = async (): Promise<string> => {
    const st = await stat(file).catch(() => undefined);
    return st === undefined ? "" : `${st.mtimeMs}:${st.size}:${st.ino}`;
  };
  // The signature is taken before the read: a write between them is seen as a change at the first poll.
  let seen = await signature();
  let state = await loadRunState(stateDir);
  let mark = options.since !== undefined ? decodeCursor(options.since) : markOf(state);
  // A wait without a cursor on a run that is not running reports that stop.
  if (options.since === undefined && state.status !== "running") mark = { ...mark, st: "running" };
  if (mark.run !== state.runId) throw new Error(`--since: the cursor is for run ${mark.run}, not ${state.runId}`);
  let first = true;
  const result = (outcome: ProgressOutcome, events: ProgressEvent[], m: ProgressMark, detail?: string): ProgressResult => ({
    runId: state.runId,
    stateDir,
    outcome,
    ...(detail !== undefined ? { detail } : {}),
    events,
    summary: progressSummary(state),
    cursor: encodeCursor(m),
  });
  for (;;) {
    const key = await signature();
    if (first || key !== seen) {
      // Any signature other than the one taken before the last read means a write that read has not seen.
      if (key !== seen) state = await loadRunState(stateDir);
      first = false;
      seen = key;
      const { events, mark: next } = progressSince(mark, state);
      if (events.length > 0) return result(state.status === "running" ? "progress" : "stopped", events, next);
      if (state.status !== "running") return result("stopped", [], next);
      // Keep what was observed without an event (a budget a raise took below the threshold), so a later crossing reports.
      mark = next;
    }
    const owner = await readOwnerClaim(stateDir).catch((err: unknown) => {
      throw new Error(`cannot read owner claim in ${stateDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (owner === undefined || isClaimStale(owner)) {
      state = await loadRunState(stateDir);
      const { events, mark: next } = progressSince(mark, state);
      if (state.status !== "running") return result("stopped", events, next);
      const detail = owner === undefined ? "no controller owns it" : `its controller (pid ${owner.controllerPid}) is no longer running`;
      return result("orphaned", events, next, detail);
    }
    if (Date.now() >= deadline) return result("timeout", [], mark);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** The text form: one line per event, the summary, and the next command. */
export function formatProgress(r: ProgressResult): string {
  const lines: string[] = [];
  if (r.outcome === "timeout") lines.push("no progress before the timeout");
  if (r.outcome === "orphaned") lines.push(`orphaned: ${r.detail ?? "no live controller"}`);
  for (const e of r.events) lines.push(`${e.kind.padEnd(20)} ${e.detail}`);
  const s = r.summary;
  const budgets = s.budgets.filter((b) => b.percent !== undefined).map((b) => `${b.budget} ${b.percent}%`).join(", ");
  lines.push(
    `run ${r.runId}  ${s.status}${s.stopReason !== undefined ? ` (${s.stopReason})` : ""}  ${s.mode}  stage ${s.stage}#${s.attempt}  ${s.stagesComplete}/${s.stages} stages complete` +
      (budgets !== "" ? `  budgets: ${budgets}` : "") +
      (s.waiting?.kind === "quota" ? `  waiting for a quota reset until ${s.waiting.until}` : s.waiting?.kind === "retry" ? `  retrying a failed job at ${s.waiting.until}` : s.waiting?.kind === "reconcile" ? `  reconciliation required (${s.waiting.stage})` : ""),
  );
  if (s.status === "running") lines.push(`next: graphloom wait ${r.stateDir} --until progress --since ${r.cursor}`);
  return lines.join("\n");
}
