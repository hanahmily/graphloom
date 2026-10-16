import type { CaseFile, CaseFinding, CaseFindingOutcome, GraphDecision, RepairTarget, RunView } from "@graphloom/sdk";
import type { ProviderFailureClass } from "./provider-failure.js";

/** Why the controller entered recovery for this episode. */
export interface RecoveryTrigger {
  code:
    | "supervise"
    | "plugin_crash"
    | "plugin_timeout"
    | "plugin_malformed"
    | "executor_failed"
    | "stalled"
    | "correction_limit"
    | "environment_changed"
    | "contract_violation"
    | "recovery_budget_reached"
    | "unhandled";
  message: string;
  /** Recorded evidence the escalation cites, such as the failing validation's inputs. */
  evidenceRefs?: string[];
}

export interface SupervisorInput {
  runId: string;
  episodeId: string;
  trigger: RecoveryTrigger;
  view: RunView;
  /** What the controller settled for the supervisor's previous proposal in this run. */
  lastSettlement?: SupervisorSettlement;
  /** Provider calls this turn may spend; a turn beyond it is aborted before its request. */
  maxProviderCalls?: number;
  /**
   * Milliseconds of the run's wait budget this turn may spend waiting out a
   * provider quota reset. Omitted means no wait is allowed. Waits spent are
   * reported through `drainRemedies` for the controller to charge.
   */
  maxWaitMs?: number;
  /**
   * The live part of the controller's case file: facts and refutations whose
   * candidate digest and active plugin version still hold, the controller's
   * settled attempts, and open questions. It is the supervisor's only memory
   * of earlier episodes; each episode starts a fresh model session.
   */
  caseFile?: CaseFile;
  /**
   * Submit a finding to the case file. The controller keeps a fact or a
   * refutation only when every evidence ref it cites exists, and says why
   * otherwise. Does not end the turn.
   */
  recordFinding?: (finding: CaseFinding) => Promise<CaseFindingOutcome>;
  /** Aborted when the run stops; the session aborts its request and settles idle. */
  signal?: AbortSignal;
  /**
   * The controller's admission, offered for this turn: state facts that narrow
   * the action tools, and a pre-admission check. A supervisor that uses it
   * returns an inadmissible proposal to the model within the same decide().
   */
  admission?: SupervisorAdmission;
  /**
   * Set when the controller re-asks within the same turn because the previous
   * proposal was inadmissible (for supervisors that did not run the check
   * themselves). Nothing in the run changed since that proposal.
   */
  rejection?: SupervisorRejection;
}

/** What the controller can tell a supervisor before admission, so tools that cannot hold are not offered. */
export interface AdmissionFacts {
  /** False outside recovery: `return` cannot be admitted. */
  inRecovery: boolean;
  /** False when no qualified repair can be admitted (no repair hooks, grants, or corrections). */
  canQualify: boolean;
  /** Candidates whose status is `qualified`; `activate_repair` needs one. */
  qualifiedArtifactIds: string[];
}

/** An inadmissible proposal, as the controller reports it: the failed precondition and the current value. */
export interface SupervisorRejection {
  action: string;
  reason: string;
  /** Inadmissible proposals still allowed this turn before the controller applies its safe default. */
  remaining: number;
}

/**
 * Pre-admission check. Returns undefined when the proposal would be admitted,
 * otherwise the rejection; `remaining: 0` means the turn is over and the
 * controller applies the trigger's safe default.
 */
export type AdmissionCheck = (decision: GraphDecision) => Promise<SupervisorRejection | undefined>;

export interface SupervisorAdmission {
  facts: AdmissionFacts;
  check: AdmissionCheck;
  /**
   * Charge a rejection the supervisor found itself (malformed spec, bad
   * write scope or continuation, escaping observe path, repeated proposal)
   * against the same per-turn allowance `check` uses; the controller owns
   * the count, and charges each rejection to the run's durable decisions
   * budget before it resolves. Returns the counted rejection.
   */
  refuse(action: string, reason: string): Promise<SupervisorRejection>;
}

/** The controller's outcome for a supervisor proposal, reported on the next turn. */
export interface SupervisorSettlement {
  action: string;
  reason: string;
  /** Concise facts: job results, receipts, candidate status, stage, run status. */
  facts: string[];
}

/**
 * A deterministic remedy the supervisor host applied to a failed provider
 * turn without asking the model what to do: wait out a quota reset and retry,
 * compact and retry after an overflow, retry once in a fresh session after a
 * prompt timed out, or, for an empty or malformed reply, re-ask once, then
 * retry in a fresh session, then retry once on the next configured model.
 */
export interface SupervisorRemedy {
  at: string;
  failureClass: ProviderFailureClass;
  remedy: "wait_and_retry" | "compact_and_retry" | "reask" | "fresh_session_retry" | "model_retry";
  /** The model a `model_retry` ran the turn's next attempt on (this turn only; the binding is unchanged). */
  model?: ModelRef;
  /** The provider's message (or what the reply lacked), bounded. */
  message: string;
  /** Wall-clock milliseconds spent waiting; charged to the run's waitMs. */
  waitedMs?: number;
  /** What a wait followed: the provider's stated reset, or the operator's `quotaRetryMs` fallback. */
  waitBasis?: "provider" | "operator";
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Ask the controller to switch the supervisor's model before its next turn. */
export interface ModelSwitchRequest extends ModelRef {
  type: "switch_model";
  reason: string;
}

/** A supervisor turn yields a graph decision, or a request to change its own model. */
export type SupervisorProposal = GraphDecision | ModelSwitchRequest;

export function isModelSwitchRequest(value: unknown): value is ModelSwitchRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "switch_model" &&
    typeof v.provider === "string" &&
    typeof v.modelId === "string" &&
    typeof v.reason === "string"
  );
}

/**
 * Run-wide recovery decision source.
 * Implementations may be scripted (CI) or Pi-backed (live).
 * One logical supervisor identity is reused for every repair round in a run;
 * a Pi-backed one opens a fresh model session per recovery episode.
 */
export interface Supervisor {
  decide(input: SupervisorInput): Promise<SupervisorProposal>;
  /**
   * Switch the session's model. The controller journals the intent durably
   * before calling this and commits it after; only configured models succeed.
   */
  switchModel?(request: ModelRef & { reason: string }): Promise<void>;
  close?(): Promise<void>;
  /**
   * Optional: settle provider/model calls spent during the last decide turn(s).
   * Controller deducts from agentInvocations when present.
   */
  drainProviderCalls?(): number;
  /**
   * Optional: deterministic remedies the host applied to failed provider
   * turns since the last drain (waits, compactions, re-asks). The controller
   * records them for the operator and charges their waits to `waitMs`.
   */
  drainRemedies?(): SupervisorRemedy[];
  /**
   * Stable session id for this run's supervisor (Pi session id or scripted stand-in).
   * Required for qualified repair so every patch round binds to the same session.
   */
  sessionId?: string;
  /**
   * Grant Pi coding tools scoped to an admitted repair candidate tree.
   * Must not change session identity; revoke after the qualification episode.
   */
  grantCandidateCoding?(candidateRoot: string): Promise<void>;
  revokeCandidateCoding?(): Promise<void>;
  /**
   * Author a qualified repair in the currently granted candidate tree using this
   * same session. Returns a concise user-facing summary, not private reasoning.
   * Provider calls spent here settle through `drainProviderCalls`.
   */
  patchCandidate?(args: CandidatePatchRequest): Promise<{ summary: string }>;
}

export interface CandidatePatchRequest {
  candidateRoot: string;
  target: RepairTarget;
  reason: string;
  /**
   * The independent reviewer's own reason from rejecting the previous round's
   * patch in this same qualification, present from the second round on: fix
   * these specific issues, keeping what the reviewer did not object to.
   */
  reviewFeedback?: string;
  /** Provider calls the controller reserved for this patch; stop before exceeding it. */
  maxProviderCalls?: number;
  /** Aborted when the run stops. */
  signal?: AbortSignal;
}

export type ScriptedRecoveryStep =
  | SupervisorProposal
  | ((input: SupervisorInput, index: number) => SupervisorProposal | Promise<SupervisorProposal>);

export interface ScriptedSupervisorOptions {
  decisions: ScriptedRecoveryStep[];
  /** Stable id reused across every repair round (default: scripted-supervisor). */
  sessionId?: string;
  /** Canned candidate patch; requires an active candidate coding grant. */
  patch?: (args: CandidatePatchRequest) => Promise<{ summary: string }>;
  /** Canned model switch; omitted means the supervisor cannot switch. */
  switchModel?: (request: ModelRef & { reason: string }) => Promise<void>;
}

/** Canned recovery decisions for controller tests (no live LLM). */
export function createScriptedSupervisor(
  options: ScriptedSupervisorOptions,
): Supervisor {
  let index = 0;
  const { decisions } = options;
  const sessionId = options.sessionId ?? "scripted-supervisor";
  let codingRoot: string | undefined;
  return {
    sessionId,
    async decide(input: SupervisorInput): Promise<SupervisorProposal> {
      if (index >= decisions.length) {
        throw new Error(
          `scripted supervisor exhausted: decide called ${index + 1} times, only ${decisions.length} scripted`,
        );
      }
      const step = decisions[index];
      if (step === undefined) {
        throw new Error(`scripted supervisor missing step at index ${index}`);
      }
      const current = index;
      index += 1;
      if (typeof step === "function") {
        return step(input, current);
      }
      return structuredClone(step);
    },
    drainProviderCalls() {
      return 0;
    },
    async grantCandidateCoding(candidateRoot: string) {
      codingRoot = candidateRoot;
    },
    async revokeCandidateCoding() {
      codingRoot = undefined;
    },
    ...(options.patch !== undefined
      ? {
          async patchCandidate(args: CandidatePatchRequest) {
            assertGrantedRoot(codingRoot, args.candidateRoot);
            return options.patch!(args);
          },
        }
      : {}),
    ...(options.switchModel !== undefined ? { switchModel: options.switchModel } : {}),
    /** Test helper: last granted candidate root (undefined when revoked). */
    getCandidateCodingRoot() {
      return codingRoot;
    },
  } as Supervisor & { getCandidateCodingRoot(): string | undefined };
}

/** A patch may only run on the candidate root the controller just granted. */
export function assertGrantedRoot(granted: string | undefined, candidateRoot: string): void {
  if (granted === undefined) {
    throw new Error("patchCandidate requires an active candidate coding grant");
  }
  if (granted !== candidateRoot) {
    throw new Error(`patchCandidate root ${candidateRoot} != granted ${granted}`);
  }
}
