// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The architecture diagram (design §6.10): the components a pull request adds or modifies, the components they
 * connect to, and the connections. The reporter returns it with the report, in
 * either mode. This module holds the contract fragment, the deterministic validation (structure, then the tree check
 * the graph runs as read-only commands), the claim targets (`A.<node id>`, `A.e<n>`), the assembly that drops what
 * the claim check could not support, and the Mermaid block of `review.md`. The SVG is `archlayout.ts`.
 */
import type { EnvironmentCommand } from "@graphloom/sdk";
import type { ClaimTarget } from "./claims.js";
import { COMMAND } from "./constants.js";
import type { RemovedPart } from "./report.js";
import type { PullFile } from "./snapshot.js";

export const MAX_ARCH_NODES = 30;
export const MAX_ARCH_EDGES = 60;
const MAX_LABEL_CHARS = 80;
const MAX_PATHS_PER_NODE = 8;

export const NODE_KINDS = ["package", "cli", "service", "api", "storage", "external", "other"] as const;
export const NODE_CHANGES = ["added", "modified", "unchanged"] as const;
export const EDGE_KINDS = ["call", "rpc", "data", "import", "config"] as const;
export const EDGE_CHANGES = ["added", "modified", "removed", "unchanged"] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type NodeChange = (typeof NODE_CHANGES)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type EdgeChange = (typeof EDGE_CHANGES)[number];

/** Where a node is, or a connection is made: lines of a file in one tree. */
export interface ArchCite {
  path: string;
  side: "head" | "base";
  start: number;
  end: number;
}

export interface ArchNode {
  id: string;
  label: string;
  kind: NodeKind;
  change: NodeChange;
  /** What the node is, in the tree: files or directories. */
  paths: string[];
  cite: ArchCite;
}

export interface ArchEdge {
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
  change: EdgeChange;
  cite: ArchCite;
}

export interface Architecture {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export const EMPTY_ARCHITECTURE: Architecture = { nodes: [], edges: [] };

const text = { type: "string" };
const strict = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, required, properties });
const ARCH_CITE_SCHEMA = strict(["path", "side", "start", "end"], { path: text, side: { type: "string", enum: ["head", "base"] }, start: { type: "integer" }, end: { type: "integer" } });

/** The contract fragment: the `architecture` property of `change-report-v1` (design §6.10). */
export const ARCHITECTURE_SCHEMA = strict(["nodes", "edges"], {
  nodes: {
    type: "array",
    items: strict(["id", "label", "kind", "change", "paths", "cite"], {
      id: text,
      label: text,
      kind: { type: "string", enum: [...NODE_KINDS] },
      change: { type: "string", enum: [...NODE_CHANGES] },
      paths: { type: "array", items: text },
      cite: ARCH_CITE_SCHEMA,
    }),
  },
  edges: {
    type: "array",
    items: strict(["from", "to", "label", "kind", "change", "cite"], {
      from: text,
      to: text,
      label: text,
      kind: { type: "string", enum: [...EDGE_KINDS] },
      change: { type: "string", enum: [...EDGE_CHANGES] },
      cite: ARCH_CITE_SCHEMA,
    }),
  },
});

/** What the reporter is told of the diagram. */
export const ARCHITECTURE_PROMPT = [
  `The "architecture" of your result is a diagram that helps a maintainer understand the components this pull request adds or changes and how they connect to each other and to the rest of the system. It is not an inventory of the repository: draw what the change touches and what it talks to.`,
  `- nodes (at most ${MAX_ARCH_NODES}): id (a short name such as "n1" or "store", unique, letters, digits, "_" and "-", and not of the form e<number>), label (what a maintainer calls it, at most ${MAX_LABEL_CHARS} characters), kind ("package", "cli", "service", "api", "storage", "external" or "other"), change ("added" when the pull request creates it, "modified" when it changes it, "unchanged" for a component it only connects to), paths (the files or directories that are the node, in the tree; an added or modified node's paths must match a changed file, an unchanged node's paths must exist at the base commit), and cite (path, side, start, end: a place that shows the node, in the head tree for an added or modified node, the base tree for one that is gone from the head).`,
  `- edges (at most ${MAX_ARCH_EDGES}): from and to (node ids), label (what flows or is done, a few words), kind ("call", "rpc", "data", "import" or "config"), change ("added", "modified", "removed" or "unchanged") and cite (path, side, start, end: where the connection is made, for example the call site or the import).`,
  `Rules: an unchanged node appears only when an edge connects it to an added or modified node (context, not inventory). Every cite must name lines that exist in the tree it names (the head tree is the working tree; the base tree is HEAD). A Go call or import edge between two package nodes is checked against the "from" package's import blocks, so draw it only when the head imports the other package. Draw only components and connections the code shows; do not invent any. Each node and each edge is checked against the code as a claim of its own, and one that is not supported is dropped from the diagram.`,
].join("\n");


/** The claim ids of a diagram's parts: `A.<node id>` and `A.e<n>` (n from 1, in the order the edges are given). */
export const nodeClaimId = (id: string): string => `A.${id}`;
export const edgeClaimId = (n: number): string => `A.e${n}`;

const isRelativePath = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.startsWith("-") && !p.split("/").some((s) => s === "..") && !/[\n\0\\]/.test(p);
const normal = (p: string): string => p.replace(/\/+$/, "").replace(/^\.\//, "");

/** Whether a node's path (a file or a directory) names `file` or something inside it. */
function pathCovers(p: string, file: string): boolean {
  const q = normal(p);
  return q === file || file.startsWith(`${q}/`);
}

/** Whether a changed file is one of the node's paths, or inside one (a renamed file by either name). */
const touchesChanged = (node: ArchNode, files: readonly PullFile[]): boolean => node.paths.some((p) => files.some((f) => pathCovers(p, f.path) || (f.previousPath !== null && pathCovers(p, f.previousPath))));

function citeProblem(c: ArchCite, at: string, problems: string[]): void {
  if (!isRelativePath(c.path)) problems.push(`${at}: the cite path ${JSON.stringify(c.path)} is not a repository-relative path`);
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 1 || c.end < c.start) problems.push(`${at}: the cite lines ${c.start}-${c.end} are not a range (a cite names lines, from 1)`);
}

/**
 * The structural rules (design §6.10 "Deterministic validation"), which need no tree: bounds, unique ids, edges that
 * name two nodes, cites that are ranges, an added or modified node's paths matching a changed file, and an unchanged
 * node only where an edge joins it to a changed one. Empty when the diagram passes. The tree check (cites that
 * resolve, an unchanged node's paths at the base, a Go import) is `architecturePlan`.
 */
export function architectureProblems(arch: Architecture, files: readonly PullFile[]): string[] {
  const problems: string[] = [];
  if (arch.nodes.length > MAX_ARCH_NODES) problems.push(`architecture: ${arch.nodes.length} nodes, more than ${MAX_ARCH_NODES}`);
  if (arch.edges.length > MAX_ARCH_EDGES) problems.push(`architecture: ${arch.edges.length} edges, more than ${MAX_ARCH_EDGES}`);
  const byId = new Map<string, ArchNode>();
  arch.nodes.forEach((n, i) => {
    const at = `architecture node ${i + 1} (${JSON.stringify(n.id)})`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(n.id)) problems.push(`${at}: the id is a short name of letters, digits, "_" and "-", starting with a letter`);
    else if (/^e\d+$/.test(n.id)) problems.push(`${at}: an id of the form e<number> is taken by the edge claims (A.e1...); name the node otherwise`);
    if (byId.has(n.id)) problems.push(`${at}: the id appears twice`);
    byId.set(n.id, n);
    if (n.label.trim() === "") problems.push(`${at}: the label is empty`);
    else if (n.label.length > MAX_LABEL_CHARS) problems.push(`${at}: the label is ${n.label.length} characters, more than ${MAX_LABEL_CHARS}`);
    if (n.paths.length === 0) problems.push(`${at}: it has no paths; say which files or directories it is`);
    if (n.paths.length > MAX_PATHS_PER_NODE) problems.push(`${at}: ${n.paths.length} paths, more than ${MAX_PATHS_PER_NODE}`);
    for (const p of n.paths) if (!isRelativePath(p)) problems.push(`${at}: the path ${JSON.stringify(p)} is not a repository-relative path`);
    citeProblem(n.cite, at, problems);
    if (n.change !== "unchanged" && n.paths.length > 0 && n.paths.every(isRelativePath) && !touchesChanged(n, files)) {
      problems.push(`${at}: it is ${n.change}, but none of its paths (${n.paths.slice(0, 3).join(", ")}) matches a file the pull request changes; mark a component the pull request does not touch "unchanged"`);
    }
  });
  arch.edges.forEach((e, i) => {
    const at = `architecture edge ${i + 1} (${edgeClaimId(i + 1)})`;
    if (!byId.has(e.from)) problems.push(`${at}: from ${JSON.stringify(e.from)} is not a node id`);
    if (!byId.has(e.to)) problems.push(`${at}: to ${JSON.stringify(e.to)} is not a node id`);
    if (e.label.trim() === "") problems.push(`${at}: the label is empty`);
    else if (e.label.length > MAX_LABEL_CHARS) problems.push(`${at}: the label is ${e.label.length} characters, more than ${MAX_LABEL_CHARS}`);
    citeProblem(e.cite, at, problems);
  });
  // An unchanged node is context: it needs an edge to a node the pull request changes.
  for (const n of arch.nodes) {
    if (n.change !== "unchanged") continue;
    const joined = arch.edges.some((e) => (e.from === n.id && byId.get(e.to) !== undefined && byId.get(e.to)!.change !== "unchanged") || (e.to === n.id && byId.get(e.from) !== undefined && byId.get(e.from)!.change !== "unchanged"));
    if (!joined) problems.push(`architecture node ${JSON.stringify(n.id)} is unchanged and no edge connects it to an added or modified node; drop it (the diagram is context, not inventory)`);
  }
  return problems;
}

// ---- the tree check ----

/** Entries one `arch-check` command takes: 4 argv elements each, within the executor's 64. */
const ENTRIES_PER_COMMAND = 14;

/** A Go file's import paths, one per line: the `import (...)` block and single-line imports; comments are skipped. */
const GO_IMPORTS_AWK = String.raw`/^[ \t]*\/\// { next } /^import[ \t]*\(/ { inb = 1; next } inb && /^\)/ { inb = 0; next } inb { if (match($0, /"[^"]+"/)) print substr($0, RSTART + 1, RLENGTH - 2); next } /^import[ \t]+/ { if (match($0, /"[^"]+"/)) print substr($0, RSTART + 1, RLENGTH - 2) }`;

/**
 * The tree check, read-only (no repository code runs, no write): a cite resolves in its tree (the file exists there
 * and has the lines), a path exists at the base, and a Go package's head import blocks are listed (a directory's
 * `*.go` files, or the one file; a symbolic link is never followed). Each entry is four argv elements: the kind, the
 * tree, the path and the last line. The output is one line per fact, `checked <n>` last.
 */
const ARCH_SCRIPT =
  String.raw`set -u; base="$1"; shift
g() { git -c core.hooksPath=/dev/null "$@"; }
imports() {
  idx="$1"; target="$2"
  if [ -d "$target" ]; then set -- "$target"/*.go; elif [ -f "$target" ]; then set -- "$target"; else set --; fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    [ -L "$f" ] && continue
    case "$f" in *.go) ;; *) continue ;; esac
    echo "$idx gofile"
    awk '` +
  GO_IMPORTS_AWK +
  String.raw`' "$f" | sed "s/^/$idx import /"
  done
  echo "$idx done"
}
{ i=0
while [ "$#" -ge 4 ]; do
  kind="$1"; tree="$2"; path="$3"; end="$4"; shift 4; i=$((i + 1))
  case "$kind" in
    cite)
      if [ "$tree" = base ]; then
        if ! g cat-file -e "$base:$path" 2>/dev/null; then echo "$i missing"; continue; fi
        n=$(g show "$base:$path" 2>/dev/null | awk 'END { print NR }')
      else
        if [ ! -f "$path" ]; then echo "$i missing"; continue; fi
        n=$(awk 'END { print NR }' "$path")
      fi
      if [ "$end" -gt "$n" ]; then echo "$i range $n"; else echo "$i ok"; fi ;;
    exists)
      if g cat-file -e "$base:$path" 2>/dev/null; then echo "$i ok"; else echo "$i missing"; fi ;;
    imports)
      imports "$i" "$path" ;;
  esac
done; echo "checked $i"; } > "$GRAPHLOOM_REPORT_FILE"`;

interface Entry {
  kind: "cite" | "exists" | "imports";
  tree: "head" | "base";
  path: string;
  end: number;
  /** What the entry checks, for the problem sentence. */
  uses: string[];
}

export interface ArchPlan {
  /** Why the check cannot run (no pinned base), or undefined. */
  unavailable?: string;
  commands: EnvironmentCommand[];
  entries: Entry[];
  /** How entries map to commands, in order. */
  sizes: number[];
  /** Imports to check: the edge (1-based), its from and to nodes. */
  importEdges: Array<{ n: number; from: ArchNode; to: ArchNode }>;
}

const needsTree = (a: Architecture): boolean => a.nodes.length > 0 || a.edges.length > 0;

/**
 * The tree check of a diagram, as commands (design §6.10): every cite resolved in the tree it names, every unchanged
 * node's paths looked up at the base, and, for a Go `call` or `import` edge between two package nodes that is not
 * removed, the `from` package's head import blocks listed. The commands' argv names the base and every entry, so a
 * recorded run belongs to exactly this diagram.
 */
export function architecturePlan(arch: Architecture, base: string | undefined): ArchPlan {
  const entries = new Map<string, Entry>();
  const add = (kind: Entry["kind"], tree: Entry["tree"], path: string, end: number, use: string): void => {
    const key = `${kind}|${tree}|${path}|${end}`;
    const e = entries.get(key);
    if (e === undefined) entries.set(key, { kind, tree, path, end, uses: [use] });
    else if (!e.uses.includes(use)) e.uses.push(use);
  };
  const byId = new Map(arch.nodes.map((n) => [n.id, n] as const));
  arch.nodes.forEach((n) => add("cite", n.cite.side, n.cite.path, n.cite.end, `node ${n.id}`));
  arch.edges.forEach((e, i) => add("cite", e.cite.side, e.cite.path, e.cite.end, `edge ${edgeClaimId(i + 1)}`));
  for (const n of arch.nodes) if (n.change === "unchanged") for (const p of n.paths) add("exists", "base", normal(p), 0, `node ${n.id}`);
  const importEdges: ArchPlan["importEdges"] = [];
  arch.edges.forEach((e, i) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from === undefined || to === undefined || e.change === "removed" || (e.kind !== "call" && e.kind !== "import") || from.kind !== "package" || to.kind !== "package") return;
    importEdges.push({ n: i + 1, from, to });
    for (const p of from.paths) add("imports", "head", normal(p), 0, `edge ${edgeClaimId(i + 1)}`);
  });
  const list = [...entries.values()];
  if (list.length === 0 || !needsTree(arch)) return { commands: [], entries: [], sizes: [], importEdges: [] };
  if (base === undefined) return { unavailable: "the checkout recorded no pinned base, so the diagram's cites cannot be resolved in their trees", commands: [], entries: list, sizes: [], importEdges };
  const commands: EnvironmentCommand[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < list.length; i += ENTRIES_PER_COMMAND) {
    const chunk = list.slice(i, i + ENTRIES_PER_COMMAND);
    const id = `${COMMAND.archCheck}-${commands.length + 1}`;
    commands.push({ id, argv: ["sh", "-c", ARCH_SCRIPT, id, base, ...chunk.flatMap((e) => [e.kind, e.tree, e.path, String(e.end)])] });
    sizes.push(chunk.length);
  }
  return { commands, entries: list, sizes, importEdges };
}

export interface ArchCheck {
  /** Deterministic problems: the reporter is asked to correct them. */
  problems: string[];
  /** Import notes for the checker, by edge claim id (`A.e3`). */
  notes: Map<string, string>;
}

/** The directory a node's path stands for as a Go package, or the path's own directory when it names a file. */
const packageDir = (p: string): string => {
  const q = normal(p);
  return /\.go$/.test(q) ? (q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "") : q;
};

/**
 * Reads the outputs of a plan's commands (the text each printed, in order): the cites that do not resolve and the
 * unchanged paths missing at the base are problems; a Go call or import edge whose `from` package's head imports
 * name no package of the `to` node is a note to the claim checker, never a failure by itself.
 */
export function readArchitectureCheck(plan: ArchPlan, outputs: readonly string[]): ArchCheck {
  const problems: string[] = [];
  const notes = new Map<string, string>();
  const imports = new Map<number, { goFiles: number; paths: string[] }>();
  let offset = 0;
  plan.sizes.forEach((size, c) => {
    const lines = (outputs[c] ?? "").split("\n");
    const checked = lines.map((l) => /^checked (\d+)$/.exec(l)).find((m) => m !== null);
    if (checked === undefined || Number(checked[1]) !== size) {
      problems.push(`the tree check ${COMMAND.archCheck}-${c + 1} checked ${checked?.[1] ?? "none"} of ${size} entries`);
      offset += size;
      return;
    }
    for (let k = 1; k <= size; k += 1) {
      const entry = plan.entries[offset + k - 1]!;
      const own = lines.filter((l) => l.startsWith(`${k} `));
      if (entry.kind === "imports") {
        const got = imports.get(offset + k) ?? { goFiles: 0, paths: [] };
        for (const l of own) {
          if (l === `${k} gofile`) got.goFiles += 1;
          const m = /^\d+ import (.+)$/.exec(l);
          if (m !== null) got.paths.push(m[1]!);
        }
        imports.set(offset + k, got);
        continue;
      }
      const verdict = own.map((l) => /^\d+ (ok|missing|range (\d+))$/.exec(l)).find((m) => m !== null);
      const who = entry.uses.join(", ");
      if (verdict === undefined) problems.push(`${who}: ${entry.kind === "cite" ? "its cite" : "its path"} ${entry.path} was not checked`);
      else if (verdict[1] === "missing") {
        problems.push(
          entry.kind === "cite"
            ? `${who}: the cite ${entry.path}:${entry.end} names no such file in the ${entry.tree} tree`
            : `${who}: the path ${entry.path} does not exist at the base, so the node cannot be unchanged (an added node is "added")`,
        );
      } else if (verdict[1]!.startsWith("range")) problems.push(`${who}: the cite ${entry.path} lies past the end of the file in the ${entry.tree} tree (${verdict[2]} lines)`);
    }
    offset += size;
  });
  for (const e of plan.importEdges) {
    const wanted = e.to.paths.map(packageDir).filter((d) => d !== "");
    if (wanted.length === 0) continue;
    let goFiles = 0;
    const found: string[] = [];
    for (const p of e.from.paths) {
      const index = plan.entries.findIndex((x) => x.kind === "imports" && x.path === normal(p));
      const got = imports.get(index + 1);
      if (got !== undefined) {
        goFiles += got.goFiles;
        found.push(...got.paths);
      }
    }
    if (goFiles === 0) continue;
    if (!found.some((imp) => wanted.some((d) => imp === d || imp.endsWith(`/${d}`)))) {
      notes.set(
        edgeClaimId(e.n),
        `import missing: the head's import blocks of package ${e.from.label} (${e.from.paths.join(", ")}) list no import of ${e.to.label} (${wanted.join(", ")}); judge whether the cited code makes this connection some other way, or not at all`,
      );
    }
  }
  return { problems, notes };
}

// ---- the claim check's quotes, verified against the tree ----

export interface TreeQuoteEntry {
  id: string;
  tree: "head" | "base";
  path: string;
  line: number;
  text: string;
}

export interface TreeQuotePlan {
  unavailable?: string;
  commands: EnvironmentCommand[];
  entries: TreeQuoteEntry[];
  sizes: number[];
}

/**
 * Whether each quote is on a line of its file in the tree the cite names, within three lines of the one it gives, as
 * the diff's own quotes are matched (whitespace collapsed). The quote travels in the environment, not in awk's `-v`,
 * which would read its backslashes. Read-only; no repository code runs.
 */
const QUOTE_SCRIPT = String.raw`set -u; base="$1"; shift
g() { git -c core.hooksPath=/dev/null "$@"; }
{ i=0
while [ "$#" -ge 4 ]; do
  tree="$1"; path="$2"; line="$3"; QUOTE="$4"; shift 4; i=$((i + 1))
  export QUOTE
  if [ "$tree" = base ]; then
    if ! g cat-file -e "$base:$path" 2>/dev/null; then echo "$i missing"; continue; fi
    g show "$base:$path" 2>/dev/null > "$GRAPHLOOM_REPORT_FILE.q"
  else
    if [ ! -f "$path" ]; then echo "$i missing"; continue; fi
    cat "$path" > "$GRAPHLOOM_REPORT_FILE.q"
  fi
  awk -v at="$line" 'function c(s) { gsub(/[ \t\r\n]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s); return s } BEGIN { w = c(ENVIRON["QUOTE"]) } NR >= at - 3 && NR <= at + 3 { if (index(c($0), w) > 0) f = 1 } END { print (f ? "ok" : "nomatch") }' "$GRAPHLOOM_REPORT_FILE.q" | sed "s/^/$i /"
done; rm -f "$GRAPHLOOM_REPORT_FILE.q"; echo "checked $i"; } > "$GRAPHLOOM_REPORT_FILE"`;

/** The commands that verify the supported architecture claims' quotes against their trees (at most 14 quotes each). */
export function treeQuotePlan(claims: ReadonlyArray<{ id: string; tree: "head" | "base"; quotes: ReadonlyArray<{ path: string; line: number; text: string }> }>, base: string | undefined): TreeQuotePlan {
  const entries: TreeQuoteEntry[] = claims.flatMap((c) => c.quotes.map((q) => ({ id: c.id, tree: c.tree, path: normal(q.path), line: q.line, text: q.text })));
  if (entries.length === 0) return { commands: [], entries: [], sizes: [] };
  if (base === undefined) return { unavailable: "the checkout recorded no pinned base, so the diagram's quotes cannot be verified in their trees", commands: [], entries, sizes: [] };
  const commands: EnvironmentCommand[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < entries.length; i += ENTRIES_PER_COMMAND) {
    const chunk = entries.slice(i, i + ENTRIES_PER_COMMAND);
    const id = `${COMMAND.archQuote}-${commands.length + 1}`;
    commands.push({ id, argv: ["sh", "-c", QUOTE_SCRIPT, id, base, ...chunk.flatMap((e) => [e.tree, e.path, String(e.line), e.text])] });
    sizes.push(chunk.length);
  }
  return { commands, entries, sizes };
}

/** The claims whose quotes the tree does not show, with why (a claim with one bad quote is unsupported), from the outputs of a plan's commands. */
export function readTreeQuotes(plan: TreeQuotePlan, outputs: readonly string[]): Map<string, string> {
  const failed = new Map<string, string>();
  let offset = 0;
  plan.sizes.forEach((size, c) => {
    const lines = (outputs[c] ?? "").split("\n");
    const checked = lines.map((l) => /^checked (\d+)$/.exec(l)).find((m) => m !== null);
    for (let k = 1; k <= size; k += 1) {
      const e = plan.entries[offset + k - 1]!;
      const verdict = lines.find((l) => l.startsWith(`${k} `))?.slice(`${k} `.length);
      if (checked === undefined || Number(checked[1]) !== size || verdict === undefined) failed.set(e.id, failed.get(e.id) ?? `its quote ${JSON.stringify(e.text.slice(0, 60))} was not checked against the ${e.tree} tree`);
      else if (verdict === "missing") failed.set(e.id, failed.get(e.id) ?? `its quote names no such file in the ${e.tree} tree (${e.path})`);
      else if (verdict !== "ok") failed.set(e.id, failed.get(e.id) ?? `its quote ${JSON.stringify(e.text.slice(0, 60))} is not in the ${e.tree} tree at ${e.path}:${e.line} (within three lines)`);
    }
    offset += size;
  });
  return new Map([...failed].map(([id, why]) => [id, `unsupported: ${why}`]));
}

// ---- claims ----

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const asCite = (c: ArchCite) => ({ path: c.path, side: c.side, start: c.start, end: c.end, symbol: "" });

/** The claims of a diagram: each node (`A.<id>`) and each edge (`A.e<n>`), the edge with the plugin's import note when it has one. */
export function architectureTargets(arch: Architecture, notes: ReadonlyMap<string, string> = new Map()): ClaimTarget[] {
  const label = new Map(arch.nodes.map((n) => [n.id, n.label] as const));
  const out: ClaimTarget[] = [];
  for (const n of arch.nodes) {
    out.push({ id: nodeClaimId(n.id), text: `Architecture node ${n.id} "${collapse(n.label)}" (${n.kind}, ${n.change}): it is ${n.paths.join(", ")}, and the pull request ${n.change === "added" ? "adds" : n.change === "modified" ? "modifies" : "does not change"} it`, cites: [asCite(n.cite)], quotes: "required", tree: n.cite.side });
  }
  arch.edges.forEach((e, i) => {
    const note = notes.get(edgeClaimId(i + 1));
    out.push({
      id: edgeClaimId(i + 1),
      text: `Architecture edge ${collapse(label.get(e.from) ?? e.from)} → ${collapse(label.get(e.to) ?? e.to)} (${e.kind}, ${e.change}): ${collapse(e.label)}; the code at the cite makes that connection${note !== undefined ? `. Plugin note: ${note}` : ""}`,
      cites: [asCite(e.cite)],
      quotes: "required",
      tree: e.cite.side,
    });
  });
  return out;
}

/**
 * The diagram once the claim check's verdicts are applied (design §6.10): an unsupported node is dropped with its
 * edges, an unsupported edge alone; an unchanged node left with no edge to a changed one is context no longer and is
 * dropped too. Each drop is a removed part, recorded under "Removed by the claim check".
 */
export function assembleArchitecture(arch: Architecture, removed: ReadonlyMap<string, string>): { architecture: Architecture; parts: RemovedPart[] } {
  const parts: RemovedPart[] = [];
  const goneNodes = new Set(arch.nodes.filter((n) => removed.has(nodeClaimId(n.id))).map((n) => n.id));
  for (const n of arch.nodes) {
    if (!goneNodes.has(n.id)) continue;
    const lost = arch.edges.filter((e) => e.from === n.id || e.to === n.id).length;
    parts.push({ id: nodeClaimId(n.id), kind: "node", item: "", label: n.label, reason: `${removed.get(nodeClaimId(n.id))!}${lost > 0 ? ` (its ${lost} edge${lost === 1 ? "" : "s"} dropped with it)` : ""}` });
  }
  let edges = arch.edges.filter((e, i) => {
    if (goneNodes.has(e.from) || goneNodes.has(e.to)) return false;
    const reason = removed.get(edgeClaimId(i + 1));
    if (reason === undefined) return true;
    const label = new Map(arch.nodes.map((n) => [n.id, n.label] as const));
    parts.push({ id: edgeClaimId(i + 1), kind: "edge", item: "", label: `${label.get(e.from) ?? e.from} → ${label.get(e.to) ?? e.to}: ${e.label}`, reason });
    return false;
  });
  let nodes = arch.nodes.filter((n) => !goneNodes.has(n.id));
  // Context left without a changed neighbour goes too, until none is left.
  for (;;) {
    const changed = new Set(nodes.filter((n) => n.change !== "unchanged").map((n) => n.id));
    const orphan = nodes.find((n) => n.change === "unchanged" && !edges.some((e) => (e.from === n.id && changed.has(e.to)) || (e.to === n.id && changed.has(e.from))));
    if (orphan === undefined) break;
    parts.push({ id: nodeClaimId(orphan.id), kind: "node", item: "", label: orphan.label, reason: "no remaining edge connects it to an added or modified component" });
    nodes = nodes.filter((n) => n !== orphan);
    edges = edges.filter((e) => e.from !== orphan.id && e.to !== orphan.id);
  }
  return { architecture: { nodes, edges }, parts };
}

// ---- Mermaid ----

const mermaidText = (s: string): string => collapse(s).replace(/["<>]/g, (c) => ({ '"': "#quot;", "<": "#lt;", ">": "#gt;" })[c]!).replace(/[\[\]{}()|]/g, (c) => `#${c.charCodeAt(0)};`);

/**
 * The diagram as a `mermaid` code block for `review.md` (design §6.10): text only, so it renders where Markdown
 * renders Mermaid and reads as a list of components and connections where it does not.
 */
export function architectureMermaid(arch: Architecture): string[] {
  if (arch.nodes.length === 0) return [];
  const index = new Map(arch.nodes.map((n, i) => [n.id, `n${i + 1}`] as const));
  const lines = ["```mermaid", "flowchart LR"];
  for (const n of arch.nodes) lines.push(`  ${index.get(n.id)}["${mermaidText(n.label)}<br/>${n.kind}"]:::${n.change}`);
  for (const e of arch.edges) {
    const from = index.get(e.from);
    const to = index.get(e.to);
    if (from === undefined || to === undefined) continue;
    const arrow = e.change === "removed" ? "-.->" : "-->";
    lines.push(`  ${from} ${arrow}|"${mermaidText(e.label)} (${e.kind}${e.change === "unchanged" ? "" : `, ${e.change}`})"| ${to}`);
  }
  lines.push("  classDef added fill:#d7f0dd,stroke:#2e8b57,color:#12361f", "  classDef modified fill:#fdeccd,stroke:#d98e04,color:#4a3200", "  classDef unchanged fill:#eceff1,stroke:#90a4ae,color:#263238", "```");
  return lines;
}

/** The Architecture part of `review.md`: the Mermaid block, then the components and connections as a list. */
export function renderArchitectureMarkdown(arch: Architecture): string[] {
  if (arch.nodes.length === 0) return ["## Architecture", "- None: the report draws no component.", ""];
  const label = new Map(arch.nodes.map((n) => [n.id, n.label] as const));
  const cell = (s: string): string => collapse(s);
  return [
    "## Architecture",
    ...architectureMermaid(arch),
    "",
    "Components:",
    ...arch.nodes.map((n) => `- ${cell(n.label)} (${n.kind}, ${n.change}): ${n.paths.join(", ")} — ${n.cite.path}:${n.cite.start === n.cite.end ? n.cite.start : `${n.cite.start}-${n.cite.end}`}${n.cite.side === "base" ? " (base)" : ""}`),
    ...(arch.edges.length > 0 ? ["Connections:"] : []),
    ...arch.edges.map((e) => `- ${cell(label.get(e.from) ?? e.from)} → ${cell(label.get(e.to) ?? e.to)} (${e.kind}, ${e.change}): ${cell(e.label)} — ${e.cite.path}:${e.cite.start === e.cite.end ? e.cite.start : `${e.cite.start}-${e.cite.end}`}${e.cite.side === "base" ? " (base)" : ""}`),
    "",
  ];
}
