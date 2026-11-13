// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The per-PR ledger (design §9.1) is a Git ref in the operator's review clone
 * that points at a commit whose tree holds `ledger.json`
 * (`graphloom-pr-ledger-v1`), `ledger.md`, and the latest `report.json` and
 * `qa.json`. After Answers, one read-only command job adds a commit and
 * advances the ref by compare-and-swap (`git update-ref <ref> <new> <old>`)
 * from the value Fetch read; the loser of a race exits with LEDGER_MOVED and
 * the run stops retryably "ledger moved". Delta reports are a later phase:
 * this version records this head's report and Q&A and keeps the list of
 * heads the ledger has seen. After the review is posted, the Publish stage advances the ref once more (`publish.ts`,
 * `ledger-published`) with the review's id on the head and the ids of its comments on the items it posted.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { parseLedger, type Ledger } from "./commands.js";
import { COMMAND, LEDGER_JSON_FILE, LEDGER_MD_FILE, LEDGER_MOVED, NECESSITY_JSON, PART_BASE, QA_JSON, REPORT_JSON, ledgerRef } from "./constants.js";
import { commandRuns, isObject, reportText, succeeded, type CommandRun } from "./evidence.js";
import type { FinalAnswer } from "./answers.js";
import type { PurposeRecord, Question } from "./questions.js";
import type { PullRequest } from "./request.js";
import { partCommands, sha256 } from "./parts.js";
import { writeChunks } from "./write.js";

export const LEDGER_SCHEMA = "graphloom-pr-ledger-v1";
const MAX_COMMAND_BYTES = 200_000;
const ANSWER_CHARS = 400;
/** Characters of the prior ledger's registry one command prints (a command report holds 65,536 bytes). */
const PRIOR_CHUNK = 30_000;

export interface LedgerHead {
  sha: string;
  base: string | undefined;
  files: number;
  commits: number;
  facts: number;
  reported: true;
  reviewed: false;
}

export interface LedgerQa {
  id: string;
  type: string;
  /** The question's stable key (design §9.4): its type and subject, which maps the same question on a later head to this id. */
  key: string;
  symbol: string | null;
  item: string;
  status: string;
  answer: string;
  state: "open";
  history: Array<{ answer: string; status: string }>;
}

export interface LedgerInput {
  pr: PullRequest;
  base: string | undefined;
  files: number;
  commits: number;
  facts: number;
  questions: readonly Question[];
  answers: readonly FinalAnswer[];
  purposes: readonly PurposeRecord[];
}

/** The ledger's `ledger.json` after this head's report and Q&A, keeping the heads a prior ledger listed. */
export function ledgerJson(i: LedgerInput, prior: unknown): string {
  const priorHeads = isObject(prior) && Array.isArray(prior.heads) ? (prior.heads as LedgerHead[]).filter((h) => isObject(h) && typeof h.sha === "string" && h.sha !== i.pr.head) : [];
  const answers = new Map(i.answers.map((a) => [a.question, a] as const));
  const current = new Set(i.questions.map((q) => q.id));
  // Questions an earlier head asked and this one did not stay in the ledger (id and key), so their ids are never reused; the posted items stay too.
  const carried = isObject(prior) && Array.isArray(prior.qa) ? (prior.qa as unknown[]).filter((q) => isObject(q) && typeof q.id === "string" && !current.has(q.id)) : [];
  const findings = isObject(prior) && Array.isArray(prior.findings) ? prior.findings : [];
  const head: LedgerHead = { sha: i.pr.head, base: i.base, files: i.files, commits: i.commits, facts: i.facts, reported: true, reviewed: false };
  return JSON.stringify({
    schema: LEDGER_SCHEMA,
    pull: { owner: i.pr.owner, repo: i.pr.repo, number: i.pr.number },
    heads: [...priorHeads, head],
    purposes: i.purposes,
    qa: [
      ...i.questions.map((q): LedgerQa => {
        const a = answers.get(q.id);
        return { id: q.id, type: q.type, key: q.stable ?? "", symbol: q.symbol ?? q.fn ?? null, item: q.item, status: a?.status ?? "unanswered", answer: (a?.answer ?? "").slice(0, ANSWER_CHARS), state: "open", history: a?.history ?? [] };
      }),
      ...carried,
    ],
    findings,
  });
}

export function ledgerMarkdown(i: LedgerInput): string {
  const by = (s: string): number => i.answers.filter((a) => a.status === s).length;
  return [
    `# ${i.pr.owner}/${i.pr.repo}#${i.pr.number}`,
    "",
    `Head ${i.pr.head}${i.base !== undefined ? ` on base ${i.base}` : ""}: report and Q&A recorded (${i.questions.length} questions: ${by("answered")} answered, ${by("partially answered")} partially answered, ${by("needs author")} needs author).`,
    "",
    "The files beside this one are the latest report.json and qa.json; `git log -p` on this ref is the pull request's history.",
    "",
  ].join("\n");
}

const WRITE_TAIL =
  String.raw`c=$(git -c core.hooksPath=/dev/null hash-object -w ` +
  QA_JSON +
  String.raw`)
d=$(git -c core.hooksPath=/dev/null hash-object -w ` +
  REPORT_JSON +
  String.raw`)
e=$(git -c core.hooksPath=/dev/null hash-object -w ` +
  NECESSITY_JSON +
  String.raw`)
tree=$(printf '100644 blob %s\tledger.json\n100644 blob %s\tledger.md\n100644 blob %s\tnecessity.json\n100644 blob %s\tqa.json\n100644 blob %s\treport.json\n' "$a" "$b" "$e" "$c" "$d" | git -c core.hooksPath=/dev/null mktree)
expect="$old"
if [ "$old" = absent ]; then
  expect=$(git hash-object --stdin </dev/null | tr '0-9a-f' '0')
  new=$(git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit-tree "$tree" -m "$msg")
else
  new=$(git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit-tree "$tree" -p "$old" -m "$msg")
fi
if git -c core.hooksPath=/dev/null update-ref "$ref" "$new" "$expect"; then echo "advanced $new"; else echo "ledger moved" >&2; exit ` +
  String(LEDGER_MOVED) +
  String.raw`; fi`;

export const GIT_IDENTITY = "export GIT_AUTHOR_NAME=graphloom GIT_AUTHOR_EMAIL=graphloom@localhost GIT_COMMITTER_NAME=graphloom GIT_COMMITTER_EMAIL=graphloom@localhost";

const WRITE =
  String.raw`set -eu; ref="$1"; old="$2"; msg="$3"; n="$4"; shift 4
json=""; while [ "$n" -gt 0 ]; do json="$json$1"; shift; n=$((n - 1)); done
md=""; for part in "$@"; do md="$md$part"; done
` +
  GIT_IDENTITY +
  String.raw`
a=$(printf '%s' "$json" | git -c core.hooksPath=/dev/null hash-object -w --stdin)
b=$(printf '%s' "$md" | git -c core.hooksPath=/dev/null hash-object -w --stdin)
` +
  WRITE_TAIL;

/** The same write for a ledger.json and ledger.md too large for one command: they were written as part sets (design §6.6) and are read from their files. */
const WRITE_FILES =
  String.raw`set -eu; ref="$1"; old="$2"; msg="$3"; jsonfile="$5"; mdfile="$6"
` +
  GIT_IDENTITY +
  String.raw`
a=$(git -c core.hooksPath=/dev/null hash-object -w "$jsonfile")
b=$(git -c core.hooksPath=/dev/null hash-object -w "$mdfile")
` +
  WRITE_TAIL;

/** What the ledger commit is for, as its message says. */
export const ledgerMessage = (pr: PullRequest): string => `pr-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: report and Q&A`;

/**
 * Advances the ledger ref by compare-and-swap from `old`, the value Fetch
 * read (`absent` when it read none), with a commit holding the ledger files
 * and the worktree's report.json and qa.json. Undefined when the files do not
 * fit one command.
 */
export function ledgerWriteCommand(pr: PullRequest, old: string, json: string, markdown: string): EnvironmentCommand | undefined {
  const parts = writeChunks(json);
  const md = writeChunks(markdown);
  const argv = ["sh", "-c", WRITE, COMMAND.ledgerWrite, ledgerRef(pr.owner, pr.repo, pr.number), old, ledgerMessage(pr), String(parts.length), ...parts, ...md];
  if (argv.length > 64 || Buffer.byteLength(JSON.stringify(argv), "utf8") > MAX_COMMAND_BYTES) return undefined;
  return { id: COMMAND.ledgerWrite, argv };
}

/**
 * What advancing the ledger takes: the commands that first write the ledger files when they do not fit one command
 * (a part set each, design §6.6), then the compare-and-swap itself. Undefined only for a ledger no part set can carry.
 */
export function ledgerWriteCommands(pr: PullRequest, old: string, json: string, markdown: string): { parts: EnvironmentCommand[]; write: EnvironmentCommand } {
  const single = ledgerWriteCommand(pr, old, json, markdown);
  if (single !== undefined) return { parts: [], write: single };
  const parts = [...partCommands(PART_BASE.ledgerJson, LEDGER_JSON_FILE, json), ...partCommands(PART_BASE.ledgerMd, LEDGER_MD_FILE, markdown)];
  const argv = ["sh", "-c", WRITE_FILES, COMMAND.ledgerWrite, ledgerRef(pr.owner, pr.repo, pr.number), old, ledgerMessage(pr), "files", LEDGER_JSON_FILE, LEDGER_MD_FILE, sha256(json), sha256(markdown)];
  return { parts, write: { id: COMMAND.ledgerWrite, argv } };
}

/** The ledger files a `ledger-write` argv carried (empty for a write that reads them from part-set files). */
export function writtenLedger(argv: readonly string[]): { ref: string; old: string; json: string; markdown: string; files?: { json: string; markdown: string } } | undefined {
  if (argv[3] !== COMMAND.ledgerWrite) return undefined;
  if (argv[7] === "files") return { ref: argv[4] ?? "", old: argv[5] ?? "", json: "", markdown: "", files: { json: argv[10] ?? "", markdown: argv[11] ?? "" } };
  const n = Number(argv[7]);
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  return { ref: argv[4] ?? "", old: argv[5] ?? "", json: argv.slice(8, 8 + n).join(""), markdown: argv.slice(8 + n).join("") };
}

/**
 * The part of the prior `ledger.json` a new ledger keeps: its schema, its heads, its questions' ids and keys (not their answers)
 * and its posted items, which a later run continues from (design §9) and this ledger carries on. A large run's ledger is mostly its
 * Q&A (a #1445-sized one passed 89 KB), past what a command report holds whole, so the command prints only these
 * (`node` reads the JSON; git's own status fails the command, since a pipe would hide it).
 */
const PRIOR_EXTRACT = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const v=JSON.parse(s);const c=(t)=>typeof t==="string"&&t.length>4000?t.slice(0,4000):t;
const qa=(Array.isArray(v.qa)?v.qa:[]).map((q)=>({id:q.id,type:q.type,key:q.key,symbol:q.symbol,item:q.item,status:q.status,state:q.state}));
const findings=(Array.isArray(v.findings)?v.findings:[]).map((f)=>({...f,body:c(f.body),text:c(f.text)}));
const r=JSON.stringify({schema:v.schema,heads:v.heads,qa,findings}).replace(/[\u007f-\uffff]/g,(m)=>"\\u"+m.charCodeAt(0).toString(16).padStart(4,"0"));
const n=Math.max(1,Math.ceil(r.length/${PRIOR_CHUNK}));const k=Number(process.argv[1]);
const h=require("crypto").createHash("sha256").update(r).digest("hex");
process.stdout.write("graphloom-prior "+k+" "+n+" "+h+"\n"+r.slice(k*${PRIOR_CHUNK},(k+1)*${PRIOR_CHUNK}))})`;

/**
 * Reads the prior ledger's registry (its schema, heads, question keys and posted items), part `k` of it. A ledger past what one
 * command report holds is read in parts: each command prints a header (`graphloom-prior <k> <parts> <sha256 of the whole>`) and
 * its slice of the registry's ASCII-only JSON, recomputed from the same commit each time, and `priorState` joins them and checks the
 * digest. `node` is the Node binary to run (the plugin's own).
 */
export const priorShowCommand = (old: string, node = "node", k = 0): EnvironmentCommand => ({
  id: k === 0 ? COMMAND.ledgerPrior : `${COMMAND.ledgerPrior}-${k}`,
  argv: ["sh", "-c", 'set -eu; j=$(git -c core.hooksPath=/dev/null show "$1:ledger.json"); printf \'%s\' "$j" | "$2" -e "$3" "$4" > "$GRAPHLOOM_REPORT_FILE"', COMMAND.ledgerPrior, old, node, PRIOR_EXTRACT, String(k)],
});

/** What part `k` of a registry's JSON (ASCII only) prints, as `priorShowCommand` does: for the stand-ins of a rehearsal and for tests. */
export function priorChunkText(registryJson: string, k: number): string {
  const n = Math.max(1, Math.ceil(registryJson.length / PRIOR_CHUNK));
  return `graphloom-prior ${k} ${n} ${sha256(registryJson)}\n${registryJson.slice(k * PRIOR_CHUNK, (k + 1) * PRIOR_CHUNK)}`;
}

export interface LedgerReading {
  ledger: Ledger;
  /** The record of the read: later writes and reads of the prior are judged against it. */
  run: CommandRun;
}

/** The ledger value the latest `ledger-read` saw. */
export function ledgerRead(evidence: readonly EvidenceRecord[]): LedgerReading | undefined {
  const run = commandRuns(evidence, COMMAND.ledger).at(-1);
  if (run === undefined || !succeeded(run.command)) return undefined;
  const ledger = parseLedger(reportText(run).text);
  return ledger === undefined ? undefined : { ledger, run };
}

export const oldValue = (l: Ledger): string => (l.present ? l.sha : "absent");

export type PriorLedger =
  | { state: "absent" }
  /** Not read whole yet: the commands that read what is missing (the first part, then every later one). */
  | { state: "missing"; next: EnvironmentCommand[] }
  | { state: "read"; value: unknown }
  | { state: "unreadable"; reason: string; run: CommandRun };

/** The most parts one job reads. */
const PRIOR_PARTS_PER_JOB = 16;

/**
 * The prior ledger's registry as the `ledger-prior` commands read it from the commit the write swaps from: the first part says how
 * many there are and the digest of the whole, the others follow, and the joined text must match the digest. A ledger that is there and
 * cannot be read whole is never replaced by one that forgets its heads.
 */
export function priorState(evidence: readonly EvidenceRecord[], old: string, node = process.execPath): PriorLedger {
  if (old === "absent") return { state: "absent" };
  const runs = commandRuns(evidence).filter((r) => r.command.argv[3] === COMMAND.ledgerPrior && r.command.argv[4] === old);
  const part = (k: number): CommandRun | undefined => runs.filter((r) => r.command.argv[7] === String(k)).at(-1);
  const first = part(0);
  if (first === undefined) return { state: "missing", next: [priorShowCommand(old, node, 0)] };
  const text = (run: CommandRun): { text: string } | { problem: string } => {
    if (!succeeded(run.command)) return { problem: `reading ${old.slice(0, 12)}:ledger.json exited ${run.command.exitCode ?? "on a signal"}` };
    const report = reportText(run);
    return report.truncated ? { problem: "a part of ledger.json did not fit the command report" } : { text: report.text };
  };
  const split = (t: string): { k: number; n: number; digest: string; body: string } | undefined => {
    const m = /^graphloom-prior (\d+) (\d+) ([0-9a-f]{64})\n/.exec(t);
    return m === null ? undefined : { k: Number(m[1]), n: Number(m[2]), digest: m[3]!, body: t.slice(m[0].length) };
  };
  const head = text(first);
  if ("problem" in head) return { state: "unreadable", reason: head.problem, run: first };
  const h = split(head.text);
  if (h === undefined || h.k !== 0 || h.n < 1) return { state: "unreadable", reason: "the first part of ledger.json carries no header", run: first };
  const bodies = [h.body];
  const missing: EnvironmentCommand[] = [];
  for (let k = 1; k < h.n; k += 1) {
    const run = part(k);
    if (run === undefined) {
      missing.push(priorShowCommand(old, node, k));
      continue;
    }
    const t = text(run);
    if ("problem" in t) return { state: "unreadable", reason: t.problem, run };
    const p = split(t.text);
    if (p === undefined || p.k !== k || p.n !== h.n || p.digest !== h.digest) return { state: "unreadable", reason: `part ${k} of ledger.json is not of the same read`, run };
    bodies[k] = p.body;
  }
  if (missing.length > 0) return { state: "missing", next: missing.slice(0, PRIOR_PARTS_PER_JOB) };
  const whole = bodies.join("");
  if (sha256(whole) !== h.digest) return { state: "unreadable", reason: "the parts of ledger.json do not match their digest", run: first };
  try {
    const value: unknown = JSON.parse(whole);
    if (!isObject(value) || value.schema !== LEDGER_SCHEMA) return { state: "unreadable", reason: `it is not a ${LEDGER_SCHEMA} document`, run: first };
    return { state: "read", value };
  } catch {
    return { state: "unreadable", reason: "it is not JSON", run: first };
  }
}
