import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeCodeBindingOptions, PiBindingOptions } from "@graphloom/executor-coding-agent";

/** Operator consent and nonsecret settings; the harness uses its existing login. */
export interface RunnerConfig {
  harness: "claude-code" | "pi";
  allowUnrestricted: true;
  timeoutMs?: number;
  claude?: Omit<ClaudeCodeBindingOptions, "apiKey">;
  pi?: Omit<PiBindingOptions, "apiKey">;
}

export async function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): Promise<RunnerConfig | undefined> {
  const explicit = env.GRAPHLOOM_RUNNER_CONFIG;
  const file = explicit
    ? path.resolve(explicit)
    : path.join(env.HOME ?? os.homedir(), ".config", "graphloom", "runner.json");
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

export function parseRunnerConfig(value: unknown, source = "runner config"): RunnerConfig {
  const obj = settings(value, source, ["harness", "allowUnrestricted", "timeoutMs", "claude", "pi"]);
  if (obj.harness !== "claude-code" && obj.harness !== "pi") throw new Error(`${source}: harness must be claude-code or pi`);
  if (obj.allowUnrestricted !== true) throw new Error(`${source}: allowUnrestricted must be true to run an agent with your user permissions`);
  const config: RunnerConfig = { harness: obj.harness, allowUnrestricted: true };
  if (obj.timeoutMs !== undefined) config.timeoutMs = milliseconds(obj.timeoutMs, `${source}: timeoutMs`, false);
  if (obj.claude !== undefined) {
    const nested = `${source}: claude`;
    const c = settings(obj.claude, nested, ["command", "model", "passEnv", "startupTimeoutMs", "responseTimeoutMs"]);
    config.claude = {
      ...(c.command !== undefined ? { command: nonempty(c.command, `${nested}.command`) } : {}),
      ...(c.model !== undefined ? { model: nonempty(c.model, `${nested}.model`) } : {}),
      ...(c.passEnv !== undefined ? { passEnv: environmentNames(c.passEnv, nested) } : {}),
      ...(c.startupTimeoutMs !== undefined ? { startupTimeoutMs: milliseconds(c.startupTimeoutMs, `${nested}.startupTimeoutMs`, true) } : {}),
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
      ...(dir !== undefined ? { agentDir: path.resolve(dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir) } : {}),
      ...(p.passEnv !== undefined ? { passEnv: environmentNames(p.passEnv, nested) } : {}),
    };
  }
  return config;
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
