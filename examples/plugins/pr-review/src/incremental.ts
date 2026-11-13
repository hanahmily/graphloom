// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Round 1 on a later head is incremental (design §9.2 and §9.3): the earlier open issues are asked again, the questions about code the
 * update changed are asked, and every other earlier answered question is carried with its recorded answer. This module is the pure part:
 * reading the delta between the last reviewed head L and the new head H, reading L's Q&A, and deciding which question is carried. It runs
 * in plugin code over recorded command output, so the graph and the validators decide the same thing and no model is involved.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import type { FinalAnswer } from "./answers.js";
import { COMMAND } from "./constants.js";
import { commandRuns, describeCommand, isObject, reportText, succeeded, type CommandRun } from "./evidence.js";
import { effectiveConclusion, NECESSITY_ID, necessityCitations, parseNecessityRecord, type Necessity, type NecessityRecord } from "./necessity.js";
import { quoteInPinned, type PinnedText, type Question } from "./questions.js";
import { sha256 } from "./parts.js";
import type { PriorItem, PriorRegistry } from "./prior.js";
import type { ViewItem } from "./reportview.js";

/** The last line the head-delta command prints: its absence means the output was cut. */
export const DELTA_END = "graphloom-delta-end";
/** The most files one delta read names, and the most base paths; past them the round is a full round 1. */
export const MAX_DELTA_FILES = 2_000;
export const MAX_BASE_PATHS = 300;
/** The most parts of the prior `qa.json` one run reads (30,000 characters each). */
export const MAX_PRIOR_PARTS = 64;
const PART_CHARS = 30_000;
const PARTS_PER_JOB = 16;

// ---- the head delta ----

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** What `git diff -U0` shows of one file: its hunks, or none (a binary or mode-only change), which counts as the whole file. */
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

/** The ranges the two sides of a hunk touch. A pure insertion or deletion has no lines on its empty side: it touches the line before and the line after its place. */
const span = (start: number, count: number): [number, number] => (count === 0 ? [start, start + 1] : [start, start + count - 1]);

/**
 * Whether lines `start..end` of `path` (a file-level citation has `start < 1`) are touched by the delta, on the old side (the numbering
 * at L) or the new side (the numbering at H). A file the delta does not list is unchanged.
 */
export function changedAt(delta: HeadDelta, path: string, start: number, end: number, side: "old" | "new"): boolean {
  const f = delta.get(path);
  if (f === undefined) return false;
  if (f.whole || start < 1) return true;
  const to = Math.max(start, end);
  return f.hunks.some((h) => {
    const [a, b] = side === "old" ? span(h.oldStart, h.oldCount) : span(h.newStart, h.newCount);
    return a <= to && b >= start;
  });
}

/** A line of `path` at L, as it is at H: shifted by every hunk that lies wholly before it. A line a hunk touches is not mapped (call `changedAt` first). */
export function mapLine(delta: HeadDelta, path: string, line: number): number {
  const f = delta.get(path);
  if (f === undefined || f.whole) return line;
  let shift = 0;
  for (const h of f.hunks) {
    const lastOld = h.oldCount === 0 ? h.oldStart : h.oldStart + h.oldCount - 1;
    if (lastOld < line) shift += h.newCount - h.oldCount;
  }
  return line + shift;
}

/** For each base path asked about, whether it differs between the two bases (output of the base-delta command). */
export function parseBaseDelta(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of text.split("\n")) {
    const m = /^(same|changed) (.+)$/.exec(line.replace(/\r$/, ""));
    if (m !== null) out.set(m[2]!, m[1] === "changed");
  }
  return out;
}

// ---- the commands ----

/**
 * The most characters the path list may take: one argument of a command (the executor allows 64 arguments of 4,096 characters each),
 * the paths joined by newlines. A list that does not fit is a full round 1, decided before the command is dispatched.
 */
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

/** The hunks between L and H over `paths` (one newline-joined argument, see `pathList`), reduced to file and hunk headers (design §9.2). No repository code runs. */
export const headDeltaCommand = (l: string, h: string, paths: readonly string[]): EnvironmentCommand => ({ id: COMMAND.delta, argv: ["sh", "-c", HEAD_DELTA, COMMAND.delta, l, h, pathList(paths) ?? ""] });

const BASE_DELTA =
  'set -eu; lb="$1"; hb="$2"; list="$3"; git -c core.hooksPath=/dev/null cat-file -e "$lb^{commit}"; git -c core.hooksPath=/dev/null cat-file -e "$hb^{commit}"; ' +
  '{ printf \'%s\\n\' "$list" | while IFS= read -r p; do [ -n "$p" ] || continue; if GIT_LITERAL_PATHSPECS=1 git -c core.hooksPath=/dev/null diff --quiet --no-ext-diff --no-textconv "$lb" "$hb" -- "$p"; then echo "same $p"; else echo "changed $p"; fi; done; } > "$GRAPHLOOM_REPORT_FILE"';

/** Whether each base path differs between the two bases (the paths as one newline-joined argument). */
export const baseDeltaCommand = (lb: string, hb: string, paths: readonly string[]): EnvironmentCommand => ({ id: COMMAND.deltaBase, argv: ["sh", "-c", BASE_DELTA, COMMAND.deltaBase, lb, hb, pathList(paths) ?? ""] });

/** Prints part `k` of a file of the ledger commit as ASCII-only JSON text, with a header the reader joins and checks (the shape `ledger-prior` uses). */
const FILE_EXTRACT = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const r=s.replace(/[\u007f-￿]/g,(m)=>"\\u"+m.charCodeAt(0).toString(16).padStart(4,"0"));
const n=Math.max(1,Math.ceil(r.length/${PART_CHARS}));const k=Number(process.argv[1]);
const h=require("crypto").createHash("sha256").update(r).digest("hex");
process.stdout.write("graphloom-prior "+k+" "+n+" "+h+"\n"+r.slice(k*${PART_CHARS},(k+1)*${PART_CHARS}))})`;

const FILE_SHOW =
  'set -eu; if ! git -c core.hooksPath=/dev/null cat-file -e "$1:$5" 2>/dev/null; then echo graphloom-prior-absent > "$GRAPHLOOM_REPORT_FILE"; exit 0; fi; ' +
  'j=$(git -c core.hooksPath=/dev/null show "$1:$5"); printf \'%s\' "$j" | "$2" -e "$3" "$4" > "$GRAPHLOOM_REPORT_FILE"';

export type PriorFile = "qa" | "necessity";
const FILE_NAME: Record<PriorFile, string> = { qa: "qa.json", necessity: "necessity.json" };
const FILE_ID: Record<PriorFile, string> = { qa: COMMAND.ledgerPriorQa, necessity: COMMAND.ledgerPriorNecessity };

/** Part `k` of `qa.json` or `necessity.json` as the ledger commit `old` holds it; says `absent` when the commit has no such file. */
export const priorFileCommand = (file: PriorFile, old: string, node: string, k: number): EnvironmentCommand => ({
  id: k === 0 ? FILE_ID[file] : `${FILE_ID[file]}-${k}`,
  argv: ["sh", "-c", FILE_SHOW, FILE_ID[file], old, node, FILE_EXTRACT, String(k), FILE_NAME[file]],
});

/** What part `k` of `text` prints, as `priorFileCommand` does: for the stand-ins of a rehearsal and for tests. */
export function priorFileText(text: string, k: number): string {
  const ascii = text.replace(/[\u007f-￿]/g, (m) => `\\u${m.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const n = Math.max(1, Math.ceil(ascii.length / PART_CHARS));
  return `graphloom-prior ${k} ${n} ${sha256(ascii)}\n${ascii.slice(k * PART_CHARS, (k + 1) * PART_CHARS)}`;
}

export type FileRead = { state: "missing"; next: EnvironmentCommand[] } | { state: "absent" } | { state: "read"; text: string } | { state: "unreadable"; reason: string };

/** The file as the part commands read it from the ledger commit `old`: absent, still to read (the commands that read what is missing), whole, or not readable. */
export function priorFile(evidence: readonly EvidenceRecord[], file: PriorFile, old: string, node: string): FileRead {
  const id = FILE_ID[file];
  const runs = commandRuns(evidence).filter((r) => r.command.argv[3] === id && r.command.argv[4] === old);
  const part = (k: number): CommandRun | undefined => runs.filter((r) => r.command.argv[7] === String(k)).at(-1);
  const first = part(0);
  if (first === undefined) return { state: "missing", next: [priorFileCommand(file, old, node, 0)] };
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
      missing.push(priorFileCommand(file, old, node, k));
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

// ---- the earlier Q&A ----

export interface PriorQuestion {
  id: string;
  type: string;
  item: string;
  stable: string;
  text: string;
  origin: "required" | "added";
  /** The head the answer was first given on, when an earlier incremental head carried it. */
  carried?: string;
  answer?: FinalAnswer;
}

export interface PriorQa {
  head: string;
  base?: string;
  mode: string;
  /** `name@version` of the dependencies the Q&A's inventory listed. */
  dependencies: string[];
  questions: PriorQuestion[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The earlier Q&A a `qa.json` holds, or undefined when it is not a Q&A of a head (a skipped Q&A has no usable answers). */
export function parsePriorQa(json: string): PriorQa | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isObject(v) || v.schema !== "pr-qa-v1" || v.roundsSkipped !== undefined || !isObject(v.pull) || !Array.isArray(v.questions)) return undefined;
  const head = str(v.pull.head);
  if (head === undefined) return undefined;
  const inv = isObject(v.inventory) && Array.isArray(v.inventory.dependencies) ? v.inventory.dependencies.filter(isObject).map((d) => `${str(d.name) ?? ""}@${str(d.version) ?? ""}`) : [];
  const questions: PriorQuestion[] = [];
  for (const q of v.questions.filter(isObject)) {
    const id = str(q.id);
    const stable = str(q.stable);
    if (id === undefined || stable === undefined) continue;
    const a = isObject(q.answer) ? q.answer : undefined;
    const answer =
      a !== undefined && typeof a.status === "string" && typeof a.answer === "string" && Array.isArray(a.citations) && Array.isArray(a.searches) && isObject(a.check) && Array.isArray(a.history) && isObject(a.proposal) && Array.isArray(a.inventory) && Array.isArray(a.metrics) && Array.isArray(a.notes)
        ? ({ question: id, ...a } as unknown as FinalAnswer)
        : undefined;
    questions.push({ id, type: str(q.type) ?? "", item: str(q.item) ?? "", stable, text: str(q.text) ?? "", origin: q.origin === "added" ? "added" : "required", ...(isObject(q.carried) && str(q.carried.head) !== undefined ? { carried: str(q.carried.head)! } : {}), ...(answer !== undefined ? { answer } : {}) });
  }
  return { head, ...(str(v.pull.base) !== undefined ? { base: str(v.pull.base)! } : {}), mode: str(v.mode) ?? "standard", dependencies: inv, questions };
}

// ---- what is read, and whether it is usable ----

export interface IncrementalPrior {
  /** L: the head the earlier Q&A is of. */
  from: string;
  fromBase: string | undefined;
  qa: PriorQa;
  necessity: NecessityRecord;
  /** The head N1's earlier answer was given on (L, or an earlier head an incremental run carried it from). */
  necessityHead: string;
  delta: HeadDelta;
  /** Lb and Hb are the same commit. */
  baseSame: boolean;
  /** For each base path the earlier answers cite, whether it differs between the two bases (empty when the bases are the same). */
  baseChanged: ReadonlyMap<string, boolean>;
}

/**
 * Where incremental round 1 stands: no prior ledger at all (a first head), a full round 1 with the reason, commands still to run, or the
 * prior ready to plan with. A pure function of the evidence, so Fetch, Questions, Answers and the validators agree.
 */
export type IncrementalReads =
  | { state: "none" }
  | { state: "full"; reason: string }
  | { state: "run"; commands: EnvironmentCommand[]; why: string }
  | { state: "usable"; prior: IncrementalPrior };

export interface IncrementalInput {
  /** The ledger commit Fetch read, when there is one. */
  ledger: string | undefined;
  registry: PriorRegistry;
  /** Whether the profile allows it (`questions.incremental`, and rounds is not review-only). */
  enabled: boolean;
  head: string;
  /** The files the head's change touches. */
  files: readonly string[];
  /** H's pinned base. */
  base: string | undefined;
  node: string;
}

/** The head-side paths an earlier Q&A's answers rest on, and the base-side ones. */
function citedPaths(qa: PriorQa, nec: NecessityRecord): { head: string[]; base: string[] } {
  const head = new Set<string>();
  const base = new Set<string>();
  const add = (c: { path: string; tree: string }): void => {
    if (c.path === "") return;
    if (c.tree === "head") head.add(c.path);
    else if (c.tree === "base") base.add(c.path);
  };
  for (const q of qa.questions) for (const c of q.answer?.citations ?? []) add(c);
  if (nec.final.necessity !== undefined) for (const c of necessityCitations(nec.final.necessity)) add(c);
  return { head: [...head].sort(), base: [...base].sort() };
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function incrementalReads(evidence: readonly EvidenceRecord[], i: IncrementalInput): IncrementalReads {
  if (i.ledger === undefined) return { state: "none" };
  if (!i.enabled) return { state: "full", reason: "the profile turns incremental review off (questions.incremental is false)" };
  const last = i.registry.heads.at(-1);
  // A ledger commit always lists its head; one that lists none (or whose prior ledger.json is not loaded yet) is as good as no ledger.
  if (last === undefined) return { state: "none" };
  const fileOf = (file: PriorFile): { text: string } | { full: string } | { run: IncrementalReads & { state: "run" } } => {
    const r = priorFile(evidence, file, i.ledger!, i.node);
    if (r.state === "missing") return { run: { state: "run", commands: r.next, why: `read ${FILE_NAME[file]} of the ledger's latest commit, so a later head can carry what it answered` } };
    if (r.state === "absent") return { full: `the ledger's latest commit holds no ${FILE_NAME[file]}${file === "necessity" ? " (a ledger written before 0.26 has none)" : ""}` };
    if (r.state === "unreadable") return { full: `the ledger's ${FILE_NAME[file]} cannot be read (${r.reason})` };
    return { text: r.text };
  };
  const q = fileOf("qa");
  if ("run" in q) return q.run;
  if ("full" in q) return { state: "full", reason: q.full };
  const qa = parsePriorQa(q.text);
  if (qa === undefined) return { state: "full", reason: "the ledger's qa.json is not the Q&A of a head (it is skipped or not a Q&A file)" };
  if (qa.head !== last) return { state: "full", reason: "the ledger's qa.json is not of the latest head it lists" };
  const n = fileOf("necessity");
  if ("run" in n) return n.run;
  if ("full" in n) return { state: "full", reason: n.full };
  const necessity = parseNecessityRecord(n.text);
  if (necessity === undefined) return { state: "full", reason: "the ledger's necessity.json is not the necessity record of a head" };
  const cited = citedPaths(qa, necessity);
  const paths = [...new Set([...i.files, ...cited.head])].sort();
  if (paths.length > MAX_DELTA_FILES) return { state: "full", reason: `the delta would name ${paths.length} files, more than the ${MAX_DELTA_FILES} one read takes` };
  if (pathList(paths) === undefined) return { state: "full", reason: `the delta's ${paths.length} file paths do not fit the one argument a command takes (${MAX_PATH_LIST_CHARS} characters)` };
  const headCommand = headDeltaCommand(qa.head, i.head, paths);
  const headRun = commandRuns(evidence, COMMAND.delta).filter((r) => sameArgv(r.command.argv, headCommand.argv)).at(-1);
  if (headRun === undefined) return { state: "run", commands: [headCommand], why: `read the delta between the last reviewed head ${qa.head.slice(0, 12)} and this one, as file and hunk headers` };
  if (!succeeded(headRun.command)) return { state: "full", reason: `the head delta could not be read (${describeCommand(headRun.command)}: the last reviewed head or its objects are not in the review clone)` };
  const text = reportText(headRun);
  if (text.truncated) return { state: "full", reason: "the head delta did not fit one command report" };
  const delta = parseHeadDelta(text.text);
  if ("problem" in delta) return { state: "full", reason: delta.problem };
  if (i.base === undefined) return { state: "full", reason: "this head's base is not recorded" };
  let baseChanged: Map<string, boolean> = new Map();
  const baseSame = qa.base === i.base;
  if (!baseSame) {
    if (qa.base === undefined) return { state: "full", reason: "the earlier head's base is not recorded" };
    if (cited.base.length > MAX_BASE_PATHS) return { state: "full", reason: `the earlier answers cite ${cited.base.length} base files, more than the ${MAX_BASE_PATHS} one read takes` };
    if (cited.base.length > 0 && pathList(cited.base) === undefined) return { state: "full", reason: `the ${cited.base.length} base paths the earlier answers cite do not fit the one argument a command takes (${MAX_PATH_LIST_CHARS} characters)` };
    if (cited.base.length > 0) {
      const baseCommand = baseDeltaCommand(qa.base, i.base, cited.base);
      const baseRun = commandRuns(evidence, COMMAND.deltaBase).filter((r) => sameArgv(r.command.argv, baseCommand.argv)).at(-1);
      if (baseRun === undefined) return { state: "run", commands: [baseCommand], why: "read which base files the earlier answers cite differ between the two bases" };
      if (!succeeded(baseRun.command)) return { state: "full", reason: `the base delta could not be read (${describeCommand(baseRun.command)})` };
      const baseText = reportText(baseRun);
      if (baseText.truncated) return { state: "full", reason: "the base check did not fit one command report" };
      baseChanged = parseBaseDelta(baseText.text);
    }
  }
  return { state: "usable", prior: { from: qa.head, fromBase: qa.base, qa, necessity, necessityHead: necessity.carried?.head ?? qa.head, delta, baseSame, baseChanged } };
}

// ---- the carry rule ----

/** What the carry rule reads of the new head, from the Q&A context. */
export interface CarryEnv {
  prior: IncrementalPrior;
  /** The earlier open round-1 issues (and what they stood for): always asked again. */
  openIds: ReadonlySet<string>;
  symbols: ReadonlyArray<{ id: string; path: string; startLine: number; endLine: number }>;
  /** The report's items and high-level changes at H, with their cites. */
  items: ReadonlyArray<Pick<ViewItem, "id" | "cites">>;
  /** `name@version` of the dependencies at H. */
  dependencies: readonly string[];
  /** The design principles record as H would write it, as JSON (or `null`), and the pull request's text. */
  principles: string;
  pinned: readonly PinnedText[];
}

/** The ids of the earlier open round-1 issues, and of the questions each stood for. */
export function openIssueIds(items: readonly PriorItem[]): Set<string> {
  const ids = new Set<string>();
  for (const it of items) {
    if (it.origin !== "round1" || it.status !== "open") continue;
    ids.add(it.id);
    for (const c of it.covers ?? []) ids.add(c);
  }
  return ids;
}

/** Whether a citation of an earlier answer is changed by the delta (design §9.2). */
function citationChanged(c: { path: string; tree: string; start: number; end: number }, p: IncrementalPrior, env: Pick<CarryEnv, "dependencies">): boolean {
  if (c.path === "") return false;
  if (c.tree === "head") return changedAt(p.delta, c.path, c.start, c.end, "old");
  if (c.tree === "base") return p.baseSame ? false : p.baseChanged.get(c.path) !== false;
  return JSON.stringify([...env.dependencies].sort()) !== JSON.stringify([...p.qa.dependencies].sort());
}

/** A citation as it reads at H: a head citation's lines move with the hunks before them. */
const mapCite = <T extends { path: string; tree: string; start: number; end: number }>(c: T, p: IncrementalPrior): T => (c.tree === "head" && c.start >= 1 ? { ...c, start: mapLine(p.delta, c.path, c.start), end: mapLine(p.delta, c.path, c.end) } : c);

/** Whether any place a report item cites at H is changed (a base-side cite and a file-level cite count as changed when the file is). */
function itemChanged(item: Pick<ViewItem, "cites"> | undefined, p: IncrementalPrior): boolean {
  if (item === undefined) return true;
  return item.cites.some((c) => (c.side === "head" ? changedAt(p.delta, c.path, c.start, c.end, "new") : true));
}

export interface Carried {
  answer: FinalAnswer;
  /** The head the answer was given on. */
  head: string;
  /** The question's recorded text, which the answer is to. */
  text: string;
}

/** The earlier answer of `q` as it reads at H, when the carry rule carries it; otherwise why it is asked. */
export function carryOf(q: Question, env: CarryEnv): Carried | { why: string } {
  const p = env.prior;
  if (q.type === "necessity") return { why: "N1 has its own rule" };
  const key = q.stable ?? "";
  if (key === "" || key.includes("#")) return { why: "its key is not unique" };
  const prior = p.qa.questions.filter((x) => x.stable === key);
  if (prior.length !== 1) return { why: prior.length === 0 ? "no earlier answer" : "its key is not unique" };
  const e = prior[0]!;
  if (e.answer === undefined || e.answer.status !== "answered") return { why: "the earlier answer was not fully answered" };
  if (env.openIds.has(e.id)) return { why: "an earlier open issue: re-checked" };
  const sym = q.symbol !== undefined ? env.symbols.find((s) => s.id === q.symbol) : undefined;
  if (q.symbol !== undefined && sym === undefined) return { why: "its symbol is unknown" };
  const subject =
    sym !== undefined
      ? changedAt(p.delta, sym.path, sym.startLine, sym.endLine, "new")
      : q.fn !== undefined
        ? changedAt(p.delta, q.fnPath ?? "", 0, 0, "new")
        : itemChanged(env.items.find((i) => i.id === q.item), p);
  if (subject) return { why: "its subject is changed" };
  if (e.answer.citations.some((c) => citationChanged(c, p, env))) return { why: "a citation of its answer is changed" };
  const a = e.answer;
  const proposal = a.proposal.kind === "split" ? { ...a.proposal, splits: a.proposal.splits.map((s) => (sym !== undefined ? { ...s, startLine: mapLine(p.delta, sym.path, s.startLine), endLine: mapLine(p.delta, sym.path, s.endLine) } : s)) } : a.proposal;
  return { answer: { ...a, question: q.id, citations: a.citations.map((c) => mapCite(c, p)), proposal }, head: e.carried ?? p.qa.head, text: e.text };
}

const mapNecessity = (n: Necessity, p: IncrementalPrior): Necessity => {
  const cite = <T extends { path: string; tree: string; start: number; end: number }>(c: T): T => mapCite(c, p);
  return {
    ...n,
    problem: { ...n.problem, trace: n.problem.trace.map(cite) },
    design: { ...n.design, statements: n.design.statements.map(cite), changed: n.design.changed.map(cite) },
    principles: n.principles.map((x) => ({ ...x, citations: x.citations.map(cite) })),
    alternatives: { ...n.alternatives, citations: n.alternatives.citations.map(cite) },
  };
};

export interface CarriedNecessity {
  record: NecessityRecord;
  head: string;
}

/**
 * N1's earlier answer, carried when it concluded `necessary` with every question asked, was not an open issue, no citation of any
 * of its parts is changed, the design principles file is the same, and the pull request's text still holds each quote it used.
 */
export function carryNecessity(env: CarryEnv): CarriedNecessity | { why: string } {
  const p = env.prior;
  const r = p.necessity;
  const n = r.final.necessity;
  if (n === undefined) return { why: "no recorded necessity answer" };
  if (r.decision.action !== "ask-all") return { why: "N1 skipped the other questions" };
  if (effectiveConclusion(r.final) !== "necessary") return { why: "N1 was an issue" };
  if (env.openIds.has(NECESSITY_ID)) return { why: "an earlier open issue: re-checked" };
  if (r.final.check.verdict !== "supported" && r.final.check.verdict !== "partial") return { why: "the checker did not support it" };
  if (JSON.stringify(r.principles ?? null) !== env.principles) return { why: "the design principles file differs" };
  if (!n.problem.quotes.every((x) => quoteInPinned(x.quote, x.source, env.pinned))) return { why: "the pull request's text no longer holds a quote it used" };
  if (necessityCitations(n).some((c) => citationChanged(c, p, env))) return { why: "a citation of its answer is changed" };
  return { record: { ...r, final: { ...r.final, necessity: mapNecessity(n, p), citations: r.final.citations.map((c) => mapCite(c, p)) }, carried: { head: p.necessityHead } }, head: p.necessityHead };
}

/** The ledger's `qa.json` note on how this head's round 1 went (design §6.7): what was asked and why. */
export interface IncrementalNote {
  /** L, the head the earlier Q&A is of; absent for a first head or a full round 1. */
  from?: string;
  /** H, the head this Q&A is of. */
  to?: string;
  full?: string;
  asked?: number;
  rechecks?: number;
  carried?: number;
}

/** The one deterministic line the Q&A opens with on a later head (design §6.7). */
export function incrementalLine(n: IncrementalNote): string {
  if (n.full !== undefined) return `Every question was asked: ${n.full}.`;
  return `Since the last review (${(n.from ?? "").slice(0, 7)} → ${(n.to ?? "").slice(0, 7)}): ${n.asked ?? 0} asked (new or changed code), ${n.rechecks ?? 0} of them re-checks of earlier issues, ${n.carried ?? 0} carried from earlier heads.`;
}
