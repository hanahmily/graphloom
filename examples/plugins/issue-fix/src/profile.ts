// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The repository profile: everything repository-specific about fixing an
 * issue, as JSON data the task's `config:` file supplies. The controller
 * passes it opaquely; only this module reads it. Code that cannot be data
 * (the regression runners and their report parsers) is selected by name.
 * See docs/design-issue-fix-graph.md for the schema.
 */
import { GRAPH_BUDGET_KEYS, MAX_JOB_TIMEOUT_MS, MAX_TIMEOUT_CONTINUATIONS, type EnvironmentCommand, type EnvironmentDeclaration, type GraphBudgetDefaults } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { runnerById, RUNNERS, type RegressionRunner, type RunnerId } from "./runners/index.js";

/**
 * Which requirement a profile command's result counts toward: `passes` and
 * `builds` are Fix's; `final-checks` and `bench-gates` are Review's, for a
 * `final` tier command: `final-checks` judged by its own success, `bench-gates`
 * by its success and the hard gates of the benchmark report it writes
 * (bench.ts).
 */
export type CommandRequirement = "passes" | "builds" | "final-checks" | "bench-gates";

/** The requirements a `final` tier command counts toward, and the only ones it may. */
export const FINAL_REQUIREMENTS: readonly CommandRequirement[] = ["final-checks", "bench-gates"];

/**
 * When a command runs among a candidate's checks. `cheap` commands run in the
 * first job beside GREEN; `full` commands (the default) run in a second job
 * only once every cheap command and GREEN passed on the same candidate;
 * `final` commands run once, in a checkout of the candidate, after code review
 * has converged and before delivery, and count toward a Review requirement
 * (`final-checks` or `bench-gates`), never Fix's.
 */
export type CommandTier = "cheap" | "full" | "final";

export interface ProfileCommand extends EnvironmentCommand {
  requirement: CommandRequirement;
  /** Default `full`. A profile declaring no `cheap` command runs every check in one job. */
  tier?: CommandTier;
  /**
   * For a `final` command, the pull request section its report summary goes
   * under, such as `Benchmark`. The report file may be JSON with a `summary`
   * (a line, or a list of lines) the graph copies there; the section says the
   * controller gated only on the command's exit status.
   */
  section?: string;
  /** The command as a requirement statement names it; default its argv joined by spaces. */
  label?: string;
  /** For a `passes` command, the clause the `passes` statement uses; default `<label> passes`. */
  statement?: string;
  /** The command as the pull request's test plan names it; default the label in backquotes. */
  summary?: string;
  /**
   * Repository-relative files or directories (a trailing `/**` is allowed) the
   * command regenerates and a failure tells the author to commit, such as the
   * license artifacts. The implementer's write scope always covers them, even
   * under a protected path.
   */
  writes?: string[];
}

/** The only changelog rule so far: a new list entry inside the first `## ` section. */
export type ChangelogRule = "first-release-section-entry";

/**
 * A document the run reads once and hands to the planner, the implementer and
 * the code reviewers next to the issue. With `repo` it is read from GitHub
 * (`ref` defaults to that repository's default branch); without, it is a file
 * of the target repository, read from the run's worktree at the base commit.
 */
export interface ContextDocumentRef {
  /** `owner/name`; absent means a path in the target repository. */
  repo?: string;
  path: string;
  /** Branch, tag or commit, for a document from another repository. */
  ref?: string;
}

/** The profile JSON, as the task's config file holds it. */
export interface ProfileData {
  /** A short name for messages, such as `banyandb`. */
  name: string;
  /** The repository the code lives in, as agents are told, such as `apache/skywalking-banyandb`. */
  project: string;
  /**
   * Where the issues live; the request names one as `owner/repo#N`. `context`
   * lists documents the issue defers to (a design, a plan): the graph reads
   * them once, pins them as evidence and gives them to the planner, the
   * implementer and the code reviewers.
   */
  issues: { owner: string; repo: string; context?: ContextDocumentRef[] };
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
    /**
     * Repository-specific guidance the planner and the implementer both get,
     * such as how to treat an issue that asks for a feature rather than
     * reporting a bug.
     */
    notes?: string[];
  };
  implementation: {
    /** The repository's coding conventions the implementer follows. */
    conventions: string;
    /** What the implementer is told the controller checks; generated from the commands when absent. */
    checks?: string;
    /**
     * Cheap commands (shell text, as the implementer would type them) it runs
     * before returning `ready`, besides the regression test, and reports in
     * its record's `selfChecks`. The graph runs its own checks and does not
     * trust the report.
     */
    selfCheck?: string[];
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
    /** How many times the graph itself sends a converging review failure back to Fix before the supervisor decides; default 4. */
    maxReentries?: number;
  };
  pullRequest: {
    /** Lines after the title, such as the template's checklist. */
    checklist: string[];
    /** Closing lines; `{issue}` becomes the issue reference (not allowed with `reference`, which keeps the issue out of the text). */
    footer: string[];
    /**
     * How the commit and the pull request refer to the issue. Absent: they
     * say `Fixes <owner>/<repo>#N` and the heading names the issue. With
     * `{ "style": "implements", "subject": "the Measure QL" }` they say
     * "Implements the Measure QL <issue title>" and carry no reference to the
     * issue's repository at all, for an issue tracked somewhere private: the
     * footer may not use `{issue}`, and any mention of that repository the
     * agents wrote (a reference, a link, a context document's name) is
     * dropped from the commit message and the body.
     */
    reference?: { style: "implements"; subject: string };
    /** The test plan's line when the record says `needsE2E`. */
    e2eNote?: string;
  };
  /** Harnesses for each role; defaults: Claude Code implements and verifies, Codex reviews. */
  harnesses?: { implementer?: string; reviewer?: string; verifier?: string };
  /**
   * The coding agents' wall clock. `timeoutMs`: how long each coding-agent job
   * (plan, implement, review, verify) asks to run, instead of the operator's
   * default (one hour); the operator's `maxTimeoutMs` still caps it, and the
   * run's active time bounds every job. `timeoutContinuations` (default 1, at
   * most 3, 0 turns it off): how many times per Fix generation the controller
   * continues the implementer's own session when it runs out of time after
   * changing the worktree, before a recovery episode.
   */
  agent?: { timeoutMs?: number; timeoutContinuations?: number };
  /**
   * What a run on this repository is expected to need, from measured runs
   * (docs/budgets.md). The graph declares them as its `defaultBudgets`;
   * intake applies them over the controller's defaults, and the task's own
   * `budgets` override them key by key.
   */
  budgets?: GraphBudgetDefaults;
}

/** A checked profile, with its runner resolved and defaults applied. */
export interface Profile extends ProfileData {
  runner: RegressionRunner;
  regressionTimeoutMs: number;
  roles: { implementer: string; reviewer: string; verifier: string };
  /** `agent.timeoutContinuations`, defaulted. */
  timeoutContinuations: number;
}

const MINUTE = 60_000;
const DEFAULT_REGRESSION_TIMEOUT_MS = 30 * MINUTE;
const DEFAULT_TIMEOUT_CONTINUATIONS = 1;
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

function checkCacheGlobs(c: Record<string, unknown>, where: string, allowed: boolean): void {
  if (c.inputs === undefined && c.outputs === undefined) return;
  need(allowed, `${where}: only a prepare command may declare inputs and outputs`);
  need(c.inputs !== undefined && c.outputs !== undefined, `${where}: inputs and outputs are declared together`);
  for (const field of ["inputs", "outputs"] as const) {
    const globs = c[field];
    need(isStrings(globs) && globs.length > 0 && globs.some((g) => !g.startsWith("!")), `${where}.${field} must list globs, at least one not starting with "!"`);
    for (const g of globs as string[]) {
      const glob = g.startsWith("!") ? g.slice(1) : g;
      need(
        glob.length > 0 && !glob.startsWith("/") && !glob.endsWith("/") && !glob.split("/").some((part) => part === ".." || part === "." || part === ""),
        `${where}.${field} glob "${g}" must be repository-relative, without "..", "." or empty segments`,
      );
    }
  }
}

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_NAME = /^[A-Za-z0-9_.\/:-]{1,255}$/;

/** The name a context document goes by in prompts and messages. */
export function contextName(doc: ContextDocumentRef): string {
  return `${doc.repo !== undefined ? `${doc.repo}:` : ""}${doc.path}${doc.ref !== undefined ? `@${doc.ref}` : ""}`;
}

function checkContext(raw: unknown): void {
  if (raw === undefined) return;
  need(Array.isArray(raw), "issues.context must be a list of documents");
  const seen = new Set<string>();
  (raw as unknown[]).forEach((entry, i) => {
    const where = `issues.context[${i}]`;
    need(isObject(entry), `${where} must be an object`);
    const d = entry as Record<string, unknown>;
    for (const key of Object.keys(d)) need(key === "repo" || key === "path" || key === "ref", `${where}.${key} is not a context document field; they are repo, path and ref`);
    need(isString(d.path), `${where}.path is required`);
    const path = d.path as string;
    need(
      path.length <= 1_000 && !path.includes("\u0000") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      `${where}.path "${path}" must be repository-relative, without "..", "." or empty segments`,
    );
    need(d.repo === undefined || (typeof d.repo === "string" && REPO_NAME.test(d.repo)), `${where}.repo must be "owner/name"`);
    need(d.ref === undefined || (typeof d.ref === "string" && REF_NAME.test(d.ref)), `${where}.ref must be a branch, tag or commit name`);
    need(d.ref === undefined || d.repo !== undefined, `${where}.ref applies only to a document from another repository (set repo)`);
    const name = contextName(d as unknown as ContextDocumentRef);
    need(!seen.has(name), `${where} repeats ${name}`);
    seen.add(name);
  });
}

function checkEnvironment(env: unknown): void {
  need(isObject(env), "environment must be an object");
  const e = env as Record<string, unknown>;
  for (const key of ["checks", "prepare"] as const) {
    if (e[key] === undefined) continue;
    need(Array.isArray(e[key]), `environment.${key} must be a list`);
    (e[key] as unknown[]).forEach((c, i) => {
      checkCommand(c, `environment.${key}[${i}]`);
      checkCacheGlobs(c as Record<string, unknown>, `environment.${key}[${i}]`, key === "prepare");
    });
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

const BUDGET_NAMES: ReadonlySet<string> = new Set(GRAPH_BUDGET_KEYS);

function checkBudgets(raw: unknown): void {
  if (raw === undefined) return;
  need(isObject(raw), "budgets must be an object");
  const b = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(b)) {
    need(BUDGET_NAMES.has(key), `budgets.${key} is not a budget; budgets are ${GRAPH_BUDGET_KEYS.join(", ")}`);
    need(Number.isSafeInteger(value) && (value as number) > 0, `budgets.${key} must be a positive integer`);
  }
  // Per value only: how one budget relates to another (recoveryReserve below
  // agentInvocations) holds for the run's final budgets, once the task's own
  // override them, so the controller checks it after merging every layer.
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
  checkContext((p.issues as Record<string, unknown>).context);
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
    need(c.requirement === "passes" || c.requirement === "builds" || c.requirement === "final-checks" || c.requirement === "bench-gates", `commands[${i}].requirement must be passes, builds, final-checks or bench-gates`);
    need(c.tier === undefined || c.tier === "cheap" || c.tier === "full" || c.tier === "final", `commands[${i}].tier must be cheap, full or final`);
    // A final command runs after Fix is accepted, so a Fix requirement would never be met; a Review requirement is met only by a final run.
    need(
      (c.tier === "final") === FINAL_REQUIREMENTS.includes(c.requirement as CommandRequirement),
      `commands[${i}]: a final tier command counts toward final-checks or bench-gates, and only a final tier command may (tier ${c.tier ?? "full"}, requirement ${String(c.requirement)})`,
    );
    need(c.section === undefined || (c.tier === "final" && isString(c.section)), `commands[${i}].section is a pull request heading, for a final tier command only`);
    need(!RESERVED_COMMANDS.has(c.id as string), `commands[${i}].id ${JSON.stringify(c.id)} is reserved`);
    need(!ids.has(c.id as string), `commands[${i}].id ${JSON.stringify(c.id)} is repeated`);
    ids.add(c.id as string);
    for (const key of ["label", "statement", "summary"]) need(c[key] === undefined || isString(c[key]), `commands[${i}].${key} must be text`);
    need(c.statement === undefined || c.requirement === "passes", `commands[${i}].statement applies only to a passes command`);
    if (c.writes !== undefined) {
      need(isStrings(c.writes) && c.writes.length > 0, `commands[${i}].writes must be a non-empty list of paths`);
      for (const w of c.writes as string[]) {
        const body = writePath(w);
        need(
          body.length > 0 && !body.startsWith("/") && !body.startsWith("!") && !body.split("/").some((part) => part === ".." || part === "." || part === ""),
          `commands[${i}].writes path "${w}" must be repository-relative, without "..", "." or empty segments`,
        );
      }
    }
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
  need((p.planning as Record<string, unknown>).notes === undefined || isStrings((p.planning as Record<string, unknown>).notes), "planning.notes must be a list of text");
  need(isObject(p.implementation) && isString(p.implementation.conventions), "implementation.conventions is required");
  for (const key of ["checks", "cleanCheckHint"]) {
    const v = (p.implementation as Record<string, unknown>)[key];
    need(v === undefined || isString(v), `implementation.${key} must be text`);
  }
  const selfCheck = (p.implementation as Record<string, unknown>).selfCheck;
  need(selfCheck === undefined || (isStrings(selfCheck) && selfCheck.every((s) => s.trim() !== "")), "implementation.selfCheck must be a list of commands");
  need(isObject(p.review) && isString(p.review.language) && isString(p.review.testFiles) && isStrings(p.review.rules), "review needs language, testFiles and rules");
  const maxReentries = (p.review as Record<string, unknown>).maxReentries;
  need(maxReentries === undefined || (typeof maxReentries === "number" && Number.isInteger(maxReentries) && maxReentries >= 0), "review.maxReentries must be a whole number, 0 or more");
  need(isObject(p.pullRequest) && isStrings(p.pullRequest.checklist) && isStrings(p.pullRequest.footer), "pullRequest needs checklist and footer lists");
  const e2eNote = (p.pullRequest as Record<string, unknown>).e2eNote;
  need(e2eNote === undefined || isString(e2eNote), "pullRequest.e2eNote must be text");
  const reference = (p.pullRequest as Record<string, unknown>).reference;
  if (reference !== undefined) {
    need(isObject(reference) && reference.style === "implements" && isString(reference.subject), 'pullRequest.reference must be { "style": "implements", "subject": "<what is implemented>" }');
    need(
      [...(p.pullRequest as { checklist: string[] }).checklist, ...(p.pullRequest as { footer: string[] }).footer].every((line) => !line.includes("{issue}")),
      "pullRequest.checklist and footer may not use {issue} when pullRequest.reference keeps the issue out of the text",
    );
  }
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
  checkBudgets(p.budgets);
  const agent = p.agent ?? {};
  need(isObject(agent), "agent must be an object");
  const a = agent as Record<string, unknown>;
  for (const key of Object.keys(a)) need(key === "timeoutMs" || key === "timeoutContinuations", `agent.${key} is not an agent setting; they are timeoutMs and timeoutContinuations`);
  need(
    a.timeoutMs === undefined || (Number.isSafeInteger(a.timeoutMs) && (a.timeoutMs as number) > 0 && (a.timeoutMs as number) <= MAX_JOB_TIMEOUT_MS),
    `agent.timeoutMs must be a positive integer of at most ${MAX_JOB_TIMEOUT_MS} (one day)`,
  );
  need(
    a.timeoutContinuations === undefined || (Number.isSafeInteger(a.timeoutContinuations) && (a.timeoutContinuations as number) >= 0 && (a.timeoutContinuations as number) <= MAX_TIMEOUT_CONTINUATIONS),
    `agent.timeoutContinuations must be a whole number from 0 to ${MAX_TIMEOUT_CONTINUATIONS}`,
  );
  const data = structuredClone(config) as unknown as ProfileData;
  return {
    ...data,
    runner: runner!,
    regressionTimeoutMs: (regression.timeoutMs as number | undefined) ?? DEFAULT_REGRESSION_TIMEOUT_MS,
    roles: roles as Profile["roles"],
    timeoutContinuations: (a.timeoutContinuations as number | undefined) ?? DEFAULT_TIMEOUT_CONTINUATIONS,
  };
}

/** The context documents the profile declares, in order. */
export const contextRefs = (profile: Pick<ProfileData, "issues">): ContextDocumentRef[] => profile.issues.context ?? [];

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

/** A `writes` entry as a path: a trailing `/**` or `/` names the directory itself. */
const writePath = (w: string): string => w.replace(/\/\*\*$/, "").replace(/\/$/, "");

/** Every path some command's `writes` declares, as plain paths. */
export function regeneratedPaths(profile: Pick<ProfileData, "commands">): string[] {
  return [...new Set(profile.commands.flatMap((c) => (c.writes ?? []).map(writePath)))];
}

/**
 * The protected paths the implementer is held to: those no command regenerates.
 * A protected path inside a declared `writes` path is writable by design.
 */
export function enforcedProtectedPaths(profile: Pick<ProfileData, "commands" | "protectedPaths">): string[] {
  const regenerated = regeneratedPaths(profile);
  return profile.protectedPaths.filter((p) => !regenerated.some((w) => p === w || p.startsWith(`${w}/`)));
}

/** Declared `writes` paths inside a protected directory the implementer is still held to: `+` scope entries re-allowing them. */
export function regeneratedExceptions(profile: Pick<ProfileData, "commands" | "protectedPaths">): string[] {
  const held = enforcedProtectedPaths(profile);
  return regeneratedPaths(profile).filter((w) => held.some((p) => w.startsWith(`${p}/`))).map((w) => `+${w}`);
}

export const commandTier = (c: ProfileCommand): CommandTier => c.tier ?? "full";

/** Whether the profile splits its checks into two jobs: only when some command is declared `cheap`. */
export const isTiered = (profile: Profile): boolean => profile.commands.some((c) => commandTier(c) === "cheap");

/** The profile's commands in one tier; an untiered profile has every command in `full`. */
export const commandsInTier = (profile: Profile, tier: CommandTier): ProfileCommand[] => profile.commands.filter((c) => commandTier(c) === tier);

/** The commands of a candidate's Fix checks: every command that is not `final`. */
export const checkCommands = (profile: Pick<ProfileData, "commands">): ProfileCommand[] => profile.commands.filter((c) => commandTier(c) !== "final");

/** The commands that run once, after code review converged: the `final` tier. */
export const finalCommands = (profile: Pick<ProfileData, "commands">): ProfileCommand[] => profile.commands.filter((c) => commandTier(c) === "final");

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
