// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmod, lstat, mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCandidateStepsUnchanged,
  digestDirectoryTree,
  makeTreeWritable,
  snapshotRepairCandidate,
  unreviewedEntries,
} from "./repair.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) {
      spawnSync("chmod", ["-R", "u+w", dir]);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe("unreviewedEntries", () => {
  it("finds node_modules and .git the digest skips, allowing only linked dependencies when asked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-unreviewed-"));
    temps.push(root);
    const target = path.join(root, "installed");
    await mkdir(target, { recursive: true });
    const candidate = path.join(root, "candidate");
    await mkdir(path.join(candidate, "node_modules", "@scope", "real"), { recursive: true });
    await mkdir(path.join(candidate, "node_modules", "shadow"), { recursive: true });
    await symlink(target, path.join(candidate, "node_modules", "linked"), "dir");
    await symlink(target, path.join(candidate, "node_modules", "@scope", "linked"), "dir");
    await mkdir(path.join(candidate, "dist", ".git"), { recursive: true });
    await mkdir(path.join(candidate, "src"), { recursive: true });
    await writeFile(path.join(candidate, "src", "index.ts"), "export {};\n", "utf8");

    expect(await unreviewedEntries(candidate)).toEqual(["dist/.git", "node_modules"]);
    expect(await unreviewedEntries(candidate, { linkedDependencies: true })).toEqual([
      "dist/.git",
      "node_modules/@scope/real",
      "node_modules/shadow",
    ]);
    expect(await unreviewedEntries(path.join(candidate, "src"))).toEqual([]);
  });

  it("ignores vitest's own cache directories inside a linked node_modules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-unreviewed-"));
    temps.push(root);
    const target = path.join(root, "installed");
    await mkdir(target, { recursive: true });
    const candidate = path.join(root, "candidate");
    await mkdir(path.join(candidate, "node_modules", ".vite"), { recursive: true });
    await mkdir(path.join(candidate, "node_modules", ".vite-temp"), { recursive: true });
    await symlink(target, path.join(candidate, "node_modules", "linked"), "dir");

    expect(await unreviewedEntries(candidate, { linkedDependencies: true })).toEqual([]);
  });
});

describe("repair snapshot", () => {
  it("copies the bundle into an isolated candidate without mutating the source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const bundle = path.join(root, "bundle");
    const repairs = path.join(root, "repairs");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, "validator.js"), "export const bad = true;\n", "utf8");

    const snap = await snapshotRepairCandidate({
      bundlePath: bundle,
      repairsDir: repairs,
      baseActiveVersion: "hello@0.1.0",
      target: "validator",
      reason: "defective gate",
    });

    expect(snap.baseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.candidateRoot).toContain(snap.artifactId);
    const source = await readFile(path.join(bundle, "validator.js"), "utf8");
    expect(source).toBe("export const bad = true;\n");
    await writeFile(
      path.join(snap.candidateRoot, "validator.js"),
      "export const bad = false;\n",
      "utf8",
    );
    expect(await readFile(path.join(bundle, "validator.js"), "utf8")).toBe(
      "export const bad = true;\n",
    );
    expect(await digestDirectoryTree(snap.candidateRoot)).not.toBe(snap.baseDigest);
  });

  it("makes the candidate writable when the bundle is in a read-only version directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const bundle = path.join(root, "versions", "0.1.0", "examples", "plugins", "hello");
    const repairs = path.join(root, "repairs");
    await mkdir(path.join(bundle, "src"), { recursive: true });
    await writeFile(path.join(bundle, "src", "index.ts"), "export const v = 1;\n", "utf8");
    await writeFile(path.join(bundle, "package.json"), "{}\n", "utf8");
    await symlink("src/index.ts", path.join(root, "outside-link"));
    // As install.sh leaves an installed version: nothing in it is writable.
    expect(spawnSync("chmod", ["-R", "a-w", path.join(root, "versions")]).status).toBe(0);
    await expect(writeFile(path.join(bundle, "src", "index.ts"), "x")).rejects.toThrow();

    const snap = await snapshotRepairCandidate({
      bundlePath: bundle,
      repairsDir: repairs,
      baseActiveVersion: "hello@0.1.0",
      target: "plugin",
      reason: "read-only install",
    });
    await writeFile(path.join(snap.candidateRoot, "src", "index.ts"), "export const v = 2;\n", "utf8");
    await writeFile(path.join(snap.candidateRoot, "src", "new.ts"), "export {};\n", "utf8");
    await mkdir(path.join(snap.candidateRoot, "dist"));
    expect(await readFile(path.join(bundle, "src", "index.ts"), "utf8")).toBe("export const v = 1;\n");
    expect((await lstat(path.join(bundle, "src"))).mode & 0o222).toBe(0);
  });

  it("makeTreeWritable adds owner write without following symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const target = path.join(root, "target.txt");
    await writeFile(target, "t", "utf8");
    await chmod(target, 0o444);
    const tree = path.join(root, "tree");
    await mkdir(path.join(tree, "a"), { recursive: true });
    await writeFile(path.join(tree, "a", "f.txt"), "f", "utf8");
    await symlink(target, path.join(tree, "a", "link"));
    await chmod(path.join(tree, "a", "f.txt"), 0o444);
    await chmod(path.join(tree, "a"), 0o555);
    await makeTreeWritable(tree);
    expect((await lstat(path.join(tree, "a"))).mode & 0o777).toBe(0o755);
    expect((await lstat(path.join(tree, "a", "f.txt"))).mode & 0o777).toBe(0o644);
    expect((await lstat(target)).mode & 0o777).toBe(0o444);
  });

  it("gives concurrent qualify attempts separate candidate trees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const bundle = path.join(root, "bundle");
    const repairs = path.join(root, "repairs");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, "a.txt"), "x\n", "utf8");

    const a = await snapshotRepairCandidate({
      bundlePath: bundle,
      repairsDir: repairs,
      baseActiveVersion: "hello@0.1.0",
      target: "plugin",
      reason: "one",
    });
    const b = await snapshotRepairCandidate({
      bundlePath: bundle,
      repairsDir: repairs,
      baseActiveVersion: "hello@0.1.0",
      target: "plugin",
      reason: "two",
    });
    expect(a.artifactId).not.toBe(b.artifactId);
    expect(a.candidateRoot).not.toBe(b.candidateRoot);
    expect(a.baseDigest).toBe(b.baseDigest);
  });

  it("rejects candidates that alter pinned stage order/ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const candidate = path.join(root, "candidate");
    await mkdir(candidate, { recursive: true });
    await writeFile(
      path.join(candidate, "graphloom.stages.json"),
      JSON.stringify({
        stages: [
          { id: "review", name: "Review", requirementIds: ["independent-review"] },
          { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
        ],
      }),
      "utf8",
    );
    await expect(
      assertCandidateStepsUnchanged({
        baseDefinitionStages: [
          { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
          { id: "review", name: "Review", requirementIds: ["independent-review"] },
        ],
        candidateRoot: candidate,
      }),
    ).rejects.toThrow(/alters pinned steps/i);
  });

  it("rejects a missing stages pin instead of deferring", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const candidate = path.join(root, "candidate");
    await mkdir(candidate, { recursive: true });
    await expect(
      assertCandidateStepsUnchanged({
        baseDefinitionStages: [
          { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
        ],
        candidateRoot: candidate,
      }),
    ).rejects.toThrow(/missing required stages pin/i);
  });

  it("rejects symlinks inside a candidate tree during digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-repair-"));
    temps.push(root);
    const candidate = path.join(root, "candidate");
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "ok.txt"), "x\n", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink("/tmp", path.join(candidate, "escape"));
    await expect(digestDirectoryTree(candidate)).rejects.toThrow(/symlink/i);
  });
});
