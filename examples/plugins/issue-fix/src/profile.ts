/**
 * The repository profile: everything repository-specific about fixing an
 * issue, as JSON data the task's `config:` file supplies. The controller
 * passes it opaquely; only this module reads it. Code that cannot be data
 * (the regression runners and their report parsers) is selected by name.
 * See docs/design-issue-fix-graph.md for the schema.
 */
import type { EnvironmentCommand, EnvironmentDeclaration } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { runnerById, RUNNERS, type RegressionRunner, type RunnerId } from "./runners/index.js";

/** Which Fix requirement a profile command's result counts toward. */
export type CommandRequirement = "passes" | "builds";

export interface ProfileCommand extends EnvironmentCommand {
  requirement: CommandRequirement;
  /** The command as a requirement statement names it; default its argv joined by spaces. */
  label?: string;
  /** For a `passes` command, the clause the `passes` statement uses; default `<label> passes`. */
  statement?: string;
  /** The command as the pull request's test plan names it; default the label in backquotes. */
  summary?: string;
}

/** The only changelog rule so far: a new list entry inside the first `## ` section. */
export type ChangelogRule = "first-release-section-entry";

/** The profile JSON, as the task's config file holds it. */
export interface ProfileData {
  /** A short name for messages, such as `banyandb`. */
  name: string;
  /** The repository the code lives in, as agents are told, such as `apache/skywalking-banyandb`. */
  project: string;
  /** Where the issues live; the request names one as `owner/repo#N`. */
  issues: { owner: string; repo: string };
  /** What the run's workspace needs, checked by the controller; must include an `ocr` check printing open-code-review's path. */
  environment: EnvironmentDeclaration;
  /** The built-in regression runner, and how long one regression run may take. */
  regression: { runner: RunnerId; timeoutMs?: number };
  /** GREEN's further checks and the build checks, run in order in the committed candidate checkout. */
  commands: ProfileCommand[];
  /** Which changed paths are test files: RED applies only these to the base commit. */
  testPaths: { suffixes: string[]; directories?: string[] };
  /** Paths the implementer may not change unless its decision record names one with a reason. */
  protectedPaths: string[];
  /** The changelog the change must add an entry to; absent means no changelog requirement. */
  changelog?: { path: string; rule: ChangelogRule };
  planning: {
    /** The reach question: every caller and lifecycle path the fix changes. */
    reach: string;
    /** What `needsE2E` means for this repository, such as `the Kind end-to-end tests`. */
    e2e?: string;
  };
  implementation: {
    /** The repository's coding conventions the implementer follows. */
    conventions: string;
    /** What the implementer is told the controller checks; generated from the commands when absent. */
    checks?: string;
    /** How to fix a check that rewrote a tracked file, such as `make check reformats Go code; run make format`. */
    cleanCheckHint?: string;
  };
  review: {
    /** The language the extra review rule is written for, such as `Go`. */
    language: string;
    /** The change's test files, which open-code-review's preview may exclude, such as "Go test files (`_test.go`)". */
    testFiles: string;
    /** The extra rule: what the change breaks outside its diff. */
    rules: string[];
  };
  pullRequest: {
    /** Lines after the title, such as the template's checklist. */
    checklist: string[];
    /** Closing lines; `{issue}` becomes the issue reference. */
    footer: string[];
    /** The test plan's line when the record says `needsE2E`. */
    e2eNote?: string;
  };
  /** Harnesses for each role; defaults: Claude Code implements and verifies, Codex reviews. */
  harnesses?: { implementer?: string; reviewer?: string; verifier?: string };
}

/** A checked profile, with its runner resolved and defaults applied. */
export interface Profile extends ProfileData {
  runner: RegressionRunner;
  regressionTimeoutMs: number;
  roles: { implementer: string; reviewer: string; verifier: string };
}

const MINUTE = 60_000;
const DEFAULT_REGRESSION_TIMEOUT_MS = 30 * MINUTE;
const RESERVED_COMMANDS: ReadonlySet<string> = new Set(Object.values(COMMAND));
const HARNESSES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" };

export class ProfileError extends Error {
  constructor(message: string) {
    super(`issue-fix profile: ${message}`);
    this.name = "ProfileError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function need(ok: boolean, message: string): void {
  if (!ok) throw new ProfileError(message);
}

function checkCommand(raw: unknown, where: string): void {
  need(isObject(raw), `${where} must be an object`);
  const c = raw as Record<string, unknown>;
  need(isString(c.id) && /^[A-Za-z0-9_.-]+$/.test(c.id as string), `${where}.id must be a word`);
  need(Array.isArray(c.argv) && c.argv.length > 0 && c.argv.every((a) => typeof a === "string"), `${where}.argv must be a non-empty list of strings`);
  need(c.timeoutMs === undefined || (Number.isSafeInteger(c.timeoutMs) && (c.timeoutMs as number) > 0), `${where}.timeoutMs must be a positive integer`);
}

function checkEnvironment(env: unknown): void {
  need(isObject(env), "environment must be an object");
  const e = env as Record<string, unknown>;
  for (const key of ["checks", "prepare"] as const) {
    if (e[key] === undefined) continue;
    need(Array.isArray(e[key]), `environment.${key} must be a list`);
    (e[key] as unknown[]).forEach((c, i) => checkCommand(c, `environment.${key}[${i}]`));
  }
  if (e.pinnedFiles !== undefined) {
    need(Array.isArray(e.pinnedFiles), "environment.pinnedFiles must be a list");
    for (const [i, f] of (e.pinnedFiles as unknown[]).entries()) {
      need(isObject(f) && isString(f.path) && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256), `environment.pinnedFiles[${i}] needs a path and a sha256`);
    }
  }
  const checks = (e.checks as Array<{ id: string }> | undefined) ?? [];
  need(checks.some((c) => c.id === "ocr"), 'environment.checks must include an "ocr" check that prints the path of open-code-review, which the code reviewer runs');
}

/**
 * The profile the task's config holds, checked, or a ProfileError naming the
 * first problem. Deterministic: the same config always gives the same profile.
 */
export function parseProfile(config: unknown): Profile {
  if (config === undefined) throw new ProfileError("the task names no profile: set config: to a profile JSON file in the task file");
  need(isObject(config), "the config must be a JSON object");
  const p = config as Record<string, unknown>;
  need(isString(p.name), "name is required");
  need(isString(p.project), "project is required");
  need(isObject(p.issues) && isString(p.issues.owner) && isString(p.issues.repo), "issues needs owner and repo");
  checkEnvironment(p.environment);
  need(isObject(p.regression), "regression is required");
  const regression = p.regression as Record<string, unknown>;
  const runner = runnerById(String(regression.runner));
  need(runner !== undefined, `regression.runner must be one of ${Object.keys(RUNNERS).join(", ")}`);
  need(regression.timeoutMs === undefined || (Number.isSafeInteger(regression.timeoutMs) && (regression.timeoutMs as number) > 0), "regression.timeoutMs must be a positive integer");
  need(Array.isArray(p.commands), "commands must be a list");
  const ids = new Set<string>();
  (p.commands as unknown[]).forEach((raw, i) => {
    checkCommand(raw, `commands[${i}]`);
    const c = raw as Record<string, unknown>;
    need(c.requirement === "passes" || c.requirement === "builds", `commands[${i}].requirement must be passes or builds`);
    need(!RESERVED_COMMANDS.has(c.id as string), `commands[${i}].id ${JSON.stringify(c.id)} is reserved`);
    need(!ids.has(c.id as string), `commands[${i}].id ${JSON.stringify(c.id)} is repeated`);
    ids.add(c.id as string);
    for (const key of ["label", "statement", "summary"]) need(c[key] === undefined || isString(c[key]), `commands[${i}].${key} must be text`);
    need(c.statement === undefined || c.requirement === "passes", `commands[${i}].statement applies only to a passes command`);
  });
  need(isObject(p.testPaths) && isStrings(p.testPaths.suffixes) && (p.testPaths.suffixes as string[]).length > 0, "testPaths.suffixes must be a non-empty list");
  need((p.testPaths as Record<string, unknown>).directories === undefined || isStrings((p.testPaths as Record<string, unknown>).directories), "testPaths.directories must be a list of names");
  need(isStrings(p.protectedPaths) && (p.protectedPaths as string[]).every((s) => s.trim() !== "" && !s.startsWith("!")), "protectedPaths must be a list of paths");
  if (p.changelog !== undefined) {
    need(isObject(p.changelog) && isString(p.changelog.path), "changelog needs a path");
    need((p.changelog as Record<string, unknown>).rule === "first-release-section-entry", 'changelog.rule must be "first-release-section-entry"');
  }
  need(isObject(p.planning) && isString(p.planning.reach), "planning.reach is required");
  need((p.planning as Record<string, unknown>).e2e === undefined || isString((p.planning as Record<string, unknown>).e2e), "planning.e2e must be text");
  need(isObject(p.implementation) && isString(p.implementation.conventions), "implementation.conventions is required");
  for (const key of ["checks", "cleanCheckHint"]) {
    const v = (p.implementation as Record<string, unknown>)[key];
    need(v === undefined || isString(v), `implementation.${key} must be text`);
  }
  need(isObject(p.review) && isString(p.review.language) && isString(p.review.testFiles) && isStrings(p.review.rules), "review needs language, testFiles and rules");
  need(isObject(p.pullRequest) && isStrings(p.pullRequest.checklist) && isStrings(p.pullRequest.footer), "pullRequest needs checklist and footer lists");
  const e2eNote = (p.pullRequest as Record<string, unknown>).e2eNote;
  need(e2eNote === undefined || isString(e2eNote), "pullRequest.e2eNote must be text");
  const harnesses = p.harnesses ?? {};
  need(isObject(harnesses), "harnesses must be an object");
  const roles = {
    implementer: (harnesses as Record<string, unknown>).implementer ?? "claude-code",
    reviewer: (harnesses as Record<string, unknown>).reviewer ?? "codex",
    verifier: (harnesses as Record<string, unknown>).verifier ?? "claude-code",
  };
  for (const [role, harness] of Object.entries(roles)) {
    need(typeof harness === "string" && HARNESSES[harness] !== undefined, `harnesses.${role} must be one of ${Object.keys(HARNESSES).join(", ")}`);
  }
  // A verifier from the reviewer's own family would judge its own findings.
  need(roles.verifier !== roles.reviewer, "harnesses.verifier must differ from harnesses.reviewer");
  const data = structuredClone(config) as unknown as ProfileData;
  return {
    ...data,
    runner: runner!,
    regressionTimeoutMs: (regression.timeoutMs as number | undefined) ?? DEFAULT_REGRESSION_TIMEOUT_MS,
    roles: roles as Profile["roles"],
  };
}

/** `owner/repo#N`. */
export function issueRef(profile: Profile, issue: number): string {
  return `${profile.issues.owner}/${profile.issues.repo}#${issue}`;
}

/** A path RED may apply to the base commit: a test file, or anything under a test-data directory. */
export function isTestPath(profile: Profile, path: string): boolean {
  if (profile.testPaths.suffixes.some((s) => path.endsWith(s))) return true;
  const dirs = profile.testPaths.directories ?? [];
  return path.split("/").slice(0, -1).some((part) => dirs.includes(part));
}

export function commandsFor(profile: Profile, requirement: CommandRequirement): ProfileCommand[] {
  return profile.commands.filter((c) => c.requirement === requirement);
}

export const commandLabel = (c: ProfileCommand): string => c.label ?? c.argv.join(" ");
export const commandStatement = (c: ProfileCommand): string => c.statement ?? `${commandLabel(c)} passes`;
export const commandSummary = (c: ProfileCommand): string => c.summary ?? `\`${commandLabel(c)}\``;

/** A harness id as people read it. */
export function harnessName(harness: string): string {
  return HARNESSES[harness] ?? harness;
}

/** "a", "a and b", "a, b and c". */
export function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
