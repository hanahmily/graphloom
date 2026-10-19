/**
 * `graphloom stats`: what a run actually used, per stage and in total, from
 * its durable state and the supervisor episode records in it — never from
 * budget deltas alone, which an operator's hand edit makes meaningless.
 *
 * Runs saved before a field existed simply lack it; every count here says
 * whether it is exact or a lower bound / estimate, and why.
 */
import {
  budgetGranted,
  budgetsUsed,
  loadRunState,
  METERED_BUDGET_KEYS,
  resolveStateDir,
  type BudgetAmounts,
  type DurableRunState,
  type MeteredBudgetKey,
} from "@graphloom/controller";
import { MAX_EPISODE_RECORDS } from "@graphloom/supervisor";

/** How far a number can be trusted. */
export type Exactness = "exact" | "lower bound" | "estimate" | "unknown";

export interface StageStats {
  stageId: string;
  /** Highest attempt the stage ran under (reentries and resumes open new ones). */
  attempts: number;
  /** Model calls reserved by jobs dispatched for the stage (`agentInvocationsByStage`). */
  agentInvocations: number;
  /** Jobs with recorded evidence or an agent session, by kind and purpose. */
  jobs: { total: number; agent: number; command: number; byPurpose: Record<string, number> };
  /** Agent sessions settled for the stage, by status. */
  agentSessions: Record<string, number>;
  receipts: { valid: number; invalidated: number };
}

export interface BudgetLine {
  budget: MeteredBudgetKey;
  used?: number;
  left?: number;
  /** Used plus left: the run's budget as it stands, operator raises included. */
  granted?: number;
  /** What intake started the run with. */
  intake?: number;
  exactness: Exactness;
}

export interface RunStats {
  runId: string;
  graphId: string;
  activeVersion: string;
  status: string;
  stopReason?: string;
  /** First and last recorded timestamps, and the wall-clock time between (includes time stopped). */
  span?: { from: string; to: string; wallMs: number };
  /** Where `budgets[].used` comes from. */
  usageSource: { kind: "ledger"; exactness: "exact" } | { kind: "estimated"; since: string; note: string };
  budgets: BudgetLine[];
  stages: StageStats[];
  agentInvocations: {
    /** Reserved by the stages' jobs: exact for every run that records it. */
    stages: number;
    /** Supervisor, proposal reviewer and repair calls: the run's total less the stages'. */
    outsideStages?: number;
    total?: number;
    exactness: Exactness;
  };
  jobs: { recorded: number; budgetUsed?: number; environmentChecks: number; exactness: Exactness };
  generations: number;
  versionTransitions: Record<string, number>;
  supervisor: {
    episodes: number;
    turns?: number;
    providerCalls?: number;
    source: "episode records" | "episode ids referenced in run state";
    exactness: Exactness;
  };
  remedies: { count: number; byCondition: Record<string, number>; waitedMs: number; exactness: Exactness };
  evidence: number;
}

const MAX_REMEDY_RECORDS = 100;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What `state` used, per stage and in total. Pure: reads only the state handed to it. */
export function runStats(state: DurableRunState): RunStats {
  const stageIds = [
    ...new Set([
      ...(state.definition?.stages ?? []).map((s) => s.id),
      ...Object.keys(state.agentInvocationsByStage ?? {}),
      ...(state.receipts ?? []).map((r) => r.stageId),
    ]),
  ];

  // Jobs: each operation that recorded evidence or settled an agent session.
  // Child tool calls name their parent job and are not jobs of their own.
  const jobs = new Map<string, { stageId: string; kind: string; purpose: string }>();
  const environment = new Set<string>();
  for (const e of state.evidence ?? []) {
    const payload = isRecord(e.payload) ? e.payload : undefined;
    const p = payload !== undefined && isRecord(payload.producer) ? payload.producer : undefined;
    if (p === undefined || typeof p.operationId !== "string" || typeof p.stageId !== "string") continue;
    if (typeof p.parentOperationId === "string") continue;
    if (payload!.environment !== undefined) {
      environment.add(p.operationId);
      continue;
    }
    if (!jobs.has(p.operationId)) jobs.set(p.operationId, { stageId: p.stageId, kind: String(p.kind ?? "unknown"), purpose: String(p.purpose ?? "unknown") });
  }
  for (const s of state.agentSessions ?? []) {
    if (!jobs.has(s.operationId)) jobs.set(s.operationId, { stageId: s.stageId, kind: "agent", purpose: s.dispatchKey.split(":")[0] ?? "unknown" });
  }

  const stages: StageStats[] = stageIds.map((stageId) => {
    const own = [...jobs.values()].filter((j) => j.stageId === stageId);
    const byPurpose: Record<string, number> = {};
    for (const j of own) byPurpose[j.purpose] = (byPurpose[j.purpose] ?? 0) + 1;
    const sessions: Record<string, number> = {};
    for (const s of (state.agentSessions ?? []).filter((r) => r.stageId === stageId)) sessions[s.status] = (sessions[s.status] ?? 0) + 1;
    const fromSessions = Math.max(0, ...(state.agentSessions ?? []).filter((r) => r.stageId === stageId).map((r) => r.attempt));
    const current = state.current?.stageId === stageId ? state.current.attempt : 0;
    return {
      stageId,
      attempts: Math.max(state.stageAttempts?.[stageId] ?? 0, fromSessions, current),
      agentInvocations: state.agentInvocationsByStage?.[stageId] ?? 0,
      jobs: {
        total: own.length,
        agent: own.filter((j) => j.kind === "agent").length,
        command: own.filter((j) => j.kind === "command").length,
        byPurpose,
      },
      agentSessions: sessions,
      receipts: {
        valid: (state.receipts ?? []).filter((r) => r.stageId === stageId && r.valid).length,
        invalidated: (state.receipts ?? []).filter((r) => r.stageId === stageId && !r.valid).length,
      },
    };
  });

  const exactLedger = state.budgetUsage?.since === "intake";
  const used: BudgetAmounts = budgetsUsed(state);
  const intakeBudgets = (state.intake?.budgets ?? {}) as Partial<Record<MeteredBudgetKey, number>>;
  const edited = editedBudgets(state);
  const budgets: BudgetLine[] = METERED_BUDGET_KEYS.filter((k) => state.budgets?.[k] !== undefined || intakeBudgets[k] !== undefined).map((budget) => {
    const left = state.budgets?.[budget];
    // Without the ledger, a budget edited by hand leaves no trace of its use.
    const unknown = !exactLedger && edited.has(budget) && budget !== "agentInvocations";
    const granted = unknown ? undefined : budgetGranted(state, budget);
    return {
      budget,
      ...(used[budget] !== undefined && !unknown ? { used: used[budget] } : {}),
      ...(left !== undefined ? { left } : {}),
      ...(granted !== undefined ? { granted } : {}),
      ...(intakeBudgets[budget] !== undefined ? { intake: intakeBudgets[budget] } : {}),
      exactness: exactLedger ? "exact" : unknown ? "unknown" : budget === "agentInvocations" && edited.has(budget) ? "lower bound" : "estimate",
    };
  });

  const stageCalls = stages.reduce((a, s) => a + s.agentInvocations, 0);
  const totalCalls = !exactLedger && edited.has("agentInvocations") ? undefined : used.agentInvocations;
  const agentInvocations: RunStats["agentInvocations"] = {
    stages: stageCalls,
    ...(totalCalls !== undefined ? { total: totalCalls, outsideStages: Math.max(0, totalCalls - stageCalls) } : {}),
    // Without the ledger the total is intake less what remains, or the
    // stages' own count when an edit made that smaller: at least the stages'.
    exactness: exactLedger ? "exact" : !edited.has("agentInvocations") && totalCalls !== undefined && totalCalls > stageCalls ? "estimate" : "lower bound",
  };

  const versionTransitions: Record<string, number> = {};
  for (const v of state.versionHistory ?? []) {
    const reason = v.reason.split(/[\s:]/)[0] ?? v.reason;
    versionTransitions[reason] = (versionTransitions[reason] ?? 0) + 1;
  }

  const supervisor = supervisorStats(state);

  const remedies = state.remedies ?? [];
  const byCondition: Record<string, number> = {};
  for (const r of remedies) byCondition[r.condition] = (byCondition[r.condition] ?? 0) + 1;

  return {
    runId: state.runId,
    graphId: state.intake?.bundle?.graphId ?? state.definition?.graphId ?? "unknown",
    activeVersion: state.activeVersion,
    status: state.status,
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    ...spanOf(state),
    usageSource: exactLedger
      ? { kind: "ledger", exactness: "exact" }
      : {
          kind: "estimated",
          since: state.budgetUsage?.since ?? "never",
          note: "the run predates the usage ledger: use is its intake budgets less what remains, unknown where the numbers show a hand edit (an undetectable edit makes the estimate wrong), and agent calls at least what its stages recorded",
        },
    budgets,
    stages,
    agentInvocations,
    jobs: {
      recorded: jobs.size,
      ...(budgets.find((b) => b.budget === "jobs")?.used !== undefined ? { budgetUsed: budgets.find((b) => b.budget === "jobs")!.used! } : {}),
      environmentChecks: environment.size,
      // Jobs that failed before recording evidence leave no trace but the budget.
      exactness: "lower bound",
    },
    generations: state.generation,
    versionTransitions,
    supervisor,
    remedies: {
      count: remedies.length,
      byCondition,
      waitedMs: remedies.reduce((a, r) => a + (r.waitedMs ?? 0), 0),
      exactness: remedies.length >= MAX_REMEDY_RECORDS ? "lower bound" : "exact",
    },
    evidence: (state.evidence ?? []).length,
  };
}

/**
 * For a run without the usage ledger: budgets whose numbers show a hand edit —
 * an intake value other than the task's own, or more left than intake gave.
 */
function editedBudgets(state: DurableRunState): Set<MeteredBudgetKey> {
  const out = new Set<MeteredBudgetKey>();
  const intake = (state.intake?.budgets ?? {}) as Partial<Record<MeteredBudgetKey, number>>;
  const task = (state.intake?.task?.budgets ?? {}) as Partial<Record<MeteredBudgetKey, number>>;
  for (const key of METERED_BUDGET_KEYS) {
    const left = state.budgets?.[key];
    if (task[key] !== undefined && intake[key] !== undefined && task[key] !== intake[key]) out.add(key);
    if (left !== undefined && intake[key] !== undefined && left > intake[key]!) out.add(key);
  }
  return out;
}

function supervisorStats(state: DurableRunState): RunStats["supervisor"] {
  const records = state.supervisorEpisodes;
  if (records !== undefined && records.length > 0) {
    // Kept to the newest MAX_EPISODE_RECORDS: a full list may have dropped older ones.
    const bounded = records.length >= MAX_EPISODE_RECORDS;
    return {
      episodes: new Set(records.map((r) => r.episodeId)).size,
      turns: records.length,
      providerCalls: records.reduce((a, r) => a + (r.providerCalls ?? 0), 0),
      source: "episode records",
      exactness: bounded ? "lower bound" : "exact",
    };
  }
  // Older runs: every episode id the state still names (newest marks, case
  // file entries, probes, outcomes, remedies) — at least that many episodes.
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v !== "") ids.add(v);
  };
  add(state.recoveryEpisodeId);
  add(state.supervisorMark?.episodeId);
  add(state.probeLog?.episodeId);
  for (const o of state.supervisorOutcomes ?? []) add(o.episodeId);
  for (const r of state.remedies ?? []) add(r.episodeId);
  const caseFile = state.caseFile as unknown;
  if (isRecord(caseFile)) {
    for (const list of Object.values(caseFile)) {
      if (Array.isArray(list)) for (const entry of list) if (isRecord(entry)) add(entry.episodeId);
    }
  }
  return { episodes: ids.size, source: "episode ids referenced in run state", exactness: "lower bound" };
}

function spanOf(state: DurableRunState): { span: NonNullable<RunStats["span"]> } | Record<string, never> {
  const times: number[] = [];
  const add = (iso: unknown) => {
    const t = typeof iso === "string" ? Date.parse(iso) : NaN;
    if (Number.isFinite(t)) times.push(t);
  };
  for (const v of state.versionHistory ?? []) add(v.at);
  for (const s of state.agentSessions ?? []) add(s.settledAt);
  for (const r of state.remedies ?? []) add(r.at);
  for (const r of state.supervisorEpisodes ?? []) add(r.at);
  for (const d of Object.values(state.dispatchesSinceReceipt ?? {})) add(d.since);
  if (times.length === 0) return {};
  const from = Math.min(...times);
  const to = Math.max(...times);
  return { span: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), wallMs: to - from } };
}

/** Loads the run named by `runRef` through the controller's public API. */
export async function loadRunStats(runRef: string, stateRoot?: string): Promise<RunStats> {
  const stateDir = await resolveStateDir(runRef, stateRoot);
  return runStats(await loadRunState(stateDir));
}

/** `ms` as `1h 05m`, `4m 10s` or `850ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.round(ms / 1_000);
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

const amount = (key: MeteredBudgetKey, v: number | undefined): string =>
  v === undefined ? "-" : key === "waitMs" || key === "activeMs" ? formatDuration(v) : String(v);

/** A readable report of `stats`. */
export function formatRunStats(stats: RunStats): string {
  const lines: string[] = [];
  lines.push(`run ${stats.runId}  ${stats.activeVersion}  ${stats.status}${stats.stopReason !== undefined ? ` (${stats.stopReason})` : ""}`);
  if (stats.span !== undefined) lines.push(`recorded ${stats.span.from} .. ${stats.span.to} (${formatDuration(stats.span.wallMs)} wall clock, stops included)`);
  lines.push(
    stats.usageSource.kind === "ledger"
      ? "budget use: exact (booked since intake)"
      : `budget use: estimated — ${stats.usageSource.note}`,
  );
  lines.push("");
  const stageRows = [["stage", "attempts", "agent calls", "jobs", "agent", "command", "review jobs", "receipts valid/invalidated"]];
  for (const s of stats.stages) {
    stageRows.push([
      s.stageId,
      String(s.attempts),
      String(s.agentInvocations),
      String(s.jobs.total),
      String(s.jobs.agent),
      String(s.jobs.command),
      String(s.jobs.byPurpose.review ?? 0),
      `${s.receipts.valid}/${s.receipts.invalidated}`,
    ]);
  }
  const sum = (f: (s: StageStats) => number) => String(stats.stages.reduce((a, s) => a + f(s), 0));
  stageRows.push([
    "all stages",
    "",
    sum((s) => s.agentInvocations),
    sum((s) => s.jobs.total),
    sum((s) => s.jobs.agent),
    sum((s) => s.jobs.command),
    sum((s) => s.jobs.byPurpose.review ?? 0),
    `${sum((s) => s.receipts.valid)}/${sum((s) => s.receipts.invalidated)}`,
  ]);
  lines.push(table(stageRows));
  lines.push("");
  const budgetRows = [["budget", "used", "left", "run's budget", "intake", ""]];
  for (const b of stats.budgets) {
    budgetRows.push([b.budget, amount(b.budget, b.used), amount(b.budget, b.left), amount(b.budget, b.granted), amount(b.budget, b.intake), b.exactness]);
  }
  lines.push(table(budgetRows));
  lines.push("");
  const a = stats.agentInvocations;
  lines.push(
    `agent calls: ${a.stages} by stage jobs (exact)` +
      (a.total !== undefined
        ? `, ${a.outsideStages} by the supervisor, reviewer and repairs, ${a.total} in total (${a.exactness})`
        : ", calls outside the stages unknown (the agent budget was edited by hand)"),
  );
  lines.push(
    `jobs: ${stats.jobs.recorded} recorded (${stats.jobs.exactness})` +
      (stats.jobs.budgetUsed !== undefined ? `, ${stats.jobs.budgetUsed} charged to the jobs budget` : "") +
      `; ${stats.jobs.environmentChecks} environment checks`,
  );
  const transitions = Object.entries(stats.versionTransitions)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  lines.push(`generations: ${stats.generations} (${transitions})`);
  const sup = stats.supervisor;
  lines.push(
    `supervisor: ${sup.episodes} episodes` +
      (sup.turns !== undefined ? `, ${sup.turns} turns, ${sup.providerCalls} provider calls` : "") +
      ` (${sup.exactness}, from ${sup.source})`,
  );
  const conditions = Object.entries(stats.remedies.byCondition)
    .sort((x, y) => y[1] - x[1])
    .map(([c, n]) => `${c} ${n}`)
    .join("; ");
  lines.push(
    `remedies: ${stats.remedies.count} (${stats.remedies.exactness})${stats.remedies.waitedMs > 0 ? `, waited ${formatDuration(stats.remedies.waitedMs)}` : ""}${conditions !== "" ? ` — ${conditions}` : ""}`,
  );
  lines.push(`evidence records: ${stats.evidence}`);
  return lines.join("\n");
}
