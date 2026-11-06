// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The checks and edits of `release.sh prepare` and `publish`
 * (docs/design-release.md §3, §6 steps 1, 2, and 10).
 *
 *   node scripts/release/prepare.mjs bump --root <repo> --version <v>
 *        Sets the lockstep versions (§3) and every workspace's dependency on
 *        a lockstep package, and the SDK entries of the plugins' own
 *        lockfiles. Prints each file it changed.
 *   node scripts/release/prepare.mjs draft --file CHANGELOG.md --version <v> --date <YYYY-MM-DD> --log <subjects file>
 *        Inserts a draft section for <v> with TODO markers; exits 3 when it wrote one.
 *   node scripts/release/prepare.mjs changelog --root <repo> --version <v> [--release <release.json>]
 *        Writes the components table into the section from the tree, or
 *        with --release requires the table to match release.json; then
 *        requires the section with its upgrade notes and no TODO marker.
 *   node scripts/release/prepare.mjs lockstep --root <repo> --version <v>
 *        The §3 lockstep rule, and each plugin's package.json version equal to its manifest's.
 *   node scripts/release/prepare.mjs notes --file CHANGELOG.md --version <v>
 *        Prints the section's body: the release notes (§2.1).
 *   node scripts/release/prepare.mjs components --src <built tree> [--out <file>]
 *        Prints the executors, plugins, stateFormat, and sdkProtocol that
 *        release.json will record for the tree, digested as assemble.mjs
 *        digests the shipped copies.
 *   node scripts/release/prepare.mjs check-components --current <json> --previous <release.json> [--src <built tree>] [--fixtures-root <dir>]
 *        The component bump rule (§3), and for a changed stateFormat a
 *        migrator and a fixture (§6 step 2).
 *   node scripts/release/prepare.mjs bump-components --root <repo> --current <json> --previous <release.json>
 *        Raises the patch version of each executor and plugin that changed since
 *        the previous release at an unchanged version (§3), with every place
 *        its version lives. Prints "<kind> <name> <from> <to>" per component.
 *   node scripts/release/prepare.mjs latest --tags <file> [--below <v>]
 *        The newest MAJOR.MINOR.PATCH among `v<version>` tags, one per line.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, readJson, runMain, sha256 } from "./lib.mjs";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** The labelled upgrade notes every section carries (§3, "Changelog"). */
export const UPGRADE_TOPICS = ["State format", "Configuration", "SDK protocol", "Node", "Digests"];

export function parseVersion(v) {
  const m = VERSION_RE.exec(v);
  if (!m) throw new Error(`version must be MAJOR.MINOR.PATCH, got ${v}`);
  return m.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The newest release version among tag names, optionally only those below `below`. */
export function latestVersion(tags, below) {
  let best;
  for (const tag of tags) {
    const v = tag.trim().replace(/^v/, "");
    if (!VERSION_RE.test(v) || !tag.trim().startsWith("v")) continue;
    if (below !== undefined && compareVersions(v, below) >= 0) continue;
    if (best === undefined || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/** Workspace directories (relative), from the root package.json globs of the form `dir/*`. */
export function workspaceDirs(root) {
  const out = [];
  for (const glob of readJson(path.join(root, "package.json")).workspaces ?? []) {
    if (!glob.endsWith("/*")) throw new Error(`workspace glob ${glob} is not of the form <dir>/*`);
    const parent = glob.slice(0, -2);
    if (!existsSync(path.join(root, parent))) continue;
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && existsSync(path.join(root, parent, entry.name, "package.json"))) out.push(`${parent}/${entry.name}`);
    }
  }
  return out;
}

/** The lockstep packages (§3): the root, `packages/*` except testkit, and `apps/*`. */
export function lockstepDirs(root) {
  return [".", ...workspaceDirs(root).filter((rel) => (rel.startsWith("packages/") && rel !== "packages/testkit") || rel.startsWith("apps/"))];
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** §6 step 2: sets the lockstep versions and the dependencies on them; returns the changed files. */
export function bumpVersions(root, version) {
  parseVersion(version);
  const lockstep = lockstepDirs(root);
  const names = new Set(lockstep.filter((rel) => rel !== ".").map((rel) => readJson(path.join(root, rel, "package.json")).name));
  const changed = [];
  for (const rel of [".", ...workspaceDirs(root)]) {
    const file = path.join(root, rel, "package.json");
    const before = readFileSync(file, "utf8");
    const pkg = JSON.parse(before);
    if (lockstep.includes(rel)) pkg.version = version;
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        // A `file:` or other protocol dependency (the plugins' SDK link) has no version to set.
        if (names.has(dep) && /^[\^~]?\d/.test(range)) pkg[field][dep] = version;
      }
    }
    const after = `${JSON.stringify(pkg, null, 2)}\n`;
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(rel === "." ? "package.json" : `${rel}/package.json`);
    }
  }
  // A workspace's own lockfile (the plugins') records the linked SDK's version; the root one is npm's to refresh.
  for (const rel of workspaceDirs(root)) {
    const file = path.join(root, rel, "package-lock.json");
    if (!existsSync(file)) continue;
    const lock = readJson(file);
    let touched = false;
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (key === "" || key.startsWith("node_modules/") || !names.has(entry.name) || entry.version === version) continue;
      entry.version = version;
      touched = true;
    }
    if (touched) {
      writeJson(file, lock);
      changed.push(`${rel}/package-lock.json`);
    }
  }
  return changed;
}

/** `^`/`~` kept, the digits replaced. */
const withRange = (range, version) => `${/^[\^~]/.test(range) ? range[0] : ""}${version}`;

export function patchBump(version) {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** Source files under a plugin's `src/` (not vendored trees), for the graph's version constant. */
function pluginSources(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "vendor") walk(full);
      } else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  if (existsSync(path.join(dir, "src"))) walk(path.join(dir, "src"));
  return out;
}

/**
 * §3 and §6 step 2: after the lockstep bump, raises the patch version of every
 * executor and plugin whose digest or manifest differs from `previous`
 * (release.json) at an unchanged version, in every place the version lives:
 * its package.json, a plugin's graph version constant (`GRAPH_VERSION = "x"`
 * or a `version: "x"` line) and own lockfile, and the dependency pins on an
 * executor in other workspaces. A component whose version already differs
 * from the previous release's is left alone. `current` has the release.json
 * shape (digests of the tree as it is now). Returns `{ kind, name, from, to }`.
 */
export function bumpComponents(root, current, previous) {
  const bumped = [];
  const dirs = workspaceDirs(root);
  const wasExecutor = new Map((previous.executors ?? []).map((e) => [e.package, e]));
  const wasPlugin = new Map((previous.plugins ?? []).map((p) => [p.graphId, p]));
  const pins = new Map();
  const bumpPackage = (rel, to) => {
    const file = path.join(root, rel, "package.json");
    const pkg = readJson(file);
    pkg.version = to;
    writeJson(file, pkg);
  };
  for (const e of current.executors ?? []) {
    const was = wasExecutor.get(e.package);
    if (!was || was.digest === e.digest || was.version !== e.version) continue;
    const rel = dirs.find((d) => d.startsWith("executors/") && readJson(path.join(root, d, "package.json")).name === e.package);
    if (!rel) throw new Error(`executor ${e.package} has no workspace under executors/`);
    const to = patchBump(e.version);
    bumpPackage(rel, to);
    pins.set(e.package, to);
    bumped.push({ kind: "executor", name: e.package, from: e.version, to });
  }
  for (const p of current.plugins ?? []) {
    const was = wasPlugin.get(p.graphId);
    if (!was || (was.manifestSha256 === p.manifestSha256 && was.sourceTree === p.sourceTree) || was.version !== p.version) continue;
    const rel = dirs.find((d) => d.startsWith("examples/plugins/") && readJson(path.join(root, d, "graphloom.manifest.json")).graphId === p.graphId);
    if (!rel) throw new Error(`plugin ${p.graphId} has no workspace under examples/plugins/`);
    const to = patchBump(p.version);
    const dir = path.join(root, rel);
    bumpPackage(rel, to);
    // The graph's own declaration of its version.
    const pattern = new RegExp(`^(\\s*(?:export const GRAPH_VERSION = |version: ))"${p.version.replace(/\./g, "\\.")}"`, "m");
    const hits = pluginSources(dir).filter((f) => pattern.test(readFileSync(f, "utf8")));
    if (hits.length > 1) throw new Error(`plugin ${p.graphId}: ${hits.length} source files declare version ${p.version}, expected one`);
    if (hits.length === 1) writeFileSync(hits[0], readFileSync(hits[0], "utf8").replace(pattern, `$1"${to}"`));
    // The plugin's own lockfile records its own version.
    const lockFile = path.join(dir, "package-lock.json");
    if (existsSync(lockFile)) {
      const lock = readJson(lockFile);
      if (lock.version === p.version) lock.version = to;
      if (lock.packages?.[""]?.version === p.version) lock.packages[""].version = to;
      writeJson(lockFile, lock);
    }
    bumped.push({ kind: "plugin", name: p.graphId, from: p.version, to });
  }
  // Dependency pins on a bumped executor (the CLI's, testkit's).
  for (const rel of [".", ...dirs]) {
    const file = path.join(root, rel, "package.json");
    const pkg = readJson(file);
    let touched = false;
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        const to = pins.get(dep);
        if (to && /^[\^~]?\d/.test(range)) {
          pkg[field][dep] = withRange(range, to);
          touched = true;
        }
      }
    }
    if (touched) writeJson(file, pkg);
  }
  return bumped;
}

/** The `## [<v>]` section of a changelog: `{ start, end, heading, body }` line indexes, or undefined. */
export function findSection(text, version) {
  const lines = text.split("\n");
  const esc = version.replace(/\./g, "\\.");
  const head = new RegExp(`^## \\[?v?${esc}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { start, end, heading: lines[start], body: lines.slice(start + 1, end).join("\n").replace(/\s+$/, "") + "\n", lines };
}

const TABLE_BEGIN = "<!-- components: generated by scripts/release/prepare.mjs from release.json; do not edit -->";
const TABLE_END = "<!-- /components -->";

/** The components table (§3) for `{ executors, plugins }` as release.json records them. */
export function componentsTable({ executors, plugins }) {
  const rows = [
    ...[...executors].sort((a, b) => a.package.localeCompare(b.package)).map((e) => `| ${e.package} | executor | ${e.version} |`),
    ...[...plugins].sort((a, b) => a.graphId.localeCompare(b.graphId)).map((p) => `| ${p.graphId} | plugin | ${p.version} |`),
  ];
  return [TABLE_BEGIN, "| Component | Kind | Version |", "|---|---|---|", ...rows, TABLE_END].join("\n");
}

/** The executor and plugin versions a source tree will ship (no digests, so no build is needed). */
export function treeComponentVersions(root) {
  const executors = [];
  const plugins = [];
  for (const rel of workspaceDirs(root)) {
    if (rel.startsWith("executors/")) {
      const pkg = readJson(path.join(root, rel, "package.json"));
      executors.push({ package: pkg.name, version: pkg.version });
    } else if (rel.startsWith("examples/plugins/")) {
      const manifest = readJson(path.join(root, rel, "graphloom.manifest.json"));
      plugins.push({ graphId: manifest.graphId, version: manifest.version });
    }
  }
  return { executors, plugins };
}

/** Puts `table` into the section, replacing a previous table, before the section's end. */
export function withTable(text, version, table) {
  const s = findSection(text, version);
  if (!s) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const body = s.lines.slice(s.start + 1, s.end);
  const b = body.indexOf(TABLE_BEGIN);
  const e = body.indexOf(TABLE_END);
  let next;
  if (b >= 0 && e > b) next = [...body.slice(0, b), ...table.split("\n"), ...body.slice(e + 1)];
  else {
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    next = [...body, "", "### Components", "", ...table.split("\n"), ""];
  }
  return [...s.lines.slice(0, s.start + 1), ...next, ...s.lines.slice(s.end)].join("\n");
}

/** The section's problems: missing entries or upgrade notes, a TODO left in it, or a stale table. */
export function checkSection(text, version, expectedTable) {
  const s = findSection(text, version);
  if (!s) return [`CHANGELOG.md has no "## [${version}]" section`];
  const problems = [];
  if (/\bTODO\b/.test(s.body)) problems.push(`the ${version} section still has a TODO marker`);
  if (!/^### (Added|Changed|Fixed)\s*$/m.test(s.body)) problems.push(`the ${version} section has no Added, Changed, or Fixed entries`);
  const notes = /^### Upgrade notes\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(s.body);
  if (!notes) problems.push(`the ${version} section has no "### Upgrade notes"`);
  else {
    for (const topic of UPGRADE_TOPICS) {
      if (!new RegExp(`^- \\*\\*${topic}[.:]?\\*\\*`, "m").test(notes[1])) problems.push(`the ${version} upgrade notes have no "- **${topic}:**" entry`);
    }
  }
  if (expectedTable !== undefined && !s.body.includes(expectedTable)) problems.push(`the ${version} components table does not match the components this tree or release.json records`);
  return problems;
}

/** A draft section from commit subjects, every judgement left as a TODO for the maintainer. */
export function draftSection(version, date, subjects, facts = {}) {
  const pick = (re) => subjects.filter((s) => re.test(s)).map((s) => `- ${s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")}`);
  const added = pick(/^feat(\(|:|!)/i);
  const fixed = pick(/^fix(\(|:|!)/i);
  const changed = subjects.filter((s) => !/^(feat|fix)(\(|:|!)/i.test(s)).map((s) => `- ${s}`);
  return [
    `## [${version}] - ${date}`,
    "",
    "TODO: one paragraph on what this release is for. Condense the entries below to what an operator or plugin author notices.",
    "",
    "### Added",
    "",
    ...(added.length ? added : ["- TODO"]),
    "",
    "### Changed",
    "",
    ...(changed.length ? changed : ["- TODO"]),
    "",
    "### Fixed",
    "",
    ...(fixed.length ? fixed : ["- TODO"]),
    "",
    "### Upgrade notes",
    "",
    `- **State format:** ${facts.stateFormat ?? "TODO"} (TODO: the migrations that move runs from earlier releases, or none).`,
    "- **Configuration:** TODO (keys added, changed, or removed in runner.json and supervisor.json).",
    `- **SDK protocol:** ${facts.sdkProtocol ?? "TODO"} (TODO: the SDK range this release accepts).`,
    `- **Node:** ${facts.node ?? "TODO"} (bundled).`,
    "- **Digests:** TODO (which executor and plugin digests changed; runs started on the previous version stay on it unless moved with `resume --upgrade`).",
    "",
  ].join("\n");
}

/** Inserts `section` above the newest version section (or at the end), keeping the file's preamble. */
export function insertSection(text, section) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^## \[?v?\d+\.\d+\.\d+/.test(l));
  const block = section.replace(/\n+$/, "").split("\n");
  if (at < 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return [...lines, "", ...block, ""].join("\n");
  }
  return [...lines.slice(0, at), ...block, "", ...lines.slice(at)].join("\n");
}

/** Never copied from a source-repairable package (assemble.mjs, §6 step 6). */
function skipInPackage(name) {
  return name === "node_modules" || name === ".git" || name === "graphloom-state" || name === "coverage" || name === ".cache" || /^\.env(\.|$)/.test(name) || name.endsWith(".tsbuildinfo");
}

/**
 * The components release.json will record for a built tree: each executor
 * digested over the copy assemble.mjs ships, each plugin's manifest digest
 * and source tree, the state format, and the SDK protocol.
 */
export async function treeComponents(src) {
  const { digestExecutorSource } = await import(pathToFileURL(path.join(src, "packages", "runner", "dist", "index.js")).href);
  const { PROTOCOL_VERSION } = await import(pathToFileURL(path.join(src, "packages", "sdk", "dist", "index.js")).href);
  const { CURRENT_STATE_FORMAT } = await import(pathToFileURL(path.join(src, "packages", "controller", "dist", "index.js")).href);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "graphloom-components-"));
  try {
    const executors = [];
    const plugins = [];
    for (const rel of workspaceDirs(src)) {
      const pkg = readJson(path.join(src, rel, "package.json"));
      if (rel.startsWith("executors/")) {
        const copy = path.join(scratch, rel);
        await cp(path.join(src, rel), copy, { recursive: true, verbatimSymlinks: true, filter: (p) => !skipInPackage(path.basename(p)) });
        executors.push({ package: pkg.name, version: pkg.version, digest: await digestExecutorSource(copy) });
      } else if (rel.startsWith("examples/plugins/")) {
        const raw = await readFile(path.join(src, rel, "graphloom.manifest.json"));
        const manifest = JSON.parse(raw.toString("utf8"));
        plugins.push({ graphId: manifest.graphId, version: manifest.version, manifestSha256: sha256(raw), sourceTree: manifest.digests?.sourceTree });
      }
    }
    return {
      version: readJson(path.join(src, "package.json")).version,
      executors: executors.sort((a, b) => a.package.localeCompare(b.package)),
      plugins: plugins.sort((a, b) => a.graphId.localeCompare(b.graphId)),
      stateFormat: CURRENT_STATE_FORMAT,
      sdkProtocol: PROTOCOL_VERSION,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The committed state-format fixtures: `{ dir, stateFormat }` for each. */
export function stateFixtures(src) {
  const dir = path.join(src, "packages", "controller", "test", "fixtures", "state-formats");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "fixture.json")))
    .map((e) => ({ dir: e.name, stateFormat: readJson(path.join(dir, e.name, "fixture.json")).stateFormat }));
}

/**
 * The §3 bump rule and the §6 step 2 state-format rule. `current` has the
 * release.json shape (`executors`, `plugins`, `stateFormat`, and
 * `sdk.sdkProtocol` or `sdkProtocol`). `migrates(from)` says whether the
 * release carries a migration path from a format, and `fixtures` lists the
 * committed fixtures' formats.
 */
export function componentProblems(previous, current, { migrates = () => true, fixtures = [] } = {}) {
  const problems = [];
  const byPackage = new Map((previous.executors ?? []).map((e) => [e.package, e]));
  for (const e of current.executors ?? []) {
    const was = byPackage.get(e.package);
    if (was && was.digest !== e.digest && was.version === e.version) {
      problems.push(`executor ${e.package}: its digest changed since ${previous.version}, but its version is still ${e.version}; bump it`);
    }
  }
  const byGraph = new Map((previous.plugins ?? []).map((p) => [p.graphId, p]));
  for (const p of current.plugins ?? []) {
    const was = byGraph.get(p.graphId);
    if (was && (was.manifestSha256 !== p.manifestSha256 || was.sourceTree !== p.sourceTree) && was.version === p.version) {
      problems.push(`plugin ${p.graphId}: its manifest changed since ${previous.version}, but its version is still ${p.version}; bump it`);
    }
  }
  const prevFormat = previous.stateFormat ?? 1;
  const format = current.stateFormat;
  if (format < prevFormat) problems.push(`stateFormat ${format} is older than ${previous.version}'s ${prevFormat}`);
  if (format > prevFormat) {
    if (!migrates(prevFormat)) problems.push(`stateFormat changed from ${prevFormat} to ${format}, but there is no migration path from format ${prevFormat} (§5.2)`);
    if (!fixtures.some((f) => f.stateFormat === prevFormat)) {
      problems.push(`stateFormat changed from ${prevFormat} to ${format}, but no committed fixture under packages/controller/test/fixtures/state-formats/ is in format ${prevFormat} (§6 step 8.8)`);
    }
  }
  const prevProtocol = previous.sdk?.sdkProtocol;
  const protocol = current.sdk?.sdkProtocol ?? current.sdkProtocol;
  if (prevProtocol !== undefined && protocol !== prevProtocol && current.version !== undefined && previous.version !== undefined) {
    const [pMajor, pMinor] = parseVersion(previous.version);
    const [cMajor, cMinor] = parseVersion(current.version);
    const breaking = cMajor !== pMajor || (cMajor === 0 && cMinor !== pMinor);
    if (!breaking) problems.push(`sdkProtocol changed from ${prevProtocol} to ${protocol}, which is a breaking change, but ${current.version} is not a breaking release after ${previous.version} (§3)`);
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { flags } = parseArgs(rest);
    const need = (...names) => {
      for (const n of names) if (!flags[n]) throw new Error(`prepare.mjs ${cmd}: --${n} is required`);
    };
    switch (cmd) {
      case "bump": {
        need("root", "version");
        for (const file of bumpVersions(path.resolve(flags.root), flags.version)) console.log(file);
        return;
      }
      case "bump-components": {
        need("root", "current", "previous");
        const bumped = bumpComponents(path.resolve(flags.root), readJson(path.resolve(flags.current)), readJson(path.resolve(flags.previous)));
        for (const b of bumped) console.log(`${b.kind} ${b.name} ${b.from} ${b.to}`);
        return;
      }
      case "lockstep": {
        need("root", "version");
        const { checkLockstep } = await import("./assemble.mjs");
        const root = path.resolve(flags.root);
        const problems = checkLockstep(root, flags.version);
        // Each plugin's package.json version is its manifest version (§3).
        for (const rel of workspaceDirs(root).filter((r) => r.startsWith("examples/plugins/"))) {
          const pkg = readJson(path.join(root, rel, "package.json"));
          const manifest = readJson(path.join(root, rel, "graphloom.manifest.json"));
          if (pkg.version !== manifest.version) problems.push(`${rel}: package.json version ${pkg.version} differs from its manifest version ${manifest.version}`);
        }
        if (problems.length > 0) throw new Error(`versions (§3):\n  ${problems.join("\n  ")}`);
        return;
      }
      case "draft": {
        need("file", "version", "date", "log");
        const file = path.resolve(flags.file);
        const text = existsSync(file) ? readFileSync(file, "utf8") : "# Changelog\n\nAll notable changes to GraphLoom are recorded here, in the style of\n[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow\n[semantic versioning](https://semver.org/); before 1.0, a minor release may\nbreak CLI flags and configuration (docs/design-release.md §3).\n";
        if (findSection(text, flags.version)) return;
        const subjects = readFileSync(path.resolve(flags.log), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
        const facts = flags.facts ? readJson(path.resolve(flags.facts)) : {};
        writeFileSync(file, insertSection(text, draftSection(flags.version, flags.date, subjects, facts)));
        process.exit(3);
      }
      case "changelog": {
        need("root", "version");
        const root = path.resolve(flags.root);
        const file = path.join(root, "CHANGELOG.md");
        if (!existsSync(file)) throw new Error("there is no CHANGELOG.md");
        let text = readFileSync(file, "utf8");
        let table;
        if (flags.release) {
          table = componentsTable(readJson(path.resolve(flags.release)));
        } else {
          table = componentsTable(treeComponentVersions(root));
          if (findSection(text, flags.version)) {
            const next = withTable(text, flags.version, table);
            if (next !== text) writeFileSync(file, (text = next));
          }
        }
        const problems = checkSection(text, flags.version, table);
        if (problems.length > 0) throw new Error(`CHANGELOG.md (§3):\n  ${problems.join("\n  ")}`);
        return;
      }
      case "notes": {
        need("file", "version");
        const s = findSection(readFileSync(path.resolve(flags.file), "utf8"), flags.version);
        if (!s) throw new Error(`${flags.file} has no section for ${flags.version}`);
        process.stdout.write(s.body.replace(/^\n+/, ""));
        return;
      }
      case "components": {
        need("src");
        const json = `${JSON.stringify(await treeComponents(path.resolve(flags.src)), null, 2)}\n`;
        if (flags.out) writeFileSync(path.resolve(flags.out), json);
        else process.stdout.write(json);
        return;
      }
      case "check-components": {
        need("current", "previous");
        const current = readJson(path.resolve(flags.current));
        const previous = readJson(path.resolve(flags.previous));
        let migrates = () => true;
        let fixtures = [];
        if (flags.src) {
          const src = path.resolve(flags.src);
          const { migrationPath } = await import(pathToFileURL(path.join(src, "packages", "controller", "dist", "index.js")).href);
          migrates = (from) => {
            try {
              migrationPath(from);
              return true;
            } catch {
              return false;
            }
          };
          // A shipped tree has no tests: the fixtures then come from the release commit.
          fixtures = stateFixtures(flags["fixtures-root"] ? path.resolve(flags["fixtures-root"]) : src);
        }
        const problems = componentProblems(previous, current, { migrates, fixtures });
        if (problems.length > 0) throw new Error(`component versions against ${previous.version} (§3):\n  ${problems.join("\n  ")}`);
        console.log(`components: the bump rule holds against ${previous.version}`);
        return;
      }
      case "latest": {
        need("tags");
        const v = latestVersion(readFileSync(path.resolve(flags.tags), "utf8").split("\n"), flags.below);
        if (v) console.log(v);
        return;
      }
      default:
        throw new Error(`prepare.mjs: unknown command ${cmd ?? ""}`);
    }
  });
}
