import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import {
  CLAUDE_API_KEY_CREDENTIAL,
  CLAUDE_BIN_ENV,
  CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS,
  CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS,
  CLAUDE_MODEL_ENV,
  CLAUDE_PASS_ENV_ENV,
  CLAUDE_RESPONSE_TIMEOUT_ENV,
  CLAUDE_STARTUP_TIMEOUT_ENV,
} from "./claude-config.js";
import { CODING_HARNESS_ENV } from "./executors.js";
import { PI_AGENT_DIR_ENV, PI_API_KEY_CREDENTIAL, PI_MODEL_ENV, PI_PASS_ENV_ENV, PI_PROVIDER_ENV } from "./pi-config.js";
import { CODING_AGENT_RUN_ID } from "./run.js";

/** Host-facing declaration; the host runs `entryModule` in an executor process and never imports it. */
export const codingAgentExecutorPackage: ExecutorPackageManifest = {
  name: "@graphloom/executor-coding-agent",
  entryModule: fileURLToPath(new URL("./executors.js", import.meta.url)),
  executorIds: [CODING_AGENT_RUN_ID],
  credentials: [CLAUDE_API_KEY_CREDENTIAL, PI_API_KEY_CREDENTIAL],
  configEnv: [
    CODING_HARNESS_ENV,
    CLAUDE_BIN_ENV,
    CLAUDE_MODEL_ENV,
    CLAUDE_PASS_ENV_ENV,
    CLAUDE_STARTUP_TIMEOUT_ENV,
    CLAUDE_RESPONSE_TIMEOUT_ENV,
    PI_PROVIDER_ENV,
    PI_MODEL_ENV,
    PI_AGENT_DIR_ENV,
    PI_PASS_ENV_ENV,
  ],
  // The agent edits the worktree and runs commands as the user.
  isolation: "unrestricted",
};

/** Absolute path of the Claude Code harness module, for `codingAgentBinding({ harness })`. */
export const claudeCodeHarnessModule = fileURLToPath(new URL("./claude.js", import.meta.url));
/** Absolute path of the Pi harness module, for `codingAgentBinding({ harness })`. */
export const piHarnessModule = fileURLToPath(new URL("./pi.js", import.meta.url));

/**
 * Operator settings for the Claude Code harness. Without `apiKey`, Claude Code
 * uses its own login; a key travels as a credential, never as config.
 */
export interface ClaudeCodeBindingOptions {
  command?: string;
  model?: string;
  apiKey?: string;
  /** Extra environment variable names Claude Code may see, beyond its minimal set. */
  passEnv?: string[];
  /** Stop Claude Code when it shows no model output this long after starting; 0 disables. */
  startupTimeoutMs?: number;
  /** Stop Claude Code when no model output arrives this long while no tool is running; 0 disables. */
  responseTimeoutMs?: number;
}

/** Operator settings for the Pi harness. The API key travels as a credential, never as config. */
export interface PiBindingOptions {
  provider?: string;
  modelId?: string;
  agentDir?: string;
  /** Extra environment variable names Pi's shell commands may see, beyond their minimal set. */
  passEnv?: string[];
  apiKey?: string;
}

export interface CodingAgentBindingOptions {
  /** Absolute path (or package specifier) of the harness adapter module. */
  harness: string;
  /** Wall-clock limit (ms) for one coding job. Default: one hour. */
  timeoutMs?: number;
  claude?: ClaudeCodeBindingOptions;
  pi?: PiBindingOptions;
}

/** A coding job runs many model turns and commands, far past the runner's default job timeout. */
export const DEFAULT_CODING_TIMEOUT_MS = 60 * 60_000;

/**
 * Operator binding for the coding agent: selects the harness and consents to
 * running it unrestricted. The controller admits its tool calls and budgets,
 * but cannot confine what the agent does in the worktree.
 */
export function codingAgentBinding(options: CodingAgentBindingOptions): ExecutorBinding {
  const claude = options.claude ?? {};
  const pi = options.pi ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  if (options.claude !== undefined || options.harness === claudeCodeHarnessModule) {
    const watchdogs = {
      startupTimeoutMs: claude.startupTimeoutMs ?? CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS,
      responseTimeoutMs: claude.responseTimeoutMs ?? CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS,
    };
    for (const [name, ms] of Object.entries(watchdogs)) {
      if (ms >= timeoutMs) {
        throw new Error(`claude.${name} (${ms} ms) must be shorter than the job timeout (${timeoutMs} ms), or the job is killed before the stall is reported`);
      }
    }
  }
  const credentials: Record<string, string> = {
    ...(claude.apiKey !== undefined ? { [CLAUDE_API_KEY_CREDENTIAL]: claude.apiKey } : {}),
    ...(pi.apiKey !== undefined ? { [PI_API_KEY_CREDENTIAL]: pi.apiKey } : {}),
  };
  return {
    allowedEffects: ["read", "write"],
    allowUnrestricted: true,
    timeoutMs,
    env: {
      [CODING_HARNESS_ENV]: options.harness,
      ...(claude.command !== undefined ? { [CLAUDE_BIN_ENV]: claude.command } : {}),
      ...(claude.model !== undefined ? { [CLAUDE_MODEL_ENV]: claude.model } : {}),
      ...(claude.passEnv !== undefined ? { [CLAUDE_PASS_ENV_ENV]: claude.passEnv.join(",") } : {}),
      ...(claude.startupTimeoutMs !== undefined ? { [CLAUDE_STARTUP_TIMEOUT_ENV]: String(claude.startupTimeoutMs) } : {}),
      ...(claude.responseTimeoutMs !== undefined ? { [CLAUDE_RESPONSE_TIMEOUT_ENV]: String(claude.responseTimeoutMs) } : {}),
      ...(pi.provider !== undefined ? { [PI_PROVIDER_ENV]: pi.provider } : {}),
      ...(pi.modelId !== undefined ? { [PI_MODEL_ENV]: pi.modelId } : {}),
      ...(pi.agentDir !== undefined ? { [PI_AGENT_DIR_ENV]: pi.agentDir } : {}),
      ...(pi.passEnv !== undefined ? { [PI_PASS_ENV_ENV]: pi.passEnv.join(",") } : {}),
    },
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
}
