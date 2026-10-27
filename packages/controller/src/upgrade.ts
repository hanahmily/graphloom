// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `resume --upgrade` (docs/design-release.md §5.2): move a stopped run from
 * the GraphLoom that owns it to the one resuming it. Under the run lock, every
 * refusal is decided and every migration and executor re-pin is computed in
 * memory first; only then are the original files backed up and the new state
 * written, with `state.json` as the single commit point. A refusal leaves the
 * run, its files, and its owner unchanged.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROTOCOL_VERSION } from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import { newEvidenceRef } from "./admit.js";
import { rebaseBudgetUsage } from "./budget-usage.js";
import { applyExecutorRepin, verifyExecutorCatalog } from "./executor-catalog.js";
import { saveRunState, type DurableRunState, type InstallRecord, type StateMigrationRecord } from "./state.js";
import {
  migrateStateFiles,
  migrationBackupDir,
  migrationPath,
  readStateFiles,
  stateFormatOf,
  STATE_FORMATS,
  writeMigratedSideFiles,
  writeMigrationBackups,
  type StateFormatRegistry,
} from "./state-migrations/index.js";

export interface UpgradeRequest {
  /** The GraphLoom the run moves to: the one resuming it. */
  install: InstallRecord;
  /**
   * Called once the move is committed, before the run runs, so the caller can
   * move its own ownership index (`runs/<runId>.json`) with it.
   */
  onMoved?: (moved: { runId: string; stateDir: string; install: InstallRecord; bundlePath: string }) => void | Promise<void>;
}

/** A refused `resume --upgrade`; the run is unchanged. */
export class UpgradeRefusedError extends Error {
  constructor(message: string) {
    super(`cannot upgrade: ${message}`);
    this.name = "UpgradeRefusedError";
  }
}

export interface ProductVersion {
  major: number;
  minor: number;
  patch: number;
  /** A prerelease or dev suffix (`dev` in `0.1.0-dev+abc1234`); it orders before the release. */
  pre?: string;
}

/** `MAJOR.MINOR.PATCH`, optionally `-<pre>` and `+<build>`; undefined for anything else. */
export function parseProductVersion(version: string): ProductVersion | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] !== undefined ? { pre: m[4] } : {}) };
}

/** Semver order; two prereleases of one version compare equal (a dev build has no order of its own). */
export function compareProductVersions(a: ProductVersion, b: ProductVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if ((a.pre === undefined) === (b.pre === undefined)) return 0;
  return a.pre === undefined ? 1 : -1;
}

/** A release version, `MAJOR.MINOR.PATCH` with nothing after it: one an installed version directory can carry. */
export function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

export interface UpgradeDeps {
  runner: Runner;
  updatePlugin: boolean;
  stateFormats?: StateFormatRegistry;
  /** With `updatePlugin`: why the installed bundle cannot replace the pinned one, or undefined when it passes describe-compatibility. */
  checkPluginUpdate?: (state: DurableRunState) => Promise<string | undefined>;
}

/**
 * Decides and, unless refused, commits the move. Returns whether the move
 * re-pinned any executor (false too when there is nothing to move: the run
 * already belongs to `request.install` and is in the current format). Throws
 * `UpgradeRefusedError` with the run unchanged.
 * The caller holds the run lock.
 */
export async function upgradeRun(stateDir: string, request: UpgradeRequest, deps: UpgradeDeps): Promise<boolean> {
  const registry = deps.stateFormats ?? STATE_FORMATS;
  const raw = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")) as DurableRunState;
  const target = request.install;
  const owner = raw.install;
  const targetVersion = parseProductVersion(target.version);
  if (targetVersion === undefined) throw new UpgradeRefusedError(`${JSON.stringify(target.version)} is not a GraphLoom version`);
  const ownerVersion = owner !== undefined ? parseProductVersion(owner.version) : undefined;
  if (owner !== undefined && ownerVersion !== undefined) {
    if (ownerVersion.major !== targetVersion.major) {
      throw new UpgradeRefusedError(
        `run ${raw.runId} belongs to GraphLoom ${owner.version}, and ${target.version} is another major version; a run never crosses a major version, so finish it on ${owner.version}`,
      );
    }
    if (compareProductVersions(targetVersion, ownerVersion) < 0) {
      throw new UpgradeRefusedError(`downgrade: run ${raw.runId} belongs to GraphLoom ${owner.version}, which is newer than ${target.version}; a run is never moved to an older version`);
    }
  }
  let format: number;
  try {
    format = stateFormatOf(raw);
  } catch (err) {
    throw new UpgradeRefusedError(err instanceof Error ? err.message : String(err));
  }
  if (format > registry.current) {
    throw new UpgradeRefusedError(
      `unknown state format ${format}: GraphLoom ${target.version} writes format ${registry.current} and knows no later one${owner !== undefined ? `; resume the run on ${owner.version}` : ""}`,
    );
  }
  let steps;
  try {
    steps = migrationPath(format, registry);
  } catch (err) {
    throw new UpgradeRefusedError(err instanceof Error ? err.message : String(err));
  }
  if (raw.status !== "stopped") {
    throw new UpgradeRefusedError(`run ${raw.runId} is ${raw.status}; only a stopped run can be moved`);
  }
  const unsettled = unsettledRepair(raw);
  if (unsettled !== undefined) {
    throw new UpgradeRefusedError(`${unsettled}; its candidate links into the owning version's dependencies, so resume the run on ${owner?.version ?? "the GraphLoom that started it"} until the repair settles`);
  }
  const sameOwner = owner !== undefined && owner.version === target.version && owner.root === target.root;
  if (sameOwner && steps.length === 0) return false;
  const files = await readStateFiles(stateDir, steps);
  let migrated;
  try {
    migrated = migrateStateFiles(files, steps, registry);
  } catch (err) {
    throw new UpgradeRefusedError(err instanceof Error ? err.message : String(err));
  }
  let state = rebaseBudgetUsage(JSON.parse(migrated.files["state.json"]!) as DurableRunState);
  if (state.intake.bundle.sdkProtocol !== PROTOCOL_VERSION && !deps.updatePlugin) {
    throw new UpgradeRefusedError(
      `the run's plugin bundle speaks sdkProtocol ${state.intake.bundle.sdkProtocol}, and GraphLoom ${target.version} speaks ${PROTOCOL_VERSION}; combine --upgrade with --update-plugin on a bundle built for it`,
    );
  }
  // The ordinary resume refuses a plugin update while an activated repair owns the plugin; decide that before the move.
  if (deps.updatePlugin && state.activeVersion !== `${state.intake.bundle.graphId}@${state.intake.bundle.version}`) {
    throw new UpgradeRefusedError(`--update-plugin: an activated repair (${state.activeVersion}) owns this run's plugin; only the installed bundle can be updated`);
  }
  if (deps.updatePlugin && deps.checkPluginUpdate !== undefined) {
    const reason = await deps.checkPluginUpdate(state);
    if (reason !== undefined) throw new UpgradeRefusedError(`--update-plugin: ${reason}`);
  }
  // --upgrade implies --update-executors, decided here so a refusal changes nothing.
  const executors = await verifyExecutorCatalog(state, deps.runner, true).catch((err: unknown) => ({
    blocker: `executor catalog unreadable: ${err instanceof Error ? err.message : String(err)}`,
  }));
  if (executors !== undefined && "blocker" in executors) throw new UpgradeRefusedError(`executor pin mismatch: ${executors.blocker}`);

  const at = new Date().toISOString();
  const migrations: StateMigrationRecord[] = migrated.steps.map((s) => ({
    from: s.from,
    to: s.to,
    backup: migrationBackupDir(stateDir, s.from, s.to),
    generation: state.generation,
    at,
  }));
  const transition = {
    ...(owner !== undefined ? { from: owner } : {}),
    to: target,
    fromStateFormat: format,
    toStateFormat: registry.current,
    generation: state.generation,
    at,
  };
  const reason = `upgrade: GraphLoom ${owner?.version ?? "(owner not recorded)"} -> ${target.version}, state format ${format} -> ${registry.current}`;
  const evidence = {
    ref: newEvidenceRef(state),
    kind: "other" as const,
    generation: state.generation,
    payload: { upgrade: { ...(owner !== undefined ? { from: owner } : {}), to: target, stateFormat: { from: format, to: registry.current }, migrations } },
  };
  state = {
    ...state,
    stateFormat: registry.current,
    install: target,
    installHistory: [...(state.installHistory ?? []), transition],
    ...(migrations.length > 0 ? { stateMigrations: [...(state.stateMigrations ?? []), ...migrations] } : {}),
    evidence: [...state.evidence, evidence],
    versionHistory: [...(state.versionHistory ?? []), { activeVersion: state.activeVersion, generation: state.generation, reason, at }],
    stateRevision: state.stateRevision + 1,
  };
  if (executors !== undefined && executors.repins.length > 0) state = applyExecutorRepin(state, executors.catalog, executors.repins);

  await writeMigrationBackups(stateDir, migrated);
  await writeMigratedSideFiles(stateDir, migrated);
  await saveRunState(state);
  await request.onMoved?.({ runId: state.runId, stateDir, install: target, bundlePath: state.intake.bundle.bundlePath });
  return executors !== undefined && executors.repins.length > 0;
}

/** A journaled activation that has not settled, or a qualified candidate that was never activated. */
function unsettledRepair(state: DurableRunState): string | undefined {
  if (state.activationIntent?.status === "intent") {
    return `unsettled repair: the activation of candidate ${state.activationIntent.artifactId} is journaled but not settled`;
  }
  const pending = (state.repairCandidates ?? []).find((c) => c.status === "qualifying" || c.status === "qualified");
  if (pending !== undefined) return `unsettled repair: candidate ${pending.artifactId} is ${pending.status} and not activated`;
  return undefined;
}
