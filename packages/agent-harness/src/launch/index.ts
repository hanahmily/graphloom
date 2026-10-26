// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What a confined launch must keep available to the agent process: the
 * directories it may write, writable directories that are the agent's own
 * state (its login, which may legitimately be links), and paths it reads.
 */
export interface LaunchScope {
  writable?: readonly string[];
  trustedWritable?: readonly string[];
  readPaths?: readonly string[];
}

/** The process a driver spawns. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Turns the agent command a driver wants to run into the process it spawns.
 * A caller that confines its agents injects one wrapping the command (the
 * runner's `confineWorker`); the library itself never depends on the runner.
 */
export type Launch = (command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, scope: LaunchScope) => LaunchSpec;

/** Runs the command as given, unconfined: the drivers' default. */
export const directLaunch: Launch = (command, args, env) => ({ command, args: [...args], env });
