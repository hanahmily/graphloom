import path from "node:path";
import { BUILTIN_AGENT_EXECUTOR_ID, pinJobExecutor, type JobSpec } from "@graphloom/sdk";
import { createBuiltinExecutorRunner, type JobResult, type Runner } from "@graphloom/runner";
import {
  CODING_AGENT_RUN_ID,
  claudeCodeHarnessModule,
  codingAgentBinding,
  codingAgentExecutorPackage,
  piHarnessModule,
} from "@graphloom/executor-coding-agent";
import type { RunnerConfig } from "./runner-config.js";

const REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: { verdict: { type: "string", enum: ["approved", "request_changes"] }, summary: { type: "string" } },
  required: ["verdict", "summary"],
  additionalProperties: false,
});

/** Keep the controller's executor pin, tools, budget port and session unchanged. */
export function createCliRunner(config: RunnerConfig | undefined): Runner {
  const fallback: Runner = {
    async runJob(job, ctx) {
      return {
        status: "failed",
        summary: config === undefined
          ? "CLI agent runner is not configured; set GRAPHLOOM_RUNNER_CONFIG or ~/.config/graphloom/runner.json with a harness and allowUnrestricted: true"
          : `CLI runner does not serve executor ${job.executor?.id ?? job.kind}`,
        runId: ctx.runId,
        operationId: ctx.operationId,
        generation: ctx.generation,
      };
    },
  };
  if (config === undefined) return fallback;
  if (config.allowUnrestricted !== true) throw new Error("CLI runner requires allowUnrestricted: true");
  const child = createBuiltinExecutorRunner({
    packages: [{
      manifest: {
        ...codingAgentExecutorPackage,
        entryModule: path.join(path.dirname(codingAgentExecutorPackage.entryModule), "legacy-executors.js"),
        executorIds: [CODING_AGENT_RUN_ID, BUILTIN_AGENT_EXECUTOR_ID],
      },
      ...codingAgentBinding({
        harness: config.harness === "claude-code" ? claudeCodeHarnessModule : piHarnessModule,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.claude !== undefined ? { claude: config.claude } : {}),
        ...(config.pi !== undefined ? { pi: config.pi } : {}),
      }),
    }],
    fallback,
  });
  return {
    describeExecutors: () => child.describeExecutors!(),
    async runJob(job, ctx) {
      const pinned = pinJobExecutor(job);
      const id = pinned.executor!.id;
      if (id !== BUILTIN_AGENT_EXECUTOR_ID && id !== CODING_AGENT_RUN_ID) return fallback.runJob(pinned, ctx);
      const legacy = id === BUILTIN_AGENT_EXECUTOR_ID;
      const input = legacy
        ? { assignment: pinned.instruction, ...(pinned.resultSchema !== undefined ? { resultSchema: pinned.resultSchema } : {}) }
        : object(pinned.input);
      const review = pinned.purpose === "review" && input?.resultSchema === "review-verdict-v1";
      const adapted: JobSpec = {
        ...pinned,
        ...(legacy || review ? { input: { ...input, ...(review ? { resultSchema: REVIEW_SCHEMA } : {}) } } : {}),
      };
      const result = await child.runJob(adapted, ctx);
      return review ? reviewEvidence(result) : result;
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only the reviewer's structured result can supply a verdict; prose is never an approval. */
function reviewEvidence(result: JobResult): JobResult {
  if (result.status !== "ok") return result;
  const output = result.evidence?.map((e) => object(object(e.payload)?.codingAgent)?.output).find((v) => v !== undefined);
  const verdict = object(output);
  if ((verdict?.verdict !== "approved" && verdict?.verdict !== "request_changes") || typeof verdict.summary !== "string") {
    return { ...result, status: "failed", summary: "reviewer did not return a valid structured review-verdict-v1 result" };
  }
  return {
    ...result,
    evidence: [...(result.evidence ?? []), { kind: "review", payload: { verdict: verdict.verdict, summary: verdict.summary } }],
  };
}
