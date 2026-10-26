// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import {
  CLAUDE_API_KEY_CREDENTIAL,
  CLAUDE_BIN_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_MODEL_ENV,
  CLAUDE_PASS_ENV_ENV,
  CLAUDE_RESPONSE_TIMEOUT_ENV,
  CLAUDE_STARTUP_TIMEOUT_ENV,
} from "./claude-config.js";
import {
  CODEX_BIN_ENV,
  CODEX_HOME_ENV,
  CODEX_MODEL_ENV,
  CODEX_PASS_ENV_ENV,
  CODEX_REASONING_EFFORT_ENV,
  CODEX_RESPONSE_TIMEOUT_ENV,
} from "./codex-config.js";
import { CODING_HARNESS_ENV } from "./executors.js";
import { PI_AGENT_DIR_ENV, PI_API_KEY_CREDENTIAL, PI_MODEL_ENV, PI_PASS_ENV_ENV, PI_PROVIDER_ENV } from "./pi-config.js";
import { REHEARSAL_HOME_ENV, REHEARSAL_SCENARIO_ENV } from "./rehearsal/scenario.js";
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
    CLAUDE_CONFIG_DIR_ENV,
    CLAUDE_PASS_ENV_ENV,
    CLAUDE_STARTUP_TIMEOUT_ENV,
    CLAUDE_RESPONSE_TIMEOUT_ENV,
    CODEX_BIN_ENV,
    CODEX_MODEL_ENV,
    CODEX_HOME_ENV,
    CODEX_PASS_ENV_ENV,
    CODEX_REASONING_EFFORT_ENV,
    CODEX_RESPONSE_TIMEOUT_ENV,
    PI_PROVIDER_ENV,
    PI_MODEL_ENV,
    PI_AGENT_DIR_ENV,
    PI_PASS_ENV_ENV,
    REHEARSAL_SCENARIO_ENV,
    REHEARSAL_HOME_ENV,
  ],
  // The agent edits the worktree and runs commands as the user.
  isolation: "unrestricted",
  // Jobs the supervisor originates run confined to the run, but the harness still keeps its login and history.
  ownState: {
    env: [CLAUDE_CONFIG_DIR_ENV, CODEX_HOME_ENV, PI_AGENT_DIR_ENV],
    homeRelative: [".claude", ".codex", path.join(".pi", "agent")],
  },
};

/** Absolute path of the Claude Code harness module, for `codingAgentBinding({ harness })`. */
export const claudeCodeHarnessModule = fileURLToPath(new URL("./claude.js", import.meta.url));
/** Absolute path of the Pi harness module, for `codingAgentBinding({ harness })`. */
export const piHarnessModule = fileURLToPath(new URL("./pi.js", import.meta.url));
/** Absolute path of the Codex harness module, for `codingAgentBinding({ harness })`. */
export const codexHarnessModule = fileURLToPath(new URL("./codex.js", import.meta.url));
/**
 * Absolute path of the Pi rehearsal stand-in (docs/design-graph-rehearsal.md
 * §4.1): the real Pi harness driven by a faux provider scripted from a
 * rehearsal scenario, in place of `piHarnessModule`.
 */
export const piRehearsalModule = fileURLToPath(new URL("./rehearsal/pi.js", import.meta.url));
/**
 * Absolute path of the Codex rehearsal stand-in executable
 * (docs/design-graph-rehearsal.md §4.1): a script that speaks just enough of
 * `codex exec --json`'s wire protocol to satisfy the real, unmodified Codex
 * harness, answering from a rehearsal scenario. Bind it as `codex.command`
 * (with `codex.passEnv` naming `REHEARSAL_SCENARIO_ENV`/`REHEARSAL_HOME_ENV`,
 * so the stand-in actually receives them) in place of a real Codex install.
 */
export const codexRehearsalStandIn = fileURLToPath(new URL("./rehearsal/codex-standin.js", import.meta.url));
/**
 * Absolute path of the Claude Code rehearsal stand-in executable
 * (docs/design-graph-rehearsal.md §4.1): a script that speaks just enough of
 * the stream-json control protocol to satisfy the real, unmodified Claude
 * Code harness, answering from a rehearsal scenario. Bind it as
 * `claude.command` (with `claude.passEnv` naming the same two variables) in
 * place of a real Claude Code install.
 */
export const claudeRehearsalStandIn = fileURLToPath(new URL("./rehearsal/claude-standin.js", import.meta.url));

/** Rehearsal settings (§4.2/§4.6): which scenario a stand-in answers from, and its isolated state root. */
export interface RehearsalBindingOptions {
  scenarioPath: string;
  /** Root directory for every stand-in's isolated HOME/config/agent dirs; never an operator's real ones. */
  homeDir: string;
}

/** Env overlay naming the scenario and isolated state root a rehearsal's stand-ins read (merge into `codingAgentBinding`'s own `env`). */
export function rehearsalBinding(options: RehearsalBindingOptions): Record<string, string> {
  return {
    [REHEARSAL_SCENARIO_ENV]: options.scenarioPath,
    [REHEARSAL_HOME_ENV]: options.homeDir,
  };
}

/**
 * Operator settings for the Claude Code harness. Without `apiKey`, Claude Code
 * uses its own login; a key travels as a credential, never as config.
 */
export interface ClaudeCodeBindingOptions {
  command?: string;
  model?: string;
  /**
   * Absolute path of the Claude Code config dir (its login and `settings.json`),
   * which picks the account or gateway this binding uses. Default: the
   * executor's `CLAUDE_CONFIG_DIR`, then `~/.claude`.
   */
  configDir?: string;
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

/** Operator settings for the Codex harness, which uses Codex's own login and serves read-only jobs only. */
export interface CodexBindingOptions {
  command?: string;
  model?: string;
  /** `minimal`, `low`, `medium`, `high` or `xhigh`. */
  reasoningEffort?: string;
  /** Absolute path of the Codex home (its login and config). Default: the executor's `CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Extra environment variable names Codex may see, beyond its minimal set. */
  passEnv?: string[];
  /** Stop Codex when it shows no activity this long while no command is running; 0 disables. */
  responseTimeoutMs?: number;
}

export interface CodingAgentBindingOptions {
  /** Absolute path (or package specifier) of the harness adapter module. */
  harness: string;
  /** Wall-clock limit (ms) for one coding job. Default: one hour. */
  timeoutMs?: number;
  /**
   * Most wall clock (ms) one coding job may ask for with its own `timeoutMs`.
   * Default: `DEFAULT_MAX_CODING_TIMEOUT_MS` (four hours), or `timeoutMs` when that is longer.
   */
  maxTimeoutMs?: number;
  claude?: ClaudeCodeBindingOptions;
  codex?: CodexBindingOptions;
  pi?: PiBindingOptions;
}

/** A coding job runs many model turns and commands, far past the runner's default job timeout. */
export const DEFAULT_CODING_TIMEOUT_MS = 60 * 60_000;
/** A job may ask for up to this much by default: the controller's default active-run budget (§10). */
export const DEFAULT_MAX_CODING_TIMEOUT_MS = 4 * 60 * 60_000;

/**
 * Operator binding for the coding agent: selects the harness and consents to
 * running it unrestricted. The controller admits its tool calls and budgets,
 * but cannot confine what the agent does in the worktree.
 */
export function codingAgentBinding(options: CodingAgentBindingOptions): ExecutorBinding {
  const claude = options.claude ?? {};
  const codex = options.codex ?? {};
  const pi = options.pi ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? Math.max(timeoutMs, DEFAULT_MAX_CODING_TIMEOUT_MS);
  if (maxTimeoutMs < timeoutMs) {
    throw new Error(`maxTimeoutMs (${maxTimeoutMs} ms) must be at least timeoutMs (${timeoutMs} ms)`);
  }
  if (claude.configDir !== undefined && !path.isAbsolute(claude.configDir)) {
    throw new Error("claude.configDir must be an absolute path");
  }
  if (codex.codexHome !== undefined && !path.isAbsolute(codex.codexHome)) {
    throw new Error("codex.codexHome must be an absolute path");
  }
  // The harness fits a default watchdog inside each job's own wall clock
  // (fitWatchdog); one the operator set explicitly must already fit the default job.
  if (codex.responseTimeoutMs !== undefined && codex.responseTimeoutMs >= timeoutMs) {
    throw new Error(`codex.responseTimeoutMs (${codex.responseTimeoutMs} ms) must be shorter than the job timeout (${timeoutMs} ms), or the job is killed before the stall is reported`);
  }
  for (const name of ["startupTimeoutMs", "responseTimeoutMs"] as const) {
    const ms = claude[name];
    if (ms !== undefined && ms >= timeoutMs) {
      throw new Error(`claude.${name} (${ms} ms) must be shorter than the job timeout (${timeoutMs} ms), or the job is killed before the stall is reported`);
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
    maxTimeoutMs,
    env: {
      [CODING_HARNESS_ENV]: options.harness,
      ...(claude.command !== undefined ? { [CLAUDE_BIN_ENV]: claude.command } : {}),
      ...(claude.model !== undefined ? { [CLAUDE_MODEL_ENV]: claude.model } : {}),
      ...(claude.configDir !== undefined ? { [CLAUDE_CONFIG_DIR_ENV]: claude.configDir } : {}),
      ...(claude.passEnv !== undefined ? { [CLAUDE_PASS_ENV_ENV]: claude.passEnv.join(",") } : {}),
      ...(claude.startupTimeoutMs !== undefined ? { [CLAUDE_STARTUP_TIMEOUT_ENV]: String(claude.startupTimeoutMs) } : {}),
      ...(claude.responseTimeoutMs !== undefined ? { [CLAUDE_RESPONSE_TIMEOUT_ENV]: String(claude.responseTimeoutMs) } : {}),
      ...(codex.command !== undefined ? { [CODEX_BIN_ENV]: codex.command } : {}),
      ...(codex.model !== undefined ? { [CODEX_MODEL_ENV]: codex.model } : {}),
      ...(codex.reasoningEffort !== undefined ? { [CODEX_REASONING_EFFORT_ENV]: codex.reasoningEffort } : {}),
      ...(codex.codexHome !== undefined ? { [CODEX_HOME_ENV]: codex.codexHome } : {}),
      ...(codex.passEnv !== undefined ? { [CODEX_PASS_ENV_ENV]: codex.passEnv.join(",") } : {}),
      ...(codex.responseTimeoutMs !== undefined ? { [CODEX_RESPONSE_TIMEOUT_ENV]: String(codex.responseTimeoutMs) } : {}),
      ...(pi.provider !== undefined ? { [PI_PROVIDER_ENV]: pi.provider } : {}),
      ...(pi.modelId !== undefined ? { [PI_MODEL_ENV]: pi.modelId } : {}),
      ...(pi.agentDir !== undefined ? { [PI_AGENT_DIR_ENV]: pi.agentDir } : {}),
      ...(pi.passEnv !== undefined ? { [PI_PASS_ENV_ENV]: pi.passEnv.join(",") } : {}),
    },
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
}
