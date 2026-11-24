// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Where a run-scoped command (`inspect`, `stats`, `wait`, `watch`, `stop`,
 * `resume`, `delete`, `replay`, `switch-model`, `session`) finds the run its
 * `<stateDir|runId>` names (docs/design-typescript-core.md §2): a state
 * directory as given; a run ID under `--state-root`; a bare run ID under the
 * default state root of the repository the command runs in
 * (`<repo>/graphloom-state`), then under the run hub's runs directory
 * (`<hub directory>/runs`, docs/design-run-hub.md). The controller only ever
 * sees the state directory found here: the hub is the CLI's notion.
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSafeRunId, defaultStateRoot } from "@graphloom/controller";
import { hubPaths, loadHubConfig } from "./hub-config.js";

const execFileAsync = promisify(execFile);

/** Whether `value` names a path rather than a bare run ID. */
export function isPathRef(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("/") || value.includes("\\");
}

const hasState = (dir: string): Promise<boolean> => access(path.join(dir, "state.json")).then(() => true, () => false);

/** The state roots a bare run ID is looked for under, in order, each with what it is. */
export async function runSearchRoots(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Array<{ root: string; what: string }>> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const repo = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1" } })
    .then(({ stdout }) => stdout.trim() || cwd, () => cwd);
  const hub = await loadHubConfig(undefined, env).then((c) => c.directory, () => hubPaths(env).directory);
  return [
    { root: defaultStateRoot(repo), what: "the default state root" },
    { root: path.join(hub, "runs"), what: "the run hub's runs" },
  ];
}

/**
 * The state directory `ref` names, or an operator-facing error that says
 * where it looked and how to name the run otherwise.
 */
export async function locateRun(ref: string, stateRoot?: string, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  if (isPathRef(ref)) {
    const dir = path.resolve(cwd, ref);
    if (await hasState(dir)) return dir;
    throw new Error(`no run at ${dir}: it holds no state.json; name a run's state directory, or its run ID`);
  }
  const runId = (() => {
    try { return assertSafeRunId(ref); }
    catch { throw new Error(`${JSON.stringify(ref)} is neither a run ID nor a state directory`); }
  })();
  if (stateRoot !== undefined) {
    const root = path.resolve(cwd, stateRoot);
    const dir = path.join(root, runId);
    if (await hasState(dir)) return dir;
    throw new Error(`no run ${runId} under --state-root ${root}`);
  }
  const roots = await runSearchRoots(options);
  for (const { root } of roots) {
    const dir = path.join(root, runId);
    if (await hasState(dir)) return dir;
  }
  throw new Error(`no run ${runId} found; looked in ${roots.map((r) => `${r.root} (${r.what})`).join(", ")}; name its state directory, or pass --state-root <dir> for a run under another state root`);
}
