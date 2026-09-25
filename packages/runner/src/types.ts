import type { JobSpec, ToolCallRequest, ToolCallResult } from "@graphloom/sdk";

/**
 * Controller services for a running job: admitted tool calls become child
 * operations, and model requests reserve the shared run budget.
 */
export interface ChildOperationPort {
  callTool(request: ToolCallRequest): Promise<ToolCallResult>;
  reserveModelCall(): Promise<boolean>;
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
}

export interface Runner {
  runJob(job: JobSpec, ctx: JobContext): Promise<JobResult>;
}
