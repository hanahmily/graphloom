import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceRecord,
  GraphDefinition,
  JobSpec,
  OutstandingOperation,
  Receipt,
  StageAttempt,
  ValidatorBinding,
} from "@graphloom/sdk";
import type { IntakePin } from "./intake.js";
import { withDirectoryLock } from "./lock.js";

export type RunStatus = "running" | "succeeded" | "stopped" | "failed";

export interface PendingDispatch {
  operationId: string;
  generation: number;
  stageId: string;
  job: JobSpec;
  /** `waiting` until the job is handed to the runner after `notBefore`; then `pending`. */
  status: "waiting" | "pending" | "completed" | "failed";
  /** Durable pin recorded at admission (before effects). */
  executor?: import("@graphloom/sdk").ExecutorPin;
  /** Model requests the job reserved against the run's agent-invocation budget. */
  modelCalls?: number;
  /** The job starts no earlier than this (an executor asked for a wait before retrying). */
  notBefore?: string;
  /** Session directory given to an agent job, and the session it continues. */
  session?: import("@graphloom/sdk").ExecutorSession;
}

/**
 * An agent session a settled dispatch returned. A later dispatch of the same
 * stage and dispatch key may continue it with `continueFrom`.
 */
export interface AgentSessionRecord {
  operationId: string;
  stageId: string;
  attempt: number;
  generation: number;
  dispatchKey: string;
  executorId: string;
  status: "ok" | "failed" | "conflict";
  /** Executor-defined identity of the saved session inside `sessionDir`. */
  sessionRef: string;
  sessionDir: string;
  continuedFrom?: string;
  settledAt: string;
}

/**
 * An executor the run pinned at intake: identity plus the digest of the code
 * it runs. Dispatches carry the digest, and resume checks it still matches.
 */
export interface ExecutorCatalogEntry {
  id: string;
  digest: string;
  /** Package root, module file, or `in-process` the digest covers. */
  source: string;
  /** Present when `source` is a package root that can be copied for repair. */
  entryModule?: string;
  isolation: "sandbox" | "unrestricted" | "in-process";
  builtin: boolean;
  /** Set once a qualified repair of this executor's package is activated; `digest` is then the copy's. */
  repair?: { artifactId: string; root: string; entryModule: string; baseDigest: string };
}

/**
 * A tool call an agent job made, admitted as a child operation. Recorded
 * before the child runs; settled results are replayed for the same stage
 * attempt and tool-call id instead of running again.
 */
export interface ChildOperationRecord {
  childOperationId: string;
  parentOperationId: string;
  toolCallId: string;
  tool: string;
  stageId: string;
  attempt: number;
  generation: number;
  executor: import("@graphloom/sdk").ExecutorPin;
  effect: import("@graphloom/sdk").ExecutorEffect;
  input: unknown;
  /**
   * `fenced`: settled after the run stopped or the parent ended; not delivered.
   *   Keeps `result` when the child finished, so a retry replays it.
   * `abandoned`: a read interrupted by a crash; the call may run again.
   * `ambiguous`: a write interrupted by a crash or stop; never replayed.
   */
  status: "pending" | "ok" | "failed" | "conflict" | "fenced" | "abandoned" | "ambiguous";
  result?: import("@graphloom/sdk").ToolCallResult;
  admittedAt: string;
  settledAt?: string;
}

export interface DurableRunState {
  runId: string;
  status: RunStatus;
  stopReason?: string;
  blocker?: string;
  generation: number;
  stateRevision: number;
  activeVersion: string;
  mode: "normal" | "recovery";
  current: StageAttempt;
  receipts: Receipt[];
  evidence: EvidenceRecord[];
  outstanding: OutstandingOperation[];
  pendingDispatch?: PendingDispatch;
  childOperations?: ChildOperationRecord[];
  agentSessions?: AgentSessionRecord[];
  /** Executors pinned at intake (absent for runs whose runner cannot describe its executors). */
  executorCatalog?: ExecutorCatalogEntry[];
  /** Earliest time each executor may run again, from a failure's retry timing. */
  executorRetryAt?: Record<string, string>;
  privateState?: string;
  definition: GraphDefinition;
  validatorBindings: ValidatorBinding[];
  budgets: IntakePin["budgets"];
  intake: IntakePin;
  worktreePath: string;
  worktreeBranch: string;
  artifactDir: string;
  stateDir: string;
  sourceDirtyBefore: string[];
  evidenceSeq: number;
  receiptSeq: number;
  /** Hash of last Observe workspace snapshot; Validate must match live worktree. */
  workspaceRevision?: string;
  /** Last successful work-purpose dispatch; used for separate-reviewer checks. */
  lastWorkOperationId?: string;
  /** Recorded active-version transitions (intake + generation fences). */
  versionHistory: VersionRecord[];
  /** Active recovery episode when mode is recovery. */
  recoveryEpisodeId?: string;
  /** Why the controller entered the current recovery episode. */
  recoveryTrigger?: {
    code: string;
    message: string;
  };
  /**
   * Durable Pi supervisor session identity (session file + active model).
   * On resume, when no supervisor is supplied, the controller restores from
   * this binding (see ResumeRequest.restoreSupervisor / default Pi restore).
   */
  supervisorBinding?: {
    sessionId: string;
    sessionFile?: string;
    provider: string;
    modelId: string;
    switchJournal: Array<{
      at: string;
      from: { provider: string; modelId: string };
      to: { provider: string; modelId: string };
      reason: string;
      status: "intent" | "committed" | "failed";
      error?: string;
    }>;
    configuredModels?: Array<{ provider: string; modelId: string }>;
  };
  /**
   * The supervisor's last proposal and the run as it stood when it was taken.
   * The next recovery prompt opens with what changed since (the settlement).
   */
  supervisorMark?: SupervisorMark;
  /** Isolated repair candidates for this run (never the live install). */
  repairCandidates?: import("./repair.js").QualifiedRepairArtifact[];
  /** Crash-safe activation journal; cleared after successful switch. */
  activationIntent?: {
    artifactId: string;
    fromVersion: string;
    toVersion: string;
    generation: number;
    at: string;
    status: "intent" | "committed" | "aborted";
  };
}

export interface SupervisorMark {
  action: string;
  reason: string;
  episodeId?: string;
  stageId: string;
  attempt: number;
  generation: number;
  evidenceRefs: string[];
  receiptIds: string[];
  candidates: Record<string, string>;
  /** Outcomes the controller recorded directly, such as a refused model switch. */
  notes: string[];
}

export interface VersionRecord {
  activeVersion: string;
  generation: number;
  reason: string;
  at: string;
}

export async function saveRunState(state: DurableRunState): Promise<void> {
  await withDirectoryLock(state.stateDir, "state.lock", async () => {
    await mkdir(state.stateDir, { recursive: true });
    const target = path.join(state.stateDir, "state.json");
    const tmp = path.join(state.stateDir, `state.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
    // Best-effort sync of the directory entry after rename.
    const dir = await open(state.stateDir, "r");
    try {
      await dir.sync();
    } catch {
      /* some FS do not support directory fsync */
    } finally {
      await dir.close();
    }
  });
}

export async function loadRunState(stateDir: string): Promise<DurableRunState> {
  return withDirectoryLock(stateDir, "state.lock", async () => {
    const raw = await readFile(path.join(stateDir, "state.json"), "utf8");
    return JSON.parse(raw) as DurableRunState;
  });
}

export async function removeStaleTmp(stateDir: string): Promise<void> {
  // no-op helper reserved for cleanup hooks
  void unlink;
}
