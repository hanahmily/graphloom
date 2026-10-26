// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * L2 replay (docs/design-graph-rehearsal.md §3.3): would a recorded run's
 * real outputs be accepted under the current code and plugin, for zero
 * provider calls? Replay never dispatches or mints a receipt — it
 * re-classifies recorded evidence against the current `resultContracts`,
 * re-runs the current validators on it, and asks the current `advance()`
 * what it would do next, given everything that happened.
 */
import type {
  EvidenceRecord,
  GraphDefinition,
  GraphDecision,
  Requirement,
  ValidationResult,
} from "@graphloom/sdk";
import { checkContract } from "@graphloom/sdk";
import type { CallContext, PluginHost } from "@graphloom/plugin-host";
import type { DurableRunState } from "./state.js";
import { toRunView } from "./loop.js";

export interface ReclassifiedRecord {
  ref: string;
  before: EvidenceRecord["kind"];
  after: EvidenceRecord["kind"];
  contract?: NonNullable<EvidenceRecord["contract"]>;
}

export interface ReplayRequirementResult {
  requirementId: string;
  /** Whether the recorded run had a valid receipt for this requirement. */
  hadReceipt: boolean;
  /** The current validator's verdict against the reclassified evidence. */
  now: ValidationResult;
}

export interface ReplayReport {
  activeVersion: string;
  /** Contract outcomes after reclassification, overall and by name. */
  contracts: {
    valid: number;
    invalid: number;
    repaired: number;
    byName: Record<string, { valid: number; invalid: number; repaired: number }>;
  };
  /** Only the records whose kind or contract status changed under the current contracts. */
  reclassified: ReclassifiedRecord[];
  requirements: ReplayRequirementResult[];
  /** What the current `advance()` would do, given the reclassified evidence, or why it could not be asked. */
  nextDecision: { decision: GraphDecision } | { error: string };
  /** Recorded for context, not replayed: a dispatch's reference id sets are not stamped on evidence (§3.3 limitation). */
  notCovered: string[];
}

function codingAgentOf(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const codingAgent = (payload as Record<string, unknown>).codingAgent;
  return codingAgent !== null && typeof codingAgent === "object" && !Array.isArray(codingAgent)
    ? (codingAgent as Record<string, unknown>)
    : undefined;
}

/**
 * A flattened "review" record's own payload, producer aside (a sibling of
 * the validated value, not part of it — attachProducer's own convention), is
 * itself the value classifyAgentResult already validated once; nothing left
 * to re-extract from a `codingAgent` wrapper, since flattening removed it.
 */
function flattenedOutputOf(payload: unknown): { output: unknown; producer: unknown } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { output: payload, producer: undefined };
  const { producer, ...output } = payload as Record<string, unknown>;
  return { output, producer };
}

/**
 * Re-derives what `recordJobEvidence` would classify a record as today: a
 * record whose raw executor wrapper is still present is reclassified against
 * the current `resultContracts` directly; one already flattened by a prior,
 * correct classification (nothing left to re-extract `.output` from) is
 * re-checked from its own payload instead — tightening the current schema or
 * validator can turn a recorded verdict invalid, and a replay that only ever
 * looked for a raw wrapper would never see that.
 */
function reclassify(definition: GraphDefinition, record: EvidenceRecord): EvidenceRecord {
  if (record.resultSchema === undefined) return record;
  const contract = definition.resultContracts?.find((c) => c.name === record.resultSchema);
  if (contract === undefined) return record;
  const agent = codingAgentOf(record.payload);

  // No stamped knownReferences (§3.3 limitation): a reference field's
  // membership cannot be checked here, only the contract's shape.
  if (agent === undefined) {
    if (record.kind !== "review") return record; // nothing flattened by classifyAgentResult reaches here otherwise.
    const { output, producer } = flattenedOutputOf(record.payload);
    const checked = checkContract(output, contract);
    if (checked.status === "invalid") {
      // An invalid result always keeps a wrapper (classifyAgentResult's own
      // convention), so nothing downstream that reads `.codingAgent.output`
      // silently sees the pre-flatten shape as if it were still valid.
      return {
        ...record,
        kind: "other",
        payload: { producer, codingAgent: { status: "completed", output: checked.value } },
        contract: { name: contract.name, status: checked.status, problems: checked.problems },
      };
    }
    const flattenedValue =
      checked.value !== null && typeof checked.value === "object" && !Array.isArray(checked.value)
        ? { ...(checked.value as Record<string, unknown>), producer }
        : checked.value;
    return {
      ...record,
      kind: contract.evidenceKind,
      payload: flattenedValue,
      contract: { name: contract.name, status: checked.status, problems: checked.problems, ...(checked.repairs !== undefined ? { repairs: checked.repairs } : {}) },
    };
  }

  const checked = checkContract(agent.output, contract);
  const kind = checked.status === "invalid" ? "other" : contract.evidenceKind;
  const flatten = checked.status !== "invalid" && contract.evidenceKind === "review";
  // Producer metadata is a sibling of `codingAgent` on the recorded payload,
  // not nested in it (attachProducer's own convention) — it must survive a
  // flatten, or a plugin's own stage/purpose-scoped lookup (e.g. `reviews()`)
  // never finds the reclassified record at all.
  const producer = (record.payload as Record<string, unknown> | undefined)?.producer;
  const flattenedValue =
    checked.value !== null && typeof checked.value === "object" && !Array.isArray(checked.value)
      ? { ...(checked.value as Record<string, unknown>), producer }
      : checked.value;
  return {
    ...record,
    kind,
    payload: flatten
      ? flattenedValue
      : { ...(record.payload as Record<string, unknown>), codingAgent: { ...agent, output: checked.value } },
    contract: { name: contract.name, status: checked.status, problems: checked.problems, ...(checked.repairs !== undefined ? { repairs: checked.repairs } : {}) },
  };
}

function contractSummary(evidence: EvidenceRecord[]): ReplayReport["contracts"] {
  const byName: Record<string, { valid: number; invalid: number; repaired: number }> = {};
  const totals = { valid: 0, invalid: 0, repaired: 0 };
  for (const e of evidence) {
    const contract = e.contract;
    if (contract === undefined) continue;
    const bucket = (byName[contract.name] ??= { valid: 0, invalid: 0, repaired: 0 });
    bucket[contract.status] += 1;
    totals[contract.status] += 1;
  }
  return { ...totals, byName };
}

function requirementsFor(definition: GraphDefinition): Requirement[] {
  return definition.requirements;
}

/**
 * Replays `recorded` against `host` — a fresh plugin host for the bundle's
 * *current* code, not the version the run was pinned to. Spends no provider
 * calls and mints no receipt; it only reads.
 */
export async function replayRun(recorded: DurableRunState, host: PluginHost): Promise<ReplayReport> {
  const ctx: CallContext = { runId: recorded.runId, operationId: "replay", expectedStateRevision: recorded.stateRevision };
  const described = await host.describe(ctx);
  if (!described.ok) {
    return {
      activeVersion: host.activeVersion,
      contracts: { valid: 0, invalid: 0, repaired: 0, byName: {} },
      reclassified: [],
      requirements: [],
      nextDecision: { error: `current describe() failed: ${JSON.stringify(described.observation)}` },
      notCovered: ["a dispatch's reference id sets are not stamped on evidence; reference replay is shape-only, not membership"],
    };
  }
  const definition = described.value;

  const reclassifiedEvidence = recorded.evidence.map((record) => reclassify(definition, record));
  const reclassified: ReclassifiedRecord[] = [];
  for (let i = 0; i < recorded.evidence.length; i += 1) {
    const before = recorded.evidence[i]!;
    const after = reclassifiedEvidence[i]!;
    if (before.kind !== after.kind || before.contract?.status !== after.contract?.status) {
      reclassified.push({ ref: after.ref, before: before.kind, after: after.kind, ...(after.contract !== undefined ? { contract: after.contract } : {}) });
    }
  }

  const receiptedRequirements = new Set(recorded.receipts.filter((r) => r.valid).map((r) => r.requirementId));
  const requirements: ReplayRequirementResult[] = [];
  if (host.evaluate !== undefined) {
    for (const requirement of requirementsFor(definition)) {
      const binding = definition.defaultValidators.find((v) => v.requirementId === requirement.id);
      if (binding === undefined) continue;
      const result = await host.evaluate(ctx, binding.validatorId, {
        requirementId: requirement.id,
        statement: requirement.statement,
        evidence: reclassifiedEvidence,
        ...(recorded.candidateDigest !== undefined ? { candidateDigest: recorded.candidateDigest } : {}),
      });
      requirements.push({
        requirementId: requirement.id,
        hadReceipt: receiptedRequirements.has(requirement.id),
        now: result.ok ? result.value : { status: "inconclusive", reason: `current validator ${binding.validatorId} failed: ${JSON.stringify(result.observation)}` },
      });
    }
  }

  const replayedState: DurableRunState = { ...recorded, definition, evidence: reclassifiedEvidence };
  const view = toRunView(replayedState);
  let nextDecision: ReplayReport["nextDecision"];
  try {
    const decided = await host.advance(ctx, view);
    nextDecision = decided.ok ? { decision: decided.value } : { error: `current advance() failed: ${JSON.stringify(decided.observation)}` };
  } catch (err) {
    nextDecision = { error: err instanceof Error ? err.message : String(err) };
  }

  return {
    activeVersion: host.activeVersion,
    contracts: contractSummary(reclassifiedEvidence),
    reclassified,
    requirements,
    nextDecision,
    notCovered: [
      "a dispatch's reference id sets are not stamped on evidence; reference replay is shape-only, not membership (§3.3)",
      "command and file/workspace evidence is replayed unchanged; only agent results are reclassified",
    ],
  };
}
