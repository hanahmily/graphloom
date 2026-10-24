import { coverageBlock } from "./acceptance.js";
import type { AcceptanceItem, CoverageEntry, DecisionRecord } from "./decision-record.js";
import { MAX_DISCOVERY_ROUNDS } from "./constants.js";
import { contextBlock, contextIntro, type ContextDocument } from "./context.js";
import type { Issue } from "./evidence.js";
import { ISSUES_DIR } from "./issues.js";
import { issueRef, type Profile } from "./profile.js";
import { clip, PRIOR_STATUSES, type PriorStatus } from "./review-common.js";

export { clip, PRIOR_STATUSES, type PriorStatus } from "./review-common.js";

/** open-code-review warns above this many characters of background; the reviewer gets the same bound. */
const MAX_BACKGROUND_CHARS = 2_000;

const CATEGORIES = ["bug", "security", "performance", "maintainability", "test", "style", "documentation", "other"];
const SEVERITIES = ["critical", "high", "medium", "low"];

/**
 * What a pass records in its result's `contract` when it was told to report each
 * problem once (issue-fix 0.10.0). The ledger merges duplicates only in passes
 * that carry it: evidence recorded before keeps its finding ids, which verdicts,
 * reviewer references and the issues file name.
 */
export const DEDUPE_CONTRACT = "dedupe-1";

/** The code reviewer's result (code-review-v2), strict enough for Codex's structured output: every property required, none extra. */
export const CODE_REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["comments", "prior", "summary", "contract"],
  properties: {
    contract: { type: "string", enum: [DEDUPE_CONTRACT] },
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "start_line", "end_line", "category", "severity", "content", "finding", "evidence", "distinct"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          category: { type: "string", enum: CATEGORIES },
          severity: { type: "string", enum: SEVERITIES },
          content: { type: "string" },
          finding: { type: "string" },
          evidence: { type: "string" },
          distinct: { type: "boolean" },
        },
      },
    },
    prior: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "status", "reason"],
        properties: {
          finding: { type: "string" },
          status: { type: "string", enum: PRIOR_STATUSES },
          reason: { type: "string" },
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["total_files", "reviewed_files", "skipped"],
      properties: {
        total_files: { type: "integer" },
        reviewed_files: { type: "integer" },
        skipped: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["path", "reason"], properties: { path: { type: "string" }, reason: { type: "string" } } },
        },
      },
    },
  },
});

/**
 * After the per-file review, the change as a whole. The defects a delivered
 * pull request's review still found after the graph's review passed were all
 * across files (#134, #143), which a file-by-file review does not look for.
 */
export const WHOLE_CHANGE_CHECK =
  "Then, with every file's diff read, check the change as a whole, across files: data passed between modules (a value one module produces with a shape, unit, order, size or guarantee another does not expect; a field written but never read, or read on a path where nothing wrote it); promises one file makes that another breaks (a doc comment, type, name, error contract or invariant stated in one place and violated in another, including code the change left as it was); budget and limit invariants (every bound, cap, size limit, timeout, retry count and budget the change adds or relies on, enforced on every path that can exceed it, resume, retry and replay included); and changed paths that no test in the change covers.";

/**
 * One review pass reports a problem once. The cross-file check comes after the
 * per-file review of the same pass, and a sweep pass follows earlier passes of
 * the round: both see what was already raised and must not raise it again
 * (run c44b4ae7-5d1 recorded about 8 problems as 14 findings). The graph also
 * merges, by path and overlapping lines, whatever still comes back twice.
 */
export const DEDUPE_RULE =
  "Report each problem once. The cross-file check adds only problems that none of your per-file comments of this pass and none of the issues listed below (this round's earlier passes included) already describes. When it finds one of those again, either add no comment, or report it with `finding` set to that issue's id (a duplicate of I<n>) and the cross-file evidence. Comments on one file with overlapping lines are merged into one issue by the graph; when two of them are different problems, set `distinct` to true on each. Set the result's `contract` to \"" + DEDUPE_CONTRACT + "\"." ;

/** What the reviewer is told about the change: the issue and the plan, bounded. */
export function reviewBackground(profile: Profile, issue: Issue, record: DecisionRecord): string {
  const head = [
    `Fix for ${issueRef(profile, issue.number)}: ${issue.title}`,
    record.summary.trim(),
    ...(record.test !== undefined ? [`Regression test: ${record.test.name} in ${record.test.package}; expected value from ${record.test.expectedValueSource}.`] : []),
    ...(record.decisions.length > 0 ? ["Decisions:", ...record.decisions.map((d) => `- ${d.point}: ${d.chosen?.trim() || "left unchanged"}`)] : []),
    ...(record.openQuestions.length > 0 ? ["Left unchanged for maintainers:", ...record.openQuestions.map((q) => `- ${q}`)] : []),
    "",
    "Issue:",
  ].join("\n");
  const room = MAX_BACKGROUND_CHARS - head.length - 2;
  const body = issue.body.trim();
  if (room <= 0) return head.slice(0, MAX_BACKGROUND_CHARS);
  return `${head}\n${body.length <= room ? body : `${body.slice(0, room - 1)}…`}`;
}

/**
 * The code reviewer's assignment: open-code-review's delegation workflow, in
 * which `ocr` only selects the files and resolves their rules and the agent
 * reviews. `ocr` is the absolute path the environment check found, since the
 * agent's shell may not have it on PATH.
 */
export function codeReviewInstruction(
  profile: Profile,
  args: {
    ocr: string;
    base: string;
    background: string;
    /** The profile's pinned context documents; the change is reviewed against them too. */
    context?: ContextDocument[];
    known?: KnownFindings;
    sweep?: boolean;
    round?: number;
    issues?: IssuesFileRef;
    /** What the issue asks for and where the implementer says each item is done; the reviewer verifies it. */
    acceptance?: { items: AcceptanceItem[]; coverage: CoverageEntry[] };
  },
): string {
  const ocr = shellQuote(args.ocr);
  const open = args.known?.open ?? [];
  const settled = args.known?.settled ?? [];
  // After the discovery rounds the pass verifies the known findings only.
  const verifying = args.round !== undefined && args.round > MAX_DISCOVERY_ROUNDS;
  const known = [
    ...(open.length > 0
      ? [
          "",
          args.issues !== undefined
            ? `Issues from earlier review passes, tracked in \`${args.issues.file}\` (readable copy \`${args.issues.markdown}\`). The graph maintains both files and applies your result to them: do not edit them. Give each issue below a status in \`prior\`, by its id, with a reason: \`resolved\` when the current code no longer has the defect (a \`fixed\` issue becomes \`done\`); \`still_present\` when it does, with a reason naming the current file:line of what is still wrong (a \`fixed\` issue is \`reopened\` and the fixer gets your reason); \`withdrawn\` when it was never a defect (an independent verifier judges it again). A \`fixed\` issue carries the fixer's note on what it changed: verify the fix against the code, not the note. Do not report these issues again as comments.`
            : "Open findings from earlier review passes. Give each one a status in `prior`: `resolved` (the current code no longer has the defect), `still_present`, or `withdrawn` (it was never a defect), with a reason. Do not report them again as comments.",
          ...open.map((f) => `- ${f.id} (${f.state}) ${f.description}`),
        ]
      : []),
    ...(settled.length > 0
      ? [
          "",
          args.issues !== undefined
            ? "Settled issues (done or dismissed). Do not report them again unless the defect is back in the current code; then report it with its id in `finding`."
            : "Settled findings. Do not report them again unless the defect is back in the current code; then report it with its name in `finding`.",
          ...settled.map((f) => `- ${f.id} (${f.state}) ${f.description}`),
        ]
      : []),
    ...(args.issues !== undefined && !verifying
      ? [
          "",
          `The run tracks critical and high findings as issues in \`${args.issues.file}\`: each one you report in \`comments\` becomes an \`open\` issue once an independent verifier confirms it. The graph writes that file from your result; do not edit it.`,
        ]
      : []),
    ...(args.sweep === true && !verifying
      ? ["", "An earlier pass on this same change reported the findings above, and they are being handled. Review every file on your list again and look for critical or high issues that are not on the list."]
      : []),
    ...(verifying
      ? [
          "",
          `This is review round ${args.round}, a verification round. The first ${MAX_DISCOVERY_ROUNDS} rounds of this run's review were for finding issues, and that search is closed: do not look for new issues and do not raise new findings. Your job is to verify the known findings against the current code:`,
          "- give every open finding listed above a status in `prior`, with a reason that names the current file:line you checked;",
          "- check that each fixed finding listed above stays fixed, and report one by name in `finding` only if its defect is back.",
          "Still go through every file on your list, so your coverage summary is complete. If you cannot leave a new critical defect unmentioned, you may report it as a comment with `finding` \"\": it will not block this change and is not verified; the pull request lists it as a follow-up.",
        ]
      : []),
  ];
  return [
    `Review the uncommitted change in this worktree against HEAD (the base commit ${args.base}) with open-code-review's delegation mode: open-code-review selects the files and resolves their rules; you do the review. Run open-code-review as ${ocr}. Do not change any file, and do not run git commands that write.`,
    "",
    "1. Run `" + `${ocr} delegate preview --format json` + "`. It lists the reviewable files (workspace mode: tracked changes and new untracked files) and the files it excluded, with reasons.",
    `2. Your list is every changed file. Add back every file preview excluded, whatever its reason: the change's ${profile.review.testFiles}, other tests, docs, fixtures, generated files and anything else it left out. Leave out only \`${ISSUES_DIR}/\`, the run's own bookkeeping, which is not part of the change.`,
    "3. Run `" + `${ocr} delegate rule --format json <path>...` + "` with every file on your list. Its output groups the files by the review rules that apply to them.",
    verifying
      ? "4. For each file, read its diff (`git diff HEAD -- <path>`; read a new untracked file whole) and check the known findings below against it, reading any other code you need. Check every file off as reviewed, or as skipped with a concrete reason."
      : "4. For each file, read its diff (`git diff HEAD -- <path>`; read a new untracked file whole) and review it against its rule group and the extra rule below, reading any other code you need. Check every file off as reviewed, or as skipped with a concrete reason. Do not stop at the first serious finding.",
    // Cross-module defects are what a file-by-file review missed (#134, #143); a verification round raises nothing new.
    ...(verifying ? [] : [WHOLE_CHANGE_CHECK, DEDUPE_RULE]),
    verifying
      ? "5. Give every open finding its status in `prior`; a fixed finding whose defect is back is a comment naming it in `finding`, with the path, the line range in the new file, a severity and in `evidence` the concrete failure, with file:line. Check that every file on your list is accounted for."
      : "5. Report each finding once, with the path, the line range in the new file, a category, a severity, and in `evidence` the concrete failure: the input or sequence of calls and what goes wrong, with file:line. An independent verifier checks every critical and high finding against the code. Drop likely false positives. Check that every file on your list is accounted for.",
    // The extra rule asks for new findings; a verification round raises none.
    ...(verifying ? [] : ["", `Extra rule for ${profile.review.language} files:`, ...profile.review.rules.map((r) => `- ${r}`)]),
    ...known,
    ...(args.acceptance !== undefined ? coverageBlock(args.acceptance.items, args.acceptance.coverage) : []),
    "",
    "What the change is for:",
    args.background,
    ...(args.context !== undefined && args.context.length > 0 ? ["", contextIntro(args.context), "", contextBlock(args.context)] : []),
    "",
    "Your result: `comments` with your findings (empty when there are none), each with `finding` set to a known finding's name when it reports that finding again and \"\" otherwise; `prior` with a status for every open finding listed above (empty when there are none); and `summary` with `total_files` (the files on your list), `reviewed_files`, and `skipped` (each skipped file with its reason).",
  ].join("\n");
}

/** The issues file a pass is pointed at: the JSON the graph maintains and its readable copy. */
export interface IssuesFileRef {
  file: string;
  markdown: string;
}

/** Findings a review pass is shown by name; `description` says where and what. */
export interface KnownFinding {
  id: string;
  state: string;
  description: string;
}

export interface KnownFindings {
  open: KnownFinding[];
  settled: KnownFinding[];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ReviewComment {
  path: string;
  start_line: number;
  end_line: number;
  category?: string;
  severity?: string;
  content: string;
  /** The known finding this comment reports again. */
  finding?: string;
  /** The concrete failure the reviewer describes. */
  evidence?: string;
  /** The reviewer says this is a different problem from an overlapping comment on the same file: do not merge them. */
  distinct?: boolean;
}

export interface PriorFinding {
  finding: string;
  status: PriorStatus;
  reason: string;
}

export interface CodeReviewReport {
  comments: ReviewComment[];
  prior: PriorFinding[];
  totalFiles: number;
  reviewedFiles: number;
  /** The pass was told to report each problem once and says so: the ledger may merge its duplicates. */
  dedupe: boolean;
  skipped: Array<{ path: string; reason: string }>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

/** The code reviewer's structured result, or why it cannot be read. Comments come most severe first. */
export function parseCodeReview(output: unknown): { report: CodeReviewReport } | { problem: string } {
  const result = object(output);
  if (result === undefined) return { problem: "the code reviewer returned no result" };
  const summary = object(result.summary);
  const totalFiles = count(summary?.total_files);
  const reviewedFiles = count(summary?.reviewed_files);
  if (!Array.isArray(result.comments) || totalFiles === undefined || reviewedFiles === undefined || !Array.isArray(summary?.skipped)) {
    return { problem: "the code reviewer's result has no comments or coverage summary" };
  }
  const comments: ReviewComment[] = [];
  for (const raw of result.comments) {
    const c = object(raw);
    if (c === undefined || typeof c.path !== "string" || typeof c.content !== "string") return { problem: "a code review comment has no path or content" };
    comments.push({
      path: c.path,
      start_line: count(c.start_line) ?? 0,
      end_line: count(c.end_line) ?? 0,
      ...(typeof c.category === "string" && c.category !== "" ? { category: c.category } : {}),
      ...(typeof c.severity === "string" && c.severity !== "" ? { severity: c.severity } : {}),
      content: c.content,
      ...(typeof c.finding === "string" && c.finding.trim() !== "" ? { finding: c.finding.trim() } : {}),
      ...(typeof c.evidence === "string" && c.evidence.trim() !== "" ? { evidence: c.evidence } : {}),
      ...(c.distinct === true ? { distinct: true } : {}),
    });
  }
  const prior: PriorFinding[] = (Array.isArray(result.prior) ? result.prior : []).flatMap((raw) => {
    const p = object(raw);
    const status = PRIOR_STATUSES.find((s) => s === p?.status);
    return p !== undefined && typeof p.finding === "string" && status !== undefined ? [{ finding: p.finding.trim(), status, reason: String(p.reason ?? "") }] : [];
  });
  const skipped = (summary!.skipped as unknown[]).map((raw) => {
    const s = object(raw);
    return { path: String(s?.path ?? ""), reason: String(s?.reason ?? "") };
  });
  const rank = (c: ReviewComment) => { const i = SEVERITIES.indexOf(c.severity ?? ""); return i < 0 ? 1.5 : i; };
  return { report: { comments: comments.sort((a, b) => rank(a) - rank(b)), prior, totalFiles, reviewedFiles, skipped, dedupe: result.contract === DEDUPE_CONTRACT } };
}

/** Every file on the reviewer's list was reviewed, and none skipped. */
export function reviewComplete(report: CodeReviewReport): boolean {
  return report.totalFiles > 0 && report.reviewedFiles === report.totalFiles && report.skipped.length === 0;
}

export function describeCoverage(report: CodeReviewReport): string {
  const skipped = report.skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`);
  return `reviewed ${report.reviewedFiles} of ${report.totalFiles} file(s)${skipped.length > 0 ? `; skipped ${skipped.join(", ")}` : ""}`;
}

/** A comment without a severity counts as blocking: the change must not pass on a missing label. */
export function isBlocking(c: Pick<ReviewComment, "severity">): boolean {
  return c.severity === undefined || c.severity === "critical" || c.severity === "high";
}

export function blockingComments(report: CodeReviewReport): ReviewComment[] {
  return report.comments.filter(isBlocking);
}

export function describeComment(c: ReviewComment): string {
  const where = c.start_line > 0 ? `${c.path}:${c.start_line}${c.end_line > c.start_line ? `-${c.end_line}` : ""}` : c.path;
  return `${where} (${[c.severity || "no severity", c.category].filter(Boolean).join(", ")}): ${clip(c.content, 1_200)}`;
}