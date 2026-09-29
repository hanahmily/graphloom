import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { COMMAND_RUN_ID } from "./run.js";

/** Host-facing declaration; the host runs `entryModule` in an executor process and never imports it. */
export const commandExecutorPackage: ExecutorPackageManifest = {
  name: "@graphloom/executor-command",
  entryModule: fileURLToPath(new URL("./executors.js", import.meta.url)),
  executorIds: [COMMAND_RUN_ID],
  // Commands run as the user, with the user's PATH and toolchains.
  isolation: "unrestricted",
};

export interface CommandBindingOptions {
  /** Wall-clock limit (ms) for one job, covering all of its commands. Default: two hours. */
  timeoutMs?: number;
}

export const DEFAULT_COMMAND_JOB_TIMEOUT_MS = 2 * 60 * 60_000;

/** Operator binding: consents to running commands unrestricted in the job's workspace. */
export function commandBinding(options: CommandBindingOptions = {}): ExecutorBinding {
  return {
    allowedEffects: ["read", "write"],
    allowUnrestricted: true,
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_JOB_TIMEOUT_MS,
  };
}
