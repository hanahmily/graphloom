// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The arbiter's assignment (docs/design-issue-fix-graph.md, "The arbiter"):
 * a fresh read-only session that never wrote, reviewed or verified the
 * change rules on one design point, from the issue, its thread, the pinned
 * documents and the candidate code, and returns `design-ruling-v1`.
 */
import { contextPrompt, type ContextDocument } from "./context.js";
import type { Finding } from "./findings.js";
import type { Issue as TrackedIssue } from "./issues.js";
import { issueIdOf } from "./issues.js";
import { clip, describeComment } from "./ocr.js";
import type { Profile } from "./profile.js";
import type { ParsedVerdict } from "./review-common.js";
import { MAX_PROOF_TESTS, MAX_RULING_CITES } from "./rulings.js";
import { describeTest } from "./test-first.js";

export interface ArbiterInputs {
  /** `owner/repo#N`. */
  issue: string;
  /** The issue snapshot with its comments, as the run pinned it. */
  snapshot: string;
  commentCount: number;
  finding: Finding;
  /** Every verifier verdict on the finding, oldest first, with the candidate it judged. */
  verdicts: Array<{ digest: string; ref: string; verdict: ParsedVerdict }>;
  /** The finding's issue in the issues file, with the fixer's argument when it contests it. */
  issueEntry?: TrackedIssue;
  /** The rulings that hold, described. */
  rulings: string[];
  /** The paths the candidate changes. */
  changed: string[];
  /** The source names a design statement may give. */
  sources: string[];
  context?: ContextDocument[];
}

const RESULT = [
  "Your result, `design-ruling-v1`:",
  "- `finding`: the finding you rule on, by the name given above (F<n>).",
  "- `ruling`: `implementation-stands` (the finding does not hold against the project's design; the change stays as it is), `review-stands` (it holds; the change must address it), or `undecidable` (the sources do not settle it; the operator rules).",
  "- `summary`: one paragraph: what the design says on this point and why that decides it.",
  `- \`design\`: 1 to ${MAX_RULING_CITES} design statements, each \`{source, quote, says}\`: \`source\` is one of the source names above, \`quote\` is copied exactly from that text (at least 8 characters; whitespace may differ), and \`says\` is what it establishes for this point. Quote the issue, its thread or a pinned document: your own view of good design is not a ruling.`,
  `- \`code\`: 1 to ${MAX_RULING_CITES} lines of the current code, each \`{path, line, quote}\`: the path relative to the repository root, the line number in the current file, and the text copied from that line.`,
  `- \`proofTests\`: 0 to ${MAX_PROOF_TESTS} tests that show the point, each \`{path, name, content, expect, shows}\`: a new test file at a test path the change does not touch, the test's name as the regression runner selects it, the whole file's content, whether it must \`fail\` or \`pass\` on the current code, and what that shows. You may try them in the run's scratch directory; only the controller's run in a clean checkout of the change counts. A \`fail\` must fail by assertion, not by a build error, a panic or a timeout.`,
  "- `undecidable`: for an `undecidable` ruling, `{question, implementation, review}`: the question for the operator and the best case for each side; for any other ruling, the three as empty strings.",
];

/** The assignment for one design point. */
export function arbiterInstruction(profile: Profile, args: ArbiterInputs): string {
  const f = args.finding;
  const id = issueIdOf(f.id);
  const contested = args.issueEntry?.history.filter((h) => h.actor === "fixer" && h.to === "design-conflict").at(-1);
  const history = (args.issueEntry?.history ?? []).map((h) => `- round ${h.round}, ${h.actor}: ${h.from ?? "new"} → ${h.to}${h.note !== "" ? `: ${clip(h.note.replace(/\s+/g, " "), 600)}` : ""}`);
  const unreproduced = f.state === "disputed" ? f.unreproduced : undefined;
  const raised =
    unreproduced !== undefined
      ? "which the verifier confirmed as a behavioral defect but the implementer could not reproduce with a test that fails on the change"
      : f.designBasis !== undefined || contested === undefined
        ? "which the code review raised and an independent verifier could not settle on the code alone"
        : "which the implementer contests as contradicting the project's design";
  return [
    `You are an independent arbiter of a design question about the uncommitted change in this worktree (${profile.project}), which fixes ${args.issue}. You did not write, review or verify the change. Do not modify any file in the worktree. Read the code with your file tools.`,
    "",
    `The point: finding ${f.id} (issue ${id}), ${raised}. Decide whether it holds against the project's design, as the issue, its discussion and the pinned documents state it.`,
    "",
    "The finding, as the code reviewer raised it:",
    `- ${describeComment(f.original ?? f.comment)}`,
    ...(f.comment.evidence !== undefined ? [`  Reviewer's failure scenario: ${clip(f.comment.evidence, 1_500)}`] : []),
    ...(f.original !== undefined ? [`  Its latest occurrence: ${describeComment(f.comment)}`] : []),
    ...(f.note !== undefined ? [`  The reviewer's latest word (${f.note.status}): ${clip(f.note.reason, 1_200)}`] : []),
    "",
    "Every verdict of the independent verifier on it:",
    ...(args.verdicts.length > 0
      ? args.verdicts.map(
          ({ digest, ref, verdict }) =>
            `- ${verdict.verdict}${verdict.designLevel === true ? ", at the design level" : ""} (candidate ${digest.slice(0, 8)}, ${ref}): ${clip(verdict.reason, 1_200)}${verdict.designBasis !== undefined && verdict.designBasis !== "" ? ` Design basis: ${clip(verdict.designBasis, 600)}` : ""}${verdict.quotes.length > 0 ? ` Witness: ${verdict.quotes.slice(0, 4).map((q) => `${q.path}:${q.line} \`${clip(q.text, 160)}\``).join("; ")}` : ""}`,
        )
      : ["- none recorded"]),
    ...(contested !== undefined ? ["", "The implementer's argument for contesting it:", clip(contested.note, 2_000)] : []),
    ...(unreproduced !== undefined
      ? [
          "",
          "Behavioral findings are fixed test-first: before changing code, the implementer must add a test that fails by assertion on the reviewed change. For this finding it reported this attempt instead:",
          `- What it tried: ${clip(unreproduced.attempt || "not described", 1_500)}`,
          `- The test it wrote: ${unreproduced.test !== undefined ? describeTest(unreproduced.test) : "none"}`,
          `- What it observed: ${clip(unreproduced.observed || "nothing reported", 1_500)}`,
          "Rule `review-stands` when the finding is a real defect of the change: give a proof test that must `fail` and fails by assertion on the current code; it becomes the finding's regression test, which the implementer must then add unchanged and make pass. Rule `implementation-stands` when the finding does not hold.",
        ]
      : []),
    ...(history.length > 0 ? ["", `The issue's history in the run's issues file:`, ...history] : []),
    "",
    ...(args.rulings.length > 0 ? ["Design rulings that already hold in this run; do not contradict them:", ...args.rulings.map((r) => `- ${r}`), ""] : []),
    ...(args.changed.length > 0 ? ["The files the change touches (a proof test goes to a new file, not one of these):", ...args.changed.map((p) => `- ${p}`), ""] : []),
    `The texts the run pinned, by the source name a design statement gives: ${args.sources.join(", ")}. \`issue\` is the issue's title and body, \`comment:<n>\` its nth comment in the snapshot below, \`doc:<name>\` a context document by its name${args.sources.includes("principles") ? ", and `principles` the project's design principles file (among the documents below)" : ""}.`,
    "",
    "Issue snapshot, the authority for this run:",
    args.snapshot,
    ...contextPrompt(args.context),
    "",
    `Test files in this repository end in ${profile.testPaths.suffixes.join(", ")}${(profile.testPaths.directories ?? []).length > 0 ? ` or live under ${profile.testPaths.directories!.join(", ")}` : ""}; the regression runner is ${profile.runner.id}. ${profile.runner.testFieldHelp}.`,
    "",
    ...RESULT,
  ].join("\n");
}

/** The revision: the arbiter's own session continues once with what did not verify. */
export function arbiterRevisionInstruction(args: { problems: string[]; proofRuns: string[]; sources: string[] }): string {
  return [
    "Your ruling did not verify. The controller found:",
    ...args.problems.map((p) => `- ${p}`),
    ...(args.proofRuns.length > 0 ? ["", "Your proof tests, as the controller ran them in a clean checkout of the change:", ...args.proofRuns.map((r) => `- ${r}`)] : []),
    "",
    `Correct the ruling and return the whole design-ruling-v1 result again: \`finding\`, \`ruling\`, \`summary\`, \`design\`, \`code\`, \`proofTests\` and \`undecidable\`. Quote design statements exactly from these sources: ${args.sources.join(", ")}. If the sources do not settle the point, rule \`undecidable\` with the question and both cases. This is your one revision: a ruling that still does not verify goes to the operator.`,
  ].join("\n");
}
