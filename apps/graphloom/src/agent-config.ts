import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILTIN_AGENT_EXECUTOR_ID, type ExecutorBinding, type JobSpec } from "@graphloom/sdk";
import { createBuiltinExecutorRunner, type JobResult, type Runner } from "@graphloom/runner";
import {
  CLAUDE_BIN_ENV,
  CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS,
  CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS,
  CODING_AGENT_RUN_ID,
  DEFAULT_CODING_TIMEOUT_MS,
  PI_MODEL_ENV,
  PI_PROVIDER_ENV,
  claudeCodeHarnessModule,
  codingAgentBinding,
  codingAgentExecutorPackage,
  piHarnessModule,
  type CodingAgentInput,
} from "@graphloom/executor-coding-agent";

/**
 * Operator-owned coding agent settings for `graphloom run` and `resume`.
 * Credentials never live here: Claude Code uses the login in its config dir,
 * and Pi resolves keys from its agent dir or the provider's environment
 * variable.
 */
export type AgentConfig = ClaudeCodeAgentConfig | PiAgentConfig;

interface AgentConfigBase {
  /** Wall-clock limit (ms) for one coding job. Default: one hour. */
  timeoutMs?: number;
  /** Extra environment variable names the agent's commands may see. */
  passEnv?: string[];
}

export interface ClaudeCodeAgentConfig extends AgentConfigBase {
  harness: "claude-code";
  command?: string;
  model?: string;
  configDir?: string;
  /** Stop Claude Code when it shows no model output this long after starting; 0 disables. */
  startupTimeoutMs?: number;
  /** Stop Claude Code when no model output arrives this long while no tool runs; 0 disables. */
  responseTimeoutMs?: number;
}

export interface PiAgentConfig extends AgentConfigBase {
  harness: "pi";
  provider: string;
  modelId: string;
  agentDir?: string;
}

const HARNESSES = ["claude-code", "pi"] as const;
const KEYS: Record<AgentConfig["harness"], readonly string[]> = {
  "claude-code": ["harness", "timeoutMs", "passEnv", "command", "model", "configDir", "startupTimeoutMs", "responseTimeoutMs"],
  pi: ["harness", "timeoutMs", "passEnv", "provider", "modelId", "agentDir"],
};
const WATCHDOGS = [
  ["startupTimeoutMs", CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS],
  ["responseTimeoutMs", CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS],
] as const;

export const AGENT_CONFIG_ENV = "GRAPHLOOM_AGENT_CONFIG";
export const AGENT_HARNESS_ENV = "GRAPHLOOM_AGENT_HARNESS";
/** Environment variables the CLI's agent setup reads, besides HOME and provider keys. */
export const AGENT_SETUP_ENV: readonly string[] = [
  AGENT_CONFIG_ENV,
  AGENT_HARNESS_ENV,
  ...(codingAgentExecutorPackage.configEnv ?? []),
  "CLAUDE_CONFIG_DIR",
];

const NOT_CONFIGURED = [
  "no coding agent configured:",
  `create ~/.config/graphloom/agent.json (or point ${AGENT_CONFIG_ENV} at one)`,
  'with {"harness": "claude-code"} or {"harness": "pi", "provider": "…", "modelId": "…"},',
  `or set ${AGENT_HARNESS_ENV} to claude-code or pi`,
].join(" ");

export function agentConfigPath(env: NodeJS.ProcessEnv = process.env): { file: string; explicit: boolean } {
  const explicit = env[AGENT_CONFIG_ENV];
  if (explicit !== undefined && explicit !== "") return { file: path.resolve(explicit), explicit: true };
  return { file: path.join(os.homedir(), ".config", "graphloom", "agent.json"), explicit: false };
}

/**
 * The operator's coding agent, from the config file or, without one, the
 * environment. Throws before any run starts when the agent is missing or
 * incompletely configured.
 */
export async function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): Promise<AgentConfig> {
  const { file, explicit } = agentConfigPath(env);
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || explicit) {
      throw new Error(`cannot read agent config ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let config: AgentConfig;
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The parser's message quotes the file, which may hold a misplaced credential.
      throw new Error(`${file}: not valid JSON`);
    }
    config = parseAgentConfig(parsed, file, env);
  } else {
    const harness = env[AGENT_HARNESS_ENV];
    if (harness === undefined || harness === "") throw new Error(NOT_CONFIGURED);
    config = parseAgentConfig({ harness }, AGENT_HARNESS_ENV, env);
  }
  return bindAgentCommand(config, env);
}

export function parseAgentConfig(value: unknown, source = "agent config", env: NodeJS.ProcessEnv = process.env): AgentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${source}: expected an object`);
  const obj = value as Record<string, unknown>;
  const harness = obj.harness;
  if (typeof harness !== "string" || !(HARNESSES as readonly string[]).includes(harness)) {
    throw new Error(`${source}: harness must be one of ${HARNESSES.join(", ")}`);
  }
  const kind = harness as AgentConfig["harness"];
  for (const key of Object.keys(obj)) {
    if (!KEYS[kind].includes(key)) {
      const hint = /key|token|secret|password|credential/i.test(key)
        ? "; credentials never go in this file: use the agent's own login or the provider's environment variable"
        : "";
      throw new Error(`${source}: ${key} is not a ${kind} setting${hint}`);
    }
  }
  const base: AgentConfigBase = {};
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !(obj.timeoutMs > 0)) throw new Error(`${source}: timeoutMs must be a positive number`);
    base.timeoutMs = obj.timeoutMs;
  }
  if (obj.passEnv !== undefined) {
    if (!Array.isArray(obj.passEnv) || !obj.passEnv.every((n) => typeof n === "string" && n !== "")) {
      throw new Error(`${source}: passEnv must be an array of environment variable names`);
    }
    base.passEnv = obj.passEnv as string[];
  }
  if (kind === "claude-code") {
    const config: ClaudeCodeAgentConfig = { harness: kind, ...base };
    if (obj.command !== undefined) config.command = requireString(obj.command, `${source}: command`);
    if (obj.model !== undefined) config.model = requireString(obj.model, `${source}: model`);
    if (obj.configDir !== undefined) config.configDir = expandHome(requireString(obj.configDir, `${source}: configDir`));
    const timeoutMs = config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
    for (const [name] of WATCHDOGS) {
      const ms = obj[name];
      if (ms === undefined) continue;
      if (typeof ms !== "number" || !(ms >= 0)) throw new Error(`${source}: ${name} must be a non-negative number (0 disables it)`);
      if (ms >= timeoutMs) throw new Error(`${source}: ${name} (${ms} ms) must be shorter than timeoutMs (${timeoutMs} ms)`);
      config[name] = ms;
    }
    return config;
  }
  const provider = obj.provider ?? env[PI_PROVIDER_ENV];
  const modelId = obj.modelId ?? env[PI_MODEL_ENV];
  if (provider === undefined || modelId === undefined || provider === "" || modelId === "") {
    throw new Error(`${source}: the pi harness needs provider and modelId (or ${PI_PROVIDER_ENV} and ${PI_MODEL_ENV})`);
  }
  const config: PiAgentConfig = {
    harness: kind,
    ...base,
    provider: requireString(provider, `${source}: provider`),
    modelId: requireString(modelId, `${source}: modelId`),
  };
  if (obj.agentDir !== undefined) config.agentDir = expandHome(requireString(obj.agentDir, `${source}: agentDir`));
  return config;
}

/**
 * Claude Code must be installed; its login is checked by its first request.
 * A command given as a path is bound as the absolute path checked here, since
 * the harness starts it from the run's worktree.
 */
async function bindAgentCommand(config: AgentConfig, env: NodeJS.ProcessEnv): Promise<AgentConfig> {
  if (config.harness !== "claude-code") return config;
  const command = config.command ?? (env[CLAUDE_BIN_ENV] || "claude");
  const bound = command.includes("/") ? expandHome(command) : command;
  if (!(await isExecutable(bound, env.PATH ?? ""))) {
    throw new Error(`Claude Code command ${command} was not found; install Claude Code or set "command" in the agent config`);
  }
  return bound === command && config.command === undefined ? config : { ...config, command: bound };
}

async function isExecutable(command: string, searchPath: string): Promise<boolean> {
  const candidates = command.includes("/")
    ? [path.resolve(command)]
    : searchPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * The CLI's runner: the coding-agent executor, running unrestricted with the
 * configured harness, serves `graphloom.coding-agent/run` and the jobs a graph
 * dispatches without naming an executor.
 */
export function agentRunner(config: AgentConfig): Runner {
  const builtin = createBuiltinExecutorRunner({
    packages: [{ manifest: codingAgentExecutorPackage, ...agentBinding(config) }],
    fallback: {
      async runJob(job, ctx) {
        return {
          status: "failed",
          summary: `no executor serves ${job.executor?.id ?? job.kind} in the CLI`,
          runId: ctx.runId,
          operationId: ctx.operationId,
          generation: ctx.generation,
        };
      },
    },
  });
  return servePlainAgentJobs(builtin);
}

/** The coding-agent package's binding for the configured harness. */
export function agentBinding(config: AgentConfig): ExecutorBinding {
  return config.harness === "claude-code"
      ? codingAgentBinding({
          harness: claudeCodeHarnessModule,
          ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
          claude: {
            ...(config.command !== undefined ? { command: config.command } : {}),
            ...(config.model !== undefined ? { model: config.model } : {}),
            ...(config.configDir !== undefined ? { configDir: config.configDir } : {}),
            ...(config.passEnv !== undefined ? { passEnv: config.passEnv } : {}),
            ...claudeWatchdogs(config),
          },
        })
      : codingAgentBinding({
          harness: piHarnessModule,
          ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
          pi: {
            provider: config.provider,
            modelId: config.modelId,
            ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
            ...(config.passEnv !== undefined ? { passEnv: config.passEnv } : {}),
          },
        });
}

/**
 * Run the jobs a graph dispatches without naming an executor (pinned to
 * `graphloom.agent/run`) on the coding agent: the job's instruction is the
 * assignment. The agent-run pin carries the coding agent's digest, so intake
 * pins and resume checks the code that serves it. A read-only review job's
 * structured result is its review verdict; the controller accepts `review`
 * evidence only from such jobs.
 */
export function servePlainAgentJobs(runner: Runner): Runner {
  return {
    async describeExecutors() {
      const described = (await runner.describeExecutors?.()) ?? [];
      const coding = described.find((d) => d.id === CODING_AGENT_RUN_ID);
      return coding === undefined ? described : [...described, { ...coding, id: BUILTIN_AGENT_EXECUTOR_ID }];
    },
    async runJob(job, ctx) {
      if (job.executor?.id !== BUILTIN_AGENT_EXECUTOR_ID) return runner.runJob(job, ctx);
      const input: CodingAgentInput = {
        assignment: job.instruction,
        ...(job.resultSchema !== undefined ? { resultSchema: job.resultSchema } : {}),
      };
      const coding: JobSpec = { ...job, executor: { ...job.executor, id: CODING_AGENT_RUN_ID }, input };
      const result = await runner.runJob(coding, ctx);
      if (result.status !== "ok" || job.purpose !== "review" || job.readOnly !== true) return result;
      const verdict = agentOutput(result);
      return verdict === undefined ? result : { ...result, evidence: [...(result.evidence ?? []), { kind: "review", payload: verdict }] };
    },
  };
}

function agentOutput(result: JobResult): Record<string, unknown> | undefined {
  for (const item of result.evidence ?? []) {
    const output = (item.payload as { codingAgent?: { output?: unknown } } | undefined)?.codingAgent?.output;
    if (output !== null && typeof output === "object" && !Array.isArray(output)) return output as Record<string, unknown>;
  }
  return undefined;
}

/** Configured watchdogs, and for a job timeout at or under a default, half the timeout in its place. */
function claudeWatchdogs(config: ClaudeCodeAgentConfig): { startupTimeoutMs?: number; responseTimeoutMs?: number } {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  const watchdogs: { startupTimeoutMs?: number; responseTimeoutMs?: number } = {};
  for (const [name, fallback] of WATCHDOGS) {
    const ms = config[name] ?? (fallback < timeoutMs ? undefined : Math.floor(timeoutMs / 2));
    if (ms !== undefined) watchdogs[name] = ms;
  }
  return watchdogs;
}

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return value;
}
