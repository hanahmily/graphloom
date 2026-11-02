// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The assignments of an aspect reviewer and its verifier (design §8.1). Pull request content is data, and nothing else
 * reaches a reviewer: it starts a fresh session seeded with review.md only. An assignment is fitted to the executor's bound
 * like every other: bulk input is a file the agent reads (written before the job), the rest is a compact index.
 */
import { ASPECT_TEXT, type Aspect, type RuleGroup } from "./aspects.js";
import { clipText, fitLines, reviewFile, shrinkToFit, spillOf, type FileSpill, type Fitted } from "./fit.js";
import { feedbackBlock, pullText, UNTRUSTED_PREAMBLE } from "./prompts.js";
import type { NecessityRecord } from "./necessity.js";
import { principlesFrom, type Principle, type PrinciplesContext } from "./principles.js";
import { fitPrinciples, howToRead } from "./qaprompts.js";
import type { PullRequest } from "./request.js";
import { MAX_SUGGESTION_LINES, type Finding } from "./review.js";
import type { Snapshot } from "./snapshot.js";

/** What a reviewer does after the per-file review: the change as a whole, across files (the defects a file-by-file review misses). */
export const WHOLE_CHANGE_CHECK =
  "Then, with every file's diff read, check the change as a whole, across files: data passed between modules (a value one side produces with a shape, unit, order, size or guarantee the other does not expect; a field written but never read, or read on a path that never writes it), a change to a shared contract that its other callers or its tests do not follow, and a documented behavior the change no longer keeps.";

/** One pass reports a problem once. */
export const DEDUPE_RULE =
  "Report each problem once. The cross-file check adds only problems that none of your per-file comments and none of the findings listed below already describes. When it finds one of those again, either leave it out or name it in `finding`; never raise it a second time as new.";

/** What round 1 concluded of each principle, for a reviewer who looks for the code-level breaks it did not cite. */
export interface PrincipleRound1 {
  verdict: string;
  /** The answer checker's judgment of that verdict; absent when it gave none. */
  checker?: string;
}

/** N1's verdict and the checker's judgment for each principle, from `necessity.json` (nothing when N1 recorded none). */
export function round1Verdicts(r: NecessityRecord | undefined): Map<string, PrincipleRound1> {
  const checks = new Map((r?.final.check.principles ?? []).map((c) => [c.id, c.verdict] as const));
  return new Map((r?.final.necessity?.principles ?? []).map((p) => [p.id, { verdict: p.verdict, ...(checks.has(p.id) ? { checker: checks.get(p.id)! } : {}) }] as const));
}

const SEVERITY_TEXT = "P0: data loss, a security hole or a crash on a normal path; P1: a defect that makes a documented behavior wrong; P2: a minor defect or a maintainability problem worth fixing; P3: a nit, which is not verified or posted.";

export interface ReviewerAssignment {
  pr: PullRequest;
  snapshot: Pick<Snapshot, "pull" | "commits">;
  aspect: Aspect;
  pass: number;
  /** The scope in the order to read it: the files that matter most first. */
  files: readonly string[];
  /** How the scope was decided, in one line (`the whole pull request`, `areas A3, A17 that the briefing cites`). */
  scopeLine: string;
  groups: readonly RuleGroup[];
  /** Findings already raised in this review, which a pass must not raise again. */
  known: readonly Finding[];
  feedback: readonly string[];
  /** The project's design principles that apply to this scope (design §8.1), when the profile names a file and one applies. */
  principles?: PrinciplesContext | undefined;
  /** What round 1 (N1 and its checker) concluded of each principle. */
  round1?: ReadonlyMap<string, PrincipleRound1> | undefined;
  baseDir?: string | undefined;
  reviewDir?: string | undefined;
}

const KNOWN_INLINE_CHARS = 8_000;
const FILES_INLINE_CHARS = 16_000;

const lineOf = (f: Finding): string => `${f.id} [${f.aspect}, ${f.kind}, ${f.severity}, ${f.state}] ${f.path}:${f.startLine}-${f.endLine} (${f.side === "RIGHT" ? "head" : "base"}): ${clipText(f.content, 240)}`;

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/** The principles block of a reviewer's assignment, empty when none applies to its scope (the assignment then says nothing of principles). */
function principleBlock(c: PrinciplesContext | undefined, round1: ReadonlyMap<string, PrincipleRound1> | undefined, scale: number): string[] {
  if (c === undefined || c.read.file === "absent" || c.applicable.length === 0) return [];
  const verdict = (id: string): string => {
    const v = round1?.get(id);
    return v === undefined ? "round 1: no verdict" : `round 1: ${v.verdict}; checker: ${v.checker ?? "no judgment"}`;
  };
  return [
    "",
    `The project's design principles that apply to your scope (from ${c.read.path} at ${principlesFrom(c.read)}). Round 1, the report and its questions, judged the change against them at the design level; its verdict for each is in brackets. Your review is of the code: look for concrete violations in the lines of your scope that round 1 did not cite. A break round 1 already recorded is not raised again unless you cite a different concrete site. A comment that says the change breaks a principle sets \`principle\` to its id, cites the violating lines, and quotes in \`content\` how the code contradicts the statement as written; a principle that is only a matter of taste or that the code does not contradict is not a finding.`,
    ...fitPrinciples(c, (p, short) => `- ${p.id} [${verdict(p.id)}]: ${short ? clipText(p.statement, 500) : oneLine(p.statement)}`, scale),
  ];
}

/** A reviewer's assignment: the aspect, its rule groups and files, and what is known already. */
export function planReviewer(a: ReviewerAssignment): Fitted {
  const t = ASPECT_TEXT[a.aspect];
  return shrinkToFit((scale) => {
    const spills: FileSpill[] = [];
    // The files of each rule group, in reading order across the groups; a long list is a file the reviewer reads.
    const groupLines = a.groups.flatMap((g) => [`- Rule for ${g.path} (${g.files.length} file${g.files.length === 1 ? "" : "s"}): ${g.rule}`]);
    const order = a.files.map((f, i) => `${i + 1}. ${f}`);
    const filesInline = order.join("\n").length <= FILES_INLINE_CHARS * scale;
    const fileList = spillOf("review-files", [`Files in scope for the ${a.aspect} pass, in reading order, with the rule each falls under:`, ...a.groups.flatMap((g) => [`## ${g.path}`, g.rule, ...g.files.map((f) => `- ${f}`)]), "", "## Reading order", ...order].join("\n"));
    if (!filesInline) spills.push(fileList);
    const knownLines = a.known.map(lineOf);
    // Every known finding stays visible to a fresh session: past the inline budget the whole list is a file the reviewer reads.
    const knownFull = spillOf("review-known-findings", a.known.map((f) => lineOf(f)).join("\n"));
    const knownInline = knownLines.join("\n").length <= KNOWN_INLINE_CHARS * scale;
    if (a.known.length > 0 && !knownInline) spills.push(knownFull);
    const fb = feedbackBlock(a.feedback, scale, a.reviewDir);
    spills.push(...fb.spills);
    const principles = principleBlock(a.principles, a.round1, scale);
    const text = [
      `You are the ${a.aspect} reviewer for ${a.pr.owner}/${a.pr.repo}#${a.pr.number} at head ${a.pr.head}, pass ${a.pass}. Review the files in scope for this one aspect, from the head's code and its diff. You are read-only: change nothing, run no code from the repository, and write no test.`,
      "",
      UNTRUSTED_PREAMBLE,
      "",
      `Aspect ${a.aspect}. Focus: ${t.focus} Out of scope: ${t.out} A finding outside this aspect is left out; one you cannot leave out, because it is real and another aspect owns it, is raised with its own \`aspect\` and is verified with yours.`,
      "",
      howToRead(a.baseDir),
      "",
      `Background: ${reviewFile(a.reviewDir, "review.md")} is the report on this pull request and the questions about it with their answers. Read its briefing and the Q&A first: what it states as the purpose, what it says exists already, what it left as needs author. Answered facts (an existing equivalent, a covering test) are context: a finding that restates a Q&A item is folded into it, not raised twice. Files under the schema, interfaces, config and removed sections of the report, and symbols with needs-author questions, come first in the reading order below.`,
      "",
      `Scope: ${a.scopeLine}; ${a.files.length} file${a.files.length === 1 ? "" : "s"}. Review every one and skip none; the files that are removed are read at the base (\`git show HEAD:<path>\`).`,
      ...groupLines,
      ...(filesInline ? ["Reading order:", ...order] : [`The files, with the rule each falls under and the reading order, are listed in ${reviewFile(a.reviewDir, fileList.name)}; read it and review in that order.`]),
      ...principles,
      "",
      `Method: for each file, read its diff and the code around it and review it against its rule. ${WHOLE_CHANGE_CHECK} ${DEDUPE_RULE}`,
      `Each comment in \`comments\` is one problem: path (a file in scope), side (RIGHT for the head, LEFT for the base), start_line and end_line on that side, aspect, kind (behavioral: it claims the code does something wrong; non-behavioral: naming, duplication, structure, coupling, test quality, a committed credential or a risky new dependency; a correctness comment is always behavioral), severity (${SEVERITY_TEXT}), content (what fails, under which input, what to do; concise, citing path:line; no private reasoning), suggestion (replacement lines for exactly the commented RIGHT range, at most ${MAX_SUGGESTION_LINES} lines; "" for none), finding ("" for a new problem, or the id of a listed finding you are confirming still present), evidence (what you read that shows it), and distinct (true only when two of your comments on nearby lines are different problems), principle (${principles.length > 0 ? "the id of the design principle the comment says the change breaks, \"\" for any other comment" : "always \"\""}).`,
      "Behavioral findings are not proven by a test in this version: they are verified by an independent reader, and listed for the maintainer's judgment. State the input and the wrong result so that the verifier can check it against the code.",
      `\`summary\` reports total_files (${a.files.length}), reviewed_files (the files you reviewed; it must equal total_files) and skipped (every file you did not review, with the reason; it must be empty). Return no comment for a file you found nothing in.`,
      ...(a.known.length > 0
        ? [
            "",
            `Findings already raised in this review (do not raise them again):`,
            ...(knownInline
              ? knownLines
              : [
                  `There are ${a.known.length} of them, too many to list in full here: every one, with its id, is in ${reviewFile(a.reviewDir, knownFull.name)}. Read that file first, and do not raise again any finding in it (name it in \`finding\` when you confirm it is still there). The first ones:`,
                  ...fitLines(knownLines, KNOWN_INLINE_CHARS * scale * 0.5, (n) => `… and ${n} more findings, all listed in ${reviewFile(a.reviewDir, knownFull.name)}`),
                ]),
          ]
        : []),
      "",
      pullText(a.snapshot),
      ...(a.feedback.length > 0 ? ["", "Your previous result for this aspect did not follow the contract or the rules; correct every problem:", ...fb.lines] : []),
    ].join("\n");
    return { text, spills };
  });
}

export interface VerifierAssignment {
  pr: PullRequest;
  snapshot: Pick<Snapshot, "pull" | "commits">;
  aspect: Aspect;
  pass: number;
  findings: readonly Finding[];
  feedback: readonly string[];
  /** The design principles the findings may name, by id (design §8.1). */
  principles?: ReadonlyMap<string, Principle> | undefined;
  baseDir?: string | undefined;
  reviewDir?: string | undefined;
}

const findingBlock = (f: Finding, full: boolean, principles?: ReadonlyMap<string, Principle>): string =>
  [
    `${f.id} [${f.aspect}, ${f.kind}, ${f.severity}] ${f.path}:${f.startLine}-${f.endLine} (${f.side === "RIGHT" ? "head" : "base"})`,
    `  Claim: ${full ? f.content.replace(/\s*\n\s*/g, " ") : clipText(f.content, 300)}`,
    ...(f.principle !== undefined ? [`  Says it breaks the design principle ${f.principle}: "${principles?.has(f.principle) ? (full ? oneLine(principles.get(f.principle)!.statement) : clipText(principles.get(f.principle)!.statement, 300)) : "(statement not available)"}"`] : []),
    ...(f.evidence !== "" ? [`  The reviewer read: ${full ? f.evidence : clipText(f.evidence, 200)}`] : []),
    ...(f.suggestion.trim() !== "" ? [`  Suggestion for the commented lines: ${full ? f.suggestion.replace(/\s*\n\s*/g, " ⏎ ") : clipText(f.suggestion, 200)}`] : []),
  ].join("\n");

/** A verifier's assignment: the findings one pass raised, each to be confirmed, refuted or left uncertain, in a fresh read-only session. */
export function planVerifier(a: VerifierAssignment): Fitted {
  return shrinkToFit((scale) => {
    const full = a.findings.map((f) => findingBlock(f, true, a.principles));
    const fb = feedbackBlock(a.feedback, scale, a.reviewDir);
    const inline = full.join("\n").length <= 30_000 * scale;
    const spill = spillOf("review-findings", full.join("\n"));
    const text = [
      `You verify findings for ${a.pr.owner}/${a.pr.repo}#${a.pr.number} at head ${a.pr.head}. Another agent, the ${a.aspect} reviewer, raised the ${a.findings.length} finding${a.findings.length === 1 ? "" : "s"} below in its pass ${a.pass}. Judge each against the code, as an independent reader in a fresh session. You are read-only: change nothing, run no code from the repository.`,
      "",
      UNTRUSTED_PREAMBLE,
      "",
      howToRead(a.baseDir),
      "",
      "For each finding return one entry of `verdicts`: finding (its id), verdict, kind, witness, quotes, reason and fixes.",
      "- confirmed: the defect is real. Give a witness of your own: the call path or the input that triggers it as `path:line` (the first place it goes wrong), not the reviewer's text restated. A confirmation without a path:line witness counts as unresolved.",
      "- refuted: the claim is false. Give one to three quotes (path, line, text) of lines of the head that disprove it, each copied from one line (at least eight characters), such as the lock that is held or the caller that does not exist. They are checked against the head's files; a quote the file does not show leaves the finding unresolved.",
      "- uncertain: you cannot decide; say what each side rests on in reason.",
      "kind is your own judgment of whether the finding claims wrong behavior (behavioral) or no wrong behavior (non-behavioral: naming, duplication, structure, coupling, test quality). reason is one or two sentences. fixes is true only when the reviewer's suggestion, applied to exactly the commented lines, would resolve the finding (false when there is none).",
      ...(a.findings.some((f) => f.principle !== undefined) ? ["A finding that names a design principle claims the code contradicts that principle's statement. Confirm it only when the cited code really contradicts the statement as written, not merely a stricter or different reading of it; a principle the code does not contradict is refuted."] : []),
      "Nothing is downgraded: a P0 or P1 with thin evidence still gets a verdict, and one you cannot decide is `uncertain`.",
      "",
      `Findings (${a.findings.length}):`,
      ...(inline
        ? full
        : [
            `The findings are too long to list in full: each one's whole claim, evidence and suggestion are in ${reviewFile(a.reviewDir, spill.name)}, in the order below; read it. In short:`,
            // The short index is bounded too (at any scale): past its budget, the remaining findings are named by id only,
            // and the file holds every one of them whole.
            ...fitLines(
              a.findings.map((f) => findingBlock(f, false, a.principles)),
              20_000 * scale,
              (left) => `- … and ${left} more finding${left === 1 ? "" : "s"}, in the file only: ${a.findings.slice(a.findings.length - left).map((f) => f.id).join(", ")}. Each still gets a verdict.`,
            ),
          ]),
      "",
      pullText(a.snapshot),
      ...(a.feedback.length > 0 ? ["", "Your previous result did not follow the contract; correct every problem:", ...fb.lines] : []),
    ].join("\n");
    return { text, spills: [...(inline ? [] : [spill]), ...fb.spills] };
  });
}
