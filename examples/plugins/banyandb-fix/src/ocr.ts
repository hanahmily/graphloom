import type { EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND, OCR_TOKEN_BUDGET } from "./constants.js";
import type { DecisionRecord } from "./decision-record.js";
import type { Issue } from "./evidence.js";
import { issueRef } from "./prompts.js";

const MINUTE = 60_000;
/** open-code-review warns above this many characters of background. */
const MAX_BACKGROUND_CHARS = 2_000;
const MARKER = "GraphLoomOcr";

/**
 * The review rule: open-code-review's own rules plus what the change breaks
 * outside its diff. Test files are reviewed too; by default they are excluded.
 */
export const OCR_RULE = JSON.stringify({
  include: ["**/*_test.go"],
  rules: [
    {
      path: "**/*.go",
      merge_system_rule: true,
      rule: [
        "Beyond the diff's own correctness, review what the change breaks.",
        "For every behaviour the change alters, use the search tools to find each caller and lifecycle path that depends on the old behaviour: shutdown and Close, context cancellation, error returns, panics, retries, concurrency and resource release.",
        "Report at high severity: a path whose behaviour changes without a test in this change covering it; a removed guarantee (a bound, a timeout, a cleanup, a cancellation) that other code or comments still rely on; a comment that describes a guarantee the change removed; a test whose expected value is derived from the new code rather than from the issue; a change to an on-disk or wire format.",
        "Report at medium severity a goroutine started without run.Go or the package's existing lifecycle helper.",
        "Do not report style.",
      ].join(" "),
    },
  ],
});

/** Reduces open-code-review's JSON result to one line: status, model, warnings and comments, most severe first, without the model's reasoning. */
const OCR_FILTER = `package main

import (
	"encoding/json"
	"os"
	"sort"
)

type comment struct {
	Path      string \`json:"path"\`
	StartLine int    \`json:"start_line"\`
	EndLine   int    \`json:"end_line"\`
	Category  string \`json:"category,omitempty"\`
	Severity  string \`json:"severity,omitempty"\`
	Content   string \`json:"content"\`
}

type warning struct {
	File    string \`json:"file,omitempty"\`
	Type    string \`json:"type,omitempty"\`
	Message string \`json:"message"\`
}

var rank = map[string]int{"critical": 0, "high": 1, "": 2, "medium": 3, "low": 4}

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

func main() {
	out := map[string]any{}
	defer func() { json.NewEncoder(os.Stdout).Encode(map[string]any{"${MARKER}": out}) }()
	b, err := os.ReadFile(os.Args[1])
	if err != nil {
		out["missing"] = true
		return
	}
	var r struct {
		Status   string
		Message  string
		LLM      *struct{ Model string }
		Summary  *struct {
			FilesReviewed int \`json:"files_reviewed"\`
			TotalTokens   int \`json:"total_tokens"\`
		}
		Comments []comment
		Warnings []warning
	}
	if json.Unmarshal(b, &r) != nil {
		out["unreadable"] = true
		return
	}
	out["status"], out["message"], out["commentCount"] = r.Status, cut(r.Message, 500), len(r.Comments)
	if r.LLM != nil {
		out["model"] = r.LLM.Model
	}
	if r.Summary != nil {
		out["filesReviewed"], out["totalTokens"] = r.Summary.FilesReviewed, r.Summary.TotalTokens
	}
	sort.SliceStable(r.Comments, func(i, j int) bool { return rank[r.Comments[i].Severity] < rank[r.Comments[j].Severity] })
	comments := []comment{}
	for i, c := range r.Comments {
		if i == 30 {
			break
		}
		c.Content = cut(c.Content, 1200)
		comments = append(comments, c)
	}
	warnings := []warning{}
	for i, w := range r.Warnings {
		if i == 20 {
			break
		}
		w.Message = cut(w.Message, 300)
		warnings = append(warnings, w)
	}
	out["comments"], out["warnings"] = comments, warnings
}
`;

const REVIEW_SCRIPT = [
  'd="$(mktemp -d)"',
  "trap 'rm -rf \"$d\"' EXIT",
  'printf \'%s\' "$1" > "$d/rule.json"',
  'printf \'%s\' "$2" > "$d/main.go"',
  "budget=\"$3\"",
  "shift 3",
  'bg=""; for part in "$@"; do bg="$bg$part"; done',
  'printf \'%s\\n\' "$bg" > "$d/background.md"',
  'ocr review --commit HEAD --format json --audience agent --effort high --rule "$d/rule.json" --background-file "$d/background.md" --max-tokens-budget "$budget" --output "$d/result.json" > "$d/ocr.log" 2>&1',
  "rc=$?",
  `(cd "$d" && GOFLAGS= GOWORK=off go run main.go "$d/result.json") > "$GRAPHLOOM_REPORT_FILE" || echo '{"${MARKER}":{"unreadable":true}}' > "$GRAPHLOOM_REPORT_FILE"`,
  'tail -c 4000 "$d/ocr.log" >&2',
  "exit $rc",
].join("; ");

/** What open-code-review is told about the change: the issue and the plan, bounded. */
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

/** Runs open-code-review on the committed candidate (HEAD against its parent) and reduces its result into the report file. */
export function codeReviewCommands(background: string): EnvironmentCommand[] {
  const chunks: string[] = [];
  for (let i = 0; i < background.length; i += 4_000) chunks.push(background.slice(i, i + 4_000));
  return [
    {
      id: COMMAND.codeReview,
      argv: ["sh", "-c", REVIEW_SCRIPT, "code-review", OCR_RULE, OCR_FILTER, String(OCR_TOKEN_BUDGET), ...chunks],
      timeoutMs: 90 * MINUTE,
    },
  ];
}

export interface OcrComment {
  path: string;
  start_line: number;
  end_line: number;
  category?: string;
  severity?: string;
  content: string;
}

export interface OcrReport {
  status: string;
  message: string;
  model?: string;
  commentCount: number;
  comments: OcrComment[];
  warnings: Array<{ file?: string; type?: string; message: string }>;
}

/** The reduced result in a code-review run's report, or why there is none. */
export function parseOcrReport(text: string): { report: OcrReport } | { problem: string } {
  const line = text.split("\n").find((l) => l.startsWith(`{"${MARKER}"`));
  if (line === undefined) return { problem: "open-code-review wrote no result" };
  let out: Record<string, unknown>;
  try {
    out = (JSON.parse(line) as Record<string, Record<string, unknown>>)[MARKER] ?? {};
  } catch {
    return { problem: "open-code-review's result could not be read" };
  }
  if (out.missing === true) return { problem: "open-code-review wrote no result file" };
  if (out.unreadable === true || typeof out.status !== "string") return { problem: "open-code-review's result file is not valid JSON" };
  return {
    report: {
      status: out.status,
      message: typeof out.message === "string" ? out.message : "",
      ...(typeof out.model === "string" && out.model !== "" ? { model: out.model } : {}),
      commentCount: typeof out.commentCount === "number" ? out.commentCount : 0,
      comments: Array.isArray(out.comments) ? (out.comments as OcrComment[]) : [],
      warnings: Array.isArray(out.warnings) ? (out.warnings as OcrReport["warnings"]) : [],
    },
  };
}

/** Statuses that mean every file was reviewed; warnings alone (a failed tool call) do not lose coverage. */
const COMPLETE = new Set(["success", "completed_with_warnings", "complete"]);

export function reviewComplete(report: OcrReport): boolean {
  return COMPLETE.has(report.status);
}

/** A comment without a severity counts as blocking: the change must not pass on a missing label. */
export function blockingComments(report: OcrReport): OcrComment[] {
  return report.comments.filter((c) => c.severity === undefined || c.severity === "" || c.severity === "critical" || c.severity === "high");
}

export function describeComment(c: OcrComment): string {
  const where = c.start_line > 0 ? `${c.path}:${c.start_line}${c.end_line > c.start_line ? `-${c.end_line}` : ""}` : c.path;
  return `${where} (${[c.severity || "no severity", c.category].filter(Boolean).join(", ")}): ${c.content.trim()}`;
}
