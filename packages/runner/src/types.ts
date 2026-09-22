import type { JobSpec } from "@graphloom/sdk";

export interface JobContext {
  runId: string;
  generation: number;
  worktreePath: string;
  /** Absolute path for immutable run artifacts (outside worktree). */
  artifactDir: string;
}

export interface JobResult {
  status: "ok" | "failed" | "conflict";
  summary: string;
  /** Optional evidence payloads for the controller to record (e.g. review verdict). */
  evidence?: Array<{
    kind: "file" | "command" | "workspace" | "review" | "other";
    payload?: unknown;
    fingerprint?: string;
  }>;
}

export interface Runner {
  runJob(job: JobSpec, ctx: JobContext): Promise<JobResult>;
}
