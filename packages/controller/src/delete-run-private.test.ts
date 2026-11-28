// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedRunner } from "@graphloom/runner";
import { createController } from "./index.js";

/** Records every tree `deleteRun` removes, and fails the one a test names (an interrupted delete). */
const removal = vi.hoisted(() => ({ order: [] as string[], failOn: undefined as string | undefined }));
vi.mock("./remove-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remove-tree.js")>();
  return {
    ...actual,
    removeTree: async (dir: string) => {
      removal.order.push(dir);
      if (removal.failOn !== undefined && path.basename(dir) === removal.failOn) throw new Error(`interrupted while removing ${dir}`);
      return actual.removeTree(dir);
    },
  };
});

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temps: string[] = [];
afterEach(async () => {
  removal.order.length = 0;
  removal.failOn = undefined;
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const GRAPH_JS = `import { observe, stop, validate } from "@graphloom/sdk";
const definition = {
  graphId: "tidy", version: "1.0.0",
  stages: [{ id: "survey", name: "Survey", requirementIds: ["surveyed"] }],
  requirements: [{ id: "surveyed", statement: "The machine was surveyed.", evidenceSchema: "survey-v1" }],
  defaultValidators: [{ requirementId: "surveyed", validatorId: "surveyed", version: "1" }],
};
export function createGraph() {
  return {
    describe: () => structuredClone(definition),
    advance(view) {
      if (view.receipts.some((r) => r.stageId === "survey" && r.valid)) return stop({ reason: "complete", blocker: "none" }, "surveyed");
      if (!view.evidence.some((e) => e.kind === "workspace")) return observe({ paths: [], includeWorkspaceManifest: true }, "look");
      return validate({ stageId: "survey", requirementIds: ["surveyed"] }, "surveyed");
    },
  };
}
export function validatorById(id) {
  return id === "surveyed" ? { evaluate: (input) => (input.evidence.some((e) => e.kind === "workspace") ? { status: "passed", reason: "surveyed" } : { status: "inconclusive", reason: "no survey" }) } : undefined;
}
`;

/** A finished run of a graph with `repository: "none"`: its private repository and linked worktree are in its state directory. */
async function noneRun(runId: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-delete-private-"));
  temps.push(dir);
  const bundle = path.join(dir, "task", "plugins", "tidy");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify({ graphId: "tidy", version: "1.0.0", sdkProtocol: 1, repository: "none", entryPoints: { createGraph: "./dist/index.js" } }));
  await writeFile(path.join(bundle, "package.json"), JSON.stringify({ name: "gl-tidy", version: "1.0.0", private: true, type: "module" }));
  await writeFile(path.join(bundle, "dist", "index.js"), GRAPH_JS);
  await symlink(path.join(root, "node_modules"), path.join(bundle, "node_modules"));
  const taskPath = path.join(dir, "task", "task.yaml");
  await writeFile(taskPath, 'graph: tidy\nrequest: "Survey."\n');
  const done = await createController().run({ taskPath, runner: createScriptedRunner({ jobs: [] }), stateRoot: path.join(dir, "state"), runId });
  expect(done.blocker).toBe("none");
  // Siblings of the repository created before and after it, so the directory listing's order (hashed, or by age) cannot hide a wrong removal order.
  const repository = path.join(done.stateDir, "repository");
  for (let i = 0; i < 12; i += 1) await writeFile(path.join(done.stateDir, `aa-before-${i}`), "x");
  await rename(repository, `${repository}.moved`);
  await rename(`${repository}.moved`, repository);
  for (let i = 0; i < 12; i += 1) await writeFile(path.join(done.stateDir, `zz-after-${i}`), "x");
  return { dir, stateDir: done.stateDir, repository: path.join(done.stateDir, "repository") };
}

describe("deleting a run of a graph that works without a repository", () => {
  it("removes the private repository last, immediately before state.json", async () => {
    const run = await noneRun("tidy-order");
    await createController().delete(run.stateDir);
    const top = removal.order.filter((dir) => path.dirname(dir) === run.stateDir).map((dir) => path.basename(dir));
    expect(top.slice(-2)).toEqual(["repository", "state.json"]);
    expect(existsSync(run.stateDir)).toBe(false);
  });

  it("finishes on retry after an interruption at state.json (the repository already gone)", async () => {
    const run = await noneRun("tidy-late");
    removal.failOn = "state.json";
    await expect(createController().delete(run.stateDir)).rejects.toThrow("interrupted while removing");
    expect(existsSync(path.join(run.stateDir, "state.json"))).toBe(true);
    expect(existsSync(run.repository)).toBe(false);
    removal.failOn = undefined;
    // The retry takes no lock inside, and so does not recreate, the repository that is gone.
    await createController().delete(run.stateDir);
    expect(existsSync(run.stateDir)).toBe(false);
  });

  it("keeps a complete repository for the retry when interrupted before it", async () => {
    const run = await noneRun("tidy-early");
    const others = (await readdir(run.stateDir)).filter((name) => !["state.json", "repository", "run.exec.lock"].includes(name));
    expect(others.length).toBeGreaterThan(0);
    removal.failOn = "repository";
    await expect(createController().delete(run.stateDir)).rejects.toThrow("interrupted while removing");
    // Everything that is not the repository went first; the repository is whole and state.json stays.
    expect((await readdir(run.stateDir)).filter((name) => name !== "run.exec.lock").sort()).toEqual(["repository", "state.json"]);
    expect((await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: run.repository })).stdout.trim()).toBe("true");
    removal.failOn = undefined;
    await createController().delete(run.stateDir);
    expect(existsSync(run.stateDir)).toBe(false);
  });

  it("deletes a run whose private repository went before state.json did (an interruption in the old order)", async () => {
    const run = await noneRun("tidy-gone");
    await rm(run.repository, { recursive: true, force: true });
    await createController().delete(run.stateDir);
    expect(existsSync(run.stateDir)).toBe(false);
  });

  it("deletes a run whose private repository is a directory that is no git repository", async () => {
    const run = await noneRun("tidy-empty");
    await rm(run.repository, { recursive: true, force: true });
    await mkdir(run.repository);
    await createController().delete(run.stateDir);
    expect(existsSync(run.stateDir)).toBe(false);
  });
  it("finishes a delete interrupted partway through the private repository, with and without force", async () => {
    // `.git/config` gone while HEAD, objects and refs survive: git still answers `.git`, but the owner record is lost.
    for (const force of [false, true]) {
      const run = await noneRun(force ? "tidy-half-force" : "tidy-half");
      await rm(path.join(run.repository, ".git", "config"), { force: true });
      await createController().delete(run.stateDir, { force });
      expect(existsSync(run.stateDir)).toBe(false);
    }
  });
});
