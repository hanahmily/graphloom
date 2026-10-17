import type { DecisionRecord } from "./decision-record.js";
import { MAX_DISCOVERY_ROUNDS } from "./constants.js";
import type { Issue } from "./evidence.js";
import { issueRef } from "./prompts.js";
import { clip, PRIOR_STATUSES, type PriorStatus } from "./review-common.js";

export { clip, PRIOR_STATUSES, type PriorStatus } from "./review-common.js";

/** open-code-review warns above this many characters of background; the reviewer gets the same bound. */
const MAX_BACKGROUND_CHARS = 2_000;

/**
 * What the reviewer checks beyond open-code-review's own rules: what the change
 * breaks outside its diff.
 */
export const REVIEW_RULE = [
  "Beyond the diff's own correctness, review what the change breaks.",
  "For every behaviour the change alters, search for each caller and lifecycle path that depends on the old behaviour: shutdown and Close, context cancellation, error returns, panics, retries, concurrency and resource release.",
  "Report at high severity: a path whose behaviour changes without a test in this change covering it; a removed guarantee (a bound, a timeout, a cleanup, a cancellation) that other code or comments still rely on; a comment that describes a guarantee the change removed; a test whose expected value is derived from the new code rather than from the issue; a change to an on-disk or wire format.",
  "Report at medium severity a goroutine started without run.Go or the package's existing lifecycle helper.",
  "Do not report style.",
];

const CATEGORIES = ["bug", "security", "performance", "maintainability", "test", "style", "documentation", "other"];
const SEVERITIES = ["critical", "high", "medium", "low"];

/** The code reviewer's result (code-review-v2), strict enough for Codex's structured output: every property required, none extra. */
export const CODE_REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["comments", "prior", "summary"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "start_line", "end_line", "category", "severity", "content", "finding", "evidence"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          category: { type: "string", enum: CATEGORIES },
          severity: { type: "string", enum: SEVERITIES },
          content: { type: "string" },
          finding: { type: "string" },
          evidence: { type: "string" },
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

/** What the reviewer is told about the change: the issue and the plan, bounded. */
export function reviewBackground(issue: Issue, record: DecisionRecord): string {
  const head = [
    `Fix for ${issueRef(issue.number)}: ${issue.title}`,
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
export function codeReviewInstruction(args: { ocr: string; base: string; background: string; known?: KnownFindings; sweep?: boolean; round?: number }): string {
  const ocr = shellQuote(args.ocr);
  const open = args.known?.open ?? [];
  const settled = args.known?.settled ?? [];
  // After the discovery rounds the pass verifies the known findings only.
  const verifying = args.round !== undefined && args.round > MAX_DISCOVERY_ROUNDS;
  const known = [
    ...(open.length > 0
      ? [
          "",
          "Open findings from earlier review passes. Give each one a status in `prior`: `resolved` (the current code no longer has the defect), `still_present`, or `withdrawn` (it was never a defect), with a reason. Do not report them again as comments.",
          ...open.map((f) => `- ${f.id} (${f.state}) ${f.description}`),
        ]
      : []),
    ...(settled.length > 0
      ? [
          "",
          "Settled findings. Do not report them again unless the defect is back in the current code; then report it with its name in `finding`.",
          ...settled.map((f) => `- ${f.id} (${f.state}) ${f.description}`),
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
    "2. The change's Go test files (`_test.go`) are reviewable too, even when preview excludes them as tests: add them to your list. Leave out other excluded files.",
    "3. Run `" + `${ocr} delegate rule --format json <path>...` + "` with every file on your list. Its output groups the files by the review rules that apply to them.",
    verifying
      ? "4. For each file, read its diff (`git diff HEAD -- <path>`; read a new untracked file whole) and check the known findings below against it, reading any other code you need. Check every file off as reviewed, or as skipped with a concrete reason."
      : "4. For each file, read its diff (`git diff HEAD -- <path>`; read a new untracked file whole) and review it against its rule group and the extra rule below, reading any other code you need. Check every file off as reviewed, or as skipped with a concrete reason. Do not stop at the first serious finding.",
    verifying
      ? "5. Give every open finding its status in `prior`; a fixed finding whose defect is back is a comment naming it in `finding`, with the path, the line range in the new file, a severity and in `evidence` the concrete failure, with file:line. Check that every file on your list is accounted for."
      : "5. Report each finding once, with the path, the line range in the new file, a category, a severity, and in `evidence` the concrete failure: the input or sequence of calls and what goes wrong, with file:line. An independent verifier checks every critical and high finding against the code. Drop likely false positives. Check that every file on your list is accounted for.",
    // The extra rule asks for new findings; a verification round raises none.
    ...(verifying ? [] : ["", "Extra rule for Go files:", ...REVIEW_RULE.map((r) => `- ${r}`)]),
    ...known,
    "",
    "What the change is for:",
    args.background,
    "",
    "Your result: `comments` with your findings (empty when there are none), each with `finding` set to a known finding's name when it reports that finding again and \"\" otherwise; `prior` with a status for every open finding listed above (empty when there are none); and `summary` with `total_files` (the files on your list), `reviewed_files`, and `skipped` (each skipped file with its reason).",
  ].join("\n");
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
  return { report: { comments: comments.sort((a, b) => rank(a) - rank(b)), prior, totalFiles, reviewedFiles, skipped } };
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