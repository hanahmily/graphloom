import type { ExecutorSession, JobSpec, ToolCallRequest, ToolCallResult } from "@graphloom/sdk";

/**
 * Controller services for a running job: admitted tool calls become child
 * operations, and model requests reserve the shared run budget.
 */
export interface ChildOperationPort {
  callTool(request: ToolCallRequest): Promise<ToolCallResult>;
  reserveModelCall(): Promise<boolean>;
}

/**
 * A run-local copy of an executor package that replaces the installed one
 * for this job, after qualified repair. The job's pin must carry the copy's
 * digest; the runner refuses to run it otherwise.
 */
export interface ExecutorSourceOverride {
  /** Package root of the copy. */
  root: string;
  /** Entry module inside `root` exporting `executors`. */
  entryModule: string;
}

export interface JobContext {
  runId: string;
  operationId: string;
  generation: number;
  worktreePath: string;
  /** Absolute path for immutable run artifacts (outside worktree). */
  artifactDir: string;
  /** Aborted when the run stops; runners terminate the job's process. */
  signal?: AbortSignal;
  /** Present for jobs the controller can service tool calls and model usage for. */
  children?: ChildOperationPort;
  /** Serve the job's executor from a repaired run-local copy instead of the installed package. */
  executorSource?: ExecutorSourceOverride;
  /** Where the job's agent may keep a resumable session, and the session to continue. */
  session?: ExecutorSession;
}

export interface JobEvidenceItem {
  kind: "file" | "command" | "workspace" | "review" | "other";
  payload?: unknown;
  fingerprint?: string;
}

export interface JobResult {
  status: "ok" | "failed" | "conflict";
  summary: string;
  /** Must echo the JobContext identity so late results cannot be applied fresh. */
  runId: string;
  operationId: string;
  generation: number;
  /** Optional evidence payloads for the controller to record (e.g. review verdict). */
  evidence?: JobEvidenceItem[];
  /** A failed executor's requested wait before retrying it (e.g. a rate limit). */
  retryAfterMs?: number;
  /** The job's agent session, which a later job may continue. */
  sessionRef?: string;
}

/** An executor a runner serves, identified by the digest of the code it would run. */
export interface ExecutorDescriptor {
  id: string;
  digest: string;
  /** Package root, module file, or `in-process` the digest covers. */
  source: string;
  /** Entry module, when `source` is a package root that can be copied for repair. */
  entryModule?: string;
  isolation: "sandbox" | "unrestricted" | "in-process";
  builtin: boolean;
}

export interface Runner {
  runJob(job: JobSpec, ctx: JobContext): Promise<JobResult>;
  /** Executors this runner (and its fallbacks) serve, for pinning at intake and checking on resume. */
  describeExecutors?(): Promise<ExecutorDescriptor[]>;
}
