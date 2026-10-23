import type { ExecutorInputShape, ExecutorSession, JobSpec, ToolCallRequest, ToolCallResult } from "@graphloom/sdk";

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

/**
 * Where a confined job may write: these paths and nothing else on the host
 * (plus a private /tmp). Reads stay open so toolchains and their caches work.
 * The runner enforces it for executors that run with the user's permissions
 * and refuses the job where it cannot.
 */
export interface JobConfinement {
  /** Run-scoped temp and cache directory; user-level state (TMPDIR, GOCACHE, ...) points into it. */
  scratchDir: string;
  /** Other paths the job may write, e.g. its worktree. */
  writablePaths: readonly string[];
  /** Paths outside `writablePaths` the job still reads, such as a worktree's shared repository directory. */
  readPaths?: readonly string[];
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
  /** Present for a job that must not write outside the run's scope. */
  confinement?: JobConfinement;
  /** Serve the job's executor from a repaired run-local copy instead of the installed package. */
  executorSource?: ExecutorSourceOverride;
  /** Where the job's agent may keep a resumable session, and the session to continue. */
  session?: ExecutorSession;
  /**
   * The job's declared result contract, resolved by the controller from the
   * run's GraphDefinition.resultContracts (the name the controller was never
   * given by anyone but the plugin). Forwarded to ExecutorContext for a
   * coding-agent executor to constrain and validate structured output with;
   * a runner that has no opinion about it just passes it through.
   */
  resultContract?: {
    name: string;
    schema: Record<string, unknown>;
    references?: string[];
    knownReferences?: Record<string, import("@graphloom/sdk").ReferenceSet>;
  };
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
  /**
   * The executor declares this failure transient: the controller may run the
   * same job again, unchanged, up to this many consecutive times (waiting
   * `retryAfterMs`, or an exponential backoff, between tries) before the
   * failure reaches recovery. Omitted means the failure is not retryable.
   */
  retryLimit?: number;
  /** The job's agent session, which a later job may continue. */
  sessionRef?: string;
  /**
   * Coarse reason category a recovery trigger can read instead of parsing
   * `summary`. "contract_violation": the job failed after its agent could
   * not produce a result satisfying its declared contract within the
   * in-turn correction bound. "quota": the executor's harness refused the
   * work until its usage allowance renews (`resetAt`, when it said when). A
   * waiting condition of the environment, not something recovery can fix.
   */
  failureKind?: "contract_violation" | "quota";
  /** With `failureKind: "quota"`: the absolute time (ISO 8601) the allowance renews, when the executor knows it. */
  resetAt?: string;
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
  /** The executor's declared input shape, passed through as data; absent when it declares none or could not be read. */
  inputShape?: ExecutorInputShape;
}

export interface Runner {
  runJob(job: JobSpec, ctx: JobContext): Promise<JobResult>;
  /** Executors this runner (and its fallbacks) serve, for pinning at intake and checking on resume. */
  describeExecutors?(): Promise<ExecutorDescriptor[]>;
  /**
   * Whether the job's executor would refuse the job before running it: its
   * pinned version, declared effect, or input schema, exactly as the executor
   * would check them at run time. Returns the executor's refusal, or
   * undefined when it would accept the job or this runner cannot tell (an
   * executor it does not serve, a check that could not be made). With
   * `confinement`, it also refuses a job this runner cannot confine, or whose
   * input names a change outside the confinement. Runs no
   * executor code beyond the executor's own declared schema, and no job.
   */
  checkJob?(job: JobSpec, ctx?: Pick<JobContext, "executorSource" | "confinement">): Promise<string | undefined>;
}
