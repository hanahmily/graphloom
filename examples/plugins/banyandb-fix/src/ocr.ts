import type { DecisionRecord } from "./decision-record.js";
import type { Issue } from "./evidence.js";
import { issueRef } from "./prompts.js";

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

/** The code reviewer's result, strict enough for Codex's structured output: every property required, none extra. */
export const CODE_REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["comments", "summary"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "start_line", "end_line", "category", "severity", "content"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          category: { type: "string", enum: CATEGORIES },
          severity: { type: "string", enum: SEVERITIES },
          content: { type: "string" },
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
export function codeReviewInstruction(args: { ocr: string; base: string; background: string }): string {
  const ocr = shellQuote(args.ocr);
  return [
    `Review the uncommitted change in this worktree against HEAD (the base commit ${args.base}) with open-code-review's delegation mode: open-code-review selects the files and resolves their rules; you do the review. Run open-code-review as ${ocr}. Do not change any file, and do not run git commands that write.`,
    "",
    "1. Run `" + `${ocr} delegate preview --format json` + "`. It lists the reviewable files (workspace mode: tracked changes and new untracked files) and the files it excluded, with reasons.",
    "2. The change's Go test files (`_test.go`) are reviewable too, even when preview excludes them as tests: add them to your list. Leave out other excluded files.",
    "3. Run `" + `${ocr} delegate rule --format json <path>...` + "` with every file on your list. Its output groups the files by the review rules that apply to them.",
    "4. For each file, read its diff (`git diff HEAD -- <path>`; read a new untracked file whole) and review it against its rule group and the extra rule below, reading any other code you need. Check every file off as reviewed, or as skipped with a concrete reason. Do not stop at the first serious finding.",
    "5. Report each finding once, with the path, the line range in the new file, a category and a severity. Drop likely false positives. Check that every file on your list is accounted for.",
    "",
    "Extra rule for Go files:",
    ...REVIEW_RULE.map((r) => `- ${r}`),
    "",
    "What the change is for:",
    args.background,
    "",
    "Your result: `comments` with your findings (empty when there are none), and `summary` with `total_files` (the files on your list), `reviewed_files`, and `skipped` (each skipped file with its reason).",
  ].join("\n");
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
}

export interface CodeReviewReport {
  comments: ReviewComment[];
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
    });
  }
  const skipped = (summary!.skipped as unknown[]).map((raw) => {
    const s = object(raw);
    return { path: String(s?.path ?? ""), reason: String(s?.reason ?? "") };
  });
  const rank = (c: ReviewComment) => { const i = SEVERITIES.indexOf(c.severity ?? ""); return i < 0 ? 1.5 : i; };
  return { report: { comments: comments.sort((a, b) => rank(a) - rank(b)), totalFiles, reviewedFiles, skipped } };
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
export function blockingComments(report: CodeReviewReport): ReviewComment[] {
  return report.comments.filter((c) => c.severity === undefined || c.severity === "critical" || c.severity === "high");
}

export function describeComment(c: ReviewComment): string {
  const where = c.start_line > 0 ? `${c.path}:${c.start_line}${c.end_line > c.start_line ? `-${c.end_line}` : ""}` : c.path;
  const content = c.content.trim();
  return `${where} (${[c.severity || "no severity", c.category].filter(Boolean).join(", ")}): ${content.length <= 1_200 ? content : `${content.slice(0, 1_200)}…`}`;
}