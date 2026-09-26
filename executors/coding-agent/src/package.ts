import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { CODING_HARNESS_ENV } from "./executors.js";
import { PI_AGENT_DIR_ENV, PI_API_KEY_CREDENTIAL, PI_MODEL_ENV, PI_PROVIDER_ENV } from "./pi-config.js";
import { CODING_AGENT_RUN_ID } from "./run.js";

/** Host-facing declaration; the host runs `entryModule` in an executor process and never imports it. */
export const codingAgentExecutorPackage: ExecutorPackageManifest = {
  name: "@graphloom/executor-coding-agent",
  entryModule: fileURLToPath(new URL("./executors.js", import.meta.url)),
  executorIds: [CODING_AGENT_RUN_ID],
  credentials: [PI_API_KEY_CREDENTIAL],
  configEnv: [CODING_HARNESS_ENV, PI_PROVIDER_ENV, PI_MODEL_ENV, PI_AGENT_DIR_ENV],
  // The agent edits the worktree and runs commands as the user.
  isolation: "unrestricted",
};

/** Absolute path of the Pi harness module, for `codingAgentBinding({ harness })`. */
export const piHarnessModule = fileURLToPath(new URL("./pi.js", import.meta.url));

/** Operator settings for the Pi harness. The API key travels as a credential, never as config. */
export interface PiBindingOptions {
  provider?: string;
  modelId?: string;
  agentDir?: string;
  apiKey?: string;
}

export interface CodingAgentBindingOptions {
  /** Absolute path (or package specifier) of the harness adapter module. */
  harness: string;
  pi?: PiBindingOptions;
}

/**
 * Operator binding for the coding agent: selects the harness and consents to
 * running it unrestricted. The controller admits its tool calls and budgets,
 * but cannot confine what the agent does in the worktree.
 */
export function codingAgentBinding(options: CodingAgentBindingOptions): ExecutorBinding {
  const pi = options.pi ?? {};
  const credentials: Record<string, string> = {
    ...(pi.apiKey !== undefined ? { [PI_API_KEY_CREDENTIAL]: pi.apiKey } : {}),
  };
  return {
    allowedEffects: ["read", "write"],
    allowUnrestricted: true,
    env: {
      [CODING_HARNESS_ENV]: options.harness,
      ...(pi.provider !== undefined ? { [PI_PROVIDER_ENV]: pi.provider } : {}),
      ...(pi.modelId !== undefined ? { [PI_MODEL_ENV]: pi.modelId } : {}),
      ...(pi.agentDir !== undefined ? { [PI_AGENT_DIR_ENV]: pi.agentDir } : {}),
    },
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
}
