// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// A run-scoped command's `<stateDir|runId>` (docs/design-typescript-core.md §2): a bare run ID resolves under the
// default state root, then the run hub's runs, with an operator-facing error when it is nowhere. Temporary HOME, state
// and config homes only: never the operator's hub.

import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createController } from "@graphloom/controller";
import { createScriptedRunner } from "@graphloom/runner";
import { createScriptedGraph, stop, type GraphDefinition } from "@graphloom/sdk";
import { HELLO_VERSION } from "@graphloom/testkit";
import { locateRun } from "../src/run-ref.js";
import { execFileAsync, makeCliEnv, repoRoot } from "./cli-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/stats/395ec998-6e4");
const RUN = "395ec998-6e4";
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A repository (the command's cwd), a hub directory, and an environment that points only at them. */
async function homes() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-run-ref-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  await mkdir(path.join(repo, "sub"), { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  const hub = path.join(dir, "state", "graphloom", "hub");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GRAPHLOOM_") && !name.startsWith("XDG_")));
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: dir, XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), XDG_RUNTIME_DIR: path.join(dir, "run") };
  const place = async (root: string, runId = RUN) => {
    await cp(fixture, path.join(root, runId), { recursive: true });
    return path.join(root, runId);
  };
  return { dir, repo, hub, env, place };
}

describe("locateRun", () => {
  it("finds a bare run ID under the default state root of the repository the command runs in, then under the hub's runs", async () => {
    const h = await homes();
    const inHub = await h.place(path.join(h.hub, "runs"));
    expect(await locateRun(RUN, undefined, { env: h.env, cwd: path.join(h.repo, "sub") })).toBe(inHub);
    // The repository's own state root comes first.
    const inRepo = await h.place(path.join(h.repo, "graphloom-state"));
    expect(await locateRun(RUN, undefined, { env: h.env, cwd: path.join(h.repo, "sub") })).toBe(inRepo);
    // A hub whose config names another directory is looked for there.
    const moved = path.join(h.dir, "elsewhere");
    await mkdir(path.join(h.dir, "config", "graphloom"), { recursive: true });
    await writeFile(path.join(h.dir, "config", "graphloom", "hub.json"), JSON.stringify({ directory: moved }));
    const other = await h.place(path.join(moved, "runs"), "r-moved");
    expect(await locateRun("r-moved", undefined, { env: h.env, cwd: h.repo })).toBe(other);
  });

  it("takes a state directory as given and a run ID under --state-root, and refuses what is not there in the operator's words", async () => {
    const h = await homes();
    const root = path.join(h.dir, "custom");
    const dir = await h.place(root);
    expect(await locateRun(dir, undefined, { env: h.env, cwd: h.repo })).toBe(dir);
    expect(await locateRun(path.relative(h.repo, dir), undefined, { env: h.env, cwd: h.repo })).toBe(dir);
    expect(await locateRun(RUN, root, { env: h.env, cwd: h.repo })).toBe(dir);
    await expect(locateRun("nope", root, { env: h.env, cwd: h.repo })).rejects.toThrow(`no run nope under --state-root ${root}`);
    await expect(locateRun(path.join(root, "nope"), undefined, { env: h.env, cwd: h.repo })).rejects.toThrow(`no run at ${path.join(root, "nope")}: it holds no state.json`);
    await expect(locateRun("a..b", undefined, { env: h.env, cwd: h.repo })).rejects.toThrow('"a..b" is neither a run ID nor a state directory');
    const missing = locateRun(RUN, undefined, { env: h.env, cwd: h.repo });
    await expect(missing).rejects.toThrow(`no run ${RUN} found; looked in ${path.join(h.repo, "graphloom-state")} (the default state root), ${path.join(h.hub, "runs")} (the run hub's runs)`);
    await expect(missing).rejects.toThrow("pass --state-root <dir>");
  });
});

describe("run-scoped commands by bare run ID", () => {
  it("inspect and stats find a hub run with no --state-root, and every such command says where it looked when it is nowhere", async () => {
    const cli_ = await makeCliEnv(cleanups);
    const hub = path.join(cli_.dir, "state", "graphloom", "hub");
    const definition: GraphDefinition = {
      graphId: "hello",
      version: HELLO_VERSION,
      stages: [
        { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
        { id: "review", name: "Review", requirementIds: ["independent-review"] },
      ],
      requirements: [
        { id: "greeting-bytes", statement: "GREETING.txt contains exactly the UTF-8 bytes Hello, GraphLoom!\\n and is the only changed path in the workspace (excluding Git metadata).", evidenceSchema: "workspace-bytes-v1" },
        { id: "independent-review", statement: "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.", evidenceSchema: "review-verdict-v1" },
      ],
      defaultValidators: [
        { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
        { requirementId: "independent-review", validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" },
      ],
    };
    const none = { evaluate: () => ({ status: "inconclusive" as const, reason: "none" }) };
    const report = await createController().run({
      taskPath: path.join(cli_.dir, "task.yaml"),
      plugin: createScriptedGraph({ definition, advances: [stop({ reason: "waiting on the operator", blocker: "waiting" }, "wait")] }),
      validators: { "exact-greeting": none, "independent-reviewer": none },
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: path.join(hub, "runs"),
      runId: "r-hub",
    });
    expect(report.stateDir).toBe(path.join(hub, "runs", "r-hub"));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GRAPHLOOM_") && !name.startsWith("XDG_")));
    const env: NodeJS.ProcessEnv = { ...inherited, HOME: cli_.dir, XDG_STATE_HOME: path.join(cli_.dir, "state"), XDG_CONFIG_HOME: path.join(cli_.dir, "config"), XDG_RUNTIME_DIR: path.join(cli_.dir, "run") };
    const run = (...args: string[]) => execFileAsync(process.execPath, [cli, ...args], { cwd: cli_.dir, env, maxBuffer: 16 * 1024 * 1024 });
    expect(JSON.parse((await run("inspect", "r-hub")).stdout)).toMatchObject({ runId: "r-hub", status: "stopped" });
    expect(JSON.parse((await run("stats", "r-hub", "--json")).stdout)).toMatchObject({ runId: "r-hub" });
    const roots = `${path.join(cli_.dir, "graphloom-state")} (the default state root), ${path.join(hub, "runs")} (the run hub's runs)`;
    for (const args of [["inspect", "r-none"], ["stats", "r-none"], ["wait", "r-none"], ["watch", "r-none"], ["stop", "r-none"], ["resume", "r-none", "--rehearsal"], ["delete", "r-none"], ["replay", "r-none"], ["switch-model", "r-none", "m", "--reason", "x"], ["session", "list", "r-none"]]) {
      const failed = await run(...args).then(() => undefined, (err: { stderr?: string }) => err.stderr ?? "");
      expect(failed, args.join(" ")).toContain(`no run r-none found; looked in ${roots}`);
      expect(failed, args.join(" ")).not.toContain("stateRoot required");
    }
  }, 60_000);
});
