import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { COMMAND_RUN_ID } from "./run.js";

/**
 * Where the operator's coding agents and their logins are, as the agent
 * harnesses are configured, so a command such as an environment check finds
 * each agent the way its harness does.
 */
export const AGENT_LOCATION_ENV = ["GRAPHLOOM_CLAUDE_BIN", "GRAPHLOOM_CLAUDE_CONFIG_DIR", "GRAPHLOOM_CODEX_BIN", "GRAPHLOOM_CODEX_HOME"];

/** Host-facing declaration; the host runs `entryModule` in an executor process and never imports it. */
export const commandExecutorPackage: ExecutorPackageManifest = {
  name: "@graphloom/executor-command",
  entryModule: fileURLToPath(new URL("./executors.js", import.meta.url)),
  executorIds: [COMMAND_RUN_ID],
  configEnv: AGENT_LOCATION_ENV,
  // Commands run as the user, with the user's PATH and toolchains.
  isolation: "unrestricted",
};

export interface CommandBindingOptions {
  /** Wall-clock limit (ms) for one job, covering all of its commands. Default: two hours. */
  timeoutMs?: number;
  /** Agent locations (`AGENT_LOCATION_ENV` names) every command sees. */
  env?: Record<string, string>;
}

export const DEFAULT_COMMAND_JOB_TIMEOUT_MS = 2 * 60 * 60_000;

/** Operator binding: consents to running commands unrestricted in the job's workspace. */
export function commandBinding(options: CommandBindingOptions = {}): ExecutorBinding {
  const env = options.env ?? {};
  for (const name of Object.keys(env)) {
    if (!AGENT_LOCATION_ENV.includes(name)) throw new Error(`the command executor does not accept configuration "${name}"`);
  }
  return {
    allowedEffects: ["read", "write"],
    allowUnrestricted: true,
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_JOB_TIMEOUT_MS,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
