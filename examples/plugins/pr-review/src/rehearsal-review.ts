// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The review layer's part of the rehearsal scenarios (design §16): how the three aspect reviewers and their verifiers
 * reply. A scenario is data. The replies are consumed in the order the graph asks for them: each aspect's passes
 * (correctness, maintainability, security), and each aspect's verification after the pass that raised findings.
 */
import type { RehearsalReply, RehearsalScenario } from "@graphloom/sdk";
import { REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME, quotePrefix, type ReviewComment } from "./review.js";
import { NO_REPRO, sha256, type ReproLanguage, type RunOutcome } from "./repro.js";

/** One scripted run of a reproducing test, as the sandbox script would report it (design §8.2). */
export interface ScriptedRun {
  outcome: RunOutcome;
  /** Where a failing assertion was reported, in the test's own file (a line number), or the whole `<file>:<line>`. */
  at?: string | number;
  /** A panic's frames in the repository (`path:line`). */
  frames?: string[];
  message?: string;
}

/**
 * The stand-in sandbox's result for the command that runs a finding's test: a `graphloom-repro-v1` report for the test text the
 * reviewer wrote, with the given outcome for each run. `sha256` and `file` are what the script would write unless given.
 */
export function reproStub(finding: string, language: ReproLanguage, text: string, runs: readonly ScriptedRun[], over: { sha256?: string; file?: string } = {}): { exitCode: number; stdout: string } {
  const file = over.file ?? (language === "go" ? `graphloom_repro_${finding}_test.go` : `graphloom-repro-${finding}.test.ts`);
  const lines = [`graphloom-repro-v1 ${language}`, `finding ${finding}`, `sha256 ${over.sha256 ?? sha256(text)}`, `file ${file}`];
  runs.forEach((r, i) => {
    const n = i + 1;
    lines.push(`run ${n} ${r.outcome}`);
    if (r.at !== undefined) lines.push(`at ${n} ${typeof r.at === "number" ? `${file}:${r.at}` : r.at}`);
    for (const f of r.frames ?? []) lines.push(`frame ${n} ${f}`);
    if (r.message !== undefined) lines.push(`message ${n} ${r.message}`);
  });
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

/** The image check that says the Go sandbox is there: the rehearsal has no Docker, so a scenario that runs tests says it does. */
export const SANDBOX_GO_READY = { "sandbox-go": { exitCode: 0, stdout: "ready\n" } };

/** A scripted comment: the fields of a review comment, any of them left to its default, and the values untyped so a scenario can also script a wrong one. */
export interface ScriptedComment {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  [field: string]: unknown;
}

const comment = (c: ScriptedComment): ReviewComment => ({
  side: "RIGHT",
  aspect: "correctness",
  kind: "behavioral",
  severity: "P2",
  suggestion: "",
  finding: "",
  evidence: "read the function and its callers",
  distinct: false,
  principle: "",
  repro: NO_REPRO,
  ...c,
} as ReviewComment);

/** A pass's reply: the comments, a summary that says every one of the `total` files was reviewed, and the judgments of the earlier findings it was given (none by default). */
export const passReply = (total: number, comments: readonly ScriptedComment[], prior: ReadonlyArray<{ finding: string; status: "still_present" | "fixed"; reason?: string }> = []): RehearsalReply => ({
  output: { comments: comments.map(comment), summary: { total_files: total, reviewed_files: total, skipped: [] }, prior: prior.map((p) => ({ reason: "read the code at its place on this head", ...p })) },
});

export interface ScriptedVerdict {
  finding: string;
  verdict?: "confirmed" | "refuted" | "uncertain";
  kind?: "behavioral" | "non-behavioral";
  witness?: string;
  quotes?: Array<{ path: string; line: number; text: string }>;
  reason?: string;
  fixes?: boolean;
  test?: { demonstrates: boolean; reason: string };
}

export const verifyReply = (verdicts: readonly ScriptedVerdict[]): RehearsalReply => ({
  output: { verdicts: verdicts.map((v) => ({ verdict: "confirmed", kind: "behavioral", witness: "", quotes: [], reason: "checked against the code", fixes: false, test: { demonstrates: false, reason: "no test" }, ...v })) },
});

/** What the review replies are about: the scope's size and the file the findings sit in (a Go file of the pull request). */
export interface ReviewScript {
  total: number;
  path: string;
}

/**
 * The default review of the `review-layer` scenario: correctness raises a P1 that the verifier confirms and a P2 it refutes
 * (the dismissal), so a second pass runs and raises nothing; maintainability raises a non-behavioral P2 that is confirmed,
 * with a second empty pass; security raises nothing.
 */
export function reviewScenarioParts(s: ReviewScript): Pick<RehearsalScenario, "results" | "commands"> {
  const results: RehearsalScenario["results"] = {
    [REVIEW_SCHEMA_NAME]: [
      passReply(s.total, [
        { path: s.path, start_line: 26, end_line: 30, severity: "P1", content: "The 'w' unit case is unreachable: the loop returns errUnit for any other letter than d or h, so a week never parses and 7w is refused.", suggestion: "\tcase 'd':\n\t\tn *= 24" },
        { path: s.path, start_line: 8, end_line: 9, severity: "P2", content: "unit is read before it is set when the string has no letter, so a bare number is accepted as hours." },
      ]),
      passReply(s.total, []),
      passReply(s.total, [{ path: s.path, start_line: 14, end_line: 16, aspect: "maintainability", kind: "non-behavioral", severity: "P2", content: "The loop that adds 0+1+2 to n has no purpose a reader can find; remove it or say what it is for." }]),
      passReply(s.total, []),
      passReply(s.total, []),
    ],
    [VERIFY_SCHEMA_NAME]: [
      verifyReply([
        { finding: "F1", verdict: "confirmed", witness: `${s.path}:15`, reason: "ParseTTL returns errUnit for 'w', so 7w is refused.", fixes: false },
        { finding: "F2", verdict: "refuted", quotes: [{ path: s.path, line: 7, text: "unit := byte(0)" }], reason: "n starts at 0 and unit stays 0, which the switch leaves alone: a bare number is hours by contract." },
      ]),
      verifyReply([{ finding: "F3", verdict: "confirmed", kind: "non-behavioral", witness: `${s.path}:14`, reason: "the loop adds a constant that nothing uses.", fixes: true }]),
    ],
  };
  // The refutation of F2 in the first correctness pass: its one quote is shown by the head.
  const commands: NonNullable<RehearsalScenario["commands"]> = { [`${quotePrefix("correctness", 1)}-1`]: { exitCode: 0, stdout: "1 ok\nchecked 1\n" } };
  return { results, commands };
}
