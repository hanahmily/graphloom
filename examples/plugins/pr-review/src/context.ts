// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The context source of round 2 (design-pr-review-split §4.2): what the reviewers start from. Plugin code decides it, from what
 * Fetch recorded and the task's pinned request, and the first that applies is taken:
 *
 * 1. `design-review`: the ledger's `design` section holds the report of a design head D (`report.json`, `qa.json`, `necessity.json`
 *    of the latest design head), of one mode with this head; when D is another head, the delta from D to this head is usable by the
 *    rules of design §9.2 items 2 and 3 (D's commit and base are in the review clone, the diff is complete and fits). A round-1 report
 *    with open items is used all the same: round 2 does not gate on round 1.
 * 2. `prelude`: a report-only prelude (the Report stage's reporter, diagrams and claim check, no question).
 * 3. `none`: only when the request says `, without a report` (`task new pr-review … --no-report`), in place of the prelude.
 *
 * This module is pure over the evidence, so the graph and the validators decide the same: the reads of the design section's files
 * (the `ledger-prior` part reads of design §9.2), the delta, the decision, the `context.json` record (`pr-review-context-v1`) and
 * the seed `review.md` the reviewers read when the source is not the prelude. It also reads round 1's status on the pull request
 * from the design section, which the posted review lists and counts (§4.5).
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { checkLines, featureLines, type FinalBriefing } from "./kit/briefing.js";
import { COMMAND } from "./kit/constants.js";
import { commandRuns, describeCommand, isObject, reportText, succeeded, type CommandRun } from "./kit/evidence.js";
import { clip } from "./kit/escape.js";
import { renderMeasurements, type MeasurementState } from "./kit/measurements.js";
import { OPEN_PENDING, QA_PENDING, VERDICT_PENDING } from "./kit/output.js";
import { sha256 } from "./kit/parts.js";
import type { Profile } from "./kit/profile.js";
import { pullText } from "./kit/prompts.js";
import { purposeLine, type FinalSummary, type RemovedPart } from "./kit/report.js";
import type { PullRequest } from "./kit/request.js";
import { isDeleted, type PullFile, type Snapshot } from "./kit/snapshot.js";

export const CONTEXT_SCHEMA = "pr-review-context-v1";
export const CONTEXT_SOURCES = ["design-review", "prelude", "none"] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/** The last line the head-delta command prints: its absence means the output was cut. */
export const DELTA_END = "graphloom-delta-end";
/** The most files one delta read names; past it the design head's report is not used. */
export const MAX_DELTA_FILES = 2_000;
/** The most parts of a design section file one run reads (30,000 characters each). */
export const MAX_PRIOR_PARTS = 64;
const PART_CHARS = 30_000;
const PARTS_PER_JOB = 16;

// ---- the head delta (design §9.2) ----

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface FileDelta {
  whole: boolean;
  hunks: Hunk[];
}

export type HeadDelta = ReadonlyMap<string, FileDelta>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The files and hunks of a head-delta command's output, or the problem that makes it unusable. */
export function parseHeadDelta(text: string): HeadDelta | { problem: string } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const end = lines.lastIndexOf(DELTA_END);
  if (end < 0) return { problem: "the delta output was cut before its end" };
  const files = new Map<string, FileDelta>();
  let cur: FileDelta | undefined;
  for (const line of lines.slice(0, end)) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      if (rest.startsWith('"')) return { problem: "the delta names a path git quoted" };
      // `a/<path> b/<path>` with no renames: both halves are the same.
      const half = (rest.length - 5) / 2;
      const path = rest.slice(2, 2 + half);
      if (!Number.isInteger(half) || half < 1 || rest !== `a/${path} b/${path}`) return { problem: `the delta has a file header it cannot read: ${rest.slice(0, 80)}` };
      cur = { whole: true, hunks: [] };
      files.set(path, cur);
      continue;
    }
    const m = HUNK.exec(line);
    if (m === null) continue;
    if (cur === undefined) return { problem: "the delta has a hunk before any file" };
    cur.whole = false;
    cur.hunks.push({ oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return files;
}

/** The most characters the path list may take: one argument of a command (64 arguments of 4,096 characters each). */
export const MAX_PATH_LIST_CHARS = 4_000;

/** The path list as the one argument the commands take, or undefined when it cannot be passed (too long, or a path with a newline). */
export const pathList = (paths: readonly string[]): string | undefined => {
  const joined = paths.join("\n");
  return joined.length <= MAX_PATH_LIST_CHARS && !paths.some((p) => p.includes("\n") || p === "") ? joined : undefined;
};

// The output goes to the report file (the stdout tail holds only 8,192 bytes): a file the command executor cuts to its tail says so
// (`truncated`), and a cut delta is never read, for the files it dropped would look unchanged.
const HEAD_DELTA =
  'set -eu; l="$1"; h="$2"; list="$3"; git -c core.hooksPath=/dev/null cat-file -e "$l^{commit}"; ' +
  '{ if [ -n "$list" ]; then IFS=\'\n\'; set -f; set -- $list; unset IFS; out=$(GIT_LITERAL_PATHSPECS=1 git -c core.hooksPath=/dev/null -c core.quotePath=false diff -U0 --no-color --no-ext-diff --no-textconv --no-renames "$l" "$h" -- "$@"); ' +
  "printf '%s\\n' \"$out\" | grep -E '^(diff --git |@@ )' || true; fi; " +
  `echo ${DELTA_END}; } > "$GRAPHLOOM_REPORT_FILE"`;

/** The hunks between D and H over `paths` (one newline-joined argument), reduced to file and hunk headers (design §9.2). No repository code runs. */
export const headDeltaCommand = (d: string, h: string, paths: readonly string[]): EnvironmentCommand => ({ id: COMMAND.delta, argv: ["sh", "-c", HEAD_DELTA, COMMAND.delta, d, h, pathList(paths) ?? ""] });

/** Whether the design head's base commit is in the review clone (design §9.2 item 3). */
export const designBaseCommand = (base: string): EnvironmentCommand => ({ id: COMMAND.designBase, argv: ["sh", "-c", 'set -eu; git -c core.hooksPath=/dev/null cat-file -e "$1^{commit}"; echo present', COMMAND.designBase, base] });

// ---- the design section's files ----

/** Prints part `k` of a file of the ledger commit as ASCII-only text, with a header the reader joins and checks (the shape `ledger-prior` uses). */
const FILE_EXTRACT = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const r=s.replace(/[\u007f-￿]/g,(m)=>"\\u"+m.charCodeAt(0).toString(16).padStart(4,"0"));
const n=Math.max(1,Math.ceil(r.length/${PART_CHARS}));const k=Number(process.argv[1]);
const h=require("crypto").createHash("sha256").update(r).digest("hex");
process.stdout.write("graphloom-prior "+k+" "+n+" "+h+"\n"+r.slice(k*${PART_CHARS},(k+1)*${PART_CHARS}))})`;

const FILE_SHOW =
  'set -eu; if ! git -c core.hooksPath=/dev/null cat-file -e "$1:$5" 2>/dev/null; then echo graphloom-prior-absent > "$GRAPHLOOM_REPORT_FILE"; exit 0; fi; ' +
  'j=$(git -c core.hooksPath=/dev/null show "$1:$5"); printf \'%s\' "$j" | "$2" -e "$3" "$4" > "$GRAPHLOOM_REPORT_FILE"';

export type DesignFile = "report" | "qa" | "necessity";
const FILE_NAME: Record<DesignFile, string> = { report: "report.json", qa: "qa.json", necessity: "necessity.json" };
const FILE_ID: Record<DesignFile, string> = { report: COMMAND.ledgerPriorReport, qa: COMMAND.ledgerPriorQa, necessity: COMMAND.ledgerPriorNecessity };

/** Part `k` of a design file as the ledger commit `old` holds it (under `dir`: `design/` in a v2 ledger, the top in a v1 one). */
export const designFileCommand = (file: DesignFile, old: string, node: string, k: number, dir = ""): EnvironmentCommand => ({
  id: k === 0 ? FILE_ID[file] : `${FILE_ID[file]}-${k}`,
  argv: ["sh", "-c", FILE_SHOW, FILE_ID[file], old, node, FILE_EXTRACT, String(k), `${dir}${FILE_NAME[file]}`],
});

/** What part `k` of `text` prints, as `designFileCommand` does: for the stand-ins of a rehearsal and for tests. */
export function designFileText(text: string, k: number): string {
  const ascii = text.replace(/[\u007f-￿]/g, (m) => `\\u${m.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const n = Math.max(1, Math.ceil(ascii.length / PART_CHARS));
  return `graphloom-prior ${k} ${n} ${sha256(ascii)}\n${ascii.slice(k * PART_CHARS, (k + 1) * PART_CHARS)}`;
}

type FileRead = { state: "missing"; next: EnvironmentCommand[] } | { state: "absent" } | { state: "read"; text: string } | { state: "unreadable"; reason: string };

/** The file as the part commands read it from the ledger commit `old`: absent, still to read, whole, or not readable. */
function designFile(evidence: readonly EvidenceRecord[], file: DesignFile, old: string, node: string, dir: string): FileRead {
  const id = FILE_ID[file];
  const runs = commandRuns(evidence).filter((r) => r.command.argv[3] === id && r.command.argv[4] === old && r.command.argv[8] === `${dir}${FILE_NAME[file]}`);
  const part = (k: number): CommandRun | undefined => runs.filter((r) => r.command.argv[7] === String(k)).at(-1);
  const first = part(0);
  if (first === undefined) return { state: "missing", next: [designFileCommand(file, old, node, 0, dir)] };
  const text = (run: CommandRun): { text: string } | { problem: string } => {
    if (!succeeded(run.command)) return { problem: `reading ${FILE_NAME[file]} ended: ${describeCommand(run.command)}` };
    const report = reportText(run);
    return report.truncated ? { problem: `a part of ${FILE_NAME[file]} did not fit the command report` } : { text: report.text };
  };
  const head = text(first);
  if ("problem" in head) return { state: "unreadable", reason: head.problem };
  if (head.text.trim() === "graphloom-prior-absent") return { state: "absent" };
  const split = (t: string): { k: number; n: number; digest: string; body: string } | undefined => {
    const m = /^graphloom-prior (\d+) (\d+) ([0-9a-f]{64})\n/.exec(t);
    return m === null ? undefined : { k: Number(m[1]), n: Number(m[2]), digest: m[3]!, body: t.slice(m[0].length) };
  };
  const h = split(head.text);
  if (h === undefined || h.k !== 0 || h.n < 1) return { state: "unreadable", reason: `the first part of ${FILE_NAME[file]} carries no header` };
  if (h.n > MAX_PRIOR_PARTS) return { state: "unreadable", reason: `${FILE_NAME[file]} is ${h.n} parts, more than the ${MAX_PRIOR_PARTS} one run reads` };
  const bodies = [h.body];
  const missing: EnvironmentCommand[] = [];
  for (let k = 1; k < h.n; k += 1) {
    const run = part(k);
    if (run === undefined) {
      missing.push(designFileCommand(file, old, node, k, dir));
      continue;
    }
    const t = text(run);
    if ("problem" in t) return { state: "unreadable", reason: t.problem };
    const p = split(t.text);
    if (p === undefined || p.k !== k || p.n !== h.n || p.digest !== h.digest) return { state: "unreadable", reason: `part ${k} of ${FILE_NAME[file]} is not of the same read` };
    bodies[k] = p.body;
  }
  if (missing.length > 0) return { state: "missing", next: missing.slice(0, PARTS_PER_JOB) };
  const whole = bodies.join("");
  if (sha256(whole) !== h.digest) return { state: "unreadable", reason: `the parts of ${FILE_NAME[file]} do not match their digest` };
  return { state: "read", text: whole };
}

// ---- the design section ----

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A head of the design section, as pr-review reads it. */
export interface DesignHead {
  sha: string;
  base?: string;
  /** Round 1's outcome on the head, set when the design review recorded it (its Publish stage). */
  round1?: "clean" | "items";
  open?: number;
}

/** The design section's heads, oldest first. */
export function designHeads(design: unknown): DesignHead[] {
  if (!isObject(design) || !Array.isArray(design.heads)) return [];
  return design.heads.filter(isObject).flatMap((h) => {
    const sha = str(h.sha);
    if (sha === undefined) return [];
    return [{ sha, ...(str(h.base) !== undefined ? { base: str(h.base)! } : {}), ...(h.round1 === "clean" || h.round1 === "items" ? { round1: h.round1 } : {}), ...(typeof h.open === "number" ? { open: h.open } : {}) }];
  });
}

/** What the design head's report, Q&A and necessity record are, read whole from the ledger. */
export interface DesignRecords {
  /** D: the design head the records are of. */
  head: string;
  /** D's pinned base. */
  base?: string;
  mode: string;
  reportJson: string;
  qaJson: string;
  necessityJson: string;
}

export type DesignReads =
  /** No design report is usable as the context, and why (the next source applies). */
  | { state: "unusable"; reason: string }
  | { state: "run"; commands: EnvironmentCommand[]; why: string }
  /** The records of D, and the delta from D to this head when D is another head. */
  | { state: "usable"; records: DesignRecords; delta?: HeadDelta };

export interface DesignReadInput {
  /** The ledger commit Fetch read, when there is one. */
  ledger: string | undefined;
  /** The design section as Fetch read it (a v1 ledger's migrated one), absent when the section is. */
  design: unknown;
  /** Where the ledger commit keeps the design head's files: `design/` in a v2 ledger, the top level in a v1 one. */
  dir: string;
  head: string;
  /** The files this head's change touches. */
  files: readonly string[];
  /** This head's pinned base. */
  base: string | undefined;
  /** This head's mode, standard or large. */
  mode: string;
  node: string;
}

/** The head-side paths a report cites (its items and its briefing), which the delta from D must cover. */
function citedHeadPaths(report: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (c: unknown): void => {
    if (isObject(c) && typeof c.path === "string" && c.path !== "" && c.side !== "base") out.add(c.path);
  };
  for (const s of Array.isArray(report.sections) ? report.sections : []) if (isObject(s)) for (const i of Array.isArray(s.items) ? s.items : []) if (isObject(i)) for (const c of Array.isArray(i.cites) ? i.cites : []) add(c);
  const b = isObject(report.briefing) ? report.briefing : {};
  for (const w of Array.isArray(b.whatsNew) ? b.whatsNew : []) if (isObject(w)) for (const c of Array.isArray(w.cites) ? w.cites : []) add(c);
  const check = isObject(b.check) ? b.check : {};
  for (const list of Object.values(check)) for (const x of Array.isArray(list) ? list : []) if (isObject(x)) for (const c of Array.isArray(x.cites) ? x.cites : []) add(c);
  return [...out].sort();
}

const parsed = (text: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Where reading the design head's report stands (design-pr-review-split §4.2, design §9.2 items 2 and 3): commands still to run,
 * the records (and the delta from D when D is another head), or the reason they are not usable. A read that cannot be made is
 * never a stop: the context is then the next source, with the reason recorded.
 */
export function designReads(evidence: readonly EvidenceRecord[], i: DesignReadInput): DesignReads {
  if (i.ledger === undefined) return { state: "unusable", reason: "the pull request has no ledger: the design review has not run on it" };
  const heads = designHeads(i.design);
  const last = heads.at(-1);
  if (last === undefined) return { state: "unusable", reason: "the ledger's design section holds no head: the design review has not run on this pull request" };
  const d = last.sha;
  const read = (file: DesignFile): { text: string } | { reason: string } | { run: DesignReads & { state: "run" } } => {
    const r = designFile(evidence, file, i.ledger!, i.node, i.dir);
    if (r.state === "missing") return { run: { state: "run", commands: r.next, why: `read the design review's ${FILE_NAME[file]} of ${d.slice(0, 12)} from the ledger, the context of round 2` } };
    if (r.state === "absent") return { reason: `the design section holds no ${FILE_NAME[file]}` };
    if (r.state === "unreadable") return { reason: `the design section's ${FILE_NAME[file]} cannot be read (${r.reason})` };
    return { text: r.text };
  };
  const files: Partial<Record<DesignFile, string>> = {};
  for (const f of ["report", "qa", "necessity"] as const) {
    const r = read(f);
    if ("run" in r) return r.run;
    if ("reason" in r) return { state: "unusable", reason: r.reason };
    files[f] = r.text;
  }
  const report = parsed(files.report!);
  const pull = report !== undefined && isObject(report.pull) ? report.pull : undefined;
  if (report === undefined || report.schema !== "pr-change-report-v1" || pull === undefined || !Array.isArray(report.sections)) return { state: "unusable", reason: "the design section's report.json is not a change report" };
  if (pull.head !== d) return { state: "unusable", reason: `the design section's report.json is not of its latest head ${d.slice(0, 12)}` };
  const qa = parsed(files.qa!);
  if (qa === undefined || qa.schema !== "pr-qa-v1" || qa.roundsSkipped !== undefined || !isObject(qa.pull) || !Array.isArray(qa.questions)) return { state: "unusable", reason: "the design section's qa.json is not the Q&A of a head (it is skipped or not a Q&A file)" };
  if (qa.pull.head !== d) return { state: "unusable", reason: `the design section's qa.json is not of its latest head ${d.slice(0, 12)}` };
  const nec = parsed(files.necessity!);
  if (nec === undefined || nec.schema !== "pr-necessity-v1") return { state: "unusable", reason: "the design section's necessity.json is not a necessity record" };
  const mode = str(report.mode) ?? "standard";
  if (mode !== i.mode) return { state: "unusable", reason: `the design review's report of ${d.slice(0, 12)} is ${mode} and this head is ${i.mode}: they are not of one mode` };
  const base = str(pull.base);
  const records: DesignRecords = { head: d, ...(base !== undefined ? { base } : {}), mode, reportJson: files.report!, qaJson: files.qa!, necessityJson: files.necessity! };
  if (d === i.head) return { state: "usable", records };
  // D is another head: its report is used when the delta from D to this head is usable (design §9.2 items 2 and 3).
  if (base === undefined) return { state: "unusable", reason: `the design head ${d.slice(0, 12)}'s base is not recorded` };
  if (i.base === undefined) return { state: "unusable", reason: "this head's base is not recorded" };
  const paths = [...new Set([...i.files, ...citedHeadPaths(report)])].sort();
  if (paths.length > MAX_DELTA_FILES) return { state: "unusable", reason: `the delta from ${d.slice(0, 12)} would name ${paths.length} files, more than the ${MAX_DELTA_FILES} one read takes` };
  if (pathList(paths) === undefined) return { state: "unusable", reason: `the delta's ${paths.length} file paths do not fit the one argument a command takes (${MAX_PATH_LIST_CHARS} characters)` };
  const want = headDeltaCommand(d, i.head, paths);
  const run = commandRuns(evidence, COMMAND.delta).filter((r) => sameArgv(r.command.argv, want.argv)).at(-1);
  if (run === undefined) return { state: "run", commands: [want, ...(base !== i.base ? [designBaseCommand(base)] : [])], why: `read the delta from the design head ${d.slice(0, 12)} to this head, as file and hunk headers, and whether its base is in the review clone` };
  if (!succeeded(run.command)) return { state: "unusable", reason: `the delta from the design head ${d.slice(0, 12)} could not be read (${describeCommand(run.command)}: its commit or objects are not in the review clone)` };
  const text = reportText(run);
  if (text.truncated) return { state: "unusable", reason: "the delta from the design head did not fit one command report" };
  const delta = parseHeadDelta(text.text);
  if ("problem" in delta) return { state: "unusable", reason: `the delta from the design head cannot be read: ${delta.problem}` };
  if (base !== i.base) {
    const check = designBaseCommand(base);
    const b = commandRuns(evidence, COMMAND.designBase).filter((r) => sameArgv(r.command.argv, check.argv)).at(-1);
    if (b === undefined) return { state: "run", commands: [check], why: `check that the design head's base ${base.slice(0, 12)} is in the review clone` };
    if (!succeeded(b.command)) return { state: "unusable", reason: `the design head's base ${base.slice(0, 12)} is not in the review clone` };
  }
  return { state: "usable", records, delta };
}

// ---- the context record ----

export interface ContextRecord {
  schema: typeof CONTEXT_SCHEMA;
  source: ContextSource;
  /** `design-review`: the design head D whose report is the context, and its base. */
  head?: string;
  base?: string;
  /** `design-review` with D another head: the files the delta from D to this head changed, with their hunks. */
  delta?: Array<{ path: string; whole: boolean; hunks: Hunk[] }>;
  /** Why the sources before the one taken were not (the design head's report not usable, the operator's `--no-report`). */
  reasons: string[];
  /** The task's request says `, without a report` (`--no-report`). */
  noReport: boolean;
}

/** The context source, decided from the design reads and the request: the first source that applies (§4.2). */
export function decideContext(reads: Exclude<DesignReads, { state: "run" }>, noReport: boolean): ContextRecord {
  if (reads.state === "usable") {
    const delta = reads.delta === undefined ? undefined : [...reads.delta].map(([path, f]) => ({ path, whole: f.whole, hunks: f.hunks })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { schema: CONTEXT_SCHEMA, source: "design-review", head: reads.records.head, ...(reads.records.base !== undefined ? { base: reads.records.base } : {}), ...(delta !== undefined ? { delta } : {}), reasons: [], noReport };
  }
  if (noReport) return { schema: CONTEXT_SCHEMA, source: "none", reasons: [reads.reason, "the operator asked for no report (--no-report), so no report-only prelude runs"], noReport };
  return { schema: CONTEXT_SCHEMA, source: "prelude", reasons: [reads.reason], noReport };
}

export const contextJson = (r: ContextRecord): string => JSON.stringify(r);

export function parseContextRecord(json: string): ContextRecord | undefined {
  const v = parsed(json);
  if (v === undefined || v.schema !== CONTEXT_SCHEMA || !(CONTEXT_SOURCES as readonly unknown[]).includes(v.source) || !Array.isArray(v.reasons) || typeof v.noReport !== "boolean") return undefined;
  return v as unknown as ContextRecord;
}

/** One line on where the reviewers' context comes from, for the records and the draft. */
export function contextLine(c: { source: ContextSource; head?: string | undefined }, head: string): string {
  if (c.source === "design-review") return c.head === head ? `the design review's report of this head (${head.slice(0, 7)})` : `the design review's report of ${(c.head ?? "").slice(0, 7)}, an earlier head, with the delta to this head`;
  if (c.source === "prelude") return "a report-only prelude of this run (no design review's report was usable)";
  return "no report (--no-report): the pull request's metadata, its file list and the patches in scope";
}

// ---- review.md as the reviewers' seed ----

/** What the briefing says of the verdict when the context has no design review (the prelude, design-pr-review-split §4.1). */
export const NO_DESIGN_LINE = "No design review in this run: round 1 (the design review, pr-design-review) asks the design-level questions, and the review below is round 2 only.";

/**
 * The prelude's `review.md` (design-pr-review-split §4.2 item 2): the report's own, with the briefing's verdict line saying there is
 * no design review in this run, and no open-questions or Q&A part.
 */
export function preludeMarkdown(reportMarkdown: string): string {
  return reportMarkdown
    .replace("Contents: Briefing · Appendix (Report · Measurements · Q&A)", "Contents: Briefing · Appendix (Report · Measurements)")
    .replace("## Necessity and principles\n", "## Design review\n")
    .replace(`${VERDICT_PENDING}\n`, `${NO_DESIGN_LINE}\n`)
    .replace(`## Open questions\n${OPEN_PENDING}\n\n`, "")
    .replace("Every change item with its lifecycles and tables, the full measurements, the claim check's removals and the whole Q&A.", "Every change item with its lifecycles and tables, the full measurements and the claim check's removals.")
    .replace(QA_PENDING, "");
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export const citeText = (c: unknown): string => {
  if (!isObject(c) || typeof c.path !== "string") return "";
  const start = typeof c.start === "number" ? c.start : 0;
  const end = typeof c.end === "number" ? c.end : start;
  // A report cite names its `side`; a Q&A citation its `tree` (base, head or a dependency's source).
  const where = c.side ?? c.tree;
  return `${c.path}${start >= 1 ? (end > start ? `:${start}-${end}` : `:${start}`) : ""}${where === "base" ? " (base)" : where === "dependency" ? " (dependency)" : ""}`;
};

/** The design review's Q&A as the seed lists it: each question with its answer's status, text and citations. */
function qaLines(qa: Record<string, unknown>): string[] {
  const qs = (Array.isArray(qa.questions) ? qa.questions : []).filter(isObject);
  if (qs.length === 0) return ["No question was asked besides N1."];
  return qs.flatMap((q) => {
    const a = isObject(q.answer) ? q.answer : undefined;
    const cites = a !== undefined && Array.isArray(a.citations) ? a.citations.map(citeText).filter((x) => x !== "").slice(0, 8) : [];
    return [
      `- **${String(q.id)} [${String(q.type)}]** ${oneLine(String(q.text ?? ""))}`,
      a === undefined ? "  Not answered." : `  ${String(a.status)}: ${clip(oneLine(String(a.answer ?? "")), 1_200)}${cites.length > 0 ? ` (cites ${cites.join(", ")})` : ""}`,
    ];
  });
}

/** N1 as the seed shows it: its conclusion and its answer's rationale. */
function necessityLines(n: Record<string, unknown>): string[] {
  const a = isObject(n.answer) ? n.answer : {};
  const nec = isObject(a.necessity) ? a.necessity : {};
  return [
    `N1, is the change necessary: **${String(n.conclusion ?? "?")}**${typeof n.conclusionNote === "string" && n.conclusionNote !== "" ? ` (${oneLine(n.conclusionNote)})` : ""}.`,
    ...(typeof nec.rationale === "string" ? [clip(oneLine(nec.rationale), 2_000)] : []),
    ...(typeof a.answer === "string" && a.answer !== nec.rationale ? [clip(oneLine(a.answer), 2_000)] : []),
  ];
}

/** The report's change items as the seed lists them, section by section, with their cites (as of D). */
function itemLines(report: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const s of (Array.isArray(report.sections) ? report.sections : []).filter(isObject)) {
    const items = (Array.isArray(s.items) ? s.items : []).filter(isObject);
    if (items.length === 0 || s.id === "measurements") continue;
    out.push(`## ${String(s.title ?? s.id)}`, ...items.map((i) => `- ${String(i.id)}. ${oneLine(String(i.text ?? ""))} — ${(Array.isArray(i.cites) ? i.cites : []).map(citeText).filter((x) => x !== "").join(", ")}`), "");
  }
  return out.length === 0 ? ["No change item.", ""] : out;
}

/** The "Since this report" part (§4.2): the report and the Q&A describe D, and the files and hunks the delta to this head changed. */
function sinceLines(c: ContextRecord, head: string): string[] {
  if (c.source !== "design-review" || c.head === head) return [];
  const changed = c.delta ?? [];
  return [
    "## Since this report",
    `The design review's report and its questions and answers below describe ${(c.head ?? "").slice(0, 12)}; this head is ${head.slice(0, 12)}. Read the code at this head; where the delta changed a file, its cited lines may have moved or changed.`,
    ...(changed.length === 0 ? ["- The delta changed none of the files this head's change or the report names."] : changed.map((f) => `- ${f.path}: ${f.whole ? "changed whole" : f.hunks.map((h) => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`).join(" ")}`)),
    "",
  ];
}

/** The seed of a `design-review` source (§4.2 item 1): rendered by plugin code from D's three records, with this run's measurements. */
export function designSeedMarkdown(i: { pr: PullRequest; base: string | undefined; context: ContextRecord; records: Pick<DesignRecords, "reportJson" | "qaJson" | "necessityJson">; measurements: MeasurementState; profile: Pick<Profile, "metrics"> }): string {
  const report = parsed(i.records.reportJson) ?? {};
  const qa = parsed(i.records.qaJson) ?? {};
  const nec = parsed(i.records.necessityJson) ?? {};
  const d = i.context.head ?? "";
  const b = (isObject(report.briefing) ? report.briefing : { whatsNew: [], features: [], check: {}, areas: [] }) as unknown as FinalBriefing;
  const summary = (isObject(report.summary) ? report.summary : { purpose: null, overview: "" }) as unknown as FinalSummary;
  const removed = (Array.isArray(report.removedParts) ? report.removedParts : []) as RemovedPart[];
  const whatsNew = (Array.isArray(b.whatsNew) ? b.whatsNew : []).map((w, n) => `- W${n + 1}. ${oneLine(w.text)} — ${w.cites.map(citeText).join(", ")}`);
  return [
    `# ${i.pr.owner}/${i.pr.repo}#${i.pr.number} at ${i.pr.head.slice(0, 12)}${i.base !== undefined ? ` (base ${i.base.slice(0, 12)})` : ""}`,
    "Contents: Context · Briefing (the design review's, as of its head) · Measurements (this run's) · Necessity (N1) · Q&A · Report",
    "",
    "# Context",
    `The context of this review is the design review (round 1, pr-design-review) of ${d === i.pr.head ? "this head" : `head ${d.slice(0, 12)}`}: its report, its necessity answer (N1) and its questions and answers, rendered by plugin code from the ledger's records. The measurements are this run's. Round 2 does not gate on round 1: an open round-1 item is listed in the posted review, not re-checked here.`,
    "",
    ...sinceLines(i.context, i.pr.head),
    "# Briefing",
    purposeLine(summary, removed),
    "",
    "## What's new",
    ...(whatsNew.length === 0 ? ["- None kept by the claim check."] : whatsNew),
    "",
    ...featureLines(b),
    ...checkLines(b),
    renderMeasurements(i.measurements, i.profile),
    "",
    "# Necessity (N1)",
    ...necessityLines(nec),
    "",
    "# Q&A",
    ...qaLines(qa),
    "",
    "# Report",
    ...itemLines(report),
  ].join("\n");
}

/** The most characters of patch text the `none` seed inlines; past it, files are listed with the command that shows their diff. */
export const MAX_SEED_PATCH_CHARS = 400_000;

/** The seed of a `none` source (§4.2 item 3): the pull request's metadata, its file list with the diffstat, and the patches of the files in scope. */
export function noneSeedMarkdown(i: { pr: PullRequest; base: string | undefined; context: ContextRecord; snapshot: Pick<Snapshot, "pull" | "commits" | "files">; scope: readonly string[]; measurements: MeasurementState; profile: Pick<Profile, "metrics"> }): string {
  const inScope = new Set(i.scope);
  const files = i.snapshot.files;
  const added = files.reduce((n, f) => n + f.additions, 0);
  const deleted = files.reduce((n, f) => n + f.deletions, 0);
  const patches: string[] = [];
  const left: PullFile[] = [];
  let used = 0;
  for (const f of files.filter((x) => inScope.has(x.path))) {
    const text = f.patch ?? "";
    if (f.patch === null || used + text.length > MAX_SEED_PATCH_CHARS) {
      left.push(f);
      continue;
    }
    used += text.length;
    patches.push(`## ${f.path}${f.previousPath !== null ? ` (from ${f.previousPath})` : ""} (${f.status ?? "modified"}, +${f.additions} −${f.deletions})`, "```diff", text.replace(/```/g, "` ` `"), "```", "");
  }
  return [
    `# ${i.pr.owner}/${i.pr.repo}#${i.pr.number} at ${i.pr.head.slice(0, 12)}${i.base !== undefined ? ` (base ${i.base.slice(0, 12)})` : ""}`,
    "Contents: Context · The pull request · Files · Measurements (this run's) · Patches",
    "",
    "# Context",
    `There is no report: the operator asked for none (--no-report), and no design review's report is usable (${i.context.reasons[0] ?? "none"}). You have the pull request's own text, its files and their patches; there is no map of the change, so read the code around each change yourself.`,
    "",
    "# The pull request",
    pullText(i.snapshot),
    "",
    "# Files",
    `${files.length} files, +${added} −${deleted}.`,
    ...files.map((f) => `- ${f.path}${f.previousPath !== null ? ` (from ${f.previousPath})` : ""}: ${isDeleted(f) ? "deleted" : f.status ?? "modified"}, +${f.additions} −${f.deletions}${inScope.has(f.path) ? "" : " (not in the review's scope)"}`),
    "",
    renderMeasurements(i.measurements, i.profile),
    "",
    "# Patches of the files in scope",
    ...patches,
    ...(left.length > 0 ? [`Not inlined (${left.length} file${left.length === 1 ? "" : "s"}: no patch from GitHub, or past ${MAX_SEED_PATCH_CHARS} characters of patches): read each with \`git diff ${i.base ?? "<base>"} ${i.pr.head} -- <path>\`.`, ...left.map((f) => `- ${f.path}`), ""] : []),
  ].join("\n");
}

// ---- round 1 on the pull request (§4.5) ----

/** The link to an earlier comment on the pull request, or to the review that holds it. */
export function commentLink(pull: Pick<PullRequest, "owner" | "repo" | "number">, item: { commentId?: number | null; reviewId?: number }): string | undefined {
  const base = `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`;
  if (item.commentId !== undefined && item.commentId !== null) return `${base}#discussion_r${item.commentId}`;
  return item.reviewId !== undefined ? `${base}#pullrequestreview-${item.reviewId}` : undefined;
}

/** Round 1's status as the posted review lists and counts it: the latest design head with a recorded outcome, and its open items. */
export interface Round1Status {
  head: string;
  /** Each open item: its id, its question (since 1.1.2; absent in a draft an earlier version wrote), and its comment's link. */
  open: Array<{ id: string; question?: string; link?: string }>;
}

/** The longest question text a round-1 line carries; a longer one is clipped. */
export const MAX_ROUND1_QUESTION = 200;

const idNumber = (id: string): number => (id === "N1" ? 0 : Number(id.slice(1)) || 0);

/** The questions of a design head's `qa.json` (`pr-qa-v1`), by id; empty when it is not one. */
function qaQuestions(qaJson: string | undefined): Map<string, string> {
  if (qaJson === undefined) return new Map();
  try {
    const v: unknown = JSON.parse(qaJson);
    if (!isObject(v) || !Array.isArray(v.questions)) return new Map();
    return new Map(v.questions.filter(isObject).flatMap((q) => (typeof q.id === "string" && typeof q.text === "string" && q.text.trim() !== "" ? [[q.id, q.text] as [string, string]] : [])));
  } catch {
    return new Map();
  }
}

/** N1's question, which every design review asks. */
const NECESSITY_QUESTION = "Is this change necessary?";

/**
 * An open item's question from its ledger entry, when the design head's Q&A is not read: the first paragraph of its posted text,
 * after the `**<label>** (<id>). ` lead-in round 1 opens it with; N1's is the necessity question.
 */
function itemQuestion(id: string, text: unknown): string | undefined {
  if (id === "N1") return NECESSITY_QUESTION;
  if (typeof text !== "string") return undefined;
  const first = text.split(/\n\s*\n/)[0] ?? "";
  const q = oneLine(first.replace(/^\s*\*\*[^*]*\*\*\s*(?:\([^)]*\)\.?\s*)?/, ""));
  return q === "" ? undefined : q;
}

/**
 * Round 1 on the pull request (design-pr-review-split §4.5), from the design section Fetch read: the latest design head whose outcome
 * the design review recorded, with the round-1 items (`N1`, `Q<n>`) open on it, each with its question and a link to its comment when
 * that run posted it. The question is the one the design head's Q&A record (`qa.json`) holds when `qa` is that head's, else the one
 * the item's posted text opens with. Null when the design section records no outcome: round 1 was not run on this pull request.
 */
export function round1Status(design: unknown, pull: Pick<PullRequest, "owner" | "repo" | "number">, qa?: { head: string; qaJson: string }): Round1Status | null {
  const head = designHeads(design).filter((h) => h.round1 !== undefined).at(-1);
  if (head === undefined) return null;
  const questions = qaQuestions(qa !== undefined && qa.head === head.sha ? qa.qaJson : undefined);
  const items = isObject(design) && Array.isArray(design.items) ? design.items.filter(isObject) : [];
  const open = items
    .filter((x) => typeof x.id === "string" && (x.state === "open" || x.state === undefined) && Array.isArray(x.history) && x.history.some((h) => isObject(h) && h.head === head.sha && h.status === "open"))
    .map((x) => {
      const id = x.id as string;
      const gh = isObject(x.github) ? x.github : {};
      const link = commentLink(pull, { ...(typeof gh.commentId === "number" ? { commentId: gh.commentId } : {}), ...(typeof gh.reviewId === "number" ? { reviewId: gh.reviewId } : {}) });
      const question = questions.get(id) ?? itemQuestion(id, x.text);
      return { id, ...(question !== undefined ? { question: clip(oneLine(question), MAX_ROUND1_QUESTION) } : {}), ...(link !== undefined ? { link } : {}) };
    })
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
  return { head: head.sha, open };
}

/**
 * The "Design review (round 1)" section (§4.5) as a lead line and its items, each item without a list marker: a surface nests them
 * under the lead its own way (`- ` in the posted body and draft.md's section, indented under the lead's bullet in the maintainer's
 * list, a list in the HTML). Each open item says what it is (its id and question) and its state: open on this head, or open as of an
 * earlier design head and not re-checked on this one. Nothing of round 1 is posted again.
 */
export function round1Section(r: Round1Status | null, head: string): { lead: string; items: string[] } {
  if (r === null) return { lead: "Round 1 (the design review) was not run on this pull request; the verdict counts this review's findings only.", items: [] };
  const d = r.head.slice(0, 7);
  if (r.open.length === 0) return { lead: `Design review at ${d}: no open item.`, items: [] };
  const same = r.head === head;
  const at = same ? `Design review at ${d} (this head)` : `Design review as of ${d}; run pr-design-review on this head to re-check them`;
  const state = same ? "open on this head" : `open as of ${d}, not re-checked on this head`;
  return {
    lead: `${at}: ${r.open.length} open item${r.open.length === 1 ? "" : "s"}:`,
    items: r.open.map((o) => `${o.id} (${state})${o.question !== undefined ? `: ${o.question}` : ""} ${o.link !== undefined ? `[comment](${o.link})` : "(not posted)"}`),
  };
}

/** The section as lines: the lead, then each item as a top-level list entry (`- `). */
export function round1Lines(r: Round1Status | null, head: string): string[] {
  const s = round1Section(r, head);
  return [s.lead, ...s.items.map((i) => `- ${i}`)];
}

/** The section as one entry of a list that renders each entry as `- <entry>`: the lead, with its items nested under it. */
export function round1Entry(r: Round1Status | null, head: string): string {
  const s = round1Section(r, head);
  return [s.lead, ...s.items.map((i) => `  - ${i}`)].join("\n");
}
