// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The pr-review profile (design-pr-review-graph.md §3.2): everything
 * repository-specific, as JSON data the task's `config:` file supplies. The
 * controller passes it opaquely; only this module reads it. Unknown fields
 * are refused, as issue-fix's parser refuses them.
 */
import { GRAPH_BUDGET_KEYS, MAX_JOB_TIMEOUT_MS, SUPERVISOR_HARNESSES, type EnvironmentCommand, type GraphBudgetDefaults, type SupervisorPreference } from "@graphloom/sdk";
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
  definitions?: string[];
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
  /** The Docker sandbox's image and limits per language; used by the coverage jobs of a later version. */
  sandbox?: Record<string, unknown>;
}

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

export interface ProfileData {
  name: string;
  description?: string;
  /** `owner/repo` whose pull requests are read. */
  project: string;
  issues?: { owner: string; repo: string };
  environment: { checks: EnvironmentCommand[] };
  report?: { sections: SectionConfig[] };
  symbols?: { packs: SymbolPack[] };
  questions?: { excludeRoots?: string[]; similarity?: number; maxCandidates?: number };
  metrics?: Partial<MetricsConfig> & { sandbox?: Record<string, unknown> };
  context?: ContextRef[];
  privateRepos?: string[];
  harnesses?: Partial<Record<Role, string>>;
  supervisor?: SupervisorPreference;
  budgets?: GraphBudgetDefaults;
  limits?: Partial<Limits>;
  agent?: { timeoutMs?: number };
}

export interface Profile {
  name: string;
  description?: string;
  project: string;
  owner: string;
  repo: string;
  environment: { checks: EnvironmentCommand[] };
  sections: SectionConfig[];
  symbols: SymbolPack[];
  questions: { excludeRoots: string[]; similarity: number; maxCandidates: number };
  metrics: MetricsConfig;
  context: ContextRef[];
  privateRepos: string[];
  roles: Record<Role, string>;
  supervisorPreference: SupervisorPreference;
  budgets?: GraphBudgetDefaults;
  limits: Limits;
  agentTimeoutMs?: number;
}

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
    onlyKeys(o, where, ["language", "globs", "definitions", "testFiles", "testNames"]);
    need(isString(o.language), `${where}.language is required`);
    checkGlobs(o.globs, `${where}.globs`);
    for (const key of ["definitions", "testFiles", "testNames"]) need(o[key] === undefined || isStrings(o[key]), `${where}.${key} must be a list of patterns`);
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
  if (m.sandbox !== undefined) need(isObject(m.sandbox), "metrics.sandbox must be an object of per-language sandbox settings");
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
    ...(m.sandbox !== undefined ? { sandbox: structuredClone(m.sandbox) as Record<string, unknown> } : {}),
  };
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

function checkRoles(raw: unknown): Record<Role, string> {
  need(raw === undefined || isObject(raw), "harnesses must be an object");
  const h = (raw ?? {}) as Record<string, unknown>;
  const names = [...ROLES, "reviewer-correctness", "reviewer-maintainability", "reviewer-security"] as readonly string[];
  for (const key of Object.keys(h)) {
    need(names.includes(key), `harnesses.${key} is not a role; the roles of this version are ${ROLES.join(", ")}`);
    need(ROLES.includes(key as Role), `harnesses.${key} belongs to the review layer, which this version does not have`);
  }
  const roles = { ...DEFAULT_ROLES };
  for (const role of ROLES) {
    const v = h[role];
    if (v === undefined) continue;
    need(typeof v === "string" && HARNESSES[v] !== undefined, `harnesses.${role} must be one of ${Object.keys(HARNESSES).join(", ")}`);
    roles[role] = v as string;
  }
  // The maintainer opens the answerer's session (design §13.1), and a Pi session has no interactive restore.
  need(roles.answerer !== "pi", 'harnesses.answerer must be claude-code or codex: a Pi session cannot be opened by the maintainer, so the review layer could not continue from it');
  for (const [checked, author] of DISTINCT_PAIRS) {
    need(roles[checked] !== roles[author], `harnesses.${checked} must differ from harnesses.${author} (both are ${roles[checked]}): an artifact is checked on a harness other than its author's`);
  }
  return roles;
}

/** The profile the task's config holds, checked, or a ProfileError naming the first problem. */
export function parseProfile(config: unknown): Profile {
  if (config === undefined) throw new ProfileError("the task names no profile: set config: to a profile JSON file in the task file");
  need(isObject(config), "the config must be a JSON object");
  const p = config as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (LATER_FIELDS[key] !== undefined) throw new ProfileError(`${key} is not supported in this version: it belongs to ${LATER_FIELDS[key]}`);
  }
  onlyKeys(p, "", ["name", "description", "project", "issues", "environment", "report", "symbols", "questions", "metrics", "context", "privateRepos", "harnesses", "supervisor", "budgets", "limits", "agent"]);
  need(isString(p.name), "name is required");
  need(typeof p.description === "undefined" || isString(p.description), "description must be text");
  need(typeof p.project === "string" && REPO_NAME.test(p.project), 'project is required, as "owner/name"');
  const [owner, repo] = (p.project as string).split("/") as [string, string];
  if (p.issues !== undefined) {
    need(isObject(p.issues), "issues must be an object");
    onlyKeys(p.issues as Record<string, unknown>, "issues", ["owner", "repo"]);
    need(isString((p.issues as Record<string, unknown>).owner) && isString((p.issues as Record<string, unknown>).repo), "issues needs owner and repo");
  }
  const environment = checkEnvironment(p.environment);
  const sections = checkSections(p.report);
  const symbols = checkSymbols(p.symbols);
  let questions = { excludeRoots: [] as string[], similarity: 0.5, maxCandidates: 5 };
  if (p.questions !== undefined) {
    need(isObject(p.questions), "questions must be an object");
    const q = p.questions as Record<string, unknown>;
    onlyKeys(q, "questions", ["excludeRoots", "similarity", "maxCandidates"]);
    need(q.excludeRoots === undefined || isStrings(q.excludeRoots), "questions.excludeRoots must be a list of paths");
    need(q.similarity === undefined || (typeof q.similarity === "number" && q.similarity > 0 && q.similarity <= 1), "questions.similarity must be a number above 0 and at most 1");
    need(q.maxCandidates === undefined || isCount(q.maxCandidates), "questions.maxCandidates must be a positive integer");
    questions = { excludeRoots: (q.excludeRoots as string[] | undefined) ?? [], similarity: (q.similarity as number | undefined) ?? 0.5, maxCandidates: (q.maxCandidates as number | undefined) ?? 5 };
  }
  const metrics = checkMetrics(p.metrics, { generated: [], coverage: true, mutation: { enabled: true }, files: {} });
  const context = checkContext(p.context);
  need(p.privateRepos === undefined || (isStrings(p.privateRepos) && (p.privateRepos as string[]).every((r) => REPO_NAME.test(r))), 'privateRepos must be a list of "owner/name"');
  const roles = checkRoles(p.harnesses);
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
