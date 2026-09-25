import type { GraphDecision, RepairTarget, RunView } from "@graphloom/sdk";

/** Why the controller entered recovery for this episode. */
export interface RecoveryTrigger {
  code:
    | "supervise"
    | "plugin_crash"
    | "plugin_timeout"
    | "plugin_malformed"
    | "executor_failed"
    | "stalled"
    | "unhandled";
  message: string;
}

export interface SupervisorInput {
  runId: string;
  episodeId: string;
  trigger: RecoveryTrigger;
  view: RunView;
}

/**
 * Run-wide recovery decision source.
 * Implementations may be scripted (CI) or Pi-backed (live).
 * One logical session identity is reused for every repair round in a run.
 */
export interface Supervisor {
  decide(input: SupervisorInput): Promise<GraphDecision>;
  close?(): Promise<void>;
  /**
   * Optional: settle provider/model calls spent during the last decide turn(s).
   * Controller deducts from agentInvocations when present.
   */
  drainProviderCalls?(): number;
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
  /** Provider calls the controller reserved for this patch; stop before exceeding it. */
  maxProviderCalls?: number;
}

export type ScriptedRecoveryStep =
  | GraphDecision
  | ((input: SupervisorInput, index: number) => GraphDecision | Promise<GraphDecision>);

export interface ScriptedSupervisorOptions {
  decisions: ScriptedRecoveryStep[];
  /** Stable id reused across every repair round (default: scripted-supervisor). */
  sessionId?: string;
  /** Canned candidate patch; requires an active candidate coding grant. */
  patch?: (args: CandidatePatchRequest) => Promise<{ summary: string }>;
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
    async decide(input: SupervisorInput): Promise<GraphDecision> {
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
