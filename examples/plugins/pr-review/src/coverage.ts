// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Measured coverage (design §6.8, §12.2; design-code-quality-metrics.md §2.3, §4): the pull request's own tests
 * run in the Docker sandbox over a prepared checkout of the head, and each changed function's statement coverage
 * is attributed from the report by line range. Which commands to run, what they report and what that means for
 * each record is decided here from the evidence alone, so the graph (to dispatch) and the `measurements`
 * validator (to recompute the written report) read one answer. Nothing here runs anything.
 *
 * A function whose coverage cannot be measured says why (`not run (<reason>)`) and keeps the unknown-coverage
 * rule: its CRAP is the upper bound and asks nothing. No job falls back to running pull request code outside
 * the sandbox.
 */
import type { DockerConfinement, EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { commandRuns, isObject, latestFile, outputTail, reportText, type CommandRun } from "./evidence.js";
import { formatSpec, goFunctionCoverage, parseCoverageReport, tsFunctionCoverage, type CoverageSpecFunction } from "./metrics/coverage.js";
import { languageOf, type Coverage, type FunctionIndexEntry, type Language, type MetricsRecord } from "./metrics/record.js";
import { SANDBOX_LIMITS, type Profile } from "./profile.js";
import { writeChunks } from "./write.js";

/** The image TypeScript coverage runs in unless a profile pins another: `node:22-bookworm-slim`, by digest (a tag is never run). */
export const DEFAULT_TS_IMAGE = "node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da";

const GO = "go";
const TS = "typescript";
const LANGUAGES: readonly ("go" | "typescript")[] = [GO, TS];

/** The most workspaces one run measures; the rest say so. */
const MAX_WORKSPACES = 8;
/** Argv elements a command may carry (64) less `sh`, the script, the count. */
const MAX_SPEC_CHUNKS = 58;
const MAX_REASON_CHARS = 240;

export interface Sandbox {
  image: string | undefined;
  cpus: number;
  memory: string;
  pids: number;
  tmp: string;
  wallClockMs: number;
}

/** The sandbox a language's coverage runs in: the profile's settings over the defaults (the image of Go has none: it follows the repository's `go.mod`). */
export function resolveSandbox(profile: Pick<Profile, "metrics">, language: "go" | "typescript"): Sandbox {
  const given = profile.metrics.sandbox?.[language] ?? {};
  return {
    image: given.image ?? (language === TS ? DEFAULT_TS_IMAGE : undefined),
    cpus: given.cpus ?? SANDBOX_LIMITS.cpus,
    memory: given.memory ?? SANDBOX_LIMITS.memory,
    pids: given.pids ?? SANDBOX_LIMITS.pids,
    tmp: given.tmp ?? SANDBOX_LIMITS.tmp,
    wallClockMs: given.wallClockMs ?? SANDBOX_LIMITS.wallClockMs,
  };
}

/**
 * Checks the image and pulls it by digest when it is missing: `graphloom sandbox pull` when it is on `PATH`, else
 * the docker CLI itself. It prints `ready` or `unavailable: <why>` and always exits 0, since an image that cannot
 * be had is a recorded reason, not a failed run. Run from `/`, so that nothing in the pull request's tree is read.
 */
const PULL_SCRIPT = [
  'cd / || exit 0; img="$1"; out=""',
  'if command -v graphloom >/dev/null 2>&1; then',
  '  if out=$(graphloom sandbox pull "$img" 2>&1); then echo ready; exit 0; fi',
  'elif ! command -v docker >/dev/null 2>&1; then',
  '  out="the docker CLI is not installed"',
  'else',
  '  if docker image inspect "$img" >/dev/null 2>&1; then echo ready; exit 0; fi',
  '  if out=$(docker pull "$img" 2>&1); then echo ready; exit 0; fi',
  'fi',
  "printf 'unavailable: %s\\n' \"$(printf '%s' \"$out\" | tail -n 1 | cut -c1-300)\"; exit 0",
].join("\n");

/** Where the host keeps what a sandbox mounts read-only: the Go module cache and the npm cache. Read from `/`, so a pull request's `.npmrc` or `go.mod` cannot answer. */
const MODCACHE_SCRIPT = 'cd / && GOTOOLCHAIN=local go env GOMODCACHE 2>/dev/null || true';
const NPMCACHE_SCRIPT = "cd / && npm config get cache 2>/dev/null || true";

/** The image checks (and pulls) of Fetch, and where the host's caches are; empty when coverage is off or no language has an image. */
export function sandboxProbeCommands(profile: Pick<Profile, "metrics">): EnvironmentCommand[] {
  if (!profile.metrics.coverage) return [];
  const commands: EnvironmentCommand[] = [];
  for (const language of LANGUAGES) {
    const { image } = resolveSandbox(profile, language);
    if (image === undefined) continue;
    commands.push({ id: `${COMMAND.sandboxPrefix}${language}`, argv: ["sh", "-c", PULL_SCRIPT, `${COMMAND.sandboxPrefix}${language}`, image], timeoutMs: 30 * 60_000 });
    commands.push(
      language === GO
        ? { id: COMMAND.hostGoModcache, argv: ["sh", "-c", MODCACHE_SCRIPT] }
        : { id: COMMAND.hostNpmCache, argv: ["sh", "-c", NPMCACHE_SCRIPT] },
    );
  }
  return commands;
}

/** The probe commands not yet run. */
export function missingProbe(evidence: readonly EvidenceRecord[], profile: Pick<Profile, "metrics">): EnvironmentCommand[] {
  return sandboxProbeCommands(profile).filter((c) => commandRuns(evidence, c.id).length === 0);
}

/** The environment checks that let `graphloom check` and `doctor --task` say what the sandbox lacks, without pulling anything. */
export function sandboxEnvironmentChecks(profile: Pick<Profile, "metrics">): EnvironmentCommand[] {
  if (!profile.metrics.coverage) return [];
  const script = [
    'cd / || exit 0; img="$1"',
    'command -v docker >/dev/null 2>&1 || { echo "unavailable: the docker CLI is not installed"; exit 0; }',
    'err=$(docker image inspect "$img" 2>&1 >/dev/null) && { echo ready; exit 0; }',
    'case "$err" in',
    '  *"No such image"*|*"No such object"*) echo "missing: Fetch pulls it by digest (graphloom sandbox pull $img)" ;;',
    '  *) printf "unavailable: %s\\n" "$(printf "%s" "$err" | tail -n 1 | cut -c1-200)" ;;',
    "esac",
    "exit 0",
  ].join("\n");
  return LANGUAGES.flatMap((language) => {
    const { image } = resolveSandbox(profile, language);
    return image === undefined ? [] : [{ id: `docker-${language}`, argv: ["sh", "-c", script, `docker-${language}`, image] }];
  });
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim() ?? "";

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= MAX_REASON_CHARS ? t : `${t.slice(0, MAX_REASON_CHARS - 1)}…`;
}

/** What the image check of a language recorded: ready, or why not; undefined while it has not run. */
function sandboxStatus(evidence: readonly EvidenceRecord[], language: "go" | "typescript"): { ready: true } | { ready: false; reason: string } | undefined {
  const run = commandRuns(evidence, `${COMMAND.sandboxPrefix}${language}`).at(-1);
  if (run === undefined) return undefined;
  if (run.command.spawnError !== undefined || run.command.timedOut === true || run.command.aborted === true || run.command.exitCode !== 0) {
    return { ready: false, reason: `the sandbox image check failed: ${oneLine(outputTail(run.command, 200))}` };
  }
  const line = lastLine(run.command.stdoutTail);
  if (line === "ready") return { ready: true };
  if (line.startsWith("unavailable:")) return { ready: false, reason: `docker unavailable: ${oneLine(line.slice("unavailable:".length))}` };
  return { ready: false, reason: "the sandbox image check printed no status" };
}

function hostPath(evidence: readonly EvidenceRecord[], id: string): string | undefined {
  const run = commandRuns(evidence, id).at(-1);
  if (run === undefined || run.command.exitCode !== 0) return undefined;
  const line = lastLine(run.command.stdoutTail);
  return line.startsWith("/") && line !== "/" && !/[:,\n\u0000]|(^|\/)\.\.(\/|$)/.test(line) ? line : undefined;
}

// ---------------------------------------------------------------- TypeScript workspaces

interface Declaration {
  vitest?: string;
  provider?: string;
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const joinDir = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);

/** `package.json` paths from a file's directory up to the repository root. */
function manifestChain(path: string): string[] {
  const out: string[] = [];
  let dir = dirOf(path);
  for (;;) {
    out.push(joinDir(dir, "package.json"));
    if (dir === ".") break;
    dir = dirOf(dir);
  }
  return out;
}

function declaredIn(bytes: string | undefined): { vitest?: string; provider?: string } | undefined {
  if (bytes === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (!isObject(json)) return undefined;
  const out: { vitest?: string; provider?: string } = {};
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = json[section];
    if (!isObject(deps)) continue;
    if (typeof deps.vitest === "string" && out.vitest === undefined) out.vitest = deps.vitest;
    if (typeof deps["@vitest/coverage-v8"] === "string" && out.provider === undefined) out.provider = deps["@vitest/coverage-v8"];
  }
  return out;
}

/** The first major version a range names (`^3.2.4`, `~3`, `3.x`, `>=3 <4`), or undefined for `*`, `latest` and links. */
export function majorOf(range: string): number | undefined {
  const m = /(\d+)/.exec(range);
  return m === null ? undefined : Number(m[1]);
}

interface Workspace {
  dir: string;
  declaration: Declaration;
}

/**
 * The workspace of a changed file (the directory of its nearest `package.json`) and what the repository declares for
 * it: vitest and the coverage provider, each from the nearest `package.json` up the tree that names it. Or why
 * the file cannot be measured.
 */
function workspaceOf(evidence: readonly EvidenceRecord[], path: string): Workspace | { reason: string } {
  let dir: string | undefined;
  const found: Declaration = {};
  for (const manifest of manifestChain(path)) {
    const file = latestFile(evidence, manifest);
    if (file === undefined || file.missing) continue;
    const declared = declaredIn(file.bytes);
    if (declared === undefined) continue;
    dir ??= dirOf(manifest);
    if (found.vitest === undefined && declared.vitest !== undefined) found.vitest = declared.vitest;
    if (found.provider === undefined && declared.provider !== undefined) found.provider = declared.provider;
  }
  if (dir === undefined) return { reason: "no package.json declares a workspace for it" };
  if (found.provider === undefined) return { reason: "no vitest coverage provider in the repository" };
  if (found.vitest === undefined) return { reason: "the repository declares @vitest/coverage-v8 but no vitest" };
  const a = majorOf(found.provider);
  const b = majorOf(found.vitest);
  if (a !== undefined && b !== undefined && a !== b) return { reason: `@vitest/coverage-v8 ${found.provider} does not match vitest ${found.vitest}` };
  return { dir, declaration: found };
}

// ---------------------------------------------------------------- the plan

export interface PlannedCommand {
  id: string;
  /** The script under `tools/cover/` the command runs. */
  script: "go.sh" | "ts.sh";
  /** The text that travels in the argv (`formatSpec`). */
  spec: string;
}

/** One language's coverage job: what runs in one container configuration. */
export interface CoveragePlan {
  language: "go" | "typescript";
  sandbox: Sandbox & { image: string };
  commands: PlannedCommand[];
  /** Host paths mounted read-only besides the plugin: the Go module cache or the npm cache. */
  cache: string;
}

export type Outcome = Coverage | { reason: string };

export interface CoverageRunFacts {
  language: "go" | "typescript";
  ran: boolean;
  reason?: string;
  /** The test command's exit status, when it ran. */
  exit?: number;
  image?: string;
  /** Test result lines, as the report carried them. */
  tests: string[];
  /** Files the run changed in its checkout, as the controller recorded them. */
  changed: string[];
}

export interface CoverageFacts {
  enabled: boolean;
  runs: CoverageRunFacts[];
}

export type CoverageState =
  | { state: "probe"; commands: EnvironmentCommand[] }
  | { state: "observe"; paths: string[] }
  | { state: "run"; plan: CoveragePlan }
  | { state: "failed"; problems: string[]; refs: string[] }
  | { state: "done"; outcomes: Map<string, Outcome>; facts: CoverageFacts; refs: string[] };

export const recordKey = (r: Pick<MetricsRecord, "path" | "function" | "startLine">): string => `${r.path}\u0000${r.function}\u0000${r.startLine}`;

export interface CoverageInput {
  evidence: readonly EvidenceRecord[];
  records: readonly MetricsRecord[];
  /** Every function of each measured file (`[name, start, end]`), from the static documents. */
  index: ReadonlyMap<string, readonly FunctionIndexEntry[]>;
  /** The measured files of the pull request. */
  files: ReadonlyArray<{ path: string; language: Language }>;
  profile: Pick<Profile, "metrics">;
  /** The static measurement's last evidence (the changed-lines diff): coverage runs count after it. */
  afterRef: string | undefined;
}

const NOT_RUN = (reason: string): { reason: string } => ({ reason: oneLine(reason) });

function entryOf(index: ReadonlyMap<string, readonly FunctionIndexEntry[]>, r: MetricsRecord): { entry: FunctionIndexEntry; all: readonly FunctionIndexEntry[] } | undefined {
  const all = index.get(r.path) ?? [];
  const entry = all.find((e) => e[0] === r.function && e[1] === r.startLine && e[2] === r.endLine);
  return entry === undefined ? undefined : { entry, all };
}

const functionsOf = (records: readonly MetricsRecord[]): CoverageSpecFunction[] => records.map((r) => ({ path: r.path, start: r.startLine, end: r.endLine }));

/** The repository-relative directories of the changed Go files, minus those `go test` does not take as packages. */
function goPackages(files: ReadonlyArray<{ path: string; language: Language }>): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    if (f.language !== GO) continue;
    const dir = dirOf(f.path);
    if (dir !== "." && dir.split("/").some((s) => s === "testdata" || s === "vendor" || s.startsWith("_") || s.startsWith("."))) continue;
    dirs.add(dir);
  }
  return [...dirs].sort();
}

/** The package that ran, or why not: the job has no image, or Docker or the image is not available. */
function languageReadiness(evidence: readonly EvidenceRecord[], profile: Pick<Profile, "metrics">, language: "go" | "typescript"): { ready: true; image: string; sandbox: Sandbox & { image: string }; cache: string } | { reason: string } | { probe: true } {
  const sandbox = resolveSandbox(profile, language);
  if (sandbox.image === undefined) return { reason: `the profile pins no ${language} sandbox image (metrics.sandbox.${language}.image)` };
  const status = sandboxStatus(evidence, language);
  if (status === undefined) return { probe: true };
  if (!status.ready) return { reason: status.reason };
  const cacheId = language === GO ? COMMAND.hostGoModcache : COMMAND.hostNpmCache;
  if (commandRuns(evidence, cacheId).length === 0) return { probe: true };
  const cache = hostPath(evidence, cacheId);
  if (cache === undefined) return { reason: language === GO ? "the Go module cache could not be located on the host (go env GOMODCACHE)" : "the npm cache could not be located on the host (npm config get cache)" };
  return { ready: true, image: sandbox.image, sandbox: { ...sandbox, image: sandbox.image }, cache };
}

interface Part {
  language: "go" | "typescript";
  /** Records measured by this part's commands. */
  records: MetricsRecord[];
  command: PlannedCommand;
}

function runFor(evidence: readonly EvidenceRecord[], id: string, afterIndex: number): CommandRun | undefined {
  return commandRuns(evidence, id)
    .filter((r) => evidence.findIndex((e) => e.ref === r.record.ref) > afterIndex)
    .at(-1);
}

/** The controller's refusals of a docker job, after `afterIndex`: the job never ran, and said why. */
function dockerRefusal(evidence: readonly EvidenceRecord[], afterIndex: number): string | undefined {
  for (let i = evidence.length - 1; i > afterIndex; i -= 1) {
    const p = evidence[i]!.payload;
    const failure = isObject(p) && isObject(p.executorFailure) ? p.executorFailure : undefined;
    if (failure !== undefined && typeof failure.summary === "string" && /docker confinement|docker image|the docker CLI|docker daemon/i.test(failure.summary)) return oneLine(failure.summary);
  }
  return undefined;
}

/**
 * The commands that exist for the language's records: Go has one for all its touched packages, TypeScript one per
 * workspace. A record whose workspace cannot run vitest with a matching coverage provider gets its reason now.
 */
function partsOf(input: CoverageInput, language: "go" | "typescript", records: MetricsRecord[], reasons: Map<string, Outcome>): Part[] | { observe: string[] } | { reason: string } {
  if (language === GO) {
    const packages = goPackages(input.files);
    if (packages.length === 0) return { reason: "no touched Go package" };
    const spec = formatSpec({ packages, functions: functionsOf(records) });
    return [{ language, records, command: { id: COMMAND.coverGo, script: "go.sh", spec } }];
  }
  const manifests = [...new Set(records.flatMap((r) => manifestChain(r.path)))];
  const unread = manifests.filter((p) => latestFile(input.evidence, p) === undefined);
  if (unread.length > 0) return { observe: unread };
  const byWorkspace = new Map<string, MetricsRecord[]>();
  for (const r of records) {
    const ws = workspaceOf(input.evidence, r.path);
    if ("reason" in ws) {
      reasons.set(recordKey(r), NOT_RUN(ws.reason));
      continue;
    }
    byWorkspace.set(ws.dir, [...(byWorkspace.get(ws.dir) ?? []), r]);
  }
  const parts: Part[] = [];
  for (const dir of [...byWorkspace.keys()].sort()) {
    const mine = byWorkspace.get(dir)!;
    if (parts.length >= MAX_WORKSPACES) {
      for (const r of mine) reasons.set(recordKey(r), NOT_RUN(`more than ${MAX_WORKSPACES} workspaces are touched; this one was not run`));
      continue;
    }
    const files = [...new Set(mine.map((r) => r.path))].sort();
    parts.push({ language, records: mine, command: { id: `${COMMAND.coverTs}-${parts.length + 1}`, script: "ts.sh", spec: formatSpec({ workspace: dir, files, functions: functionsOf(mine) }) } });
  }
  return parts;
}

/** The spec a coverage command's argv carries: `sh <script> <n> <chunks…>`. */
export function measuredSpec(argv: readonly string[]): string | undefined {
  const n = Number(argv[2]);
  if (!Number.isSafeInteger(n) || n < 0 || argv.length < 3 + n) return undefined;
  return argv.slice(3, 3 + n).join("");
}

/** The coverage job's commands as the executor takes them: the script under the plugin's `tools/cover/`, then the spec in chunks. */
export function coverageCommand(c: PlannedCommand, pluginRoot: string, wallClockMs: number): EnvironmentCommand {
  const parts = writeChunks(c.spec);
  // The container's own wall clock ends it first; the executor's limit only has to outlast it.
  return { id: c.id, argv: ["sh", `${pluginRoot}/tools/cover/${c.script}`, String(parts.length), ...parts], timeoutMs: wallClockMs + 60_000 };
}

/** The Docker confinement of a coverage job: the checkout and (Go) a build cache in the run's scratch are writable; the plugin and the dependency cache are read-only; only the variables below reach the container. */
export function coverageConfinement(plan: CoveragePlan, pluginRoot: string): DockerConfinement {
  const { sandbox: s } = plan;
  const go = plan.language === GO;
  return {
    kind: "docker",
    image: s.image,
    cpus: s.cpus,
    memory: s.memory,
    pids: s.pids,
    tmp: s.tmp,
    wallClockMs: s.wallClockMs,
    writable: go ? [".", "@scratch/gocache"] : ["."],
    readOnly: [pluginRoot, plan.cache],
    env: go
      ? { HOME: "/tmp", GOFLAGS: "-mod=readonly", GOPROXY: "off", GOTOOLCHAIN: "local", GOCACHE: "@scratch/gocache", GOMODCACHE: plan.cache }
      : { HOME: "/tmp", npm_config_cache: plan.cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  };
}

/** Whether a plan's specs fit the commands that carry them. */
export function planFits(plan: CoveragePlan): boolean {
  return plan.commands.every((c) => writeChunks(c.spec).length <= MAX_SPEC_CHUNKS);
}

/** What one command's report says of its records. */
function attribute(part: Part, run: CommandRun, input: CoverageInput, outcomes: Map<string, Outcome>): { facts: CoverageRunFacts; problem?: string } {
  const facts: CoverageRunFacts = { language: part.language, ran: false, tests: [], changed: [] };
  const mutated = isObject(run.record.payload) && isObject(run.record.payload.checkout) && Array.isArray(run.record.payload.checkout.mutations) ? run.record.payload.checkout.mutations.filter((m): m is string => typeof m === "string") : [];
  facts.changed = mutated;
  const none = (reason: string): { facts: CoverageRunFacts } => {
    facts.reason = oneLine(reason);
    for (const r of part.records) outcomes.set(recordKey(r), NOT_RUN(reason));
    return { facts };
  };
  const spec = measuredSpec(run.command.argv);
  if (spec !== part.command.spec) return { facts, problem: `${part.command.id}: the command measured other functions than the measurements name` };
  const text = reportText(run);
  if (text.truncated) return none("the coverage report did not fit the command report whole");
  const parsed = parseCoverageReport(text.text);
  if ("error" in parsed) {
    const why = outputTail(run.command, 200);
    return none(`the coverage command wrote no report${why !== "" ? `: ${oneLine(why)}` : ""}`);
  }
  if (parsed.language !== part.language) return { facts, problem: `${part.command.id}: the report is for ${parsed.language}, not ${part.language}` };
  facts.ran = true;
  if (parsed.exit !== undefined) facts.exit = parsed.exit;
  facts.tests = parsed.tests.slice(0, 12);
  const wholeFailure = parsed.language === TS && parsed.fail.length > 0 && parsed.seen.size === 0;
  for (const r of part.records) {
    const where = entryOf(input.index, r);
    if (where === undefined) {
      outcomes.set(recordKey(r), NOT_RUN("the function is not in the file index"));
      continue;
    }
    if (wholeFailure) {
      outcomes.set(recordKey(r), NOT_RUN(parsed.fail[0]!));
      continue;
    }
    const got = parsed.language === GO ? goFunctionCoverage(parsed, r.path, where.entry, where.all) : tsFunctionCoverage(parsed, r.path, where.entry, where.all);
    outcomes.set(recordKey(r), "reason" in got ? NOT_RUN(got.reason) : got);
  }
  return { facts };
}

/**
 * Where coverage stands: the image checks and the files a plan needs still to read, the job still to run, the
 * commands that failed to measure what they were asked, or every record's coverage (measured, or not run with a
 * reason). Each coverage value is attributed from the report a command wrote, never taken from anywhere else.
 */
export function coverageState(input: CoverageInput): CoverageState {
  const { evidence, profile } = input;
  const outcomes = new Map<string, Outcome>();
  const facts: CoverageFacts = { enabled: profile.metrics.coverage, runs: [] };
  const measured = input.records.filter((r) => !r.test);
  if (!profile.metrics.coverage) {
    for (const r of measured) outcomes.set(recordKey(r), NOT_RUN("coverage disabled by the profile"));
    return { state: "done", outcomes, facts, refs: [] };
  }
  const afterIndex = input.afterRef === undefined ? -1 : evidence.findIndex((e) => e.ref === input.afterRef);
  const problems: string[] = [];
  const refs: string[] = [];
  let cursor = afterIndex;
  for (const language of LANGUAGES) {
    const mine = measured.filter((r) => languageOf(r.path) === language);
    if (mine.length === 0) continue;
    const ready = languageReadiness(evidence, profile, language);
    if ("probe" in ready) return { state: "probe", commands: missingProbe(evidence, profile) };
    if ("reason" in ready) {
      for (const r of mine) outcomes.set(recordKey(r), NOT_RUN(ready.reason));
      facts.runs.push({ language, ran: false, reason: oneLine(ready.reason), tests: [], changed: [] });
      continue;
    }
    const parts = partsOf(input, language, mine, outcomes);
    if (!Array.isArray(parts)) {
      if ("observe" in parts) return { state: "observe", paths: parts.observe };
      for (const r of mine) outcomes.set(recordKey(r), NOT_RUN(parts.reason));
      facts.runs.push({ language, ran: false, reason: parts.reason, tests: [], changed: [] });
      continue;
    }
    if (parts.length === 0) {
      const why = [...new Set(mine.map((r) => (outcomes.get(recordKey(r)) as { reason: string } | undefined)?.reason ?? "not run"))].join("; ");
      facts.runs.push({ language, ran: false, reason: why, tests: [], changed: [] });
      continue;
    }
    const plan: CoveragePlan = { language, sandbox: ready.sandbox, commands: parts.map((p) => p.command), cache: ready.cache };
    if (!planFits(plan)) {
      for (const p of parts) for (const r of p.records) outcomes.set(recordKey(r), NOT_RUN("the changed functions are too many for one coverage command"));
      facts.runs.push({ language, ran: false, reason: "the changed functions are too many for one coverage command", tests: [], changed: [] });
      continue;
    }
    const runs = parts.map((p) => ({ part: p, run: runFor(evidence, p.command.id, afterIndex) }));
    const missing = runs.filter((x) => x.run === undefined);
    if (missing.length > 0) {
      const refused = dockerRefusal(evidence, cursor);
      if (refused === undefined) return { state: "run", plan: { ...plan, commands: missing.map((x) => x.part.command) } };
      for (const x of missing) for (const r of x.part.records) outcomes.set(recordKey(r), NOT_RUN(refused));
      facts.runs.push({ language, ran: false, reason: refused, image: ready.image, tests: [], changed: [] });
      cursor = evidence.length - 1;
      continue;
    }
    for (const { part, run } of runs) {
      refs.push(run!.record.ref);
      cursor = Math.max(cursor, evidence.findIndex((e) => e.ref === run!.record.ref));
      const result = attribute(part, run!, input, outcomes);
      if (result.problem !== undefined) problems.push(result.problem);
      facts.runs.push({ ...result.facts, image: ready.image });
    }
  }
  if (problems.length > 0) return { state: "failed", problems, refs };
  return { state: "done", outcomes, facts, refs };
}

/** A reason as a record carries it: `not run (<reason>)`. */
export function reasonText(reason: string): string {
  return reason.startsWith("not run") ? reason : `not run (${reason})`;
}
