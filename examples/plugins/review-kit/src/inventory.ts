// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The dependency inventory (design §7.2 item 3): every declared dependency
 * with its version and a base call site, every internal package, and where
 * each dependency's source is available locally: Go's module cache for a
 * required version, `node_modules/<pkg>` for an npm package, else `source
 * unavailable`. The answerer's confinement mounts the available directories
 * read-only.
 */
import type { EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";

export const MAX_INVENTORY = 300;
/** Manifests read from the base: the root's and a bounded number of nested ones. */
export const MAX_MANIFESTS = 12;
/** The read-only mounts one confinement carries for dependency source. */
export const MAX_MOUNTS = 60;
const MANIFEST_BYTES = 40_000;
const SITES_PER_COMMAND = 25;
const SOURCES_PER_COMMAND = 25;
const manifestDir = (manifest: string): string => (manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : ".");

export interface Dependency {
  ecosystem: "go" | "npm";
  name: string;
  version: string;
  /** The manifest that declares it, by path in the base. */
  manifest: string;
  indirect: boolean;
  /** `path:line` of a use in the base, when the search found one. */
  site?: string;
  /** The directory holding its source on this machine, when it does. */
  source?: string;
}

export interface Inventory {
  dependencies: Dependency[];
  /** Directories of the base, which hold the repository's internal packages. */
  packages: string[];
  /** The inventory or the package list did not fit and was cut. */
  truncated: string[];
}

const MANIFEST_MARK = "===== graphloom manifest ";
const END = "# end";

const CUT = "# cut: ";

/** Root manifests first (fewest path segments), then the rest, at most MAX_MANIFESTS; a cut is said, never silent. */
const MANIFESTS =
  String.raw`set -eu; base="$1"
{ list=$(git -c core.hooksPath=/dev/null ls-tree -r --name-only "$base" | grep -E '(^|/)(go\.mod|package\.json)$' | grep -v node_modules | awk -F/ '{ print NF, $0 }' | sort -n -s | cut -d' ' -f2- || true)
total=$(printf '%s\n' "$list" | grep -c . || true)
printf '%s\n' "$list" | head -n ` +
  String(MAX_MANIFESTS) +
  String.raw` | while IFS= read -r f; do
  [ -n "$f" ] || continue
  printf '%s%s\n' '` +
  MANIFEST_MARK +
  String.raw`' "$f"
  n=$(git -c core.hooksPath=/dev/null show "$base:$f" | wc -c)
  git -c core.hooksPath=/dev/null show "$base:$f" | head -c ` +
  String(MANIFEST_BYTES) +
  String.raw`; printf '\n'
  if [ "$n" -gt ` +
  String(MANIFEST_BYTES) +
  String.raw` ]; then echo "` +
  CUT +
  String.raw`$f"; fi
done
if [ "$total" -gt ` +
  String(MAX_MANIFESTS) +
  String.raw` ]; then echo "` +
  CUT +
  String.raw`$((total - ` +
  String(MAX_MANIFESTS) +
  String.raw`)) more manifests"; fi
echo '` +
  END +
  String.raw`'; } > "$GRAPHLOOM_REPORT_FILE"`;

/** Reads the base's dependency manifests (go.mod, package.json): the root's and a few nested ones. */
export const manifestsCommand = (base: string): EnvironmentCommand => ({ id: COMMAND.baseManifests, argv: ["sh", "-c", MANIFESTS, COMMAND.baseManifests, base] });

const TREE = String.raw`set -eu; base="$1"; { git -c core.hooksPath=/dev/null ls-tree -d -r --name-only "$base" | head -n 8000; echo '` + END + String.raw`'; } > "$GRAPHLOOM_REPORT_FILE"`;

/** Lists every directory of the base commit: its internal packages. */
export const treeCommand = (base: string): EnvironmentCommand => ({ id: COMMAND.baseTree, argv: ["sh", "-c", TREE, COMMAND.baseTree, base] });

/** The directories a `base-tree` report lists, and whether the report was complete. */
export function parseTree(text: string): { dirs: string[]; complete: boolean } {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const complete = lines.at(-1) === END;
  return { dirs: lines.filter((l) => l !== END), complete };
}

export function parseManifests(text: string): { files: Array<{ path: string; text: string }>; complete: boolean; cuts: string[] } {
  const files: Array<{ path: string; text: string }> = [];
  const cuts: string[] = [];
  let complete = false;
  let current: { path: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined) files.push({ path: current.path, text: current.lines.join("\n") });
    current = undefined;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(MANIFEST_MARK)) {
      flush();
      current = { path: line.slice(MANIFEST_MARK.length).trim(), lines: [] };
    } else if (line === END) {
      flush();
      complete = true;
    } else if (line.startsWith(CUT)) cuts.push(line.slice(CUT.length));
    else current?.lines.push(line);
  }
  flush();
  return { files, complete, cuts };
}

/** The requires of a go.mod: both forms, `// indirect` marked. */
export function parseGoMod(text: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];
  let block = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      block = true;
      continue;
    }
    if (block && line === ")") {
      block = false;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)(.*)$/.exec(line);
    const inBlock = block ? /^(\S+)\s+(v\S+)(.*)$/.exec(line) : null;
    const m = single ?? inBlock;
    if (m === null) continue;
    out.push({ ecosystem: "go", name: m[1]!, version: m[2]!, manifest, indirect: /\/\/\s*indirect/.test(m[3] ?? "") });
  }
  return out;
}

/** The dependencies a package.json declares, with their ranges. */
export function parsePackageJson(text: string, manifest: string): Dependency[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (json === null || typeof json !== "object") return [];
  const out: Dependency[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const table = (json as Record<string, unknown>)[field];
    if (table === null || typeof table !== "object") continue;
    for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
      if (typeof version === "string") out.push({ ecosystem: "npm", name, version, manifest, indirect: field === "devDependencies" });
    }
  }
  return out;
}

export function declaredDependencies(manifests: ReadonlyArray<{ path: string; text: string }>): Dependency[] {
  const out: Dependency[] = [];
  for (const f of manifests) {
    if (f.path === "go.mod" || f.path.endsWith("/go.mod")) out.push(...parseGoMod(f.text, f.path));
    else if (f.path === "package.json" || f.path.endsWith("/package.json")) out.push(...parsePackageJson(f.text, f.path));
  }
  return out;
}

const SITES =
  String.raw`set -u; base="$1"; kind="$2"; shift 2
{ for m in "$@"; do
  if [ "$kind" = go ]; then
    hit=$(git -c core.hooksPath=/dev/null grep -n -I --no-color -F -e "\"$m" "$base" -- '*.go' 2>/dev/null | head -n 1)
  else
    hit=$(git -c core.hooksPath=/dev/null grep -n -I --no-color -F -e "\"$m\"" -e "'$m'" -e "\"$m/" -e "'$m/" "$base" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.mts' 2>/dev/null | head -n 1)
  fi
  hit=$(printf '%s' "$hit" | sed 's/^[0-9a-f]\{40\}://' | cut -d: -f1,2)
  if [ -n "$hit" ]; then printf '%s\t%s\n' "$m" "$hit"; else printf '%s\t-\n' "$m"; fi
done; echo '` +
  END +
  String.raw`'; } > "$GRAPHLOOM_REPORT_FILE"`;

/** Where each dependency is used in the base: the first hit of its import path. One command per batch of dependencies. */
export function siteCommands(base: string, deps: readonly Dependency[]): EnvironmentCommand[] {
  const out: EnvironmentCommand[] = [];
  for (const eco of ["go", "npm"] as const) {
    const names = [...new Set(deps.filter((d) => d.ecosystem === eco).map((d) => d.name))];
    for (let i = 0; i < names.length; i += SITES_PER_COMMAND) {
      const id = `${COMMAND.depSites}-${out.length + 1}`;
      out.push({ id, argv: ["sh", "-c", SITES, id, base, eco, ...names.slice(i, i + SITES_PER_COMMAND)] });
    }
  }
  return out;
}

export function parseSites(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(\S+)\t(\S+)$/.exec(line);
    if (m !== null && m[2] !== "-") out.set(m[1]!, m[2]!);
  }
  return out;
}

const SOURCE_GO =
  String.raw`set -u
{ mc=$(go env GOMODCACHE 2>/dev/null || true)
while [ "$#" -ge 2 ]; do
  m="$1"; v="$2"; shift 2
  esc=$(printf '%s' "$m" | sed 's/[A-Z]/!&/g' | tr 'A-Z' 'a-z')
  if [ -n "$mc" ] && [ -d "$mc/$esc@$v" ]; then printf 'go\t%s\t%s\t%s\n' "$m" "$v" "$mc/$esc@$v"; fi
done; echo '` +
  END +
  String.raw`'; } > "$GRAPHLOOM_REPORT_FILE"`;

const SOURCE_NPM =
  String.raw`set -u
{ common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true); root=$(dirname "$common")
while [ "$#" -ge 2 ]; do
  d="$1"; p="$2"; shift 2
  for c in "$root/$d/node_modules/$p" "$root/node_modules/$p"; do
    if [ -d "$c" ]; then printf 'npm\t%s\t%s\t%s\n' "$p" "$d" "$c"; break; fi
  done
done; echo '` +
  END +
  String.raw`'; } > "$GRAPHLOOM_REPORT_FILE"`;

/**
 * Where a dependency's source is on this machine: the module cache directory
 * of each required Go version, and `node_modules/<pkg>` in the operator's
 * review clone (the worktree's common Git directory's parent) for npm.
 */
export function sourceCommands(deps: readonly Dependency[]): EnvironmentCommand[] {
  const out: EnvironmentCommand[] = [];
  const go = [...new Map(deps.filter((d) => d.ecosystem === "go").map((d) => [`${d.name}@${d.version}`, [d.name, d.version]] as const)).values()];
  for (let i = 0; i < go.length; i += SOURCES_PER_COMMAND) {
    const id = `${COMMAND.depSource}-go-${out.length + 1}`;
    out.push({ id, argv: ["sh", "-c", SOURCE_GO, id, ...go.slice(i, i + SOURCES_PER_COMMAND).flat()] });
  }
  const npm = [...new Map(deps.filter((d) => d.ecosystem === "npm").map((d) => [`${manifestDir(d.manifest)}|${d.name}`, [manifestDir(d.manifest), d.name]] as const)).values()];
  for (let i = 0; i < npm.length; i += SOURCES_PER_COMMAND) {
    const id = `${COMMAND.depSource}-npm-${out.length + 1}`;
    out.push({ id, argv: ["sh", "-c", SOURCE_NPM, id, ...npm.slice(i, i + SOURCES_PER_COMMAND).flat()] });
  }
  return out;
}

/** `go<TAB>module<TAB>version<TAB>dir` and `npm<TAB>package<TAB>manifest dir<TAB>dir` lines. */
export function parseSources(text: string): Array<{ ecosystem: "go" | "npm"; name: string; versionOrDir: string; dir: string }> {
  const out: Array<{ ecosystem: "go" | "npm"; name: string; versionOrDir: string; dir: string }> = [];
  for (const line of text.split("\n")) {
    const m = /^(go|npm)\t([^\t]+)\t([^\t]+)\t(\/.+)$/.exec(line);
    if (m !== null) out.push({ ecosystem: m[1] as "go" | "npm", name: m[2]!, versionOrDir: m[3]!, dir: m[4]! });
  }
  return out;
}

/** The inventory from what the commands printed. */
export function buildInventory(input: {
  manifests: Array<{ path: string; text: string }>;
  tree: { dirs: string[]; complete: boolean };
  sites: ReadonlyMap<string, string>;
  sources: ReturnType<typeof parseSources>;
  manifestsComplete: boolean;
  /** What the manifests command said it cut: a manifest past the byte limit, manifests past the count. */
  manifestCuts?: readonly string[];
}): Inventory {
  const truncated: string[] = [];
  if (!input.tree.complete) truncated.push("the list of internal packages was cut");
  if (!input.manifestsComplete) truncated.push("the dependency manifests were cut");
  for (const c of input.manifestCuts ?? []) truncated.push(`dependency manifests cut: ${c}`);
  let deps = declaredDependencies(input.manifests);
  if (deps.length > MAX_INVENTORY) {
    truncated.push(`${deps.length - MAX_INVENTORY} of ${deps.length} dependencies are not listed`);
    deps = deps.slice(0, MAX_INVENTORY);
  }
  const mounted = new Set<string>();
  let unmounted = 0;
  const dependencies = deps.map((d): Dependency => {
    const site = input.sites.get(d.name);
    const src = input.sources.find((s) => s.ecosystem === d.ecosystem && s.name === d.name && (d.ecosystem === "go" ? s.versionOrDir === d.version : s.versionOrDir === manifestDir(d.manifest)));
    // One confinement mounts at most MAX_MOUNTS directories; a source it cannot mount is as unavailable to the answerer as none.
    if (src !== undefined && !mounted.has(src.dir) && mounted.size >= MAX_MOUNTS) {
      unmounted += 1;
      return { ...d, ...(site !== undefined ? { site } : {}) };
    }
    if (src !== undefined) mounted.add(src.dir);
    return { ...d, ...(site !== undefined ? { site } : {}), ...(src !== undefined ? { source: src.dir } : {}) };
  });
  if (unmounted > 0) truncated.push(`${unmounted} dependencies have source on this machine that the answerer's confinement cannot mount (at most ${MAX_MOUNTS} directories); they are marked source unavailable`);
  return { dependencies, packages: input.tree.dirs, truncated };
}

/** A dependency's source status as the answers state it. */
export const sourceStatus = (d: Dependency): string => (d.source !== undefined ? `source available: ${d.source}` : "source unavailable");

/** The directories the answerer's confinement mounts read-only: where an inventory dependency's source is. */
export function sourceDirs(inv: Inventory): string[] {
  return [...new Set(inv.dependencies.flatMap((d) => (d.source !== undefined ? [d.source] : [])))].sort();
}
