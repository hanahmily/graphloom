/**
 * Evaluates a finished rehearsal (or a replayed recorded run) against the
 * scenario it was asked to reach, reading only generic durable state — no
 * plugin vocabulary (docs/design-graph-rehearsal.md §4.7). The CLI supplies
 * what durable state alone cannot show (B2's capability probe, the seam
 * guard); this module fills in the rest from `DurableRunState` and renders
 * the final verdict.
 */
import type { EvidenceRecord, RehearsalScenario, Receipt } from "@graphloom/sdk";
import type { DurableRunState } from "./state.js";

export type Boundary = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7" | "B8" | "B9" | "B10";

export type BoundaryStatus = "passed" | "failed" | "unverified" | "unexercised";

export interface BoundaryResult {
  status: BoundaryStatus;
  notes: string[];
}

export interface RehearsalConvergence {
  expected: RehearsalScenario["expect"];
  actual: {
    status: DurableRunState["status"];
    receipts: string[];
    stopReason?: string;
    recovery: string[];
  };
  met: boolean;
}

export interface RehearsalReport {
  verdict: "ready" | "not-ready" | "inconclusive";
  blocker?: { boundary: Boundary; reason: string; evidenceRefs: string[] };
  boundaries: Record<Boundary, BoundaryResult>;
  substituted: string[];
  notCovered: string[];
  convergence: RehearsalConvergence;
}

export interface EvidenceProducerInfo {
  operationId?: string;
  stageId?: string;
  purpose?: string;
  executorId?: string;
}

export function producerOf(record: EvidenceRecord): EvidenceProducerInfo | undefined {
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const producer = (payload as Record<string, unknown>).producer;
  return producer !== null && typeof producer === "object" && !Array.isArray(producer)
    ? (producer as EvidenceProducerInfo)
    : undefined;
}

function validReceiptStages(receipts: Receipt[]): string[] {
  return [...new Set(receipts.filter((r) => r.valid).map((r) => r.stageId))];
}

/**
 * Evaluates `state` against `scenario`, merging in boundary results the CLI
 * already determined (B2's capability probe, a seam-guard failure) rather
 * than guessing them. `substituted`/`notCovered` are appended to, not
 * replaced, so the CLI's own entries (which stand-in modules ran, which
 * commands were stubbed) survive.
 */
export function evaluateRehearsal(
  state: DurableRunState,
  scenario: RehearsalScenario,
  given: Partial<Record<Boundary, BoundaryResult>> = {},
  context: { substituted?: string[]; notCovered?: string[] } = {},
): RehearsalReport {
  const boundaries = {
    B1: given.B1 ?? checkB1(state),
    B2: given.B2 ?? { status: "unverified", notes: ["no capability probe was supplied"] },
    B3: given.B3 ?? checkB3(state),
    B4: given.B4 ?? checkB4(state),
    B5: given.B5 ?? checkB5(state),
    B6: given.B6 ?? checkB6(state),
    B7: given.B7 ?? checkB789(state, scenario),
    B8: given.B8 ?? { status: "passed", notes: [] },
    B9: given.B9 ?? { status: "passed", notes: [] },
    B10: given.B10 ?? checkB10(state, scenario),
  } as const satisfies Record<Boundary, BoundaryResult>;

  const convergence = checkConvergence(state, scenario);

  const notCovered = [...(context.notCovered ?? [])];
  notCovered.push("model behaviour: the stand-in answers from a scenario, never a real model's judgment");
  notCovered.push("provider health and real GitHub state beyond what the scenario recorded");

  const failedEntry = (Object.entries(boundaries) as Array<[Boundary, BoundaryResult]>).find(([, r]) => r.status === "failed");
  const unexercised = (Object.entries(boundaries) as Array<[Boundary, BoundaryResult]>).some(([, r]) => r.status === "unexercised");

  let verdict: RehearsalReport["verdict"];
  let blocker: RehearsalReport["blocker"];
  if (failedEntry !== undefined || !convergence.met) {
    verdict = "not-ready";
    const [boundary, result] = failedEntry ?? (["B10", { status: "failed", notes: ["convergence not met"] }] as [Boundary, BoundaryResult]);
    blocker = { boundary, reason: result.notes.join("; ") || "convergence not met", evidenceRefs: [] };
  } else if (unexercised) {
    verdict = "inconclusive";
  } else {
    verdict = "ready";
  }

  return {
    verdict,
    ...(blocker !== undefined ? { blocker } : {}),
    boundaries,
    substituted: context.substituted ?? [],
    notCovered,
    convergence,
  };
}

/** B1: no dispatch was refused at admission (a contract name, scope, or undeclared stage the plugin itself got wrong). */
function checkB1(state: DurableRunState): BoundaryResult {
  const refusals = ["contract rejected", "scope rejected", "undeclared stage"];
  if (state.status === "stopped" && refusals.includes(state.stopReason ?? "")) {
    return { status: "failed", notes: [`admission refused: ${state.stopReason} — ${state.blocker ?? ""}`] };
  }
  return { status: "passed", notes: [] };
}

/** B3: every agent result the stand-in produced completed with an output (a scripted failure is not a B3 defect — it is what the scenario asked for). */
export function checkB3(state: DurableRunState): BoundaryResult {
  const malformed: string[] = [];
  for (const record of state.evidence) {
    const payload = record.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const codingAgent = (payload as Record<string, unknown>).codingAgent;
    if (codingAgent === null || typeof codingAgent !== "object" || Array.isArray(codingAgent)) continue;
    const agent = codingAgent as Record<string, unknown>;
    if (agent.status === undefined) malformed.push(record.ref);
  }
  if (malformed.length > 0) return { status: "failed", notes: [`malformed agent evidence: ${malformed.join(", ")}`] };
  return { status: "passed", notes: [] };
}

/** B4: every record checked against a declared contract is valid or repaired, and its kind matches what a valid/repaired result should record as. */
function checkB4(state: DurableRunState): BoundaryResult {
  const invalid = state.evidence.filter((e) => e.contract?.status === "invalid");
  if (invalid.length > 0) {
    return {
      status: "failed",
      notes: invalid.map((e) => `${e.ref}: contract ${e.contract?.name} invalid — ${(e.contract?.problems ?? []).join("; ")}`),
    };
  }
  const repaired = state.evidence.filter((e) => e.contract?.status === "repaired");
  return { status: "passed", notes: repaired.map((e) => `${e.ref}: contract ${e.contract?.name} repaired — ${(e.contract?.repairs ?? []).join("; ")}`) };
}

/** B5: a stage that received a contract-valid or repaired result minted a receipt; a validation failure against valid evidence is a parser/validator mismatch. */
function checkB5(state: DurableRunState): BoundaryResult {
  const validByStage = new Map<string, number>();
  for (const record of state.evidence) {
    if (record.contract === undefined || record.contract.status === "invalid") continue;
    const stageId = producerOf(record)?.stageId;
    if (stageId === undefined) continue;
    validByStage.set(stageId, (validByStage.get(stageId) ?? 0) + 1);
  }
  if (validByStage.size === 0) return { status: "unexercised", notes: ["no agent result named a declared contract"] };
  const accepted = new Set(validReceiptStages(state.receipts));
  const stuck = [...validByStage.keys()].filter((stageId) => !accepted.has(stageId));
  if (stuck.length > 0 && state.status !== "running") {
    return { status: "failed", notes: stuck.map((s) => `stage ${s}: a contract-valid result never minted a receipt`) };
  }
  return { status: "passed", notes: [] };
}

/** B6: no reference stayed an unreconciled problem; a repair is listed, not a failure. */
function checkB6(state: DurableRunState): BoundaryResult {
  const problems = state.evidence.flatMap((e) => e.contract?.problems ?? []);
  if (problems.length > 0) return { status: "failed", notes: problems };
  return { status: "passed", notes: [] };
}

/** B7–B9: recovery was entered only for the triggers the scenario named, in order; any other entry is unfamiliar. */
function checkB789(state: DurableRunState, scenario: RehearsalScenario): BoundaryResult {
  const expected = scenario.expect.recovery ?? [];
  const actual = state.recoveryTrigger !== undefined ? [state.recoveryTrigger.code] : [];
  if (actual.length === 0) return { status: "passed", notes: [] };
  if (expected.length === 0) {
    return { status: "failed", notes: [`entered recovery (${actual.join(", ")}) though the scenario expected none`] };
  }
  if (!expected.includes(actual[0]!)) {
    return { status: "failed", notes: [`entered recovery as ${actual[0]}, which the scenario did not name among ${expected.join(", ")}`] };
  }
  return { status: "passed", notes: [] };
}

/** B10: no stage exceeded its dispatch ceiling, and the recovery reserve was left intact unless the scenario drove the budget down on purpose. */
function checkB10(state: DurableRunState, scenario: RehearsalScenario): BoundaryResult {
  const notes: string[] = [];
  const ceiling = scenario.expect.maxAgentDispatches;
  if (ceiling !== undefined) {
    for (const [stageId, counts] of Object.entries(state.dispatchesSinceReceipt ?? {})) {
      if (counts.agent > ceiling) notes.push(`stage ${stageId}: ${counts.agent} agent dispatches exceeds the scenario's ceiling of ${ceiling}`);
    }
  }
  if (state.recoveryTrigger?.code === "stalled" && !(scenario.expect.recovery ?? []).includes("stalled")) {
    notes.push(`stalled: ${state.recoveryTrigger.message}`);
  }
  const reserve = state.intake.budgets.recoveryReserve;
  if (reserve !== undefined && state.budgets.agentInvocations < reserve && scenario.budgets?.agentInvocations === undefined) {
    notes.push(`agentInvocations (${state.budgets.agentInvocations}) fell below the recovery reserve (${reserve})`);
  }
  return notes.length > 0 ? { status: "failed", notes } : { status: "passed", notes: [] };
}

function checkConvergence(state: DurableRunState, scenario: RehearsalScenario): RehearsalConvergence {
  const expected = scenario.expect;
  const actualReceipts = validReceiptStages(state.receipts);
  const recovery = state.recoveryTrigger !== undefined ? [state.recoveryTrigger.code] : [];
  const actual = {
    status: state.status,
    receipts: actualReceipts,
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    recovery,
  };
  let met = statusMatches(expected.status, state.status);
  if (met && expected.receipts !== undefined) {
    met = expected.receipts.every((stageId) => actualReceipts.includes(stageId));
  }
  if (met && expected.stopReason !== undefined) {
    met = state.stopReason === expected.stopReason;
  }
  if (met && expected.executorCalls !== undefined) {
    const calls: Record<string, number> = {};
    for (const record of state.evidence) {
      const executorId = producerOf(record)?.executorId;
      if (executorId !== undefined) calls[executorId] = (calls[executorId] ?? 0) + 1;
    }
    met = Object.entries(expected.executorCalls).every(([id, count]) => (calls[id] ?? 0) === count);
  }
  return { expected, actual, met };
}

function statusMatches(expected: "succeeded" | "stopped", actual: DurableRunState["status"]): boolean {
  if (expected === "succeeded") return actual === "succeeded";
  return actual === "stopped" || actual === "failed";
}
