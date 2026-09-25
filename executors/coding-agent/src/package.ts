import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { CODING_HARNESS_ENV } from "./executors.js";
import { CODING_AGENT_RUN_ID } from "./run.js";

/** Host-facing declaration; the host runs `entryModule` in an executor process and never imports it. */
export const codingAgentExecutorPackage: ExecutorPackageManifest = {
  name: "@graphloom/executor-coding-agent",
  entryModule: fileURLToPath(new URL("./executors.js", import.meta.url)),
  executorIds: [CODING_AGENT_RUN_ID],
  configEnv: [CODING_HARNESS_ENV],
  // The agent edits the worktree and runs commands as the user.
  isolation: "unrestricted",
};

export interface CodingAgentBindingOptions {
  /** Absolute path (or package specifier) of the harness adapter module. */
  harness: string;
}

/**
 * Operator binding for the coding agent: selects the harness and consents to
 * running it unrestricted. The controller admits its tool calls and budgets,
 * but cannot confine what the agent does in the worktree.
 */
export function codingAgentBinding(options: CodingAgentBindingOptions): ExecutorBinding {
  return {
    allowedEffects: ["read", "write"],
    allowUnrestricted: true,
    env: { [CODING_HARNESS_ENV]: options.harness },
  };
}
