// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { matchesGeneratedGlob } from "./metrics/generated.js";
import type { DetectorConfig, Profile } from "./profile.js";
import type { Side } from "./patch.js";
import { isDeleted, type PullFile } from "./snapshot.js";
import { reporterSections } from "./template.js";

/** A deterministic fact from the pinned patches (design §6.3). */
export interface Fact {
  id: string;
  section: string;
  path: string;
  side: Side;
  line: number;
  symbol?: string;
  text: string;
}

type RawFact = Omit<Fact, "id">;

/** Generic detectors that apply to every repository, before the profile's own. */
const DEFAULTS: ReadonlyArray<{ section: string; detector: DetectorConfig }> = [
  { section: "external", detector: { kind: "manifest", files: ["go.mod", "package.json", "pom.xml", "requirements*.txt", "Cargo.toml"] } },
  { section: "schema", detector: { kind: "paths", globs: ["**/migrations/**", "*.sql", "*.proto"], label: "schema or migration file" } },
  { section: "config", detector: { kind: "added-line", pattern: String.raw`os\.Getenv\("([^"]+)"\)`, label: "environment variable" } },
  { section: "config", detector: { kind: "added-line", pattern: String.raw`process\.env\.([A-Za-z_][A-Za-z0-9_]*)`, label: "environment variable" } },
  { section: "config", detector: { kind: "added-line", pattern: String.raw`\bflag\.\w+\(\s*"([^"]+)"`, label: "command-line flag" } },
  { section: "config", detector: { kind: "added-line", pattern: String.raw`Flags\(\)\.\w+\(\s*"([^"]+)"`, label: "command-line flag" } },
  { section: "background", detector: { kind: "added-line", pattern: String.raw`["'\x60]((?:[0-9*/,-]+\s+){4}[0-9*/,A-Za-z-]+)["'\x60]`, label: "cron expression" } },
  { section: "background", detector: { kind: "added-line", pattern: String.raw`["'\x60](@every\s+\S+)["'\x60]`, label: "schedule" } },
  { section: "interfaces", detector: { kind: "added-line", pattern: String.raw`\b(?:HandleFunc|Handle|GET|POST|PUT|DELETE|PATCH)\(\s*"(/[^"]*)"`, label: "route" } },
  { section: "interfaces", detector: { kind: "added-line", pattern: String.raw`\.(?:get|post|put|delete|patch)\(\s*['"](/[^'"]*)['"]`, label: "route" } },
  { section: "removed", detector: { kind: "removed" } },
  { section: "removed", detector: { kind: "deprecated" } },
];

const DEPRECATED = /\/\/\s*Deprecated:|@deprecated\b|\bdeprecated\s*=\s*true\b|\bDeprecated:\s*true\b/;
const GO_DECL = /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[(\[]|^type\s+([A-Z]\w*)\b/;
const TS_DECL = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|enum|abstract class)\s+(\w+)/;

function declName(text: string): string | undefined {
  const g = GO_DECL.exec(text);
  if (g !== null) return g[1] ?? g[2];
  return TS_DECL.exec(text)?.[1];
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const matches = (globs: readonly string[], path: string): boolean => matchesGeneratedGlob(globs, path);

interface Dep {
  name: string;
  version: string;
  line: number;
}

/** Dependency lines of a manifest's patch, by side, per its format (heuristic: the patch alone shows no section). */
function manifestDeps(file: PullFile, kind: "go" | "npm" | "pom" | "pip" | "cargo"): { added: Dep[]; removed: Dep[] } {
  const out = { added: [] as Dep[], removed: [] as Dep[] };
  const NPM_SKIP = new Set(["version", "name", "description", "main", "module", "types", "typings", "license", "homepage", "author", "packageManager", "node", "npm", "type", "repository", "bugs", "url"]);
  for (const l of file.parsed.lines) {
    if (l.kind === "ctx") continue;
    const text = l.text.trim();
    let dep: { name: string; version: string } | undefined;
    if (kind === "go") {
      const m = /^(?:require\s+)?([A-Za-z0-9._~-]+\.[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~/-]+)?)\s+(v\d\S*)/.exec(text);
      if (m !== null && !/^(?:replace|exclude|retract|module|go|toolchain)\b/.test(text)) dep = { name: m[1]!, version: m[2]! };
    } else if (kind === "npm") {
      const m = /^"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"([^"]+)"\s*,?$/.exec(text);
      if (m !== null && !NPM_SKIP.has(m[1]!) && /^(?:[\^~<>=]*\d|\*|latest|npm:|file:|git|https?:|workspace:|link:)/.test(m[2]!)) dep = { name: m[1]!, version: m[2]! };
    } else if (kind === "pom") {
      const m = /^<artifactId>([^<]+)<\/artifactId>/.exec(text);
      if (m !== null) dep = { name: m[1]!, version: "" };
    } else if (kind === "pip") {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*((?:[=<>~!]=?|@)\s*[^#\s;]+)?/.exec(text);
      if (m !== null && !text.startsWith("#") && !text.startsWith("-")) dep = { name: m[1]!, version: m[2] ?? "" };
    } else {
      const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/.exec(text);
      if (m !== null && !["name", "version", "edition", "authors", "description", "license", "repository", "homepage", "readme", "rust-version", "documentation", "publish"].includes(m[1]!)) dep = { name: m[1]!, version: m[2] ?? m[3] ?? "" };
    }
    if (dep !== undefined) (l.kind === "add" ? out.added : out.removed).push({ ...dep, line: l.line });
  }
  return out;
}

function manifestKind(path: string): "go" | "npm" | "pom" | "pip" | "cargo" | undefined {
  const b = baseName(path);
  if (b === "go.mod") return "go";
  if (b === "package.json") return "npm";
  if (b === "pom.xml") return "pom";
  if (/^requirements.*\.txt$/.test(b)) return "pip";
  if (b === "Cargo.toml") return "cargo";
  return undefined;
}

function manifestFacts(file: PullFile, section: string): RawFact[] {
  const kind = manifestKind(file.path);
  if (kind === undefined) return [];
  const { added, removed } = manifestDeps(file, kind);
  const facts: RawFact[] = [];
  const old = new Map(removed.map((d) => [d.name, d]));
  const seen = new Set<string>();
  for (const d of added) {
    const before = old.get(d.name);
    seen.add(d.name);
    const what = before === undefined ? `Dependency ${d.name}${d.version !== "" ? ` ${d.version}` : ""} added` : before.version === d.version ? undefined : `Dependency ${d.name} changed from ${before.version || "(unversioned)"} to ${d.version || "(unversioned)"}`;
    if (what !== undefined) facts.push({ section, path: file.path, side: "head", line: d.line, symbol: d.name, text: `${what} in ${file.path}` });
  }
  for (const d of removed) {
    if (seen.has(d.name)) continue;
    facts.push({ section, path: file.path, side: "base", line: d.line, symbol: d.name, text: `Dependency ${d.name}${d.version !== "" ? ` ${d.version}` : ""} removed from ${file.path}` });
  }
  return facts;
}

function addedLineFacts(file: PullFile, section: string, pattern: string, label: string | undefined): RawFact[] {
  const re = new RegExp(pattern);
  const facts: RawFact[] = [];
  for (const l of file.parsed.lines) {
    if (l.kind !== "add") continue;
    const m = re.exec(l.text);
    if (m === null) continue;
    const symbol = m[1];
    facts.push({ section, path: file.path, side: "head", line: l.line, ...(symbol !== undefined ? { symbol } : {}), text: `${label ?? "Added line matching"}${symbol !== undefined ? ` ${symbol}` : ""} at ${file.path}:${l.line}` });
  }
  return facts;
}

function removedFacts(file: PullFile, section: string): RawFact[] {
  if (isDeleted(file)) {
    const first = file.parsed.lines.find((l) => l.kind === "del");
    return [{ section, path: file.path, side: "base", line: first?.line ?? 0, text: `File ${file.path} deleted` }];
  }
  const readded = new Set(file.parsed.lines.filter((l) => l.kind === "add").flatMap((l) => declName(l.text) ?? []));
  const facts: RawFact[] = [];
  for (const l of file.parsed.lines) {
    if (l.kind !== "del") continue;
    const name = declName(l.text);
    if (name === undefined || readded.has(name)) continue;
    facts.push({ section, path: file.path, side: "base", line: l.line, symbol: name, text: `Exported declaration ${name} removed from ${file.path}` });
  }
  return facts;
}

function deprecatedFacts(file: PullFile, section: string): RawFact[] {
  return file.parsed.lines.filter((l) => l.kind === "add" && DEPRECATED.test(l.text)).map((l) => ({ section, path: file.path, side: "head" as const, line: l.line, text: `Deprecation marker added at ${file.path}:${l.line}` }));
}

function pathFact(file: PullFile, section: string, label: string): RawFact {
  const deleted = isDeleted(file);
  const first = deleted ? file.parsed.lines.find((l) => l.kind === "del") : file.parsed.lines.find((l) => l.kind === "add");
  return { section, path: file.path, side: deleted ? "base" : "head", line: first?.line ?? 0, text: `${label} ${file.path} ${deleted ? "deleted" : file.status === "added" ? "added" : "changed"}` };
}

function detect(file: PullFile, section: string, d: DetectorConfig): RawFact[] {
  const applies = (globs: readonly string[] | undefined): boolean => globs === undefined || matches(globs, file.path);
  switch (d.kind) {
    case "manifest":
      return matches(d.files, file.path) ? manifestFacts(file, section) : [];
    case "paths":
      return matches(d.globs, file.path) ? [pathFact(file, section, d.label ?? "File")] : [];
    case "added-line":
      return applies(d.files) ? addedLineFacts(file, section, d.pattern, d.label) : [];
    case "removed":
      return applies(d.files) ? removedFacts(file, section) : [];
    case "deprecated":
      return applies(d.files) ? deprecatedFacts(file, section) : [];
  }
}

/**
 * Every detector fact of the pull request, in a stable order, with ids
 * `D1…`: the generic defaults, then each section's profile detectors, then
 * its routing (a changed file matching a section's routing glob is a fact of
 * that section). The same pull request and profile always give the same facts.
 */
export function detectFacts(files: readonly PullFile[], profile: Pick<Profile, "sections">): Fact[] {
  const raw: RawFact[] = [];
  const seen = new Set<string>();
  const add = (f: RawFact): void => {
    const key = `${f.section}\0${f.path}\0${f.side}\0${f.line}\0${f.symbol ?? f.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    raw.push(f);
  };
  const sections = reporterSections(profile);
  const known = new Set(sections.map((s) => s.id));
  for (const file of files) {
    for (const { section, detector } of DEFAULTS) for (const f of detect(file, section, detector)) add(f);
    for (const s of sections) {
      for (const d of s.detectors) for (const f of detect(file, s.id, d)) add(f);
      if (s.routing.length > 0 && matches(s.routing, file.path)) add(pathFact(file, s.id, "File routed to this section:"));
    }
  }
  return raw
    .filter((f) => known.has(f.section))
    .map((f, i) => ({ ...f, id: `D${i + 1}` }));
}
