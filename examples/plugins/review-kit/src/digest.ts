// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The bounded high-level digest the large-mode reporter reads instead of the diff (design §6.9): the areas with their
 * sizes and the names of the exported symbols they add, and the patches of the interface files only (the files the
 * profile's `schema`, `config` and `interfaces` sections route, protobuf definitions, the changelog and the docs),
 * capped in total, largest first dropped, with the files left out listed. A pure function of the snapshot and the
 * profile, so the job's input is recomputable.
 */
import { declName } from "./detectors.js";
import { GENERATED_AREA, type Partition } from "./areas.js";
import { matchesGeneratedGlob } from "./metrics/generated.js";
import type { PullFile } from "./snapshot.js";
import type { Section } from "./template.js";

/** The sections whose routing globs name interface files. */
export const INTERFACE_SECTIONS: readonly string[] = ["schema", "config", "interfaces"];
/** Interface files whatever the profile routes. */
export const INTERFACE_EXTRA_GLOBS: readonly string[] = ["**/*.proto", "CHANGES.md", "docs/**"];
/** The most patch bytes the digest carries in all. */
export const INTERFACE_PATCH_BYTES = 200_000;
/** The most new symbol names the digest lists for one area; the rest are counted. */
export const MAX_SYMBOLS_PER_AREA = 40;

/** The globs that make a changed file an interface file: the routing of the interface sections, and the fixed extras. */
export function interfaceGlobs(sections: ReadonlyArray<Pick<Section, "id" | "routing">>): string[] {
  return [...new Set([...sections.filter((s) => INTERFACE_SECTIONS.includes(s.id)).flatMap((s) => s.routing), ...INTERFACE_EXTRA_GLOBS])];
}

const TEST_FILE = /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?)$/;

/**
 * The exported symbols a file's patch adds, by name only (Go: an added `func Name` or `type Name` whose first letter is
 * upper case; TypeScript: an added `export ...`). A name that is also on a removed line of the file was there before.
 * Test files add none.
 */
export function newExportedSymbols(file: Pick<PullFile, "path" | "status" | "parsed">): string[] {
  if (file.status === "removed" || TEST_FILE.test(file.path)) return [];
  const before = new Set(file.parsed.lines.filter((l) => l.kind === "del").flatMap((l) => declName(l.text) ?? []));
  const names: string[] = [];
  for (const l of file.parsed.lines) {
    if (l.kind !== "add") continue;
    const name = declName(l.text);
    if (name !== undefined && !before.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export interface AreaDigest {
  id: string;
  name: string;
  kind: "read" | "generated";
  files: number;
  additions: number;
  deletions: number;
  /** The area's patch bytes, as the partition counted them. */
  bytes: number;
  /** Names of the exported symbols the area's patches add, at most `MAX_SYMBOLS_PER_AREA`. */
  symbols: string[];
  /** Names beyond the ones listed. */
  moreSymbols: number;
}

export interface InterfacePatch {
  path: string;
  bytes: number;
  patch: string;
}

export interface LeftOut {
  path: string;
  bytes: number;
}

export interface Digest {
  areas: AreaDigest[];
  /** The interface files' patches that fit under the cap, in path order. */
  patches: InterfacePatch[];
  /** Interface files whose patch did not fit, largest first. */
  leftOut: LeftOut[];
  /** The cap that applied, in bytes of patch text. */
  cap: number;
}

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The digest of a large pull request's snapshot. When the interface patches are over `cap` bytes together, the largest
 * is left out first, then the next largest, until the rest fit; each is listed in `leftOut`.
 */
export function buildDigest(files: readonly PullFile[], partition: Partition, sections: ReadonlyArray<Pick<Section, "id" | "routing">>, cap: number = INTERFACE_PATCH_BYTES): Digest {
  const byFile = new Map(files.map((f) => [f.path, f] as const));
  const areas: AreaDigest[] = partition.areas.map((a) => {
    const mine = a.paths.flatMap((p) => byFile.get(p) ?? []);
    // The names of generated code say nothing of the design.
    const symbols = a.kind === "generated" ? [] : mine.flatMap(newExportedSymbols);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      files: mine.length,
      additions: mine.reduce((n, f) => n + f.additions, 0),
      deletions: mine.reduce((n, f) => n + f.deletions, 0),
      bytes: a.bytes,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_AREA),
      moreSymbols: Math.max(0, symbols.length - MAX_SYMBOLS_PER_AREA),
    };
  });
  const generated = new Set(partition.areas.find((a) => a.id === GENERATED_AREA)?.paths ?? []);
  const globs = interfaceGlobs(sections);
  const candidates: InterfacePatch[] = files
    .filter((f) => f.patch !== null && f.patch !== "" && !generated.has(f.path) && matchesGeneratedGlob(globs, f.path))
    .map((f) => ({ path: f.path, bytes: bytesOf(f.patch!), patch: f.patch! }));
  const kept = new Set(candidates.map((c) => c.path));
  const leftOut: LeftOut[] = [];
  let total = candidates.reduce((n, c) => n + c.bytes, 0);
  for (const c of [...candidates].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1))) {
    if (total <= cap) break;
    kept.delete(c.path);
    leftOut.push({ path: c.path, bytes: c.bytes });
    total -= c.bytes;
  }
  return { areas, patches: candidates.filter((c) => kept.has(c.path)).sort(byPath), leftOut, cap };
}
