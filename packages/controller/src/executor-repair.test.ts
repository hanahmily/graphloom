import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QualifyRepairSpec } from "@graphloom/sdk";
import { assertAdmittedCandidateRoot } from "@graphloom/supervisor";
import { digestExecutorSource } from "@graphloom/runner";
import { executorRepairSubject } from "./executor-repair.js";
import type { DurableRunState, ExecutorCatalogEntry } from "./state.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakeExecutorPackage(): Promise<{ root: string; entryModule: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphloom-executor-pkg-"));
  cleanup.push(root);
  await mkdir(path.join(root, "dist"), { recursive: true });
  const entryModule = path.join(root, "dist", "index.js");
  await writeFile(entryModule, "export const ok = true;\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "test-executor" }));
  return { root, entryModule };
}

async function stateWithCatalogEntry(entry: ExecutorCatalogEntry): Promise<DurableRunState> {
  return { activeVersion: "test-graph@0.1.0", executorCatalog: [entry] } as unknown as DurableRunState;
}

describe("executorRepairSubject", () => {
  it("snapshot() writes the controller snapshot record a candidate-coding grant requires", async () => {
    const { root, entryModule } = await fakeExecutorPackage();
    const digest = await digestExecutorSource(root);
    const entry: ExecutorCatalogEntry = { id: "test.executor/run", digest, source: root, entryModule, isolation: "unrestricted", builtin: false };
    const state = await stateWithCatalogEntry(entry);
    const qualify: QualifyRepairSpec = { target: "executor", executorId: entry.id, reason: "test: enforce read-only on review jobs" };

    const subject = await executorRepairSubject(state, qualify);
    if ("error" in subject) throw new Error(subject.error);

    const repairsDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-repairs-"));
    cleanup.push(repairsDir);
    const artifactId = "repair-test1";
    const snap = await subject.snapshot({ repairsDir, artifactId });

    const record = JSON.parse(await readFile(path.join(repairsDir, artifactId, "snapshot.json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      artifactId,
      candidateRoot: snap.candidateRoot,
      target: "executor",
      executorId: entry.id,
      reason: qualify.reason,
      baseActiveVersion: "test-graph@0.1.0",
    });

    // The regression this guards: before the fix, snapshot() never wrote this
    // file, so the supervisor's own candidate-coding grant (which every real
    // executor repair goes through) always failed with "no controller
    // snapshot record" — making the "executor" repair target entirely unusable.
    await expect(assertAdmittedCandidateRoot(repairsDir, snap.candidateRoot)).resolves.toBe(snap.candidateRoot);
  });
});
