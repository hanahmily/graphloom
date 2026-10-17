import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import type { ReviewComment } from "./ocr.js";
import { clip } from "./review-common.js";

/**
 * The issues file: the run's critical and high code review findings as
 * issues, in `.graphloom/issues.json` in the run's worktree, with a readable
 * `.graphloom/issues.md` beside it.
 *
 * The graph is its authority. The table is rebuilt from evidence on every
 * call, like the findings ledger it extends: an issue is created when the
 * verifier confirms (`open`) or refutes (`dismissed`) a finding, the code
 * reviewer's statuses move it (`fixed` to `done` or `reopened`), and the
 * fixer's edits to the file, read back by a command job after each
 * implementer run, move `open` or `reopened` issues to `fixed`. Every other
 * edit is rejected and the file is rewritten from the table. The write
 * command carries the whole file in its argv, so the last version the graph
 * accepted is evidence too.
 *
 * The directory holds a `.gitignore` of `*`, written with the files, so Git
 * ignores it in any repository: the controller's candidate digest, its scope
 * checks and `git add -A` all follow Git's ignore rules, and the deliver
 * command also excludes the directory by pathspec.
 */

export const ISSUES_DIR = ".graphloom";
export const ISSUES_FILE = `${ISSUES_DIR}/issues.json`;
export const ISSUES_MARKDOWN = `${ISSUES_DIR}/issues.md`;
export const ISSUES_SCHEMA = "graphloom-issues-v1";
export const ISSUES_COMMAND = { write: "issues-write", read: "issues-read" } as const;

export type IssueStatus = "open" | "fixed" | "done" | "reopened" | "dismissed";
export const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "fixed", "done", "reopened", "dismissed"];
export type IssueSeverity = "P0" | "P1" | "P2" | "P3";
export type IssueActor = "reviewer" | "fixer" | "verifier" | "graph";

export interface IssueEvent {
  actor: IssueActor;
  /** null when the event created the issue. */
  from: IssueStatus | null;
  to: IssueStatus;
  note: string;
  round: number;
  /** The candidate digest the event applies to. */
  candidate: string;
  /** The evidence record the event comes from. */
  evidence: string;
}

export interface IssueLocation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface Issue {
  /** I1, I2, …: the number of the finding it tracks (F1 is I1). */
  id: string;
  severity: IssueSeverity;
  location: IssueLocation;
  title: string;
  description: string;
  status: IssueStatus;
  /** The review round the finding was raised in. */
  round: number;
  history: IssueEvent[];
}

/** An edit to the file the graph did not accept; the file was restored. */
export interface Rejection {
  issue?: string;
  note: string;
  round: number;
  candidate: string;
  evidence: string;
}

export interface IssueTable {
  issues: Issue[];
  rejections: Rejection[];
  /** The issues as the graph last wrote them to the worktree, by id: what the fixer started from. */
  written?: Map<string, Issue>;
}

/** Where an event happens: its round, candidate and evidence record. */
export interface EventContext {
  round: number;
  digest: string;
  ref: string;
}

export const emptyIssueTable = (): IssueTable => ({ issues: [], rejections: [] });

/** The issue id for a finding id, and back: I3 tracks F3. */
export const issueIdOf = (findingId: string): string => findingId.replace(/^F(\d+)$/, "I$1");
export const findingIdOf = (ref: string): string => ref.trim().replace(/^I(\d+)$/i, "F$1");

export const issueById = (table: IssueTable, id: string): Issue | undefined => table.issues.find((i) => i.id === id);

/** critical P0, high P1, medium P2, low P3; a comment without a severity blocks, so it is P1. */
export function severityOf(c: Pick<ReviewComment, "severity">): IssueSeverity {
  return c.severity === "critical" ? "P0" : c.severity === "medium" ? "P2" : c.severity === "low" ? "P3" : "P1";
}

export const SEVERITY_WORD: Record<IssueSeverity, string> = { P0: "critical", P1: "high", P2: "medium", P3: "low" };

/** An issue that keeps the code review requirement from passing: P0 or P1, and not done or dismissed. */
export function isUnsettled(i: Issue): boolean {
  return (i.severity === "P0" || i.severity === "P1") && (i.status === "open" || i.status === "reopened" || i.status === "fixed");
}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 1_500;
const MAX_NOTE = 1_000;

function titleOf(content: string): string {
  const line = content.trim().split("\n")[0] ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return clip(sentence, MAX_TITLE);
}

/** A new issue for a finding the verifier judged. */
export function createIssue(
  table: IssueTable,
  finding: { id: string; comment: ReviewComment; original?: ReviewComment },
  args: { status: IssueStatus; actor: IssueActor; note: string; raisedIn: number; ctx: EventContext },
): Issue {
  const c = finding.original ?? finding.comment;
  const issue: Issue = {
    id: issueIdOf(finding.id),
    severity: severityOf(c),
    location: { path: c.path, startLine: c.start_line, endLine: Math.max(c.end_line, c.start_line) },
    title: titleOf(c.content),
    description: clip([c.content.trim(), ...(c.evidence !== undefined ? [`Failure: ${c.evidence.trim()}`] : [])].join("\n"), MAX_DESCRIPTION),
    status: args.status,
    round: args.raisedIn,
    history: [],
  };
  issue.history.push(event(args.actor, null, args.status, args.note, args.ctx));
  table.issues.push(issue);
  table.issues.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return issue;
}

export function moveIssue(issue: Issue, actor: IssueActor, to: IssueStatus, note: string, ctx: EventContext): void {
  issue.history.push(event(actor, issue.status, to, note, ctx));
  issue.status = to;
}

function event(actor: IssueActor, from: IssueStatus | null, to: IssueStatus, note: string, ctx: EventContext): IssueEvent {
  return { actor, from, to, note: clip(note, MAX_NOTE), round: ctx.round, candidate: ctx.digest, evidence: ctx.ref };
}

/** The fixer's latest note on an issue it marked fixed, when its last move was that. */
export function fixerNote(issue: Issue): IssueEvent | undefined {
  const last = issue.history.at(-1);
  return last?.actor === "fixer" && last.to === "fixed" ? last : undefined;
}

// ---- The file in the worktree ------------------------------------------------

interface IssueFile {
  schema: string;
  protocol: string[];
  round?: number;
  phase?: string;
  issues: Issue[];
}

export const FILE_PROTOCOL = [
  "The issue-fix graph owns this file and rewrites it from the run's evidence; .graphloom/issues.md is its readable copy.",
  "Statuses: open (confirmed by an independent verifier), fixed (the fixer says it is fixed; not yet verified), done (the reviewer verified the fix), reopened (the reviewer found it still present after a fix), dismissed (the verifier refuted it).",
  "The fixer may only change an open or reopened issue's status to fixed, and append to its history one entry {\"actor\": \"fixer\", \"from\": <old status>, \"to\": \"fixed\", \"note\": <what you changed, with file:line>}. Any other edit (another status, a new, deleted or reworded issue) is rejected and the file is restored.",
  "The code reviewer verifies each fixed issue in its result (resolved makes it done; still_present reopens it with the reviewer's note) and reports new issues there; it does not edit this file.",
];

/** The command executor keeps 64 KiB of a report: a larger file could not be read back whole. */
export const MAX_READ_BYTES = 64 * 1024;
const COMPACT_TEXT = 200;

/**
 * The file's JSON. A table too large to read back whole is written with its
 * descriptions and history notes cut to 200 characters; the full text stays
 * in the evidence the table is rebuilt from.
 */
export function issueFileJson(table: IssueTable, meta: { round?: number; phase?: string } = {}): string {
  const render = (issues: Issue[]) => {
    const file: IssueFile = {
      schema: ISSUES_SCHEMA,
      protocol: FILE_PROTOCOL,
      ...(meta.round !== undefined ? { round: meta.round } : {}),
      ...(meta.phase !== undefined ? { phase: meta.phase } : {}),
      issues,
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  };
  const fits = (json: string) => Buffer.byteLength(json) < MAX_READ_BYTES - 1_024;
  const full = render(table.issues);
  if (fits(full)) return full;
  // Shorter text first, then only each issue's latest events; issues.md and the evidence keep everything.
  let compact = full;
  for (const [text, events] of [[COMPACT_TEXT, Infinity], [80, 3], [40, 1]] as const) {
    compact = render(
      table.issues.map((i) => ({ ...i, description: clip(i.description, text), history: i.history.slice(-events).map((h) => ({ ...h, note: clip(h.note, text) })) })),
    );
    if (fits(compact)) break;
  }
  return compact;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
export const where = (l: IssueLocation): string => (l.startLine > 0 ? `${l.path}:${l.startLine}${l.endLine > l.startLine ? `-${l.endLine}` : ""}` : l.path);

/** The markdown table rows of the issues, for issues.md and the pull request. */
export function issueTableRows(issues: Issue[], note: (i: Issue) => string = latestNote): string[] {
  return [
    "| Issue | Severity | Status | Location | Title | Latest note |",
    "|---|---|---|---|---|---|",
    ...issues.map((i) => `| ${i.id} | ${i.severity} (${SEVERITY_WORD[i.severity]}) | ${i.status} | \`${cell(where(i.location))}\` | ${cell(i.title)} | ${cell(clip(note(i), 300))} |`),
  ];
}

const latestNote = (i: Issue): string => {
  const last = i.history.at(-1);
  return last === undefined ? "" : `${last.actor}: ${last.note}`;
};

export function issueMarkdown(table: IssueTable, extra: { round?: number; phase?: string; followUps?: string[] } = {}): string {
  const lines = [
    "# Review issues",
    "",
    `Generated by the issue-fix graph from ${ISSUES_FILE}; edits to this file are ignored.${extra.round !== undefined ? ` Review round ${extra.round}${extra.phase !== undefined ? ` (${extra.phase})` : ""}.` : ""}`,
    "",
    ...issueTableRows(table.issues),
  ];
  for (const i of table.issues) {
    lines.push("", `## ${i.id}: ${i.title}`, "", `${i.severity} (${SEVERITY_WORD[i.severity]}), ${i.status}, \`${where(i.location)}\`, raised in review round ${i.round}.`, "", i.description, "", "History:");
    for (const h of i.history) {
      lines.push(`- round ${h.round}, ${h.actor}: ${h.from ?? "new"} → ${h.to} (${h.evidence}, candidate ${h.candidate.slice(0, 8)})${h.note !== "" ? `: ${h.note.replace(/\s+/g, " ")}` : ""}`);
    }
  }
  if ((extra.followUps ?? []).length > 0) lines.push("", "## Follow-ups", "", "Raised after the discovery rounds; not tracked as issues.", "", ...extra.followUps!.map((f) => `- ${f}`));
  const rejected = table.rejections.filter((r) => r.issue === undefined);
  if (rejected.length > 0) lines.push("", "## Rejected edits", "", ...rejected.map((r) => `- round ${r.round} (${r.evidence}): ${r.note}`));
  return `${lines.join("\n")}\n`;
}

// ---- Commands ------------------------------------------------------------------

const CHUNK = 4_000;
/** The command executor allows 64 arguments: sh, -c, the script, $0, the chunk count, and the chunks. */
const MAX_CHUNKS = 59;

/**
 * Every executor input, the whole `{ commands: [...] }` object serialized, must
 * fit the SDK's byte bound; a little room stays for the job's other fields.
 */
const MAX_COMMAND_INPUT_BYTES = MAX_EXECUTOR_INPUT_BYTES - 4_096;

/** Chunks of at most CHUNK UTF-16 units that never split a surrogate pair, so each argv element stays valid text. */
function chunked(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/** The bytes the command adds to its job's input, as the controller serializes it. */
const inputBytes = (command: EnvironmentCommand): number => Buffer.byteLength(JSON.stringify({ commands: [command] }), "utf8");

const IGNORE = `mkdir -p ${ISSUES_DIR}; printf '*\\n' > ${ISSUES_DIR}/.gitignore; `;

const WRITE =
  'set -eu; n="$1"; shift; json=""; while [ "$n" -gt 0 ]; do json="$json$1"; shift; n=$((n - 1)); done; md=""; for part in "$@"; do md="$md$part"; done; ' +
  IGNORE +
  `printf '%s' "$json" > ${ISSUES_FILE}.tmp; mv ${ISSUES_FILE}.tmp ${ISSUES_FILE}; printf '%s' "$md" > ${ISSUES_MARKDOWN}; echo written`;

const READ = `set -eu; if [ -d ${ISSUES_DIR} ]; then printf '*\\n' > ${ISSUES_DIR}/.gitignore; fi; if [ -f ${ISSUES_FILE} ]; then cat ${ISSUES_FILE} > "$GRAPHLOOM_REPORT_FILE"; echo present; else echo missing; fi`;

/**
 * Write the file and its markdown copy, or undefined when the JSON alone does
 * not fit one command: the argument count and the executor's input byte bound,
 * measured on the serialized input. The markdown is optional; whatever does not
 * fit is cut short, the JSON never is.
 */
export function writeIssuesCommand(json: string, markdown: string): EnvironmentCommand | undefined {
  const parts = chunked(json);
  const build = (md: string[]): EnvironmentCommand => ({ id: ISSUES_COMMAND.write, argv: ["sh", "-c", WRITE, ISSUES_COMMAND.write, String(parts.length), ...parts, ...md] });
  const fits = (command: EnvironmentCommand) => command.argv.length - 5 <= MAX_CHUNKS && inputBytes(command) <= MAX_COMMAND_INPUT_BYTES;
  if (!fits(build([]))) return undefined;
  const md = chunked(markdown);
  if (fits(build(md))) return build(md);
  const cut = `\n… (cut short; see ${ISSUES_FILE})\n`;
  // The longest prefix of whole chunks that fits with the note.
  let kept = 0;
  while (kept < md.length && fits(build([...md.slice(0, kept + 1), cut]))) kept += 1;
  return build(fits(build([...md.slice(0, kept), cut])) ? [...md.slice(0, kept), cut] : md.slice(0, kept));
}

/** Read the file into the command's report; the directory's .gitignore is restored first. */
export function readIssuesCommand(): EnvironmentCommand {
  return { id: ISSUES_COMMAND.read, argv: ["sh", "-c", READ, ISSUES_COMMAND.read] };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A command record of `id`, with its argv, exit code, stdout and report. */
export function issueCommand(record: EvidenceRecord, id: string): { argv: string[]; ok: boolean; stdout: string; report?: { text: string; truncated: boolean } } | undefined {
  if (record.kind !== "command") return undefined;
  const command = object(object(record.payload)?.command);
  if (command?.id !== id || !Array.isArray(command.argv)) return undefined;
  const ok = command.exitCode === 0 && command.timedOut !== true && command.aborted !== true && command.spawnError === undefined;
  const report = object(command.report);
  return {
    argv: command.argv.map(String),
    ok,
    stdout: String(command.stdoutTail ?? ""),
    ...(report !== undefined ? { report: { text: String(report.text ?? ""), truncated: report.truncated === true } } : {}),
  };
}

/** The JSON a write command wrote. */
export function writtenJson(argv: string[]): string | undefined {
  const n = Number(argv[4]);
  if (argv[3] !== ISSUES_COMMAND.write || !Number.isSafeInteger(n) || n < 0) return undefined;
  return argv.slice(5, 5 + n).join("");
}

/** The issues a file's JSON holds, keyed by id, or why it cannot be read. */
export function parseIssueFile(text: string): { issues: Map<string, Record<string, unknown>> } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { problem: `it is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const list = object(parsed)?.issues;
  if (!Array.isArray(list)) return { problem: "it has no issues array" };
  const issues = new Map<string, Record<string, unknown>>();
  for (const raw of list) {
    const i = object(raw);
    if (i === undefined || typeof i.id !== "string") return { problem: "an issue has no id" };
    if (issues.has(i.id)) return { problem: `${i.id} appears twice` };
    issues.set(i.id, i);
  }
  return { issues };
}

/** Fields only the graph sets; the fixer changing one is a reword. */
const FIXED_FIELDS = ["severity", "location", "title", "description", "round"] as const;

/**
 * Apply the fixer's edits, as a read of the file shows them, to the table:
 * an open or reopened issue moved to `fixed` with a new fixer history entry
 * is accepted; everything else the fixer changed is rejected. The read is
 * compared with what the graph last wrote, so fields nobody touched never
 * look edited.
 */
export function applyFixerRead(table: IssueTable, read: { present: boolean; text?: string; truncated?: boolean }, ctx: EventContext): void {
  const written = table.written;
  // The graph never handed the file out: nothing the fixer could have edited.
  if (written === undefined) return;
  const reject = (note: string, issue?: Issue) => {
    table.rejections.push({ ...(issue !== undefined ? { issue: issue.id } : {}), note, round: ctx.round, candidate: ctx.digest, evidence: ctx.ref });
    if (issue !== undefined) issue.history.push(event("graph", issue.status, issue.status, `rejected the fixer's edit: ${note}`, ctx));
  };
  if (!read.present) return reject(`${ISSUES_FILE} was deleted; the graph restored it`);
  if (read.truncated === true) return reject(`${ISSUES_FILE} was larger than the graph reads back; the graph restored it`);
  const parsed = parseIssueFile(read.text ?? "");
  if ("problem" in parsed) return reject(`${ISSUES_FILE} could not be read: ${parsed.problem}; the graph restored it`);
  for (const id of parsed.issues.keys()) {
    if (!written.has(id)) reject(`the fixer added ${id}; only the code reviewer raises issues`);
  }
  for (const [id, before] of written) {
    const issue = issueById(table, id);
    if (issue === undefined) continue;
    const after = parsed.issues.get(id);
    if (after === undefined) {
      reject(`the fixer deleted ${id}`, issue);
      continue;
    }
    const reworded = FIXED_FIELDS.filter((f) => JSON.stringify(after[f]) !== JSON.stringify(before[f]));
    if (reworded.length > 0) reject(`the fixer changed ${id}'s ${reworded.join(", ")}; only the graph sets them`, issue);
    const to = after.status;
    if (to === before.status) continue;
    if (issue.status !== before.status) continue;
    if (to !== "fixed" || (before.status !== "open" && before.status !== "reopened")) {
      const why = to === "done" ? "only the code reviewer marks an issue done" : to === "dismissed" ? "only the verifier dismisses an issue" : "the fixer may only move an open or reopened issue to fixed";
      reject(`the fixer moved ${id} from ${before.status} to ${typeof to === "string" ? to : JSON.stringify(to)}: ${why}`, issue);
      continue;
    }
    const note = newFixerNote(before.history, after.history);
    if (note === undefined) {
      reject(`the fixer marked ${id} fixed without a history entry {"actor": "fixer", "to": "fixed", "note": …} saying what it changed`, issue);
      continue;
    }
    moveIssue(issue, "fixer", "fixed", note, ctx);
  }
}

/** The newest fixer history entry the read adds, moving the issue to fixed with a note. */
function newFixerNote(before: Issue["history"], after: unknown): string | undefined {
  if (!Array.isArray(after)) return undefined;
  const known = new Set(before.map((h) => JSON.stringify(h)));
  for (const raw of [...after].reverse()) {
    const h = object(raw);
    if (h === undefined || known.has(JSON.stringify(raw))) continue;
    if (h.actor === "fixer" && h.to === "fixed" && typeof h.note === "string" && h.note.trim() !== "") return h.note.trim();
  }
  return undefined;
}

/** The issues the graph wrote, by id, from a write command's JSON. */
export function writtenIssues(json: string): Map<string, Issue> | undefined {
  const parsed = parseIssueFile(json);
  if ("problem" in parsed) return undefined;
  return new Map([...parsed.issues].map(([id, i]) => [id, i as unknown as Issue]));
}
