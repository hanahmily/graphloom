// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Durable run-state formats and the ordered migrators between them
 * (docs/design-release.md §5.2). `stateFormat` is bumped for any non-additive
 * change to durable run state; additive optional fields do not bump it. A
 * release writes `CURRENT_STATE_FORMAT` and carries every migrator of its
 * major version, so `resume --upgrade` can move a run from any earlier release
 * of that major.
 *
 * A migrator is a pure function over the run's durable state files, from one
 * format to the next. It may change how accepted receipts, evidence, the
 * pinned step set and requirement statements are stored, never what they say;
 * `migrateStateFiles` checks that through each format's protected view.
 */
import { cp, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "@graphloom/sdk";
import { externalizeEvidenceMigrator, formatTwoProtectedView } from "./externalize-evidence.js";

/**
 * The format this release writes. Format 1 is every run saved before formats were recorded; format 2 keeps the
 * large parts of evidence payloads in the run's `evidence/` store instead of `state.json`.
 */
export const CURRENT_STATE_FORMAT = 2;

/** The run's durable files a migration reads or writes, by path relative to the state directory, as UTF-8 text. */
export type StateFiles = Record<string, string>;

export interface StateMigrator {
  from: number;
  /** Always `from + 1`. */
  to: number;
  /** Files besides `state.json` it reads or writes. */
  files?: readonly string[];
  /** Pure: the files in format `to`. A file it drops is absent from the result. */
  migrate(files: Readonly<StateFiles>): StateFiles;
}

/**
 * What a migration must preserve, read from the files of one format: accepted
 * receipts, evidence content, the pinned step set and requirement statements.
 */
export type ProtectedView = (files: Readonly<StateFiles>) => unknown;

export interface StateFormatRegistry {
  /** The format this release writes. */
  current: number;
  /** Every migrator of the major version, in any order. */
  migrators: readonly StateMigrator[];
  /** Per format, how to read what a migration must preserve; formats without one use format 1's reader. */
  protectedViews?: Readonly<Record<number, ProtectedView>>;
}

/** This release's formats. Migrators are never removed within a major version. */
export const STATE_FORMATS: StateFormatRegistry = {
  current: CURRENT_STATE_FORMAT,
  migrators: [externalizeEvidenceMigrator],
  protectedViews: { 2: formatTwoProtectedView },
};

/** Format 1 keeps everything in `state.json`. */
export const formatOneProtectedView: ProtectedView = (files) => {
  const state = JSON.parse(files["state.json"] ?? "{}") as {
    receipts?: unknown;
    evidence?: unknown;
    definition?: { stages?: unknown; requirements?: unknown };
  };
  return {
    receipts: state.receipts ?? [],
    evidence: state.evidence ?? [],
    stages: state.definition?.stages ?? [],
    requirements: state.definition?.requirements ?? [],
  };
};

/** A run's format: its recorded `stateFormat`, or 1 for a run saved before formats were recorded. */
export function stateFormatOf(state: { stateFormat?: unknown }): number {
  const format = state.stateFormat ?? 1;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    throw new Error(`run state has an unreadable stateFormat ${JSON.stringify(format)}`);
  }
  return format;
}

/** The migrators from `from` to the registry's current format, in order; throws naming the first missing step. */
export function migrationPath(from: number, registry: StateFormatRegistry = STATE_FORMATS): StateMigrator[] {
  const steps: StateMigrator[] = [];
  for (let format = from; format < registry.current; format++) {
    const step = registry.migrators.find((m) => m.from === format && m.to === format + 1);
    if (step === undefined) {
      throw new Error(`no state migrator from format ${format} to ${format + 1}; this GraphLoom cannot move the run from format ${from} to ${registry.current}`);
    }
    steps.push(step);
  }
  return steps;
}

export interface MigratedStateFiles {
  /** The original files every step read, by path, as they were before the first step. */
  original: StateFiles;
  /** The files after the last step. */
  files: StateFiles;
  /** Per step, the files it read before it ran (its backup). */
  steps: Array<{ from: number; to: number; before: StateFiles }>;
}

/** Reads the files `steps` need (always `state.json`); a file that does not exist is left out. */
export async function readStateFiles(stateDir: string, steps: readonly StateMigrator[]): Promise<StateFiles> {
  const names = new Set<string>(["state.json"]);
  for (const step of steps) for (const name of step.files ?? []) names.add(name);
  const files: StateFiles = {};
  for (const name of names) {
    const file = resolveInside(stateDir, name);
    try {
      files[name] = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return files;
}

/**
 * Applies `steps` in memory, checking after each that its protected view is
 * unchanged. Throws naming the step that changed one; nothing is written.
 */
export function migrateStateFiles(
  files: Readonly<StateFiles>,
  steps: readonly StateMigrator[],
  registry: StateFormatRegistry = STATE_FORMATS,
): MigratedStateFiles {
  const viewOf = (format: number): ProtectedView => registry.protectedViews?.[format] ?? formatOneProtectedView;
  let current: StateFiles = { ...files };
  const applied: MigratedStateFiles["steps"] = [];
  for (const step of steps) {
    const before = current;
    const after = step.migrate(structuredClone(before));
    if (after["state.json"] === undefined) throw new Error(`state migrator ${step.from}-${step.to} dropped state.json`);
    if (stableHash(viewOf(step.from)(before)) !== stableHash(viewOf(step.to)(after))) {
      throw new Error(`state migrator ${step.from}-${step.to} changed accepted receipts, evidence, the step set or requirement statements; a migrator may only change how they are stored`);
    }
    applied.push({ from: step.from, to: step.to, before });
    current = after;
  }
  return { original: { ...files }, files: current, steps: applied };
}

/** `<stateDir>/migrations/<from>-<to>`. */
export function migrationBackupDir(stateDir: string, from: number, to: number): string {
  return path.join(stateDir, "migrations", `${from}-${to}`);
}

/**
 * Keeps each step's original files under its backup directory. Called before
 * anything of the migration is written; a backup left by an attempt that never
 * committed is replaced.
 */
export async function writeMigrationBackups(stateDir: string, migrated: MigratedStateFiles): Promise<string[]> {
  const dirs: string[] = [];
  for (const step of migrated.steps) {
    const dir = migrationBackupDir(stateDir, step.from, step.to);
    const staging = `${dir}.tmp-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    for (const [name, text] of Object.entries(step.before)) await writeDurable(resolveInside(staging, name), text);
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    await rename(staging, dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Writes the migrated files other than `state.json` and removes the ones the
 * migration dropped. `state.json` is the commit point and is written by the
 * caller (saveRunState) last.
 */
export async function writeMigratedSideFiles(stateDir: string, migrated: MigratedStateFiles): Promise<void> {
  // Each renamed file's directory, and the parent of every directory created on the way, is synced before the
  // caller commits state.json: a file whose rename is not yet durable could vanish after a crash while the
  // committed state already refers to it (evidence blobs, for one).
  const dirs = new Set<string>();
  for (const [name, text] of Object.entries(migrated.files)) {
    if (name === "state.json" || migrated.original[name] === text) continue;
    await writeDurable(resolveInside(stateDir, name), text, dirs);
  }
  for (const dir of dirs) await syncDirectory(dir);
  for (const name of Object.keys(migrated.original)) {
    if (name !== "state.json" && migrated.files[name] === undefined) await rm(resolveInside(stateDir, name), { force: true });
  }
}

/** Restores the files of a run from a step's backup (an operator's undo; never automatic). */
export async function restoreMigrationBackup(stateDir: string, from: number, to: number): Promise<void> {
  await cp(migrationBackupDir(stateDir, from, to), stateDir, { recursive: true, force: true });
}

function resolveInside(dir: string, name: string): string {
  const file = path.resolve(dir, name);
  if (!file.startsWith(`${path.resolve(dir)}${path.sep}`)) throw new Error(`state file ${JSON.stringify(name)} is outside the state directory`);
  return file;
}

async function writeDurable(file: string, text: string, dirs: Set<string> = new Set()): Promise<void> {
  const dir = path.dirname(file);
  const created = await mkdir(dir, { recursive: true });
  // mkdir returns the first directory it created: that one and every directory below it up to `dir` are new.
  if (created !== undefined) {
    for (let d = dir; ; d = path.dirname(d)) {
      dirs.add(path.dirname(d));
      if (d === created || path.dirname(d) === d) break;
    }
  }
  dirs.add(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/** fsync a directory, so the entries renamed or created in it survive a crash; skipped where the file system cannot. */
async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") throw err;
  } finally {
    await handle?.close();
  }
}
