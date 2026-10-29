// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_JOB_TIMEOUT_MS } from "@graphloom/sdk";
import {
  CLAUDE_BIN_ENV,
  CODEX_BIN_ENV,
  DEFAULT_CODING_TIMEOUT_MS,
  PI_MODEL_ENV,
  PI_PROVIDER_ENV,
  codingAgentExecutorPackage,
  type ClaudeCodeBindingOptions,
  type CodexBindingOptions,
  type PiBindingOptions,
} from "@graphloom/executor-coding-agent";

export const RUNNER_CONFIG_ENV = "GRAPHLOOM_RUNNER_CONFIG";
/** Environment variables the CLI's runner setup reads, besides HOME and provider keys. */
export const RUNNER_SETUP_ENV: readonly string[] = [
  RUNNER_CONFIG_ENV,
  ...(codingAgentExecutorPackage.configEnv ?? []),
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
];

export type HarnessName = "claude-code" | "codex" | "pi";
const HARNESS_NAMES: readonly HarnessName[] = ["claude-code", "codex", "pi"];

/**
 * The operator's own wrapper for `graphloom session open` only (docs/design-typescript-core.md section 15): an
 * argv prefix that replaces the agent command, and the directories it keeps its own state in. Headless graph
 * jobs never use it: they keep `command`.
 */
export interface SessionLauncherSettings {
  sessionLauncher?: string[];
  sessionLauncherStateDirs?: string[];
}

/** The settings the executor binding takes: the launcher keys are the CLI's, never the executor's. */
export function withoutLauncher<T extends SessionLauncherSettings>(settings: T): Omit<T, keyof SessionLauncherSettings> {
  const { sessionLauncher: _l, sessionLauncherStateDirs: _d, ...rest } = settings;
  void _l;
  void _d;
  return rest;
}

/** Operator consent and nonsecret settings; the harness uses its existing login. */
export interface RunnerConfig {
  /** Harness for agent jobs that do not choose one. */
  harness: HarnessName;
  /** Harnesses a job may choose with `input.harness`. Default: only `harness`. */
  harnesses?: HarnessName[];
  allowUnrestricted: true;
  /** Wall clock (ms) for one coding-agent job. Default one hour. */
  timeoutMs?: number;
  /** Most wall clock (ms) a coding-agent job may ask for with its own `timeoutMs`. Default four hours, or `timeoutMs` when longer. */
  maxTimeoutMs?: number;
  claude?: Omit<ClaudeCodeBindingOptions, "apiKey"> & SessionLauncherSettings;
  /** Codex serves read-only jobs only, with its own login. */
  codex?: CodexBindingOptions & SessionLauncherSettings;
  /** Largest operator-conversation transcript `session open` stores (bytes); beyond it the evidence says `transcript: omitted`. Default 32 MiB. */
  maxConversationBytes?: number;
  pi?: Omit<PiBindingOptions, "apiKey">;
  /** Serve the read-only GitHub executors; the token comes from the named environment variable. */
  github?: { tokenEnv?: string; baseUrl?: string };
  /** Settings for command jobs, which run as the user in the job's workspace. */
  command?: { timeoutMs?: number };
  /** Shell command run once when a run leaves `running`; `run --on-stop` and `resume --on-stop` override it. */
  notify?: { onStop?: string; timeoutMs?: number };
  /** Automatic updates of the install (docs/design-release.md §5.4). Default `auto`. */
  autoUpdate?: "auto" | "notify" | "off";
}

/** Why `run`, `resume`, and `probe` refuse without a runner config (docs/design-release.md §4.5). */
export const NO_RUNNER_CONFIG = `no agent runner configured: run graphloom setup (graphloom setup --yes in scripts), or point ${RUNNER_CONFIG_ENV} at a runner config`;

/** Where `run` looks for the runner config: `$GRAPHLOOM_RUNNER_CONFIG`, otherwise `~/.config/graphloom/runner.json`. */
export function runnerConfigPath(env: NodeJS.ProcessEnv = process.env): { file: string; explicit: boolean } {
  const explicit = env[RUNNER_CONFIG_ENV];
  return explicit
    ? { file: path.resolve(explicit), explicit: true }
    : { file: path.join(env.HOME ?? os.homedir(), ".config", "graphloom", "runner.json"), explicit: false };
}

/** Every harness a job of this run may use. */
export function enabledHarnesses(config: RunnerConfig): HarnessName[] {
  return [...new Set([config.harness, ...(config.harnesses ?? [])])];
}

export async function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): Promise<RunnerConfig | undefined> {
  const { file, explicit } = runnerConfigPath(env);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (!explicit && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read runner config ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${file}: invalid JSON in runner config`);
  }
  return parseRunnerConfig(value, file);
}

/**
 * The runner config for `run` and `resume`, checked before a run starts: it
 * exists, Pi has a model, and the Claude Code and Codex commands are
 * executable. A command given as a path is bound to the absolute path that
 * passed the check, since the agent starts in the run's worktree.
 */
export async function requireRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
  /** Called with the parsed config before the harness availability checks, which can throw. */
  onLoaded?: (config: RunnerConfig) => void,
): Promise<RunnerConfig> {
  const loaded = await loadRunnerConfig(env);
  if (loaded !== undefined) onLoaded?.(loaded);
  if (loaded === undefined) {
    throw new Error(NO_RUNNER_CONFIG);
  }
  let config = loaded;
  const harnesses = enabledHarnesses(config);
  if (harnesses.includes("pi")) {
    if (!(config.pi?.provider ?? env[PI_PROVIDER_ENV]) || !(config.pi?.modelId ?? env[PI_MODEL_ENV])) {
      throw new Error(`the pi harness needs pi.provider and pi.modelId in the runner config (or ${PI_PROVIDER_ENV} and ${PI_MODEL_ENV})`);
    }
  }
  if (harnesses.includes("claude-code")) {
    const configured = config.claude?.command;
    const command = await requireCommand(configured ?? (env[CLAUDE_BIN_ENV] || "claude"), env, "Claude Code", "claude.command");
    if (configured !== undefined || command.includes("/")) config = { ...config, claude: { ...config.claude, command } };
  }
  if (harnesses.includes("codex")) {
    const configured = config.codex?.command;
    const command = await requireCommand(configured ?? (env[CODEX_BIN_ENV] || "codex"), env, "Codex", "codex.command");
    if (configured !== undefined || command.includes("/")) config = { ...config, codex: { ...config.codex, command } };
  }
  return config;
}

/** The command as it will be bound: a path is made absolute; it must be executable. */
async function requireCommand(command: string, env: NodeJS.ProcessEnv, name: string, setting: string): Promise<string> {
  const bound = command.includes("/") ? expandHome(command) : command;
  if (!(await isExecutable(bound, env.PATH ?? ""))) {
    throw new Error(`${name} command ${command} was not found; install ${name} or set ${setting} in the runner config`);
  }
  return bound;
}

async function isExecutable(command: string, searchPath: string): Promise<boolean> {
  const candidates = command.includes("/")
    ? [command]
    : searchPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

export function parseRunnerConfig(value: unknown, source = "runner config"): RunnerConfig {
  const obj = settings(value, source, ["harness", "harnesses", "allowUnrestricted", "timeoutMs", "maxTimeoutMs", "maxConversationBytes", "claude", "codex", "pi", "github", "command", "notify", "autoUpdate"]);
  if (!isHarness(obj.harness)) throw new Error(`${source}: harness must be one of ${HARNESS_NAMES.join(", ")}`);
  if (obj.allowUnrestricted !== true) throw new Error(`${source}: allowUnrestricted must be true to run an agent with your user permissions`);
  const config: RunnerConfig = { harness: obj.harness, allowUnrestricted: true };
  if (obj.harnesses !== undefined) {
    if (!Array.isArray(obj.harnesses) || obj.harnesses.length === 0 || !obj.harnesses.every(isHarness)) {
      throw new Error(`${source}: harnesses must be a non-empty array of ${HARNESS_NAMES.join(", ")}`);
    }
    config.harnesses = [...new Set(obj.harnesses)];
  }
  if (obj.timeoutMs !== undefined) config.timeoutMs = milliseconds(obj.timeoutMs, `${source}: timeoutMs`, false);
  if (obj.maxTimeoutMs !== undefined) {
    config.maxTimeoutMs = milliseconds(obj.maxTimeoutMs, `${source}: maxTimeoutMs`, false);
    if (config.maxTimeoutMs > MAX_JOB_TIMEOUT_MS) throw new Error(`${source}: maxTimeoutMs must be at most ${MAX_JOB_TIMEOUT_MS} (one day)`);
    if (config.maxTimeoutMs < (config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS)) {
      throw new Error(`${source}: maxTimeoutMs must be at least timeoutMs (${config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS} ms)`);
    }
  }
  if (obj.maxConversationBytes !== undefined) config.maxConversationBytes = milliseconds(obj.maxConversationBytes, `${source}: maxConversationBytes`, false);
  if (obj.autoUpdate !== undefined) {
    if (obj.autoUpdate !== "auto" && obj.autoUpdate !== "notify" && obj.autoUpdate !== "off") {
      throw new Error(`${source}: autoUpdate must be auto, notify, or off`);
    }
    config.autoUpdate = obj.autoUpdate;
  }
  if (obj.github !== undefined) {
    const nested = `${source}: github`;
    const g = settings(obj.github, nested, ["tokenEnv", "baseUrl"]);
    if (g.tokenEnv !== undefined && (typeof g.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(g.tokenEnv))) {
      throw new Error(`${source}: github.tokenEnv must name an environment variable`);
    }
    config.github = {
      ...(g.tokenEnv !== undefined ? { tokenEnv: g.tokenEnv } : {}),
      ...(g.baseUrl !== undefined ? { baseUrl: nonempty(g.baseUrl, `${nested}.baseUrl`) } : {}),
    };
  }
  if (obj.command !== undefined) {
    const c = settings(obj.command, `${source}: command`, ["timeoutMs"]);
    config.command = c.timeoutMs !== undefined ? { timeoutMs: milliseconds(c.timeoutMs, `${source}: command.timeoutMs`, false) } : {};
  }
  if (obj.notify !== undefined) {
    const n = settings(obj.notify, `${source}: notify`, ["onStop", "timeoutMs"]);
    config.notify = {
      ...(n.onStop !== undefined ? { onStop: nonempty(n.onStop, `${source}: notify.onStop`) } : {}),
      ...(n.timeoutMs !== undefined ? { timeoutMs: milliseconds(n.timeoutMs, `${source}: notify.timeoutMs`, false) } : {}),
    };
  }
  if (obj.claude !== undefined) {
    const nested = `${source}: claude`;
    const c = settings(obj.claude, nested, ["command", "model", "configDir", "passEnv", "startupTimeoutMs", "responseTimeoutMs", "sessionLauncher", "sessionLauncherStateDirs"]);
    config.claude = {
      ...launcherSettings(c, nested),
      ...(c.command !== undefined ? { command: nonempty(c.command, `${nested}.command`) } : {}),
      ...(c.configDir !== undefined ? { configDir: expandHome(nonempty(c.configDir, `${nested}.configDir`)) } : {}),
      ...(c.model !== undefined ? { model: nonempty(c.model, `${nested}.model`) } : {}),
      ...(c.passEnv !== undefined ? { passEnv: environmentNames(c.passEnv, nested) } : {}),
      ...(c.startupTimeoutMs !== undefined ? { startupTimeoutMs: milliseconds(c.startupTimeoutMs, `${nested}.startupTimeoutMs`, true) } : {}),
      ...(c.responseTimeoutMs !== undefined ? { responseTimeoutMs: milliseconds(c.responseTimeoutMs, `${nested}.responseTimeoutMs`, true) } : {}),
    };
  }
  if (obj.codex !== undefined) {
    const nested = `${source}: codex`;
    const c = settings(obj.codex, nested, ["command", "model", "reasoningEffort", "codexHome", "passEnv", "responseTimeoutMs", "sessionLauncher", "sessionLauncherStateDirs"]);
    if (c.reasoningEffort !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(c.reasoningEffort as string)) {
      throw new Error(`${nested}.reasoningEffort: expected minimal, low, medium, high or xhigh`);
    }
    config.codex = {
      ...launcherSettings(c, nested),
      ...(c.command !== undefined ? { command: nonempty(c.command, `${nested}.command`) } : {}),
      ...(c.model !== undefined ? { model: nonempty(c.model, `${nested}.model`) } : {}),
      ...(c.reasoningEffort !== undefined ? { reasoningEffort: c.reasoningEffort as string } : {}),
      ...(c.codexHome !== undefined ? { codexHome: expandHome(nonempty(c.codexHome, `${nested}.codexHome`)) } : {}),
      ...(c.passEnv !== undefined ? { passEnv: environmentNames(c.passEnv, nested) } : {}),
      ...(c.responseTimeoutMs !== undefined ? { responseTimeoutMs: milliseconds(c.responseTimeoutMs, `${nested}.responseTimeoutMs`, true) } : {}),
    };
  }
  if (obj.pi !== undefined) {
    const nested = `${source}: pi`;
    const p = settings(obj.pi, nested, ["provider", "modelId", "agentDir", "passEnv"]);
    const dir = p.agentDir !== undefined ? nonempty(p.agentDir, `${nested}.agentDir`) : undefined;
    config.pi = {
      ...(p.provider !== undefined ? { provider: nonempty(p.provider, `${nested}.provider`) } : {}),
      ...(p.modelId !== undefined ? { modelId: nonempty(p.modelId, `${nested}.modelId`) } : {}),
      ...(dir !== undefined ? { agentDir: expandHome(dir) } : {}),
      ...(p.passEnv !== undefined ? { passEnv: environmentNames(p.passEnv, nested) } : {}),
    };
  }
  return config;
}

/** `sessionLauncher`: a non-empty array of non-empty strings; `sessionLauncherStateDirs`: absolute or `~/` paths. */
function launcherSettings(c: Record<string, unknown>, nested: string): SessionLauncherSettings {
  const out: SessionLauncherSettings = {};
  if (c.sessionLauncher !== undefined) {
    if (!Array.isArray(c.sessionLauncher) || c.sessionLauncher.length === 0 || !c.sessionLauncher.every((w) => typeof w === "string" && w !== "")) {
      throw new Error(`${nested}.sessionLauncher: expected a non-empty array of non-empty strings, such as ["hapi", "claude"]`);
    }
    out.sessionLauncher = [...(c.sessionLauncher as string[])];
  }
  if (c.sessionLauncherStateDirs !== undefined) {
    const dirs = c.sessionLauncherStateDirs;
    if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string" && (d === "~" || d.startsWith("~/") || path.isAbsolute(d)))) {
      throw new Error(`${nested}.sessionLauncherStateDirs: expected an array of absolute or ~/ paths`);
    }
    out.sessionLauncherStateDirs = (dirs as string[]).map((d) => expandHome(d));
  }
  return out;
}

function isHarness(value: unknown): value is HarnessName {
  return HARNESS_NAMES.includes(value as HarnessName);
}

function settings(value: unknown, source: string, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: expected an object`);
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !keys.includes(key))) {
    throw new Error(`${source}: unsupported setting; credentials must use the harness login or provider environment, not this file`);
  }
  return obj;
}

function nonempty(value: unknown, source: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${source}: expected a non-empty string`);
  return value;
}

function milliseconds(value: unknown, source: string, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${source}: expected ${allowZero ? "non-negative" : "positive"} integer milliseconds`);
  }
  return value;
}

function environmentNames(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error(`${source}.passEnv: expected an array of environment variable names`);
  }
  return value;
}
