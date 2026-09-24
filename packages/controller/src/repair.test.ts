import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCandidateStepsUnchanged,
  digestDirectoryTree,
  snapshotRepairCandidate,
} from "./repair.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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
});
