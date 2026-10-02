import { cp, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { QualifyRepairSpec } from "@graphloom/sdk";
import { describeExecutorModule, digestExecutorSource, type DescribedExecutor } from "@graphloom/runner";
import { invalidateStageAndAfter } from "./admit.js";
import { catalogEntry } from "./executor-catalog.js";
import { bumpGeneration } from "./generation.js";
import {
  assertCandidateFullyReviewed,
  assertDependenciesUnchanged,
  linkDependencies,
  type QualifiedRepairArtifact,
} from "./repair.js";
import type { RepairSubject } from "./repair-lifecycle.js";
import { saveRunState, type DurableRunState, type ExecutorCatalogEntry } from "./state.js";

/** Where the executor's package currently comes from: its run-local repair, or the install. */
function currentSource(entry: ExecutorCatalogEntry): { root: string; entryModule: string } | undefined {
  if (entry.repair !== undefined) return { root: entry.repair.root, entryModule: entry.repair.entryModule };
  if (entry.entryModule !== undefined) return { root: entry.source, entryModule: entry.entryModule };
  return undefined;
}

/** Catalog entries served by the same package as `entry`; a repair replaces them together. */
function packageEntries(state: DurableRunState, root: string): ExecutorCatalogEntry[] {
  return (state.executorCatalog ?? []).filter((e) => currentSource(e)?.root === root);
}

/**
 * Executor repairs copy the pinned executor's whole package into the run. The
 * copy must define exactly the executors, versions, and effects the original
 * does, so repair cannot introduce code the run never pinned.
 */
export async function executorRepairSubject(
  state: DurableRunState,
  qualify: QualifyRepairSpec,
): Promise<RepairSubject | { error: string }> {
  if (qualify.executorId === undefined) return { error: "executor repair requires executorId" };
  const entry = catalogEntry(state, qualify.executorId);
  if (entry === undefined) return { error: `executor ${qualify.executorId} is not pinned for this run` };
  const base = currentSource(entry);
  if (base === undefined) {
    return { error: `executor ${entry.id} is served from ${entry.source}, not a package that can be copied` };
  }
  const baseDigest = await digestExecutorSource(base.root).catch(() => undefined);
  if (baseDigest !== entry.digest) {
    return { error: `executor ${entry.id} source no longer matches the run's pin` };
  }
  const sandbox = entry.isolation === "sandbox";
  return {
    label: `executor package ${base.root}`,
    baseDigest,
    liveDigest: () => digestExecutorSource(base.root),
    async snapshot({ repairsDir, artifactId }) {
      const candidateRoot = path.join(repairsDir, artifactId, "candidate");
      await mkdir(path.dirname(candidateRoot), { recursive: true });
      const baseReal = await realpath(base.root);
      await cp(baseReal, candidateRoot, {
        recursive: true,
        dereference: true,
        filter: (src) => {
          const name = path.basename(src);
          return name !== "node_modules" && name !== ".git";
        },
      });
      await linkDependencies(baseReal, candidateRoot);
      return {
        candidateRoot,
        baseDigest: await digestExecutorSource(base.root),
        candidateEntryModule: path.join(candidateRoot, path.relative(base.root, base.entryModule)),
      };
    },
    async checkCandidate({ candidateRoot, candidateEntryModule }) {
      if (candidateEntryModule === undefined) throw new Error("executor candidate has no entry module");
      await assertCandidateFullyReviewed(candidateRoot, { linkedDependencies: true });
      await assertDependenciesUnchanged(await realpath(base.root), candidateRoot);
      const [pinned, candidate] = await Promise.all([
        describeExecutorModule({ entryModule: base.entryModule, sandbox }),
        describeExecutorModule({ entryModule: candidateEntryModule, sandbox }),
      ]);
      const want = contract(pinned);
      const got = contract(candidate);
      if (want !== got) {
        throw new Error(`candidate changes the executors its package defines: pinned ${want}, candidate ${got}`);
      }
    },
  };
}

function contract(executors: DescribedExecutor[]): string {
  return executors
    .map((e) => `${e.id}@${e.version ?? "unversioned"}:${e.effect}`)
    .sort()
    .join(", ");
}

/**
 * Serve the qualified copy for every executor of its package, in this run
 * only. The installed package is never modified. The copy's digest becomes
 * the pin, so dispatch and resume run exactly the reviewed bytes.
 */
export async function activateExecutorRepair(
  state: DurableRunState,
  candidates: QualifiedRepairArtifact[],
  idx: number,
  artifact: QualifiedRepairArtifact,
): Promise<DurableRunState> {
  const supersede = (stopReason: string, blocker: string): DurableRunState => {
    const next = [...candidates];
    next[idx] = { ...artifact, status: "superseded" };
    return { ...state, repairCandidates: next, status: "stopped", stopReason, blocker };
  };
  const entry = artifact.executorId !== undefined ? catalogEntry(state, artifact.executorId) : undefined;
  const base = entry !== undefined ? currentSource(entry) : undefined;
  if (entry === undefined || base === undefined || artifact.candidateEntryModule === undefined) {
    return supersede("activate_repair base mismatch", `executor ${artifact.executorId ?? "(none)"} is not repairable in this run`);
  }
  if (entry.digest !== artifact.baseDigest) {
    return supersede("activate_repair base mismatch", `executor ${entry.id} pin moved since the candidate was copied`);
  }
  const liveCandidate = await digestExecutorSource(artifact.candidateRoot).catch(() => undefined);
  if (artifact.candidateDigest === undefined || liveCandidate !== artifact.candidateDigest) {
    return supersede("activate_repair candidate digest mismatch", "candidate changed after independent review");
  }
  const unreviewed = await assertCandidateFullyReviewed(artifact.candidateRoot, { linkedDependencies: true }).then(
    () => undefined,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (unreviewed !== undefined) {
    return supersede("activate_repair candidate digest mismatch", unreviewed);
  }

  const tag = (suffix: string) => `executor:${entry.id}@${suffix}`;
  const intent = {
    artifactId: artifact.artifactId,
    fromVersion: tag(artifact.baseDigest.slice(0, 12)),
    toVersion: tag(`repair-${artifact.artifactId}`),
    generation: state.generation + 1,
    at: new Date().toISOString(),
    status: "intent" as const,
  };
  await saveRunState({ ...state, activationIntent: intent });

  const replaced = new Set(packageEntries(state, base.root).map((e) => e.id));
  const repair = {
    artifactId: artifact.artifactId,
    root: artifact.candidateRoot,
    entryModule: artifact.candidateEntryModule,
  };
  const nextCandidates = candidates.map((c, i) =>
    i === idx ? { ...artifact, status: "activated" as const } : c.status === "qualified" ? { ...c, status: "superseded" as const } : c,
  );
  let next: DurableRunState = {
    ...state,
    repairCandidates: nextCandidates,
    executorCatalog: (state.executorCatalog ?? []).map((e) =>
      replaced.has(e.id)
        ? { ...e, digest: liveCandidate, repair: { ...repair, baseDigest: e.repair?.baseDigest ?? e.digest } }
        : e,
    ),
    activationIntent: { ...intent, status: "committed" },
  };
  // Work already accepted stays; the stage that hit the failure is checked again.
  next = invalidateStageAndAfter(next, next.current.stageId, next.definition);
  return bumpGeneration(next, `activate_repair:${artifact.artifactId}`);
}
