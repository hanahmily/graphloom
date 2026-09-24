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
  status: "pending" | "completed" | "failed";
  /** Durable pin recorded at admission (before effects). */
  executor?: import("@graphloom/sdk").ExecutorPin;
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
  };
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
