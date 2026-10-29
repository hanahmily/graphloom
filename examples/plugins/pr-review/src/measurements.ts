// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Measurements (design §6.8, design-code-quality-metrics.md §4, §5), the
 * static part: `gometrics` and `tsmetrics` run under bwrap with no network
 * over the head tree and execute none of it, then the `graphloom-metrics-v1`
 * documents are recomputed from the head file bytes (`validateMetricsDocument`)
 * before any value reaches the report. Coverage and mutation run PR code and
 * so belong in the Docker sandbox, which a later version brings; until then
 * every record says so, honestly, and CRAP is its upper bound (§2.4).
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { commandRuns, describeCommand, latestFile, outputTail, reportText, succeeded, type CommandRun } from "./evidence.js";
import { crapRounded, LIMITS } from "./metrics/crap.js";
import { matchesGeneratedGlob } from "./metrics/generated.js";
import { formatHunkFile, hunksFromUnifiedDiff } from "./metrics/hunks.js";
import { isTestPath, languageOf, SCHEMA, type Hunks, type Language, type MetricsDocument, type MetricsRecord } from "./metrics/record.js";
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
function observable(p: string): boolean {
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

/** `git diff -U0 -w` of the worktree against the pinned base: the head-side hunks, whitespace-only edits excluded (§5.1). */
export const METRICS_DIFF_ARGV = ["env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "git", "-c", "core.hooksPath=/dev/null", "diff", "-U0", "-w", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--"];
export const metricsDiffCommand = (): EnvironmentCommand => ({ id: COMMAND.metricsDiff, argv: [...METRICS_DIFF_ARGV] });

const STATIC_SCRIPT =
  'set -eu; n="$1"; shift; h=""; while [ "$n" -gt 0 ]; do h="$h$1"; shift; n=$((n - 1)); done; kind="$1"; root="$2"; gen="$3"; node="$4"; wt=$(pwd -P); ' +
  'if [ "$kind" = go ]; then printf \'%s\' "$h" | { cd "$root/tools/gometrics" && GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0 go run . --head "$wt" --hunks - --generated "$gen"; } > "$GRAPHLOOM_REPORT_FILE"; ' +
  'else printf \'%s\' "$h" | "$node" "$root/dist/metrics/tsmetrics-cli.js" --head "$wt" --hunks - --generated "$gen" > "$GRAPHLOOM_REPORT_FILE"; fi';

/** The command that measures one batch: its hunks travel in the argv, so the recorded bytes are the bytes measured. */
export function staticCommand(batch: Batch, hunks: Hunks, pluginRoot: string, generated: readonly string[], nodeBin: string): EnvironmentCommand {
  const subset: Hunks = new Map(batch.paths.flatMap((p) => (hunks.has(p) ? [[p, hunks.get(p)!] as const] : [])));
  const parts = writeChunks(formatHunkFile(subset));
  return { id: batch.id, argv: ["sh", "-c", STATIC_SCRIPT, batch.id, String(parts.length), ...parts, batch.language === "go" ? "go" : "ts", pluginRoot, generated.join(","), nodeBin] };
}

/** The hunk text a static command measured, read back from its argv. */
export function measuredHunks(argv: readonly string[]): string | undefined {
  const n = Number(argv[4]);
  if (argv[3] === undefined || !Number.isSafeInteger(n) || n < 0) return undefined;
  return argv.slice(5, 5 + n).join("");
}

export type MeasurementState =
  | { state: "none"; reason: string }
  | { state: "observe"; paths: string[] }
  | { state: "diff" }
  | { state: "tools"; batches: Batch[]; hunks: Hunks }
  | { state: "failed"; problems: string[]; refs: string[]; retry: Batch[] }
  | { state: "ready"; records: MetricsRecord[]; refs: string[]; excluded: Measurable["excluded"] };

export interface Reasons {
  coverage: string;
  mutation: string;
}

/** Why coverage and mutation did not run, in the words a record carries. */
export function notRunReasons(profile: Pick<Profile, "metrics">): Reasons {
  return {
    coverage: profile.metrics.coverage ? "not run (coverage arrives in a later wave)" : "not run (coverage disabled by the profile)",
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
export function measurementState(evidence: readonly EvidenceRecord[], files: readonly PullFile[], profile: Pick<Profile, "metrics">): MeasurementState {
  const m = measurable(files, profile);
  if (m.files.length === 0) return { state: "none", reason: "no changed file is in a measured language" };
  const unread = m.files.filter((f) => latestFile(evidence, f.path) === undefined).map((f) => f.path);
  if (unread.length > 0) return { state: "observe", paths: unread };
  const diff = diffRun(evidence);
  if (diff === undefined) return { state: "diff" };
  if (!succeeded(diff.command)) return { state: "failed", problems: [`${describeCommand(diff.command)}: ${outputTail(diff.command)}`], refs: [diff.record.ref], retry: [] };
  const text = reportText(diff);
  if (text.truncated || Buffer.byteLength(text.text, "utf8") > MAX_DIFF_BYTES) {
    return { state: "failed", problems: [`the changed lines (git diff -U0) did not fit the ${MAX_DIFF_BYTES}-byte report whole`], refs: [diff.record.ref], retry: [] };
  }
  const all = hunksFromUnifiedDiff(text.text);
  const wanted = new Set(m.files.map((f) => f.path));
  const hunks: Hunks = new Map([...all].filter(([p]) => wanted.has(p)));
  const batches = batchesOf(m);
  const runs = latestRuns(evidence, batches);
  if (batches.some((b) => !runs.has(b.id))) return { state: "tools", batches: batches.filter((b) => !runs.has(b.id)), hunks };
  const problems: string[] = [];
  const refs = [diff.record.ref];
  const retry: Batch[] = [];
  const records: MetricsRecord[] = [];
  const covered = new Set<string>();
  for (const b of batches) {
    const run = runs.get(b.id)!;
    refs.push(run.record.ref);
    if (!succeeded(run.command)) {
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
    for (const f of document.files) covered.add(f.path);
    for (const s of document.skipped) covered.add(s.path);
    records.push(...document.records);
  }
  if (problems.length > 0) return { state: "failed", problems, refs, retry };
  const missing = m.files.map((f) => f.path).filter((p) => !covered.has(p) && hunks.has(p));
  if (missing.length > 0) return { state: "failed", problems: [`the tools accounted for none of: ${missing.slice(0, 5).join(", ")}`], refs, retry: [] };
  return { state: "ready", records: records.map((r) => withUnknownCoverage(r, profile)), refs, excluded: m.excluded };
}

/** A record with the not-run coverage and its upper-bound CRAP (design-code-quality-metrics.md §2.3, §2.4). */
export function withUnknownCoverage(r: MetricsRecord, profile: Pick<Profile, "metrics">): MetricsRecord {
  if (r.test) return r;
  const { coverage } = notRunReasons(profile);
  return { ...r, coverage: { source: "unknown", reason: coverage }, crap: crapRounded(r.complexity, undefined) };
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

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
    `Static metrics (gometrics, tsmetrics): parsed over the head tree, read-only, no network; no PR code ran. Coverage: ${reasons.coverage}. Mutation: ${reasons.mutation}.`,
    "",
    `| Function | Change | Complexity (limit < ${LIMITS.complexity}) | Nesting (limit ≤ ${LIMITS.nesting}) | Coverage | CRAP (threshold ${LIMITS.crap}) | Mutation |`,
    "|---|---|---|---|---|---|---|",
  );
  if (state.records.length === 0) lines.push("| (no function added or modified) | | | | | | |");
  for (const r of state.records) {
    const over = (value: number, exceeded: boolean, limit: number): string => (exceeded ? `${value} (over the limit of ${limit})` : String(value));
    const test = r.test || isTestPath(r.path);
    const coverage = test ? "n/a (test file)" : `unknown: ${reasons.coverage}`;
    const crap = test || r.crap === undefined ? "n/a" : `${r.crap} (upper bound, coverage unknown)`;
    const mutation = test ? "n/a (test file)" : "not run: no coverage";
    lines.push(
      `| ${cell(`\`${r.function}\` ${r.path}:${r.startLine}`)} | ${r.change} | ${over(r.complexity, r.complexity >= LIMITS.complexity, LIMITS.complexity)} | ${over(r.nesting, r.nesting > LIMITS.nesting, LIMITS.nesting)} | ${cell(coverage)} | ${cell(crap)} | ${cell(mutation)} |`,
    );
  }
  for (const e of state.excluded) lines.push("", `Not measured: ${e.path} (${e.reason}).`);
  lines.push("");
  return lines.join("\n");
}

export { SCHEMA as METRICS_SCHEMA };
