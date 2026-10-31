// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The pr-review profile (design-pr-review-graph.md §3.2): everything
 * repository-specific, as JSON data the task's `config:` file supplies. The
 * controller passes it opaquely; only this module reads it. Unknown fields
 * are refused, as issue-fix's parser refuses them.
 */
import { confinementProblem, GRAPH_BUDGET_KEYS, MAX_JOB_TIMEOUT_MS, SUPERVISOR_HARNESSES, type EnvironmentCommand, type GraphBudgetDefaults, type SupervisorPreference } from "@graphloom/sdk";
import { RESERVED_CHECKS } from "./constants.js";

export type SectionId = string;

/** One deterministic matcher over the pinned patches (design §6.3). */
export type DetectorConfig =
  | { kind: "paths"; globs: string[]; label?: string }
  | { kind: "added-line"; pattern: string; files?: string[]; label?: string }
  | { kind: "manifest"; files: string[] }
  | { kind: "removed"; files?: string[] }
  | { kind: "deprecated"; files?: string[] };

export interface SectionConfig {
  id: SectionId;
  title?: string;
  /** What the section means in this repository; handed to the agents as text. */
  meaning?: string;
  /** Changed files matching these globs must appear in this section. */
  routing?: string[];
  detectors?: DetectorConfig[];
}

export interface SymbolPack {
  language: string;
  globs: string[];
  /** Top-level declaration patterns: JavaScript regular expressions with a named group `name` (see packs.ts). */
  definitions?: string[];
  /** Class member patterns, same shape. */
  members?: string[];
  /** POSIX extended expression that selects a file's declaration lines from the base commit. */
  grep?: string;
  testFiles?: string[];
  testNames?: string[];
}

export interface ContextRef {
  repo?: string;
  path: string;
  ref?: string;
}

export interface Limits {
  maxFiles: number;
  maxPatchBytes: number;
  maxNewSymbols: number;
}

export interface MetricsConfig {
  /** Generated-file globs, skipped by the metrics tools. */
  generated: string[];
  /** Run the PR's tests for coverage (default true). */
  coverage: boolean;
  mutation: { enabled: boolean; timeBudgetMs?: number };
  /** Per language: which changed files are measured, by glob. */
  files: Partial<Record<"go" | "typescript", string[]>>;
  /** The Docker sandbox's image and limits per language, over the defaults (`resolveSandbox`). */
  sandbox?: Partial<Record<"go" | "typescript", SandboxConfig>>;
}

/** What a profile may say about one language's Docker sandbox; the rest is the default. */
export interface SandboxConfig {
  /** `name@sha256:<digest>`; a tag is refused. */
  image?: string;
  cpus?: number;
  /** Memory, and swap equal to it. */
  memory?: string;
  pids?: number;
  /** Size of `/tmp`. */
  tmp?: string;
  /** Wall clock of each container. */
  wallClockMs?: number;
  /**
   * Host directories mounted read-only into the container (tools, offline caches): each is named, and the container sees its
   * resolved path in `GRAPHLOOM_MOUNT_<NAME>`. Never a path of the pull request (design §12.2).
   */
  readOnly?: SandboxMount[];
  /**
   * Commands run inside the same container configuration, in the checkout, before the tests (Go only in this version):
   * code generation the repository does not commit. Never run on the host.
   */
  setup?: SandboxSetupStep[];
  /**
   * Go build tags (`-tags=a,b`) the coverage `go test` compiles with: the ones the repository's own CI passes. Never applied
   * to the setup commands. Go only.
   */
  buildTags?: string[];
  /**
   * A Ginkgo label filter (`-args -ginkgo.label-filter=<filter>`) for the test binaries that use Ginkgo, as the repository's own CI
   * passes it (BanyanDB: `!slow`). Other test binaries do not get it. Go only.
   */
  ginkgoLabelFilter?: string;
}

/** A host directory a sandbox mounts read-only. */
export interface SandboxMount {
  /** `[a-z][a-z0-9-]*`, unique per language. */
  name: string;
  /** Absolute, or `~/…` for the operator's home. */
  path: string;
}

/** One sandboxed setup command. */
export interface SandboxSetupStep {
  /** `[a-z][a-z0-9-]*`, unique per language. */
  id: string;
  argv: string[];
}

export const MOUNT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_MOUNTS = 8;
export const MAX_SETUP_STEPS = 8;
export const BUILD_TAG = /^[A-Za-z0-9_.]+$/;
export const MAX_BUILD_TAGS = 16;
/** The characters of a Ginkgo label-filter expression the profile accepts, and its longest length. */
export const GINKGO_LABEL_FILTER = /^[A-Za-z0-9_.\-!&|() ,/]+$/;
export const MAX_GINKGO_LABEL_FILTER_CHARS = 200;
/** An argv element's longest text; the whole setup must also fit the coverage command's spec. */
const MAX_SETUP_ARG_CHARS = 2_000;

export type Role = "reporter" | "report-checker" | "questioner" | "answerer" | "answer-checker";
export const ROLES: readonly Role[] = ["reporter", "report-checker", "questioner", "answerer", "answer-checker"];

/** The harness each role defaults to (design §13.1). */
const DEFAULT_ROLES: Record<Role, string> = {
  reporter: "claude-code",
  "report-checker": "codex",
  questioner: "codex",
  answerer: "claude-code",
  "answer-checker": "codex",
};

/** The pairs that must not share a harness: [checked, author]. */
export const DISTINCT_PAIRS: ReadonlyArray<readonly [Role, Role]> = [
  ["report-checker", "reporter"],
  ["questioner", "reporter"],
  ["answerer", "questioner"],
  ["answer-checker", "answerer"],
];

/** What a role asks of its harness beyond which one: either may be absent, which inherits the harness's own. */
export interface RoleSettings {
  model?: string;
  effort?: string;
}

/** A role's `harnesses` entry: a harness id, or the harness with its model and effort. */
export type RoleHarness = string | ({ harness: string } & RoleSettings);

/** The effort levels each harness accepts: `claude --help` (`--effort`), and Codex's `model_reasoning_effort`. */
const EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export interface ProfileData {
  name: string;
  description?: string;
  /** `owner/repo` whose pull requests are read. */
  project: string;
  /** The branch pull requests are made against, for `graphloom task new` (default `main`); `--base` overrides it. */
  baseBranch?: string;
  issues?: { owner: string; repo: string };
  environment: { checks: EnvironmentCommand[] };
  report?: { sections: SectionConfig[] };
  symbols?: { packs: SymbolPack[] };
  questions?: { excludeRoots?: string[]; similarity?: number; maxCandidates?: number; designDocs?: string[] };
  metrics?: Partial<MetricsConfig>;
  context?: ContextRef[];
  privateRepos?: string[];
  harnesses?: Partial<Record<Role, RoleHarness>>;
  supervisor?: SupervisorPreference;
  budgets?: GraphBudgetDefaults;
  limits?: Partial<Limits>;
  agent?: { timeoutMs?: number };
}

export interface Profile {
  name: string;
  description?: string;
  project: string;
  /** The branch pull requests are made against (`task new`); `main` unless the profile names another. */
  baseBranch: string;
  owner: string;
  repo: string;
  environment: { checks: EnvironmentCommand[] };
  sections: SectionConfig[];
  symbols: SymbolPack[];
  questions: { excludeRoots: string[]; similarity: number; maxCandidates: number; designDocs: string[] };
  metrics: MetricsConfig;
  context: ContextRef[];
  privateRepos: string[];
  roles: Record<Role, string>;
  /** The model and effort a role names, for the roles that name one. */
  roleSettings: Partial<Record<Role, RoleSettings>>;
  supervisorPreference: SupervisorPreference;
  budgets?: GraphBudgetDefaults;
  limits: Limits;
  agentTimeoutMs?: number;
}

/** The sandbox's limits when a profile says nothing: the ones issue-fix's banyandb-ql `bench-gates` already uses (design-code-quality-metrics.md §4). */
export const SANDBOX_LIMITS = { cpus: 4, memory: "8g", pids: 512, tmp: "1g", wallClockMs: 30 * 60_000 } as const;
/** A digest-shaped placeholder, so the limits are checked alone. */
const SANDBOX_PROBE_IMAGE = `probe@sha256:${"0".repeat(64)}`;

export const DEFAULT_LIMITS: Limits = { maxFiles: 150, maxPatchBytes: 1024 * 1024, maxNewSymbols: 200 };
export const DEFAULT_SUPERVISOR_PREFERENCE: SupervisorPreference = { harnesses: ["pi", "claude-code", "codex"] };
const HARNESSES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" };

/** Fields of a later version of pr-review: refused with that reason instead of "unknown". */
const LATER_FIELDS: Readonly<Record<string, string>> = {
  review: "the review layer",
  rules: "the review layer",
  checks: "the Checks stage",
  comments: "the review layer",
};

export class ProfileError extends Error {
  constructor(message: string) {
    super(`pr-review profile: ${message}`);
    this.name = "ProfileError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
const isCount = (v: unknown, min = 1): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SECTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const BUDGET_NAMES: ReadonlySet<string> = new Set(GRAPH_BUDGET_KEYS);

function need(ok: boolean, message: string): void {
  if (!ok) throw new ProfileError(message);
}

function onlyKeys(o: Record<string, unknown>, where: string, allowed: readonly string[]): void {
  for (const key of Object.keys(o)) need(allowed.includes(key), `${where}${where === "" ? "" : "."}${key} is not a field; the fields are ${allowed.join(", ")}`);
}

function checkGlobs(value: unknown, where: string): void {
  need(isStrings(value) && (value as string[]).length > 0, `${where} must be a non-empty list of globs`);
  for (const g of value as string[]) need(!g.startsWith("/") && !g.includes("\u0000") && !g.split("/").includes(".."), `${where} glob ${JSON.stringify(g)} must be repository-relative, without ".."`);
}

function checkCommand(raw: unknown, where: string): void {
  need(isObject(raw), `${where} must be an object`);
  const c = raw as Record<string, unknown>;
  onlyKeys(c, where, ["id", "argv", "timeoutMs"]);
  need(isString(c.id) && /^[A-Za-z0-9_.-]+$/.test(c.id as string), `${where}.id must be a word`);
  need(Array.isArray(c.argv) && c.argv.length > 0 && c.argv.every((a) => typeof a === "string"), `${where}.argv must be a non-empty list of strings`);
  need(c.timeoutMs === undefined || isCount(c.timeoutMs), `${where}.timeoutMs must be a positive integer`);
}

function checkEnvironment(env: unknown): { checks: EnvironmentCommand[] } {
  need(isObject(env), "environment must be an object with checks");
  const e = env as Record<string, unknown>;
  need(e.prepare === undefined, "environment.prepare is refused: preparation would run contributor code in the unconfined worktree");
  need(e.pinnedFiles === undefined, "environment.pinnedFiles is refused: the repository under review is not the repository the profile was written against");
  onlyKeys(e, "environment", ["checks"]);
  need(Array.isArray(e.checks), "environment.checks must be a list");
  const ids = new Set<string>();
  (e.checks as unknown[]).forEach((c, i) => {
    checkCommand(c, `environment.checks[${i}]`);
    const id = (c as { id: string }).id;
    need(!RESERVED_CHECKS.includes(id), `environment.checks[${i}].id ${JSON.stringify(id)} is reserved: the graph adds that check itself`);
    need(!ids.has(id), `environment.checks[${i}].id ${JSON.stringify(id)} is repeated`);
    ids.add(id);
  });
  return { checks: structuredClone(e.checks as EnvironmentCommand[]) };
}

function checkDetector(raw: unknown, where: string): void {
  need(isObject(raw), `${where} must be an object`);
  const d = raw as Record<string, unknown>;
  switch (d.kind) {
    case "paths":
      onlyKeys(d, where, ["kind", "globs", "label"]);
      checkGlobs(d.globs, `${where}.globs`);
      break;
    case "added-line":
      onlyKeys(d, where, ["kind", "pattern", "files", "label"]);
      need(isString(d.pattern), `${where}.pattern must be a regular expression`);
      try {
        new RegExp(d.pattern as string);
      } catch (err) {
        throw new ProfileError(`${where}.pattern is not a regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (d.files !== undefined) checkGlobs(d.files, `${where}.files`);
      break;
    case "manifest":
      onlyKeys(d, where, ["kind", "files"]);
      checkGlobs(d.files, `${where}.files`);
      break;
    case "removed":
    case "deprecated":
      onlyKeys(d, where, ["kind", "files"]);
      if (d.files !== undefined) checkGlobs(d.files, `${where}.files`);
      break;
    default:
      throw new ProfileError(`${where}.kind must be paths, added-line, manifest, removed or deprecated, got ${JSON.stringify(d.kind)}`);
  }
  need(d.label === undefined || isString(d.label), `${where}.label must be text`);
}

function checkSections(raw: unknown): SectionConfig[] {
  if (raw === undefined) return [];
  need(isObject(raw), "report must be an object");
  const r = raw as Record<string, unknown>;
  onlyKeys(r, "report", ["sections"]);
  need(Array.isArray(r.sections), "report.sections must be a list");
  const seen = new Set<string>();
  const out: SectionConfig[] = [];
  (r.sections as unknown[]).forEach((entry, i) => {
    const where = `report.sections[${i}]`;
    need(isObject(entry), `${where} must be an object`);
    const s = entry as Record<string, unknown>;
    onlyKeys(s, where, ["id", "title", "meaning", "routing", "detectors", "remove"]);
    need(typeof s.id === "string" && SECTION_ID.test(s.id), `${where}.id must be a lowercase word`);
    const id = s.id as string;
    need(s.remove === undefined, `${where}.remove: no section may be removed; other and claims are required, and the rest are the maintainer's template`);
    need(!seen.has(id), `${where} repeats the section ${id}`);
    seen.add(id);
    need(s.title === undefined || isString(s.title), `${where}.title must be text`);
    need(s.meaning === undefined || isString(s.meaning), `${where}.meaning must be text`);
    if (s.routing !== undefined) checkGlobs(s.routing, `${where}.routing`);
    need(id !== "measurements" || (s.routing === undefined && s.detectors === undefined), `${where}: the measurements section is built from records, not from routing or detectors`);
    if (s.detectors !== undefined) {
      need(Array.isArray(s.detectors), `${where}.detectors must be a list`);
      (s.detectors as unknown[]).forEach((d, j) => checkDetector(d, `${where}.detectors[${j}]`));
    }
    out.push(structuredClone(s) as unknown as SectionConfig);
  });
  return out;
}

function checkSymbols(raw: unknown): SymbolPack[] {
  if (raw === undefined) return [];
  need(isObject(raw), "symbols must be an object");
  const s = raw as Record<string, unknown>;
  onlyKeys(s, "symbols", ["packs"]);
  need(Array.isArray(s.packs), "symbols.packs must be a list");
  return (s.packs as unknown[]).map((p, i) => {
    const where = `symbols.packs[${i}]`;
    need(isObject(p), `${where} must be an object`);
    const o = p as Record<string, unknown>;
    onlyKeys(o, where, ["language", "globs", "definitions", "members", "grep", "testFiles", "testNames"]);
    need(isString(o.language), `${where}.language is required`);
    checkGlobs(o.globs, `${where}.globs`);
    for (const key of ["definitions", "members", "testFiles", "testNames"]) need(o[key] === undefined || isStrings(o[key]), `${where}.${key} must be a list of patterns`);
    need(o.grep === undefined || isString(o.grep), `${where}.grep must be a POSIX extended regular expression`);
    for (const key of ["definitions", "members", "testNames"]) {
      for (const pattern of (o[key] as string[] | undefined) ?? []) {
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (err) {
          throw new ProfileError(`${where}.${key} pattern ${JSON.stringify(pattern)} is not a regular expression: ${err instanceof Error ? err.message : String(err)}`);
        }
        need(key === "testNames" || /\(\?<name>/.test(pattern), `${where}.${key} pattern ${JSON.stringify(pattern)} must name the symbol with a (?<name>…) group`);
        void re;
      }
    }
    return structuredClone(o) as unknown as SymbolPack;
  });
}

function checkMetrics(raw: unknown, defaults: MetricsConfig): MetricsConfig {
  if (raw === undefined) return defaults;
  need(isObject(raw), "metrics must be an object");
  const m = raw as Record<string, unknown>;
  onlyKeys(m, "metrics", ["generated", "coverage", "mutation", "sandbox", "go", "typescript"]);
  for (const key of ["go", "typescript"]) {
    if (m[key] === undefined) continue;
    need(isObject(m[key]), `metrics.${key} must be an object`);
    const lang = m[key] as Record<string, unknown>;
    onlyKeys(lang, `metrics.${key}`, ["files"]);
    if (lang.files !== undefined) checkGlobs(lang.files, `metrics.${key}.files`);
  }
  need(m.generated === undefined || isStrings(m.generated), "metrics.generated must be a list of globs");
  need(m.coverage === undefined || typeof m.coverage === "boolean", "metrics.coverage must be true or false");
  let mutation = defaults.mutation;
  if (m.mutation !== undefined) {
    need(isObject(m.mutation), "metrics.mutation must be an object");
    const mu = m.mutation as Record<string, unknown>;
    onlyKeys(mu, "metrics.mutation", ["enabled", "timeBudgetMs"]);
    need(mu.enabled === undefined || typeof mu.enabled === "boolean", "metrics.mutation.enabled must be true or false");
    need(mu.timeBudgetMs === undefined || isCount(mu.timeBudgetMs), "metrics.mutation.timeBudgetMs must be a positive integer");
    mutation = { enabled: (mu.enabled as boolean | undefined) ?? true, ...(mu.timeBudgetMs !== undefined ? { timeBudgetMs: mu.timeBudgetMs as number } : {}) };
  }
  const sandbox = checkSandbox(m.sandbox);
  const files: MetricsConfig["files"] = {};
  for (const key of ["go", "typescript"] as const) {
    const lang = m[key] as { files?: string[] } | undefined;
    if (lang?.files !== undefined) files[key] = [...lang.files];
  }
  return {
    generated: (m.generated as string[] | undefined) ?? defaults.generated,
    coverage: (m.coverage as boolean | undefined) ?? defaults.coverage,
    mutation,
    files,
    ...(sandbox !== undefined ? { sandbox } : {}),
  };
}

/**
 * `metrics.sandbox`: per language (`go`, `typescript`), the image (pinned by digest, a tag is refused) and the
 * limits, each checked by the SDK's own docker-confinement rules so that what a profile accepts is what a job runs.
 */
function checkSandbox(raw: unknown): MetricsConfig["sandbox"] {
  if (raw === undefined) return undefined;
  need(isObject(raw), "metrics.sandbox must be an object of per-language sandbox settings");
  const out: NonNullable<MetricsConfig["sandbox"]> = {};
  for (const [language, value] of Object.entries(raw as Record<string, unknown>)) {
    const where = `metrics.sandbox.${language}`;
    need(language === "go" || language === "typescript", `${where} is not a language with a sandbox; the languages are go and typescript`);
    need(isObject(value), `${where} must be an object`);
    const v = value as Record<string, unknown>;
    onlyKeys(v, where, ["image", "cpus", "memory", "pids", "tmp", "wallClockMs", "readOnly", "setup", "buildTags", "ginkgoLabelFilter"]);
    const { readOnly, setup, buildTags, ginkgoLabelFilter, ...limits } = v;
    const problem = confinementProblem({ kind: "docker", writable: [], readOnly: [], env: {}, ...SANDBOX_LIMITS, image: SANDBOX_PROBE_IMAGE, ...limits });
    need(problem === undefined, `${where}.${(problem ?? "").replace(/^confinement\./, "")}`);
    const config = structuredClone(limits) as SandboxConfig;
    if (readOnly !== undefined) config.readOnly = checkMounts(readOnly, `${where}.readOnly`);
    if (setup !== undefined) {
      need(language === "go", `${where}.setup: sandboxed setup is supported for go only in this version`);
      config.setup = checkSetup(setup, `${where}.setup`);
    }
    if (buildTags !== undefined) {
      need(language === "go", `${where}.buildTags: build tags are supported for go only`);
      config.buildTags = checkBuildTags(buildTags, `${where}.buildTags`);
    }
    if (ginkgoLabelFilter !== undefined) {
      need(language === "go", `${where}.ginkgoLabelFilter: a Ginkgo label filter is supported for go only`);
      need(typeof ginkgoLabelFilter === "string" && ginkgoLabelFilter.trim() !== "" && ginkgoLabelFilter.length <= MAX_GINKGO_LABEL_FILTER_CHARS && GINKGO_LABEL_FILTER.test(ginkgoLabelFilter), `${where}.ginkgoLabelFilter must be a non-empty string of at most ${MAX_GINKGO_LABEL_FILTER_CHARS} characters matching ${GINKGO_LABEL_FILTER.source}`);
      config.ginkgoLabelFilter = ginkgoLabelFilter as string;
    }
    out[language as "go" | "typescript"] = config;
  }
  return out;
}

/**
 * `metrics.sandbox.<language>.readOnly`: host directories the container sees read-only. A path is absolute or `~/…`
 * (the operator's home, expanded on the host when the sandbox is probed), has no `..` and none of `: ,` or a line
 * break, and is never `/`. That it exists is checked when the sandbox is probed, and that it is not inside the
 * checkout when the job is prepared.
 */
function checkMounts(raw: unknown, where: string): SandboxMount[] {
  need(Array.isArray(raw) && raw.length <= MAX_MOUNTS, `${where} must be a list of at most ${MAX_MOUNTS} {name, path} mounts`);
  const seen = new Set<string>();
  return (raw as unknown[]).map((entry, i) => {
    const at = `${where}[${i}]`;
    need(isObject(entry), `${at} must be an object {name, path}`);
    const e = entry as Record<string, unknown>;
    onlyKeys(e, at, ["name", "path"]);
    need(typeof e.name === "string" && MOUNT_NAME.test(e.name), `${at}.name must match ${MOUNT_NAME.source}`);
    need(!seen.has(e.name as string), `${at}.name ${JSON.stringify(e.name)} is used twice`);
    seen.add(e.name as string);
    const p = e.path;
    need(typeof p === "string" && p.length <= 1_024, `${at}.path must be a path`);
    const path = p as string;
    need(path.startsWith("/") || path.startsWith("~/"), `${at}.path ${JSON.stringify(path)} must be absolute or start with ~/ (a relative path would name the pull request's checkout)`);
    need(!/[:,\n\r\0]/.test(path), `${at}.path must not contain : , or a line break`);
    need(!path.split("/").includes(".."), `${at}.path must not contain ..`);
    need(path.replace(/\/+$/, "") !== "" && path !== "~/", `${at}.path must not be the filesystem root or the whole home`);
    return { name: e.name as string, path };
  });
}

/** `metrics.sandbox.go.buildTags`: Go build tag identifiers, each `[A-Za-z0-9_.]+`, none twice, at most `MAX_BUILD_TAGS`. */
function checkBuildTags(raw: unknown, where: string): string[] {
  need(Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_BUILD_TAGS, `${where} must be a list of 1 to ${MAX_BUILD_TAGS} build tags`);
  const seen = new Set<string>();
  return (raw as unknown[]).map((tag, i) => {
    need(typeof tag === "string" && BUILD_TAG.test(tag) && tag.length <= 64, `${where}[${i}] must be a Go build tag matching ${BUILD_TAG.source} (at most 64 characters)`);
    need(!seen.has(tag as string), `${where}[${i}] ${JSON.stringify(tag)} is used twice`);
    seen.add(tag as string);
    return tag as string;
  });
}

/** `metrics.sandbox.go.setup`: commands run in the container, in the checkout, before the tests, in order. */
function checkSetup(raw: unknown, where: string): SandboxSetupStep[] {
  need(Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_SETUP_STEPS, `${where} must be a list of 1 to ${MAX_SETUP_STEPS} {id, argv} commands`);
  const seen = new Set<string>();
  return (raw as unknown[]).map((entry, i) => {
    const at = `${where}[${i}]`;
    need(isObject(entry), `${at} must be an object {id, argv}`);
    const e = entry as Record<string, unknown>;
    onlyKeys(e, at, ["id", "argv"]);
    need(typeof e.id === "string" && MOUNT_NAME.test(e.id), `${at}.id must match ${MOUNT_NAME.source}`);
    need(!seen.has(e.id as string), `${at}.id ${JSON.stringify(e.id)} is used twice`);
    seen.add(e.id as string);
    need(Array.isArray(e.argv) && e.argv.length > 0 && e.argv.length <= 32 && e.argv.every((a) => typeof a === "string" && a.length <= MAX_SETUP_ARG_CHARS && !a.includes("\0")), `${at}.argv must be a list of 1 to 32 strings of at most ${MAX_SETUP_ARG_CHARS} characters`);
    need((e.argv as string[])[0] !== "", `${at}.argv needs a program`);
    return { id: e.id as string, argv: [...(e.argv as string[])] };
  });
}

function checkContext(raw: unknown): ContextRef[] {
  if (raw === undefined) return [];
  need(Array.isArray(raw), "context must be a list of documents");
  return (raw as unknown[]).map((entry, i) => {
    const where = `context[${i}]`;
    need(isObject(entry), `${where} must be an object`);
    const d = entry as Record<string, unknown>;
    onlyKeys(d, where, ["repo", "path", "ref"]);
    need(isString(d.path) && !(d.path as string).split("/").some((p) => p === "" || p === "." || p === ".."), `${where}.path must be repository-relative, without "..", "." or empty segments`);
    need(d.repo === undefined || (typeof d.repo === "string" && REPO_NAME.test(d.repo)), `${where}.repo must be "owner/name"`);
    need(d.ref === undefined || (isString(d.ref) && d.repo !== undefined), `${where}.ref applies only to a document from another repository (set repo)`);
    return structuredClone(d) as unknown as ContextRef;
  });
}

function checkBudgets(raw: unknown): GraphBudgetDefaults | undefined {
  if (raw === undefined) return undefined;
  need(isObject(raw), "budgets must be an object");
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    need(BUDGET_NAMES.has(key), `budgets.${key} is not a budget; budgets are ${GRAPH_BUDGET_KEYS.join(", ")}`);
    need(isCount(value), `budgets.${key} must be a positive integer`);
  }
  return structuredClone(raw) as GraphBudgetDefaults;
}

function checkSupervisor(raw: unknown): SupervisorPreference {
  if (raw === undefined) return structuredClone(DEFAULT_SUPERVISOR_PREFERENCE);
  need(isObject(raw), "supervisor must be an object");
  const s = raw as Record<string, unknown>;
  onlyKeys(s, "supervisor", ["harnesses", "models", "required"]);
  const known: readonly string[] = SUPERVISOR_HARNESSES;
  need(isStrings(s.harnesses) && (s.harnesses as string[]).length > 0, "supervisor.harnesses must be a non-empty list");
  for (const h of s.harnesses as string[]) need(known.includes(h), `supervisor.harnesses: ${JSON.stringify(h)} is not one of ${known.join(", ")}`);
  need(new Set(s.harnesses as string[]).size === (s.harnesses as string[]).length, "supervisor.harnesses must not repeat a harness");
  if (s.models !== undefined) {
    need(isObject(s.models), "supervisor.models must be an object of model lists by harness");
    for (const [h, list] of Object.entries(s.models as Record<string, unknown>)) {
      need(known.includes(h), `supervisor.models.${h} is not one of ${known.join(", ")}`);
      need(isStrings(list), `supervisor.models.${h} must be a list of model names`);
    }
  }
  need(s.required === undefined || typeof s.required === "boolean", "supervisor.required must be true or false");
  return structuredClone(s) as unknown as SupervisorPreference;
}

function checkRoles(raw: unknown): { roles: Record<Role, string>; settings: Partial<Record<Role, RoleSettings>> } {
  need(raw === undefined || isObject(raw), "harnesses must be an object");
  const h = (raw ?? {}) as Record<string, unknown>;
  const names = [...ROLES, "reviewer-correctness", "reviewer-maintainability", "reviewer-security"] as readonly string[];
  for (const key of Object.keys(h)) {
    need(names.includes(key), `harnesses.${key} is not a role; the roles of this version are ${ROLES.join(", ")}`);
    need(ROLES.includes(key as Role), `harnesses.${key} belongs to the review layer, which this version does not have`);
  }
  const roles = { ...DEFAULT_ROLES };
  const settings: Partial<Record<Role, RoleSettings>> = {};
  for (const role of ROLES) {
    const v = h[role];
    if (v === undefined) continue;
    if (isObject(v)) {
      onlyKeys(v, `harnesses.${role}`, ["harness", "model", "effort"]);
      need(typeof v.harness === "string" && EFFORTS[v.harness] !== undefined, `harnesses.${role}.harness must be one of ${Object.keys(EFFORTS).join(", ")}`);
      const harness = v.harness as string;
      need(v.model === undefined || (typeof v.model === "string" && v.model.trim() !== "" && !/[\u0000-\u001f]/.test(v.model)), `harnesses.${role}.model must be a model name`);
      const efforts = EFFORTS[harness]!;
      need(v.effort === undefined || (typeof v.effort === "string" && efforts.includes(v.effort)), `harnesses.${role}.effort must be one of ${efforts.join(", ")} for ${harness}`);
      roles[role] = harness;
      if (v.model !== undefined || v.effort !== undefined) settings[role] = { ...(v.model !== undefined ? { model: v.model as string } : {}), ...(v.effort !== undefined ? { effort: v.effort as string } : {}) };
      continue;
    }
    need(typeof v === "string" && HARNESSES[v] !== undefined, `harnesses.${role} must be one of ${Object.keys(HARNESSES).join(", ")}, or an object with harness (claude-code or codex), model and effort`);
    roles[role] = v as string;
  }
  // The maintainer opens the answerer's session (design §13.1), and a Pi session has no interactive restore.
  need(roles.answerer !== "pi", 'harnesses.answerer must be claude-code or codex: a Pi session cannot be opened by the maintainer, so the review layer could not continue from it');
  for (const [checked, author] of DISTINCT_PAIRS) {
    need(roles[checked] !== roles[author], `harnesses.${checked} must differ from harnesses.${author} (both are ${roles[checked]}): an artifact is checked on a harness other than its author's`);
  }
  return { roles, settings };
}

/** The profile the task's config holds, checked, or a ProfileError naming the first problem. */
export function parseProfile(config: unknown): Profile {
  if (config === undefined) throw new ProfileError("the task names no profile: set config: to a profile JSON file in the task file");
  need(isObject(config), "the config must be a JSON object");
  const p = config as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (LATER_FIELDS[key] !== undefined) throw new ProfileError(`${key} is not supported in this version: it belongs to ${LATER_FIELDS[key]}`);
  }
  onlyKeys(p, "", ["name", "description", "project", "baseBranch", "issues", "environment", "report", "symbols", "questions", "metrics", "context", "privateRepos", "harnesses", "supervisor", "budgets", "limits", "agent"]);
  need(isString(p.name), "name is required");
  need(typeof p.description === "undefined" || isString(p.description), "description must be text");
  need(typeof p.project === "string" && REPO_NAME.test(p.project), 'project is required, as "owner/name"');
  const [owner, repo] = (p.project as string).split("/") as [string, string];
  need(p.baseBranch === undefined || (typeof p.baseBranch === "string" && BRANCH_NAME.test(p.baseBranch) && !(p.baseBranch as string).includes("..") && !(p.baseBranch as string).endsWith("/") && !(p.baseBranch as string).endsWith(".lock")), "baseBranch must be a branch name");
  if (p.issues !== undefined) {
    need(isObject(p.issues), "issues must be an object");
    onlyKeys(p.issues as Record<string, unknown>, "issues", ["owner", "repo"]);
    need(isString((p.issues as Record<string, unknown>).owner) && isString((p.issues as Record<string, unknown>).repo), "issues needs owner and repo");
  }
  const environment = checkEnvironment(p.environment);
  const sections = checkSections(p.report);
  const symbols = checkSymbols(p.symbols);
  let questions = { excludeRoots: [] as string[], similarity: 0.5, maxCandidates: 5, designDocs: [] as string[] };
  if (p.questions !== undefined) {
    need(isObject(p.questions), "questions must be an object");
    const q = p.questions as Record<string, unknown>;
    onlyKeys(q, "questions", ["excludeRoots", "similarity", "maxCandidates", "designDocs"]);
    need(q.excludeRoots === undefined || isStrings(q.excludeRoots), "questions.excludeRoots must be a list of paths");
    // They travel in one argument of each search command, which a command allows 4,096 characters.
    need(q.excludeRoots === undefined || (q.excludeRoots as string[]).join("\n").length <= 3_000, "questions.excludeRoots is too long: at most 3,000 characters in all");
    need(q.similarity === undefined || (typeof q.similarity === "number" && q.similarity > 0 && q.similarity <= 1), "questions.similarity must be a number above 0 and at most 1");
    need(q.maxCandidates === undefined || isCount(q.maxCandidates), "questions.maxCandidates must be a positive integer");
    need(q.designDocs === undefined || isStrings(q.designDocs), "questions.designDocs must be a list of repository-relative globs");
    need(q.designDocs === undefined || (q.designDocs as string[]).every((g) => g.trim() !== "" && !g.startsWith("/") && !g.split("/").includes("..") && !/[\n\u0000]/.test(g)), "questions.designDocs globs are repository-relative, without \"..\" or empty entries");
    need(q.designDocs === undefined || (q.designDocs as string[]).join("\n").length <= 3_000, "questions.designDocs is too long: at most 3,000 characters in all");
    questions = { excludeRoots: (q.excludeRoots as string[] | undefined) ?? [], similarity: (q.similarity as number | undefined) ?? 0.5, maxCandidates: (q.maxCandidates as number | undefined) ?? 5, designDocs: (q.designDocs as string[] | undefined) ?? [] };
  }
  const metrics = checkMetrics(p.metrics, { generated: [], coverage: true, mutation: { enabled: true }, files: {} });
  const context = checkContext(p.context);
  need(p.privateRepos === undefined || (isStrings(p.privateRepos) && (p.privateRepos as string[]).every((r) => REPO_NAME.test(r))), 'privateRepos must be a list of "owner/name"');
  const { roles, settings: roleSettings } = checkRoles(p.harnesses);
  const budgets = checkBudgets(p.budgets);
  const supervisorPreference = checkSupervisor(p.supervisor);
  let limits = { ...DEFAULT_LIMITS };
  if (p.limits !== undefined) {
    need(isObject(p.limits), "limits must be an object");
    const l = p.limits as Record<string, unknown>;
    onlyKeys(l, "limits", ["maxFiles", "maxPatchBytes", "maxNewSymbols"]);
    for (const key of Object.keys(l)) need(isCount(l[key]), `limits.${key} must be a positive integer`);
    limits = { ...limits, ...(l as Partial<Limits>) };
  }
  let agentTimeoutMs: number | undefined;
  if (p.agent !== undefined) {
    need(isObject(p.agent), "agent must be an object");
    const a = p.agent as Record<string, unknown>;
    onlyKeys(a, "agent", ["timeoutMs"]);
    need(a.timeoutMs === undefined || (isCount(a.timeoutMs) && (a.timeoutMs as number) <= MAX_JOB_TIMEOUT_MS), `agent.timeoutMs must be a positive integer of at most ${MAX_JOB_TIMEOUT_MS} (one day)`);
    agentTimeoutMs = a.timeoutMs as number | undefined;
  }
  return {
    name: p.name as string,
    ...(p.description !== undefined ? { description: p.description as string } : {}),
    project: p.project as string,
    baseBranch: (p.baseBranch as string | undefined) ?? "main",
    owner,
    repo,
    environment,
    sections,
    symbols,
    questions,
    metrics,
    context,
    privateRepos: (p.privateRepos as string[] | undefined) ?? [],
    roles,
    roleSettings,
    supervisorPreference,
    ...(budgets !== undefined ? { budgets } : {}),
    limits,
    ...(agentTimeoutMs !== undefined ? { agentTimeoutMs } : {}),
  };
}

/** A harness id as people read it. */
export function harnessName(harness: string): string {
  return HARNESSES[harness] ?? harness;
}
