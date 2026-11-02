// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Run ownership end to end (docs/design-release.md §5.1, §5.2, §6 step 8.7,
 * phase R3): release trees that carry the real built CLI, controller, and
 * executors are installed with the real install.sh in a temporary HOME with no
 * Node on PATH. A rehearsal run stopped with `--stop-at` on one version is
 * dispatched to it from a later `current` and finishes there with no pin
 * mismatch; another is moved with `resume --upgrade --rehearsal`. The records
 * the CLI writes are the ones `self prune` keeps and `upgrade` lists.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISPATCHED_ENV, planDispatch, type SelfInstall } from "../src/ownership.js";
import { makeSandbox, realCli, removeTree, repoRoot, tempBase, type Sandbox } from "./install-env.js";

let base: string;
beforeAll(async () => {
  base = await tempBase("gl-ownership-");
});
afterAll(async () => {
  await removeTree(base);
});

const quiet = { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" };

/** A task beside a one-commit repository, with plugins/hello linked to this checkout's built bundle. */
async function helloTask(sb: Sandbox, name: string): Promise<string> {
  const dir = path.join(sb.root, name);
  const repo = path.join(dir, "test-repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(repoRoot, "examples/plugins/hello"), path.join(dir, "plugins", "hello"));
  const task = path.join(dir, "task.yaml");
  await writeFile(task, `graph: hello\nrepo: ./test-repo\nrequest: |\n  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by\n  one newline. Do not modify other files.\n`);
  return task;
}

function json<T>(r: { stdout: string; stderr: string; status: number | null }, what: string): T {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`${what}: exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
}

interface Stopped {
  ok: boolean;
  runId: string;
  stateDir: string;
  stoppedAt: string;
}

interface Inspect {
  status: string;
  stopReason?: string;
  install?: { version: string; root: string };
  installHistory: Array<{ from?: { version: string }; to: { version: string } }>;
  executorTransitions: Array<{ id: string; fromSource?: string; toSource?: string }>;
  stateFormat: number;
}

describe("run ownership across installed versions (no Node on PATH)", () => {
  it("records, dispatches, upgrades, prunes, and refuses per the design", async () => {
    const sb = await makeSandbox(base);
    for (const v of ["0.1.0", "0.1.1", "0.2.0"]) await sb.publish(v, { populate: realCli, release: { stateFormat: 2 } });
    const install = sb.installer(["--version", "0.1.0"]);
    expect(install.status, install.stderr).toBe(0);
    const v010 = path.join(sb.ghome, "versions", "0.1.0");

    // Two kept rehearsal runs on 0.1.0, stopped after Write; the CLI records their owner.
    const task = await helloTask(sb, "task");
    const stopA = sb.graphloom(["rehearse", task, "--stop-at", "Write"], quiet);
    const a = json<Stopped>(stopA, "rehearse --stop-at");
    expect(stopA.status, stopA.stderr).toBe(0);
    expect(a).toMatchObject({ ok: true, stoppedAt: "Write" });
    const b = json<Stopped>(sb.graphloom(["rehearse", task, "--stop-at", "write"], quiet), "rehearse --stop-at (stage id)");
    expect(b.ok).toBe(true);
    const recordA = JSON.parse(sb.read(`runs/${a.runId}.json`)!) as Record<string, string>;
    expect(recordA).toEqual({ version: "0.1.0", stateDir: a.stateDir, plugin: path.join(path.dirname(task), "plugins", "hello") });
    expect(json<Inspect>(sb.graphloom(["inspect", a.stateDir], quiet), "inspect").install).toEqual({ version: "0.1.0", root: v010 });

    // A newer current lists the runs still on 0.1.0; prune keeps 0.1.0 for them (it is neither current nor previous).
    expect(sb.graphloom(["upgrade", "0.1.1"], quiet).status).toBe(0);
    const up = sb.graphloom(["upgrade", "0.2.0"], quiet);
    expect(up.status, up.stderr).toBe(0);
    expect(up.stdout).toContain("runs still on older versions");
    expect(up.stdout).toContain(`  ${a.runId}  0.1.0  stopped  graphloom resume ${a.runId} --upgrade`);
    expect(sb.current()).toBe("0.2.0");
    const prune = sb.graphloom(["self", "prune"], quiet);
    expect(prune.status, prune.stderr).toBe(0);
    expect(prune.stdout).toContain("nothing to prune");
    expect(sb.installed()).toEqual(["0.1.0", "0.1.1", "0.2.0"]);
    expect(sb.graphloom(["self", "list"], quiet).stdout).toContain("0.1.0 (owns 2 runs)");

    // inspect and resume under the new current run on the owner: same executor sources, no pin mismatch.
    const inspectA = sb.graphloom(["inspect", a.stateDir], quiet);
    expect(inspectA.stderr).toContain(`graphloom: run ${a.runId} belongs to GraphLoom 0.1.0; running inspect there (${path.join(v010, "bin", "graphloom")})`);
    expect(json<Inspect>(inspectA, "inspect via current").status).toBe("stopped");
    const resumeA = sb.graphloom(["resume", a.stateDir, "--rehearsal"], quiet);
    expect(resumeA.stderr).toContain(`run ${a.runId} belongs to GraphLoom 0.1.0`);
    const reportA = json<{ status: string; stopReason?: string }>(resumeA, "resume --rehearsal via current");
    expect(reportA.stopReason).not.toBe("executor pin mismatch");
    expect(reportA.status).toBe("succeeded");
    expect(resumeA.status).toBe(0);
    const doneA = json<Inspect>(sb.graphloom(["inspect", a.stateDir], quiet), "inspect A");
    expect(doneA.install?.version).toBe("0.1.0");
    expect(doneA.executorTransitions).toEqual([]);

    // resume --upgrade moves B to 0.2.0: re-pinned executors, recorded owner move, record moved.
    const resumeB = sb.graphloom(["resume", b.stateDir, "--upgrade", "--rehearsal"], quiet);
    expect(resumeB.stderr).not.toContain("belongs to GraphLoom");
    expect(json<{ status: string }>(resumeB, "resume --upgrade --rehearsal").status).toBe("succeeded");
    const movedB = json<Inspect>(sb.graphloom(["inspect", b.stateDir], quiet), "inspect B");
    expect(movedB.install).toEqual({ version: "0.2.0", root: path.join(sb.ghome, "versions", "0.2.0") });
    expect(movedB.installHistory).toEqual([expect.objectContaining({ from: { version: "0.1.0", root: v010 }, to: movedB.install })]);
    expect(movedB.stateFormat).toBe(2);
    expect(movedB.executorTransitions.length).toBeGreaterThan(0);
    for (const t of movedB.executorTransitions) {
      expect(t.fromSource?.startsWith(v010)).toBe(true);
      expect(t.toSource?.startsWith(path.join(sb.ghome, "versions", "0.2.0"))).toBe(true);
    }
    expect(JSON.parse(sb.read(`runs/${b.runId}.json`)!)).toMatchObject({ version: "0.2.0", stateDir: b.stateDir });

    // A downgrade is refused, with the run unchanged: 0.1.1 cannot take B back.
    const before = readFileSync(path.join(b.stateDir, "state.json"), "utf8");
    const down = spawnSync(path.join(sb.ghome, "versions", "0.1.1", "bin", "graphloom"), ["resume", b.stateDir, "--upgrade", "--rehearsal"], { encoding: "utf8", env: { ...sb.env, ...quiet } });
    expect(down.status).toBe(1);
    expect(down.stderr).toContain("cannot upgrade: downgrade: run");
    expect(down.stderr).toContain("belongs to GraphLoom 0.2.0, which is newer than 0.1.1");
    expect(readFileSync(path.join(b.stateDir, "state.json"), "utf8")).toBe(before);

    // A clone (no install root) dispatches a run an installed version owns, found under $GRAPHLOOM_HOME.
    const fromClone = spawnSync(process.execPath, [path.join(repoRoot, "apps", "graphloom", "dist", "main.js"), "inspect", b.stateDir], {
      encoding: "utf8",
      env: { ...sb.env, ...quiet, GRAPHLOOM_HOME: sb.ghome },
    });
    expect(fromClone.stderr).toContain(`run ${b.runId} belongs to GraphLoom 0.2.0; running inspect there`);
    expect(json<Inspect>(fromClone, "inspect from a clone").status).toBe("succeeded");

    // Without its records, nothing keeps 0.1.0; with them, prune --force is needed. Pruning the owner leaves runs refused.
    await rename(path.join(sb.ghome, "runs"), path.join(sb.ghome, "runs.away"));
    expect(sb.graphloom(["self", "prune", "--dry-run"], quiet).stdout).toContain("would remove 0.1.0");
    await rename(path.join(sb.ghome, "runs.away"), path.join(sb.ghome, "runs"));
    expect(sb.graphloom(["self", "prune", "--dry-run"], quiet).stdout).not.toContain("would remove 0.1.0");
    expect(sb.graphloom(["self", "prune", "--force"], quiet).stdout).toContain("removed 0.1.0");
    const orphan = sb.graphloom(["inspect", a.stateDir], quiet);
    expect(orphan.status).toBe(1);
    expect(orphan.stderr).toContain(
      `graphloom: run ${a.runId} belongs to GraphLoom 0.1.0, which is not installed; reinstall it with graphloom upgrade 0.1.0 --no-switch, or move the run here with graphloom resume ${a.stateDir} --upgrade`,
    );
    const restored = sb.graphloom(["upgrade", "0.1.0", "--no-switch"], quiet);
    expect(restored.status, restored.stderr).toBe(0);
    expect(sb.current()).toBe("0.2.0");
    expect(sb.graphloom(["inspect", a.stateDir], quiet).stderr).toContain("running inspect there");

    // delete removes the run's record with it.
    const del = sb.graphloom(["delete", b.stateDir, "--force"], quiet);
    expect(del.status, del.stderr).toBe(0);
    expect(sb.read(`runs/${b.runId}.json`)).toBeUndefined();
  }, 300_000);
});

describe("planDispatch (§5.1)", () => {
  const installed = (version: string, home = "/h"): SelfInstall => ({ record: { version, root: `${home}/versions/${version}` }, home });
  const clone: SelfInstall = { record: { version: "0.2.0-dev+abc1234", root: "/src/graphloom" } };
  const run = { runId: "r1", ref: "/repo/graphloom-state/r1" };

  it("runs a run with no owner, or a clone's run, where it is invoked", () => {
    expect(planDispatch(installed("0.2.0"), undefined, run, { home: "/h" })).toEqual({ kind: "here" });
    expect(planDispatch(installed("0.2.0"), { version: "0.1.0-dev+abc", root: "/src/old" }, run, { home: "/h" })).toEqual({ kind: "here" });
    expect(planDispatch(clone, { version: "0.2.0-dev+def", root: "/src/other" }, run, { home: "/h" })).toEqual({ kind: "here" });
  });

  it("runs its own runs here and leaves --upgrade to move the run", () => {
    expect(planDispatch(installed("0.2.0"), { version: "0.2.0", root: "/h/versions/0.2.0" }, run, { home: "/h" })).toEqual({ kind: "here" });
    expect(planDispatch(installed("0.2.0"), { version: "0.1.0", root: "/h/versions/0.1.0" }, run, { home: "/h", upgrade: true })).toEqual({ kind: "here" });
  });

  it("refuses a run whose owner is not installed, naming the ways forward", () => {
    const plan = planDispatch(clone, { version: "0.1.0", root: "/nowhere/versions/0.1.0" }, run, { home: "/nowhere" });
    expect(plan).toEqual({
      kind: "refuse",
      message: "run r1 belongs to GraphLoom 0.1.0, which is not installed; reinstall it with graphloom upgrade 0.1.0 --no-switch, or move the run here with graphloom resume /repo/graphloom-state/r1 --upgrade",
    });
  });

  it("never bounces a dispatched run again", async () => {
    const home = path.join(base, "bounce");
    const root = path.join(home, "versions", "0.1.0");
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin", "graphloom"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(root, "release.json"), JSON.stringify({ product: "graphloom", version: "0.1.0" }));
    const owner = { version: "0.1.0", root };
    expect(planDispatch(installed("0.2.0", home), owner, run, { home })).toEqual({ kind: "exec", bin: path.join(root, "bin", "graphloom"), version: "0.1.0" });
    expect(planDispatch(installed("0.2.0", home), owner, run, { home, env: { [DISPATCHED_ENV]: "0.2.0" } })).toMatchObject({ kind: "refuse" });
    // The same version installed in another home is not the owner while the recorded one exists.
    const otherHome = path.join(base, "other-home");
    expect(planDispatch(installed("0.1.0", otherHome), owner, run, { home: otherHome })).toEqual({ kind: "exec", bin: path.join(root, "bin", "graphloom"), version: "0.1.0" });
    expect(planDispatch(installed("0.1.0", otherHome), { version: "0.1.0", root: path.join(base, "gone", "versions", "0.1.0") }, run, { home: otherHome })).toEqual({ kind: "here" });
    // A hook the owner ran, calling back through a newer current, still reaches the owner.
    expect(planDispatch(installed("0.2.0", home), owner, run, { home, env: { [DISPATCHED_ENV]: "0.1.0" } })).toMatchObject({ kind: "exec" });
  });
});
