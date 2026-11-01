// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Measurements (design §6.8, design-code-quality-metrics.md §4, §5): `gometrics`
 * and `tsmetrics` run under bwrap with no network over the head tree and execute
 * none of it, then the `graphloom-metrics-v1` documents are recomputed from the
 * head file bytes (`validateMetricsDocument`) before any value reaches the report.
 * Coverage runs the pull request's own tests, so it runs only in the Docker
 * sandbox (`coverage.ts`); each record then carries measured statement coverage
 * attributed from the sandbox's report, or says why it was not run, and CRAP is
 * recomputed (or stays its upper bound, §2.4). Mutation arrives with a later version.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { coverageState, reasonText, recordKey, type CoverageFacts, type CoverageRunFacts, type CoveragePlan, type Outcome } from "./coverage.js";
import { pinnedBase } from "./commands.js";
import { commandRuns, describeCommand, latestFile, outputTail, reportText, succeeded, type CommandRun } from "./evidence.js";
import { crapRounded, exceeds, LIMITS, originOf, type Metric } from "./metrics/crap.js";
import { matchesGeneratedGlob } from "./metrics/generated.js";
import { formatHunkFile, hunksFromUnifiedDiff } from "./metrics/hunks.js";
import { withCoverage } from "./metrics/coverage.js";
import { isTestPath, languageOf, SCHEMA, type BaseMetrics, type FunctionIndexEntry, type Hunks, type Language, type MetricsDocument, type MetricsRecord } from "./metrics/record.js";
import { validateMetricsDocument } from "./metrics/validate.js";
import { COMMAND } from "./constants.js";
import type { Profile } from "./profile.js";
import { isDeleted, type PullFile } from "./snapshot.js";
import { writeChunks } from "./write.js";

/** Files per tool run: one document must fit a command's 64 KiB report. */
export const BATCH_FILES = 8;
export const MAX_DIFF_BYTES = 60_000;

export const STATIC_PREFIX = "static-";

/** The observable path rule: a relative file path the controller can read (no `..`, no `.git`, a file name with an extension). */
export function observable(p: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s === ".git")) return false;
  return parts.at(-1)!.indexOf(".", 1) > 0;
}

export interface Measurable {
  /** Files to measure, by language, in the pull request's order. */
  files: Array<{ path: string; language: Language }>;
  /** Files of a measured language that cannot be measured, with why. */
  excluded: Array<{ path: string; reason: string }>;
}

/** The changed files the static tools measure (design-code-quality-metrics.md §1): added or modified, in a measured language, in the profile's file globs. */
export function measurable(files: readonly PullFile[], profile: Pick<Profile, "metrics">): Measurable {
  const out: Measurable = { files: [], excluded: [] };
  for (const f of files) {
    if (isDeleted(f)) continue;
    const language = languageOf(f.path);
    if (language === undefined) continue;
    const globs = profile.metrics.files[language];
    if (globs !== undefined && !matchesGeneratedGlob(globs, f.path)) continue;
    if (!observable(f.path)) out.excluded.push({ path: f.path, reason: "its path cannot be observed" });
    else out.files.push({ path: f.path, language });
  }
  return out;
}

export interface Batch {
  /** The command id, `static-go-1`, `static-typescript-2`, … */
  id: string;
  language: Language;
  paths: string[];
}

export function batchesOf(m: Measurable): Batch[] {
  const out: Batch[] = [];
  for (const language of ["go", "typescript"] as const) {
    const paths = m.files.filter((f) => f.language === language).map((f) => f.path);
    for (let i = 0; i < paths.length; i += BATCH_FILES) out.push({ id: `${STATIC_PREFIX}${language}-${out.filter((b) => b.language === language).length + 1}`, language, paths: paths.slice(i, i + BATCH_FILES) });
  }
  return out;
}

/** The files a measured language can have, as Git pathspecs: the diff the tools' hunks come from holds nothing else. */
export const MEASURED_PATHSPECS = ["*.go", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/**
 * Keeps a `-U0` diff's `+++ ` file headers and `@@ ` hunk headers and drops the hunk bodies, which the measurement never
 * reads: the line ranges are in the headers. It counts through each body as `hunksFromUnifiedDiff` does, so an added
 * line that reads `++ x` (`+++ x` in the diff) is never taken for a file header. A large pull request's added code no
 * longer has to fit the report (§6.8); `hunksFromUnifiedDiff(text, { headersOnly: true })` reads the result.
 */
export const DIFF_HEADERS_AWK =
  'o > 0 || n > 0 { c = substr($0, 1, 1); if (c == "-") o--; else if (c == "+") n--; else if (c == " ") { o--; n-- } next } ' +
  'substr($0, 1, 4) == "+++ " { print; next } ' +
  'substr($0, 1, 3) == "@@ " { print; split($2, a, ","); o = (a[2] == "" ? 1 : a[2] + 0); split($3, b, ","); n = (b[2] == "" ? 1 : b[2] + 0); next }';

/**
 * `git diff -U0 -w` of the worktree against the pinned base, over the measured languages' files: the head-side
 * hunks, whitespace-only edits excluded (§5.1). It goes to the command's report file, whose tail the controller
 * keeps with a flag when it is cut, so a diff that does not fit is refused, never read short.
 */
export const metricsDiffCommand = (): EnvironmentCommand => ({
  id: COMMAND.metricsDiff,
  // A pipeline's status is awk's, so git's own status comes back on fd 3 and decides the command's: a git that fails
  // (an unresolved HEAD, an unreadable object) fails the command rather than leave an empty or partial report.
  argv: ["sh", "-c", `set -eu; rc=$( { { git -c core.hooksPath=/dev/null diff -U0 -w --no-color --no-ext-diff --no-textconv HEAD -- "$@" && s=0 || s=$?; echo "$s" >&3; } | awk '${DIFF_HEADERS_AWK}' > "$GRAPHLOOM_REPORT_FILE"; } 3>&1 ); [ "$rc" = 0 ] || { echo "git diff exited $rc" >&2; exit 1; }`, COMMAND.metricsDiff, ...MEASURED_PATHSPECS],
});

const STATIC_SCRIPT =
  'set -eu; n="$1"; shift; h=""; while [ "$n" -gt 0 ]; do h="$h$1"; shift; n=$((n - 1)); done; kind="$1"; root="$2"; gen="$3"; node="$4"; gobin="${5:-go}"; wt=$(pwd -P); ' +
  'if [ "$kind" = go ]; then printf \'%s\' "$h" | { cd "$root/tools/gometrics" && GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0 "$gobin" run . --head "$wt" --hunks - --generated "$gen"; } > "$GRAPHLOOM_REPORT_FILE"; ' +
  'else printf \'%s\' "$h" | "$node" "$root/dist/metrics/tsmetrics-cli.js" --head "$wt" --hunks - --generated "$gen" > "$GRAPHLOOM_REPORT_FILE"; fi';

/**
 * The command that measures one batch: its hunks travel in the argv, so the recorded bytes are the bytes measured.
 * `goBin` is the Go toolchain to run: the `go` of the GOROOT the environment check resolved in the worktree (which
 * the confined job binds), not the first `go` on PATH, which may be a launcher in the hidden home.
 */
export function staticCommand(batch: Batch, hunks: Hunks, pluginRoot: string, generated: readonly string[], nodeBin: string, goBin = "go"): EnvironmentCommand {
  const subset: Hunks = new Map(batch.paths.flatMap((p) => (hunks.has(p) ? [[p, hunks.get(p)!] as const] : [])));
  const parts = writeChunks(formatHunkFile(subset));
  return { id: batch.id, argv: ["sh", "-c", STATIC_SCRIPT, batch.id, String(parts.length), ...parts, batch.language === "go" ? "go" : "ts", pluginRoot, generated.join(","), nodeBin, goBin] };
}

/** The hunk text a static command measured, read back from its argv. */
export function measuredHunks(argv: readonly string[]): string | undefined {
  const n = Number(argv[4]);
  if (argv[3] === undefined || !Number.isSafeInteger(n) || n < 0) return undefined;
  return argv.slice(5, 5 + n).join("");
}

// ---- the base side of a modified function (design §6.8)

/** The base file a modified function lives in, read at the pinned base and measured by the same tool. */
export interface BaseTarget {
  /** 1-based, in the order the records name their files: the `base-file-<n>` command id. */
  index: number;
  /** The path at the base: the pull request's `previousPath` for a renamed file. */
  path: string;
  language: Language;
}

/** The base files whose functions the pull request modifies (added functions have no base): unique, in record order. */
export function baseTargets(records: readonly MetricsRecord[], files: readonly PullFile[]): BaseTarget[] {
  const out: BaseTarget[] = [];
  for (const r of records) {
    if (r.change !== "modified" || r.test || isTestPath(r.path)) continue;
    const file = files.find((f) => f.path === r.path);
    if (file === undefined) continue;
    const path = file.previousPath ?? file.path;
    const language = languageOf(path);
    if (language === undefined || out.some((t) => t.path === path)) continue;
    out.push({ index: out.length + 1, path, language });
  }
  return out;
}

const modulePathOf = (file: string): string => file.replace(/\.(d\.)?[cm]?[jt]sx?$/, "");

/**
 * A head function's name as the base file's measurement names it. `tsmetrics` qualifies a function with its file's module path
 * (the path without its extension), so a renamed TypeScript file's function carries the old module path at the base; a Go
 * function is named by its package and receiver, which do not change with the file's name.
 */
export function baseFunctionName(fn: string, headPath: string, basePath: string, language: Language): string {
  if (headPath === basePath || language !== "typescript") return fn;
  const head = modulePathOf(headPath);
  return fn === head || fn.startsWith(`${head}.`) ? `${modulePathOf(basePath)}${fn.slice(head.length)}` : fn;
}

/** A base file larger than a command report holds whole is not measured at the base. */
export const MAX_BASE_FILE_BYTES = 60_000;
export const BASE_FILE_PREFIX = `${COMMAND.baseFile}-`;
export const STATIC_BASE_PREFIX = "static-base-";

/** The base file's text, whole, to the command's report file: `git show <base>:<path>`, read-only, no repository code. */
export const baseFileCommand = (t: BaseTarget, base: string): EnvironmentCommand => ({
  id: `${BASE_FILE_PREFIX}${t.index}`,
  argv: ["sh", "-c", 'set -eu; git -c core.hooksPath=/dev/null show "$1:$2" > "$GRAPHLOOM_REPORT_FILE"', `${BASE_FILE_PREFIX}${t.index}`, base, t.path],
});

/** Every line of a base file as changed, so the tool records every function of it. */
export const wholeFile = (path: string, text: string): Hunks => new Map([[path, [{ start: 1, end: Math.max(1, text.split("\n").length) }]]]);

export interface BaseBatch {
  /** `static-base-go-1`, `static-base-typescript-1`, …: one base file each, so its document fits a command's report. */
  id: string;
  language: Language;
  path: string;
  text: string;
}

const BASE_TOOL_RUN =
  'if [ "$kind" = go ]; then printf \'%s\' "$h" | { cd "$root/tools/gometrics" && GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0 "$gobin" run . --head "$wt" --hunks - --generated "$gen"; } > "$GRAPHLOOM_REPORT_FILE"; ' +
  'else printf \'%s\' "$h" | "$node" "$root/dist/metrics/tsmetrics-cli.js" --head "$wt" --hunks - --generated "$gen" > "$GRAPHLOOM_REPORT_FILE"; fi';

const STATIC_BASE_SCRIPT =
  'set -eu; n="$1"; shift; h=""; while [ "$n" -gt 0 ]; do h="$h$1"; shift; n=$((n - 1)); done; kind="$1"; root="$2"; gen="$3"; node="$4"; gobin="$5"; base="$6"; p="$7"; ' +
  'wt=$(mktemp -d); trap \'rm -rf "$wt"\' EXIT; mkdir -p "$wt/$(dirname "$p")"; git -c core.hooksPath=/dev/null show "$base:$p" > "$wt/$p"; ' +
  BASE_TOOL_RUN;

/**
 * The command that measures one base file: it writes the file as `git show` prints it into a scratch directory and runs
 * the same static tool over it, every line changed. The whole-file hunks travel in the argv, with the base and the path, so
 * the recorded bytes say what was measured and the validator recomputes the values from the file's recorded text.
 */
export function staticBaseCommand(b: BaseBatch, base: string, pluginRoot: string, generated: readonly string[], nodeBin: string, goBin = "go"): EnvironmentCommand {
  const parts = writeChunks(formatHunkFile(wholeFile(b.path, b.text)));
  return { id: b.id, argv: ["sh", "-c", STATIC_BASE_SCRIPT, b.id, String(parts.length), ...parts, b.language === "go" ? "go" : "ts", pluginRoot, generated.join(","), nodeBin, goBin, base, b.path] };
}

type BaseRead = { path: string; text: string } | { path: string; unavailable: string };

function runAfter(evidence: readonly EvidenceRecord[], id: string, afterRef: string): CommandRun | undefined {
  const after = evidence.findIndex((e) => e.ref === afterRef);
  return commandRuns(evidence, id).filter((r) => evidence.findIndex((e) => e.ref === r.record.ref) > after).at(-1);
}

/**
 * Where the base measurement of the modified functions stands: the base files still to read, the base files still to
 * measure, or the head records with their base values. A base that cannot be read or measured never fails the report:
 * the row says why its base is not known, and shows the head's value alone.
 */
function baseState(evidence: readonly EvidenceRecord[], records: readonly MetricsRecord[], files: readonly PullFile[], afterRef: string, profile: Pick<Profile, "metrics">):
  | { state: "baseFiles"; commands: EnvironmentCommand[] }
  | { state: "baseTools"; batches: BaseBatch[]; base: string }
  | { state: "done"; records: MetricsRecord[] } {
  const base = pinnedBase(evidence);
  const targets = base === undefined ? [] : baseTargets(records, files);
  if (base === undefined || targets.length === 0) return { state: "done", records: [...records] };
  const reads = new Map<string, BaseRead>();
  const missing: EnvironmentCommand[] = [];
  for (const t of targets) {
    const command = baseFileCommand(t, base);
    const run = observable(t.path) ? runAfter(evidence, command.id, afterRef) : undefined;
    if (!observable(t.path)) {
      reads.set(t.path, { path: t.path, unavailable: "its path cannot be passed to the tool" });
      continue;
    }
    if (run === undefined || run.command.argv.length !== command.argv.length || run.command.argv.some((a, i) => a !== command.argv[i])) {
      missing.push(command);
      continue;
    }
    const report = reportText(run);
    if (!succeeded(run.command)) reads.set(t.path, { path: t.path, unavailable: "the file cannot be read at the base" });
    else if (report.truncated || Buffer.byteLength(report.text, "utf8") > MAX_BASE_FILE_BYTES) reads.set(t.path, { path: t.path, unavailable: `the base file is over ${MAX_BASE_FILE_BYTES / 1000} KB, more than a command report holds whole` });
    else if (report.text.trim() === "") reads.set(t.path, { path: t.path, unavailable: "the file is empty at the base" });
    else reads.set(t.path, { path: t.path, text: report.text });
  }
  if (missing.length > 0) return { state: "baseFiles", commands: missing };
  const batches: BaseBatch[] = [];
  const perLanguage = new Map<Language, number>();
  for (const t of targets) {
    const r = reads.get(t.path)!;
    if ("text" in r) {
      const n = (perLanguage.get(t.language) ?? 0) + 1;
      perLanguage.set(t.language, n);
      batches.push({ id: `${STATIC_BASE_PREFIX}${t.language}-${n}`, language: t.language, path: t.path, text: r.text });
    }
  }
  const toRun: BaseBatch[] = [];
  const documents = new Map<string, { metrics: Map<string, BaseMetrics> } | { unavailable: string }>();
  for (const b of batches) {
    const run = runAfter(evidence, b.id, afterRef);
    const argv = run?.command.argv ?? [];
    if (run === undefined || argv.at(-2) !== base || argv.at(-1) !== b.path || measuredHunks(argv) !== formatHunkFile(wholeFile(b.path, b.text))) {
      toRun.push(b);
      continue;
    }
    documents.set(b.path, baseDocument(run, b, profile));
  }
  if (toRun.length > 0) return { state: "baseTools", batches: toRun, base };
  const out = records.map((r): MetricsRecord => {
    const target = r.change === "modified" && !r.test ? targets.find((t) => t.path === (files.find((f) => f.path === r.path)?.previousPath ?? r.path)) : undefined;
    if (target === undefined) return r;
    const read = reads.get(target.path)!;
    if ("unavailable" in read) return { ...r, base: { unavailable: read.unavailable } };
    const doc = documents.get(target.path);
    if (doc === undefined || "unavailable" in doc) return { ...r, base: { unavailable: doc?.unavailable ?? "the base was not measured" } };
    return { ...r, base: doc.metrics.get(baseFunctionName(r.function, r.path, target.path, target.language)) ?? { unavailable: "no function of this name at the base" } };
  });
  return { state: "done", records: out };
}

/** One base file's measured functions, recomputed from its recorded text; or why they cannot be trusted. */
function baseDocument(run: CommandRun, b: BaseBatch, profile: Pick<Profile, "metrics">): { metrics: Map<string, BaseMetrics> } | { unavailable: string } {
  if (!succeeded(run.command)) return { unavailable: `the base measurement failed: ${outputTail(run.command, 200).replace(/\s+/g, " ")}` };
  const report = reportText(run);
  if (report.truncated) return { unavailable: "the base file's measurements did not fit a command report whole" };
  let doc: unknown;
  try {
    doc = JSON.parse(report.text);
  } catch {
    return { unavailable: "the base measurement printed no JSON document" };
  }
  const result = validateMetricsDocument(doc, { readFile: (p) => (p === b.path ? b.text : undefined), hunks: wholeFile(b.path, b.text), generated: profile.metrics.generated });
  if (!result.ok) return { unavailable: `the base measurement does not recompute: ${result.errors[0]?.message ?? "invalid"}` };
  const document = doc as MetricsDocument;
  if (document.tool !== (b.language === "go" ? "gometrics" : "tsmetrics")) return { unavailable: `the base document is from ${document.tool}` };
  return { metrics: new Map(document.records.filter((r) => r.path === b.path).map((r) => [r.function, { complexity: r.complexity, nesting: r.nesting, startLine: r.startLine, endLine: r.endLine, path: r.path }] as const)) };
}

export type MeasurementState =
  | { state: "none"; reason: string }
  /** The base files of the modified functions are to be read (`git show <base>:<path>`, read-only). */
  | { state: "baseFiles"; commands: EnvironmentCommand[] }
  /** The base files are to be measured by the same static tool. */
  | { state: "baseTools"; batches: BaseBatch[]; base: string }
  | { state: "observe"; paths: string[] }
  | { state: "diff" }
  | { state: "tools"; batches: Batch[]; hunks: Hunks }
  /** The sandbox images are to be checked, and pulled by digest when missing, before any sandboxed job (design §12.2). */
  | { state: "probe"; commands: EnvironmentCommand[] }
  /** The coverage job to run in the Docker sandbox next. */
  | { state: "coverage"; plan: CoveragePlan }
  | { state: "failed"; problems: string[]; refs: string[]; retry: Batch[] }
  | { state: "ready"; records: MetricsRecord[]; refs: string[]; excluded: Measurable["excluded"]; coverage: CoverageFacts };

export interface Reasons {
  coverage: string;
  mutation: string;
}

/** Why coverage did not run when the profile says so, and why mutation did not run, in the words a record carries. */
export function notRunReasons(profile: Pick<Profile, "metrics">): Reasons {
  return {
    coverage: profile.metrics.coverage ? "not run" : "not run (coverage disabled by the profile)",
    mutation: !profile.metrics.mutation.enabled ? "not run (mutation disabled by the profile)" : "not run: mutation not available in this version",
  };
}

function diffRun(evidence: readonly EvidenceRecord[]): CommandRun | undefined {
  return commandRuns(evidence, COMMAND.metricsDiff).at(-1);
}

/** Static runs of the latest tools job: the newest run of each batch id. */
function latestRuns(evidence: readonly EvidenceRecord[], batches: readonly Batch[]): Map<string, CommandRun> {
  const out = new Map<string, CommandRun>();
  const diff = diffRun(evidence);
  const after = diff === undefined ? -1 : evidence.findIndex((e) => e.ref === diff.record.ref);
  for (const b of batches) {
    const run = commandRuns(evidence, b.id).filter((r) => evidence.findIndex((e) => e.ref === r.record.ref) > after).at(-1);
    if (run !== undefined) out.set(b.id, run);
  }
  return out;
}

/**
 * Where the static measurement stands: what it still needs, why it failed, or
 * the recomputed records. Every record's complexity, nesting and scope are
 * rebuilt from the head file bytes the graph observed; a document that does
 * not recompute is a failure, never corrected.
 */
export function measurementState(
  evidence: readonly EvidenceRecord[],
  files: readonly PullFile[],
  profile: Pick<Profile, "metrics">,
  /** Whether a failed run may run again because the operator resumed since it failed (the graph passes it; validators do not). */
  canRetry?: (run: CommandRun) => boolean,
): MeasurementState {
  const m = measurable(files, profile);
  if (m.files.length === 0) return { state: "none", reason: "no changed file is in a measured language" };
  const unread = m.files.filter((f) => latestFile(evidence, f.path) === undefined).map((f) => f.path);
  if (unread.length > 0) return { state: "observe", paths: unread };
  const diff = diffRun(evidence);
  if (diff === undefined) return { state: "diff" };
  if (!succeeded(diff.command)) {
    // A failure from before the operator's resume runs again once, as every command does.
    if (canRetry?.(diff) === true) return { state: "diff" };
    return { state: "failed", problems: [`${describeCommand(diff.command)}: ${outputTail(diff.command)}`], refs: [diff.record.ref], retry: [] };
  }
  const text = reportText(diff);
  if (text.truncated || Buffer.byteLength(text.text, "utf8") > MAX_DIFF_BYTES) {
    return { state: "failed", problems: [`the changed lines' hunk headers (git diff -U0) did not fit the ${MAX_DIFF_BYTES}-byte report whole`], refs: [diff.record.ref], retry: [] };
  }
  const all = hunksFromUnifiedDiff(text.text, { headersOnly: true });
  const wanted = new Set(m.files.map((f) => f.path));
  const hunks: Hunks = new Map([...all].filter(([p]) => wanted.has(p)));
  const batches = batchesOf(m);
  const runs = latestRuns(evidence, batches);
  if (batches.some((b) => !runs.has(b.id))) return { state: "tools", batches: batches.filter((b) => !runs.has(b.id)), hunks };
  const problems: string[] = [];
  const refs = [diff.record.ref];
  const retry: Batch[] = [];
  const rerun: Batch[] = [];
  const records: MetricsRecord[] = [];
  const covered = new Set<string>();
  const index = new Map<string, FunctionIndexEntry[]>();
  for (const b of batches) {
    const run = runs.get(b.id)!;
    refs.push(run.record.ref);
    if (!succeeded(run.command)) {
      if (canRetry?.(run) === true) {
        rerun.push(b);
        continue;
      }
      problems.push(`${describeCommand(run.command)}: ${outputTail(run.command)}`);
      retry.push(b);
      continue;
    }
    const report = reportText(run);
    if (report.truncated) {
      problems.push(`${b.id}: the tool's output did not fit the command report whole`);
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(report.text);
    } catch (err) {
      problems.push(`${b.id}: the tool printed no JSON document (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const batchHunks: Hunks = new Map(b.paths.flatMap((p) => (hunks.has(p) ? [[p, hunks.get(p)!] as const] : [])));
    // The hunks the tool measured are the hunks of the diff, not whatever the argv carried.
    const argvHunks = measuredHunks(run.command.argv);
    if (argvHunks !== formatHunkFile(batchHunks)) {
      problems.push(`${b.id}: the tool measured other changed lines than the diff's`);
      continue;
    }
    const result = validateMetricsDocument(doc, {
      readFile: (p) => {
        const f = latestFile(evidence, p);
        return f === undefined || f.missing ? undefined : f.bytes;
      },
      hunks: batchHunks,
      generated: profile.metrics.generated,
    });
    if (!result.ok) {
      problems.push(...result.errors.slice(0, 5).map((e) => `${b.id}: ${e.path ?? ""}${e.function !== undefined ? ` ${e.function}` : ""}: ${e.message}`.replace(/\s+/g, " ")));
      continue;
    }
    const document = doc as MetricsDocument;
    const expectedTool = b.language === "go" ? "gometrics" : "tsmetrics";
    if (document.tool !== expectedTool) {
      problems.push(`${b.id}: the document is from ${document.tool}, not ${expectedTool}`);
      continue;
    }
    for (const f of document.files) {
      covered.add(f.path);
      index.set(f.path, f.functions);
    }
    for (const s of document.skipped) covered.add(s.path);
    records.push(...document.records);
  }
  // Batches that failed before the operator's resume are measured again before anything is judged.
  if (rerun.length > 0) return { state: "tools", batches: rerun, hunks };
  if (problems.length > 0) return { state: "failed", problems, refs, retry };
  const missing = m.files.map((f) => f.path).filter((p) => !covered.has(p) && hunks.has(p));
  if (missing.length > 0) return { state: "failed", problems: [`the tools accounted for none of: ${missing.slice(0, 5).join(", ")}`], refs, retry: [] };
  // The modified functions' values at the base (design §6.8): never a failure, only a row that says why its base is not known.
  const withBase = baseState(evidence, records, files, diff.record.ref, profile);
  if (withBase.state === "baseFiles") return { state: "baseFiles", commands: withBase.commands };
  if (withBase.state === "baseTools") return { state: "baseTools", batches: withBase.batches, base: withBase.base };
  const measured = withBase.records;
  const cov = coverageState({ evidence, records: measured, index, files: m.files, profile, afterRef: diff.record.ref });
  switch (cov.state) {
    case "probe":
      return { state: "probe", commands: cov.commands };
    case "observe":
      return { state: "observe", paths: cov.paths };
    case "run":
      return { state: "coverage", plan: cov.plan };
    case "failed":
      return { state: "failed", problems: cov.problems, refs: [...refs, ...cov.refs], retry: [] };
    case "done":
      return { state: "ready", records: measured.map((r) => withOutcome(r, cov.outcomes.get(recordKey(r)))), refs: [...refs, ...cov.refs], excluded: m.excluded, coverage: cov.facts };
  }
}

/** A record with its coverage outcome and the CRAP it implies: measured, or not run with a reason and the upper bound (design-code-quality-metrics.md §2.3, §2.4). */
export function withOutcome(r: MetricsRecord, outcome: Outcome | undefined): MetricsRecord {
  if (r.test) return r;
  if (outcome === undefined) return { ...r, coverage: { source: "unknown", reason: "not run" }, crap: crapRounded(r.complexity, undefined) };
  if ("reason" in outcome) return { ...r, coverage: { source: "unknown", reason: reasonText(outcome.reason) }, crap: crapRounded(r.complexity, undefined) };
  return withCoverage(r, outcome);
}

/** A record whose coverage was not measured, with the reason and the upper-bound CRAP. */
export function withUnknownCoverage(r: MetricsRecord, reason: string): MetricsRecord {
  return withOutcome(r, { reason });
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

const shortImage = (image: string): string => image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]*$/, "@sha256:$1…");

/** A failing entry as a name: `--- FAIL: TestX (0.01s)` is `TestX`; a Ginkgo `[FAIL] spec` and a `FAIL pkg` line stay as written. */
function failingName(entry: string): string {
  const go = /^--- FAIL: (\S+)/.exec(entry);
  if (go !== null) return go[1]!;
  const pkg = /^FAIL (\S+)/.exec(entry);
  return pkg !== null ? `package ${pkg[1]!}` : entry.replace(/^\[FAIL\]\s*/, "");
}

/** A package whose test binary hit `go test -timeout`: `package <pkg> (timed out after 10m0s; running tests: TestA, TestB)`. */
function timeoutName(t: { package: string; after: string; tests: string[] }): string {
  const running = t.tests.length > 0 ? `; running tests: ${t.tests.join(", ")}` : "";
  return `package ${t.package} (timed out after ${t.after}${running})`;
}

/** What a non-zero test command says: the failing tests when the report names them, else the generic sentence; the first build error either way. */
function failureSentence(run: CoverageRunFacts): string {
  const timedOut = new Map((run.timedOut ?? []).map((t) => [`package ${t.package}`, t]));
  const named = (run.failing ?? []).map(failingName).map((n) => {
    const t = timedOut.get(n);
    if (t === undefined) return n;
    timedOut.delete(n);
    return timeoutName(t);
  });
  const names = [...new Set([...named, ...[...timedOut.values()].map(timeoutName)])];
  const build = run.buildError !== undefined ? `; first build error: ${run.buildError}` : "";
  if (names.length > 0) return `the test command exited ${run.exit}; failing: ${names.join("; ")} (coverage is of what ran)${build}`;
  return `the test command exited ${run.exit} (a test failed or a package did not build: coverage is of what ran)${build}`;
}

/** What the Coverage run did, in a sentence per language. */
export function coverageNotes(facts: CoverageFacts): string[] {
  if (!facts.enabled) return ["Coverage: not run (coverage disabled by the profile); CRAP is shown as its upper bound."];
  if (facts.runs.length === 0) return ["Coverage: no function needed a run."];
  return facts.runs.map((run) => {
    if (!run.ran) return `Coverage (${run.language}): not run (${run.reason ?? "no reason recorded"}).`;
    const timeout = run.timeoutSeconds !== undefined ? `, -timeout=${run.timeoutSeconds}s from the start of the run (the sandbox's wall clock less a margin for setup and profile collection)` : "";
    const label = run.ginkgoLabelFilter !== undefined ? `, the packages whose tests use Ginkgo run with -ginkgo.label-filter=${JSON.stringify(run.ginkgoLabelFilter)} (the repository's own CI filter; plain test packages without it)` : "";
    const how = run.language === "go" ? `go test -coverprofile -covermode=set over the touched packages${timeout}${label}` : "the repository's own vitest run with @vitest/coverage-v8 over the touched workspace";
    const exit = run.exit === undefined ? "" : run.exit === 0 ? "; the tests passed" : `; ${failureSentence(run)}`;
    const changed = run.changed.length > 0 ? `; the run changed ${run.changed.length} file(s) in its checkout (${run.changed.slice(0, 3).join(", ")}): the checks must not change files` : "";
    const setup = run.setup !== undefined && run.setup.length > 0 ? `, after the profile's sandboxed setup (${run.setup.join(", ")}: code the repository does not commit, generated from read-only tools and caches, in the same sandbox)` : "";
    return `Coverage (${run.language}): measured with ${how}, in the Docker sandbox (image ${shortImage(run.image ?? "")}, no network, read-only dependency caches) over a prepared checkout of the head${setup}, statement coverage by function line range${exit}${changed}.`;
  });
}

/** The Measurements part of `review.md` (design §6.8): facts only, built from the records. */
export function renderMeasurements(state: MeasurementState, profile: Pick<Profile, "metrics">): string {
  const reasons = notRunReasons(profile);
  const lines = ["# Measurements", ""];
  if (state.state === "none") {
    lines.push(`No function is measured: ${state.reason}.`, "");
    return lines.join("\n");
  }
  if (state.state !== "ready") {
    lines.push("Not measured: the static metrics did not complete.", "");
    return lines.join("\n");
  }
  lines.push(
    "Static metrics (gometrics, tsmetrics): parsed over the head tree, read-only, no network; none of the pull request's code ran for them. A modified function also shows its value at the base (`base → head`), measured by the same tool over the base file, so a value the base already had is not read as the pull request's.",
    ...coverageNotes(state.coverage),
    `Mutation: ${reasons.mutation}.`,
    "",
    `| Function | Change | Complexity (limit < ${LIMITS.complexity}) | Nesting (limit ≤ ${LIMITS.nesting}) | Coverage | CRAP (threshold ${LIMITS.crap}) | Mutation |`,
    "|---|---|---|---|---|---|---|",
  );
  if (state.records.length === 0) lines.push("| (no function added or modified) | | | | | | |");
  for (const r of state.records) {
    // A modified function shows base → head, and says whether an over-the-limit value was already there (design §6.8).
    const over = (metric: Metric, limit: number): string => {
      const o = originOf(r, metric);
      const head = r[metric];
      if (r.change === "added") return exceeds(metric, head) ? `${head} (over the limit of ${limit})` : String(head);
      if (o.origin === "unknown") return `${head}${exceeds(metric, head) ? ` (over the limit of ${limit})` : ""} (base not measured: ${r.base !== undefined && "unavailable" in r.base ? r.base.unavailable : "not recorded"})`;
      const arrow = `${o.base} → ${head}`;
      if (o.origin === "within") return arrow;
      if (o.origin === "introduced") return `${arrow} (over the limit of ${limit}: introduced by the pull request)`;
      return `${arrow} (over the limit of ${limit} at the base${o.origin === "worse" ? "; made worse" : "; not raised"})`;
    };
    const test = r.test || isTestPath(r.path);
    const measured = r.coverage?.source === "measured" ? r.coverage : undefined;
    const coverage = test
      ? "n/a (test file)"
      : measured !== undefined
        ? measured.total === 0
          ? "100% (no executable statements)"
          : `${Math.round((measured.covered / measured.total) * 1000) / 10}% (${measured.covered}/${measured.total} statements, measured)`
        : `unknown: ${r.coverage?.source === "unknown" ? r.coverage.reason : "not run"}`;
    const crap =
      test || r.crap === undefined
        ? "n/a"
        : measured !== undefined
          ? `${r.crap}${r.crap >= LIMITS.crap ? ` (at or over the threshold of ${LIMITS.crap})` : ""}`
          : `${r.crap} (upper bound, coverage unknown)`;
    const mutation = test ? "n/a (test file)" : measured !== undefined ? reasons.mutation : "not run: no coverage";
    lines.push(
      `| ${cell(`\`${r.function}\` ${r.path}:${r.startLine}`)} | ${r.change} | ${over("complexity", LIMITS.complexity)} | ${over("nesting", LIMITS.nesting)} | ${cell(coverage)} | ${cell(crap)} | ${cell(mutation)} |`,
    );
  }
  for (const e of state.excluded) lines.push("", `Not measured: ${e.path} (${e.reason}).`);
  lines.push("");
  return lines.join("\n");
}

export { SCHEMA as METRICS_SCHEMA };
