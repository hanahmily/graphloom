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
 * heads the ledger has seen.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { parseLedger, type Ledger } from "./commands.js";
import { COMMAND, LEDGER_MOVED, QA_JSON, REPORT_JSON, ledgerRef } from "./constants.js";
import { commandRuns, isObject, reportText, succeeded, type CommandRun } from "./evidence.js";
import type { FinalAnswer } from "./answers.js";
import type { PurposeRecord, Question } from "./questions.js";
import type { PullRequest } from "./request.js";
import { writeChunks } from "./write.js";

export const LEDGER_SCHEMA = "graphloom-pr-ledger-v1";
const MAX_COMMAND_BYTES = 200_000;
const ANSWER_CHARS = 400;

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
  const head: LedgerHead = { sha: i.pr.head, base: i.base, files: i.files, commits: i.commits, facts: i.facts, reported: true, reviewed: false };
  return JSON.stringify({
    schema: LEDGER_SCHEMA,
    pull: { owner: i.pr.owner, repo: i.pr.repo, number: i.pr.number },
    heads: [...priorHeads, head],
    purposes: i.purposes,
    qa: i.questions.map((q): LedgerQa => {
      const a = answers.get(q.id);
      return { id: q.id, type: q.type, symbol: q.symbol ?? q.fn ?? null, item: q.item, status: a?.status ?? "unanswered", answer: (a?.answer ?? "").slice(0, ANSWER_CHARS), state: "open", history: a?.history ?? [] };
    }),
    findings: [],
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

const WRITE = String.raw`set -eu; ref="$1"; old="$2"; msg="$3"; n="$4"; shift 4
json=""; while [ "$n" -gt 0 ]; do json="$json$1"; shift; n=$((n - 1)); done
md=""; for part in "$@"; do md="$md$part"; done
export GIT_AUTHOR_NAME=graphloom GIT_AUTHOR_EMAIL=graphloom@localhost GIT_COMMITTER_NAME=graphloom GIT_COMMITTER_EMAIL=graphloom@localhost
a=$(printf '%s' "$json" | git -c core.hooksPath=/dev/null hash-object -w --stdin)
b=$(printf '%s' "$md" | git -c core.hooksPath=/dev/null hash-object -w --stdin)
c=$(git -c core.hooksPath=/dev/null hash-object -w ` +
  QA_JSON +
  String.raw`)
d=$(git -c core.hooksPath=/dev/null hash-object -w ` +
  REPORT_JSON +
  String.raw`)
tree=$(printf '100644 blob %s\tledger.json\n100644 blob %s\tledger.md\n100644 blob %s\tqa.json\n100644 blob %s\treport.json\n' "$a" "$b" "$c" "$d" | git -c core.hooksPath=/dev/null mktree)
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

/** The ledger files a `ledger-write` argv carried. */
export function writtenLedger(argv: readonly string[]): { ref: string; old: string; json: string; markdown: string } | undefined {
  const n = Number(argv[7]);
  if (argv[3] !== COMMAND.ledgerWrite || !Number.isSafeInteger(n) || n < 0) return undefined;
  return { ref: argv[4] ?? "", old: argv[5] ?? "", json: argv.slice(8, 8 + n).join(""), markdown: argv.slice(8 + n).join("") };
}

/** Reads the prior ledger's `ledger.json`, so the new one keeps its heads. */
export const priorShowCommand = (old: string): EnvironmentCommand => ({
  id: COMMAND.ledgerPrior,
  argv: ["sh", "-c", 'set -eu; git -c core.hooksPath=/dev/null show "$1:ledger.json" > "$GRAPHLOOM_REPORT_FILE"', COMMAND.ledgerPrior, old],
});

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

/** The prior `ledger.json`, parsed, when the latest `ledger-prior` read it after the latest ledger read; undefined when it could not be read or is not JSON. */
export function priorLedger(evidence: readonly EvidenceRecord[], old: string): unknown {
  const run = commandRuns(evidence, COMMAND.ledgerPrior).filter((r) => r.command.argv[4] === old).at(-1);
  if (run === undefined || !succeeded(run.command)) return undefined;
  try {
    return JSON.parse(reportText(run).text);
  } catch {
    return undefined;
  }
}
