import type { JobSpec } from "@graphloom/sdk";

export interface JobContext {
  runId: string;
  operationId: string;
  generation: number;
  worktreePath: string;
  /** Absolute path for immutable run artifacts (outside worktree). */
  artifactDir: string;
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
