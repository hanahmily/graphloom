// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { writeScopeProblem, type ActivateRepairSpec, type GraphDecision, type QualifyRepairSpec } from "@graphloom/sdk";
import type { AdmissionFacts } from "@graphloom/supervisor";
import { supervisorProposalKey, progressMark } from "./escalation.js";
import { manifestRepairContract } from "./intake.js";
import { noteOutcome } from "./settlement.js";
import type { DurableRunState, SupervisorOutcomeRecord } from "./state.js";

/**
 * Inadmissible supervisor proposals one decide() turn may make before the
 * controller ends the episode with the trigger's safe default.
 */
export const MAX_INADMISSIBLE_PER_TURN = 3;

/** Durable supervisor outcomes kept for the operator; older ones are dropped. */
const MAX_OUTCOMES = 20;

/**
 * A proposal whose precondition fails. Unlike a blocking outcome (budget
 * exhausted, operator stop, unrecoverable host failure), it never stops a run
 * in recovery by itself: the supervisor is told and proposes again.
 */
export interface Inadmissible {
  /** The failed precondition, stable across runs (also the stop reason a graph-authored decision gets). */
  precondition: string;
  /** The current value that fails it. */
  detail: string;
}

export function describeInadmissible(refusal: Inadmissible): string {
  return `${refusal.precondition}: ${refusal.detail}`;
}

/**
 * Settle an inadmissible decision found at admission. In recovery the run
 * keeps running and the supervisor's next turn opens with the rejection; a
 * graph-authored decision in normal mode still stops, since no supervisor
 * proposed it.
 */
export function inadmissible(
  state: DurableRunState,
  refusal: Inadmissible,
  stop: Partial<Pick<DurableRunState, "stopEvidenceRefs">> = {},
): DurableRunState {
  if (state.mode !== "recovery") {
    return { ...state, ...stop, status: "stopped", stopReason: refusal.precondition, blocker: refusal.detail };
  }
  const reason = describeInadmissible(refusal);
  const noted = noteOutcome(state, `inadmissible, not applied: ${reason}`);
  return recordSupervisorOutcome(noted, { outcome: "inadmissible", rejections: [reason], applied: "recovery" });
}

export function recordSupervisorOutcome(
  state: DurableRunState,
  record: Omit<SupervisorOutcomeRecord, "at" | "episodeId" | "triggerCode">,
): DurableRunState {
  const entry: SupervisorOutcomeRecord = {
    at: new Date().toISOString(),
    ...(state.recoveryEpisodeId !== undefined ? { episodeId: state.recoveryEpisodeId } : {}),
    ...(state.recoveryTrigger !== undefined ? { triggerCode: state.recoveryTrigger.code } : {}),
    ...record,
  };
  return { ...state, supervisorOutcomes: [...(state.supervisorOutcomes ?? []), entry].slice(-MAX_OUTCOMES) };
}

/** What the supervisor's tools may offer this turn. Admission stays the authority. */
export function admissionFacts(state: DurableRunState, hasRepairHooks: boolean): AdmissionFacts {
  return {
    inRecovery: state.mode === "recovery",
    canQualify: state.mode === "recovery" && hasRepairHooks && state.budgets.corrections > 0 && repairGranted(state),
    qualifiedArtifactIds: (state.repairCandidates ?? []).filter((c) => c.status === "qualified").map((c) => c.artifactId),
  };
}

/** Some repair target the operator granted and the bundle permits. */
function repairGranted(state: DurableRunState): boolean {
  const { grants } = state.intake;
  const opaque = manifestRepairContract(state.intake.bundle.manifestRaw) === "opaque";
  return (grants.sourceRepair && !opaque) || grants.validatorSubstitution || grants.executorRepair === true;
}

export function returnRefusal(state: DurableRunState): Inadmissible | undefined {
  if (state.mode === "recovery") return undefined;
  return { precondition: "return outside recovery", detail: `the run is in ${state.mode} mode` };
}

/** Preconditions of `activate_repair` that state alone decides; activation rechecks digests on disk. */
export function activateRefusal(
  state: DurableRunState,
  activate: ActivateRepairSpec,
  hasRepairHooks: boolean,
): Inadmissible | undefined {
  if (state.mode !== "recovery") {
    return { precondition: "activate_repair outside recovery", detail: `the run is in ${state.mode} mode` };
  }
  if (!hasRepairHooks) {
    return { precondition: "activate_repair requires repair hooks", detail: "this controller has no repair hooks configured" };
  }
  const candidates = state.repairCandidates ?? [];
  const artifact = candidates.find((c) => c.artifactId === activate.qualifiedArtifactId);
  const qualified = candidates.filter((c) => c.status === "qualified").map((c) => c.artifactId);
  const others = `qualified candidates: ${qualified.length > 0 ? qualified.join(", ") : "none"}; active version is ${state.activeVersion}`;
  if (artifact === undefined) {
    return {
      precondition: "activate_repair missing qualified artifact",
      detail: `no repair candidate ${activate.qualifiedArtifactId}; ${others}`,
    };
  }
  if (artifact.status !== "qualified") {
    return {
      precondition: "activate_repair missing qualified artifact",
      detail: `${artifact.artifactId} is \`${artifact.status}\`, not \`qualified\`; ${others}`,
    };
  }
  if (artifact.target !== "executor" && artifact.baseActiveVersion !== state.activeVersion) {
    return {
      precondition: "activate_repair base version mismatch",
      detail: `${artifact.artifactId} was qualified against ${artifact.baseActiveVersion}; active version is ${state.activeVersion}`,
    };
  }
  if (artifact.target !== "executor" && !artifact.candidateDigest) {
    return { precondition: "activate_repair missing candidate digest", detail: `${artifact.artifactId} has no reviewed candidate digest` };
  }
  return undefined;
}

/** Preconditions of `qualify_repair` the supervisor can act on; controller configuration faults stay blocking. */
export function qualifyRefusal(
  state: DurableRunState,
  qualify: QualifyRepairSpec,
  hasRepairHooks: boolean,
): Inadmissible | undefined {
  if (state.mode !== "recovery") {
    return { precondition: "qualify_repair outside recovery", detail: `the run is in ${state.mode} mode` };
  }
  if (!hasRepairHooks) {
    return { precondition: "qualify_repair requires repair hooks", detail: "this controller has no repair hooks configured" };
  }
  if (qualify.requirementId !== undefined && !state.definition.requirements.some((r) => r.id === qualify.requirementId)) {
    return { precondition: "qualify_repair rejected", detail: `requirement ${qualify.requirementId} is not pinned by this run` };
  }
  const opaque = opaqueGateRefusal(state, qualify);
  if (opaque !== undefined) return { precondition: "opaque gate", detail: opaque };
  const grants = state.intake.grants;
  const grant =
    qualify.target === "plugin"
      ? { ok: grants.sourceRepair, name: "sourceRepair" }
      : qualify.target === "validator"
        ? { ok: grants.validatorSubstitution, name: "validatorSubstitution" }
        : { ok: grants.executorRepair === true, name: "executorRepair" };
  if (!grant.ok) {
    return { precondition: "qualify_repair missing operator grant", detail: `${grant.name} grant is false` };
  }
  return undefined;
}

/**
 * Why an opaque bundle cannot take this repair, or undefined when it can.
 * Its code is never patched; a validator may be substituted only under the
 * operator's grant, for a requirement the manifest pins readably.
 */
export function opaqueGateRefusal(state: DurableRunState, qualify: QualifyRepairSpec): string | undefined {
  if (qualify.target === "executor") return undefined;
  if (manifestRepairContract(state.intake.bundle.manifestRaw) !== "opaque") return undefined;
  if (qualify.target === "plugin") {
    return "the graph bundle is opaque: its code cannot be patched";
  }
  if (!state.intake.grants.validatorSubstitution) {
    return "the graph bundle is opaque and validator substitution is not authorized";
  }
  if (qualify.requirementId === undefined) {
    return "validator substitution on an opaque bundle must name the disputed requirement";
  }
  const pinned = (JSON.parse(state.intake.bundle.manifestRaw) as { requirements?: unknown }).requirements;
  const readable =
    Array.isArray(pinned) &&
    pinned.some(
      (r: unknown) =>
        typeof r === "object" &&
        r !== null &&
        (r as { id?: unknown }).id === qualify.requirementId &&
        typeof (r as { statement?: unknown }).statement === "string" &&
        ((r as { statement: string }).statement).trim() !== "",
    );
  if (!readable) {
    return `requirement ${qualify.requirementId} has no readable statement pinned in the manifest`;
  }
  return undefined;
}

/** The same proposal a 3rd time with no progress since: the tools refuse it in-turn, and so does admission. */
export function repeatRefusal(state: DurableRunState, triggerCode: string, decision: GraphDecision): Inadmissible | undefined {
  const entries = state.repeatedProposals?.mark === progressMark(state) ? state.repeatedProposals.entries : {};
  const already = entries[supervisorProposalKey(triggerCode, decision.action)]?.count ?? 0;
  if (already + 1 < 3) return undefined;
  return {
    precondition: "repeated no-progress proposal",
    detail: `this exact ${decision.action.type} proposal would be the ${already + 1 === 3 ? "3rd" : `${already + 1}th`} with no progress since the controller last checked; propose something that would change the outcome, or stop`,
  };
}

/**
 * Triggers whose cause a plain `return` reproduces: the graph cannot make
 * progress on its own, so the safe default after inadmissible proposals is to stop.
 */
const RETURN_REPRODUCES_TRIGGER = new Set([
  "plugin_crash",
  "plugin_timeout",
  "plugin_malformed",
  "environment_changed",
  "correction_limit",
  "stalled",
  "recovery_budget_reached",
]);

/**
 * The trigger's safe default after a turn of inadmissible proposals: hand
 * control back to the graph when it can still dispatch, otherwise stop.
 */
export function safeDefault(state: DurableRunState, triggerCode: string): "return" | "stop" {
  const canDispatch =
    state.mode === "recovery" &&
    !RETURN_REPRODUCES_TRIGGER.has(triggerCode) &&
    state.environmentBlock === undefined &&
    state.budgets.jobs > 0 &&
    state.budgets.decisions > 0;
  return canDispatch ? "return" : "stop";
}

/** Why a checkout spec is malformed, or undefined. The job-level rules (read-only command, no tools) are the caller's. */
export function checkoutSpecRefusal(checkout: unknown): string | undefined {
  if (typeof checkout !== "object" || checkout === null) return "checkout must be an object";
  const spec = checkout as { from?: unknown; paths?: unknown };
  if (spec.from === "candidate") return spec.paths === undefined ? undefined : "a candidate checkout takes no paths";
  if (spec.from !== "base") return `checkout.from must be "candidate" or "base"`;
  if (!Array.isArray(spec.paths) || spec.paths.length === 0 || !spec.paths.every((p) => typeof p === "string")) {
    return "a base checkout must list the changed paths to apply";
  }
  const problem = writeScopeProblem(spec.paths as string[]);
  return problem === undefined ? undefined : `checkout paths: ${problem}`;
}

/** Step ids for a refusal: `inv-1..inv-7` when they run without a gap, else listed. */
function stepList(ids: ReadonlySet<string>): string {
  const numbers = [...ids].map((id) => Number(id.slice(4))).filter((n) => Number.isSafeInteger(n)).sort((a, b) => a - b);
  if (numbers.length > 2 && numbers.every((n, i) => n === numbers[0]! + i)) return `inv-${numbers[0]}..inv-${numbers.at(-1)}`;
  return numbers.map((n) => `inv-${n}`).join(", ");
}

/** Supervisor proposals that assert a fault must say what shows it. */
const CITATION_BLAME_TARGETS: ReadonlySet<string> = new Set(["validator", "executor"]);

/**
 * A supervisor's `stop`, `reenter`, or `qualify_repair` that blames a
 * validator or executor is admissible only with a citation: an evidence ref
 * recorded in this run, a probe that ran in this episode, or an investigation
 * step (`inv-<n>`) the episode observed. Every citation must resolve,
 * whatever the action. A step shows code or the environment, never what the
 * controller or a validator does, so a `stop` or a validator- or
 * executor-blaming `qualify_repair` must also cite a probe or recorded
 * evidence (design-supervisor-harnesses.md §5.3).
 */
export function groundingRefusal(
  state: DurableRunState,
  decision: GraphDecision,
  probeIds: ReadonlySet<string>,
  stepIds: ReadonlySet<string> = new Set(),
): Inadmissible | undefined {
  const { action } = decision;
  const own =
    action.type === "stop"
      ? action.stop.evidenceRefs
      : action.type === "reenter"
        ? action.reenter.evidenceRefs
        : action.type === "qualify_repair"
          ? action.qualify.evidenceRefs
          : undefined;
  // A citation list that is not an array of strings is returned for correction, not thrown at the loop.
  for (const [name, list] of [["evidence", decision.evidence], ["evidenceRefs", own]] as const) {
    if (list !== undefined && (!Array.isArray(list) || !list.every((ref) => typeof ref === "string"))) {
      return { precondition: `${action.type} cites malformed evidence`, detail: `${name} must be an array of evidence refs or probe ids` };
    }
  }
  const cited = [...(decision.evidence ?? []), ...(own ?? [])];
  const known = new Set(state.evidence.map((e) => e.ref));
  const unknown = cited.filter((ref) => !known.has(ref) && !probeIds.has(ref) && !stepIds.has(ref));
  if (unknown.length > 0) {
    const steps = stepIds.size > 0 ? `; investigation steps this episode: ${stepList(stepIds)}` : "";
    return {
      precondition: `${action.type} cites unknown evidence`,
      detail: `${unknown.join(", ")} is neither recorded evidence in this run nor a probe that ran in this episode${stepIds.size > 0 ? " nor one of its investigation steps" : ""}; probes this episode: ${probeIds.size > 0 ? [...probeIds].join(", ") : "none"}${steps}`,
    };
  }
  const blames = action.type === "qualify_repair" && CITATION_BLAME_TARGETS.has(action.qualify.target);
  const needsCitation = action.type === "stop" || action.type === "reenter" || blames;
  if (needsCitation && cited.length === 0) {
    return {
      precondition: `${action.type} requires cited evidence`,
      detail:
        "list in evidence the evidence refs (list_evidence, get_evidence) or probe ids (check_validate, check_activation, check_checkout) from this episode that show why; check before you claim",
    };
  }
  if ((action.type === "stop" || blames) && cited.every((ref) => stepIds.has(ref) && !known.has(ref) && !probeIds.has(ref))) {
    const claim = action.type === "qualify_repair" ? `a qualify_repair blaming the ${action.qualify.target}` : "a stop";
    return {
      precondition: `${action.type} rests on investigation steps alone`,
      detail: `${cited.join(", ")} show code or the environment, not what the controller or a validator does; ${claim} must also cite a GraphLoom probe or recorded evidence (cite check_validate for a claim about validation)`,
    };
  }
  return undefined;
}
