import path from "node:path";
import { BUILTIN_AGENT_EXECUTOR_ID, pinJobExecutor, type JobSpec } from "@graphloom/sdk";
import { createBuiltinExecutorRunner, type JobResult, type Runner } from "@graphloom/runner";
import {
  CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS,
  CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS,
  CODEX_DEFAULT_RESPONSE_TIMEOUT_MS,
  CODING_AGENT_RUN_ID,
  DEFAULT_CODING_TIMEOUT_MS,
  claudeCodeHarnessModule,
  codexHarnessModule,
  codingAgentBinding,
  codingAgentExecutorPackage,
  piHarnessModule,
} from "@graphloom/executor-coding-agent";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { enabledHarnesses, type HarnessName, type RunnerConfig } from "./runner-config.js";

const REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { axis: { type: "string" }, severity: { type: "string" }, detail: { type: "string" } },
        required: ["detail"],
        additionalProperties: false,
      },
    },
    productDecision: { type: "string" },
  },
  required: ["verdict", "summary"],
  additionalProperties: false,
});
const WATCHDOGS = [
  ["startupTimeoutMs", CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS],
  ["responseTimeoutMs", CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS],
] as const;
const INSTALLED_HARNESSES: Record<HarnessName, string> = {
  "claude-code": claudeCodeHarnessModule,
  codex: codexHarnessModule,
  pi: piHarnessModule,
};

/**
 * Keep the controller's executor pin, tools, budget port and session unchanged.
 * Agent jobs run on the configured harness, or the one `input.harness` names;
 * command jobs and GitHub reads run in their own built-in executor processes.
 */
export function createCliRunner(
  config: RunnerConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  /** Harness adapter modules to load instead of the installed ones (tests). */
  harnessModules: Partial<Record<HarnessName, string>> = {},
): Runner {
  const fallback: Runner = {
    async runJob(job, ctx) {
      return failure(
        ctx,
        config === undefined
          ? "CLI agent runner is not configured; set GRAPHLOOM_RUNNER_CONFIG or ~/.config/graphloom/runner.json with a harness and allowUnrestricted: true"
          : `CLI runner does not serve executor ${job.executor?.id ?? job.kind}`,
      );
    },
  };
  if (config === undefined) return fallback;
  if (config.allowUnrestricted !== true) throw new Error("CLI runner requires allowUnrestricted: true");
  const agents = new Map<HarnessName, Runner>(
    enabledHarnesses(config).map((harness) => [
      harness,
      createBuiltinExecutorRunner({
        packages: [{
          manifest: {
            ...codingAgentExecutorPackage,
            entryModule: path.join(path.dirname(codingAgentExecutorPackage.entryModule), "legacy-executors.js"),
            executorIds: [CODING_AGENT_RUN_ID, BUILTIN_AGENT_EXECUTOR_ID],
          },
          ...codingAgentBinding({
            harness: harnessModules[harness] ?? INSTALLED_HARNESSES[harness],
            ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            ...(harness === "claude-code" ? { claude: claudeOptions(config) } : {}),
            ...(harness === "codex" ? { codex: codexOptions(config) } : {}),
            ...(config.pi !== undefined ? { pi: config.pi } : {}),
          }),
        }],
        fallback,
      }),
    ]),
  );
  const tokenEnv = config.github?.tokenEnv;
  const token = tokenEnv !== undefined ? env[tokenEnv] : undefined;
  const others = createBuiltinExecutorRunner({
    packages: [
      { manifest: commandExecutorPackage, ...commandBinding(config.command?.timeoutMs !== undefined ? { timeoutMs: config.command.timeoutMs } : {}) },
      ...(config.github !== undefined
        ? [{ manifest: githubExecutorPackage, ...githubBinding(token !== undefined && token !== "" ? { token } : {}) }]
        : []),
    ],
    fallback,
  });
  const defaultAgent = agents.get(config.harness)!;
  return {
    async describeExecutors() {
      return [...(await defaultAgent.describeExecutors!()), ...(await others.describeExecutors!())];
    },
    async runJob(job, ctx) {
      const pinned = pinJobExecutor(job);
      const id = pinned.executor!.id;
      if (id !== BUILTIN_AGENT_EXECUTOR_ID && id !== CODING_AGENT_RUN_ID) return others.runJob(pinned, ctx);
      const legacy = id === BUILTIN_AGENT_EXECUTOR_ID;
      const { harness: chosen, ...input } = legacy
        ? { assignment: pinned.instruction, ...(pinned.resultSchema !== undefined ? { resultSchema: pinned.resultSchema } : {}) }
        : (object(pinned.input) ?? {});
      const agent = chosen === undefined ? defaultAgent : agents.get(chosen as HarnessName);
      if (agent === undefined) {
        return failure(ctx, `agent job asks for harness ${JSON.stringify(chosen)}, which the runner config does not enable (harnesses: ${[...agents.keys()].join(", ")})`);
      }
      const review = pinned.purpose === "review" && input.resultSchema === "review-verdict-v1";
      const adapted: JobSpec = {
        ...pinned,
        ...(legacy || review || chosen !== undefined ? { input: { ...input, ...(review ? { resultSchema: REVIEW_SCHEMA } : {}) } } : {}),
      };
      const result = await agent.runJob(adapted, ctx);
      return review ? reviewEvidence(result) : result;
    },
  };
}

function failure(ctx: { runId: string; operationId: string; generation: number }, summary: string): JobResult {
  return { status: "failed", summary, runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation };
}

/** Claude Code settings, with any default watchdog that would outlast the job timeout cut to half of it. */
export function claudeOptions(config: RunnerConfig): NonNullable<RunnerConfig["claude"]> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  const claude = { ...config.claude };
  for (const [name, fallback] of WATCHDOGS) {
    if (claude[name] === undefined && fallback >= timeoutMs) claude[name] = Math.floor(timeoutMs / 2);
  }
  return claude;
}

/** Codex settings, with a default watchdog that would outlast the job timeout cut to half of it. */
export function codexOptions(config: RunnerConfig): NonNullable<RunnerConfig["codex"]> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  const codex = { ...config.codex };
  if (codex.responseTimeoutMs === undefined && CODEX_DEFAULT_RESPONSE_TIMEOUT_MS >= timeoutMs) codex.responseTimeoutMs = Math.floor(timeoutMs / 2);
  return codex;
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
  const payload: Record<string, unknown> = { verdict: verdict.verdict, summary: verdict.summary };
  if (Array.isArray(verdict.findings)) payload.findings = verdict.findings;
  if (typeof verdict.productDecision === "string") payload.productDecision = verdict.productDecision;
  return { ...result, evidence: [...(result.evidence ?? []), { kind: "review", payload }] };
}
