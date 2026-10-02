import type { EnvironmentCommand } from "@graphloom/sdk";
import { CHANGES_PATH, COMMAND, ISSUE_REPO, PROTECTED_PATHS } from "./constants.js";
import type { DecisionRecord } from "./decision-record.js";
import { writeScopeFor } from "./decision-record.js";
import type { Issue, IssueComment } from "./evidence.js";
import type { KnownPlanFindings } from "./plan-findings.js";
import { regressionArgv } from "./gotest.js";

const MINUTE = 60_000;
export const MAX_SNAPSHOT_CHARS = 200_000;

export const UNCLEAR_POLICY = [
  "Unclear points (issue descriptions are often incomplete):",
  "- Sources, highest first: the issue's explicit acceptance criteria; its expected-behaviour section; maintainer or assignee comments, later over earlier; a linked design document; existing code patterns and tests; your judgement.",
  "- A point is unclear when the regression test's expected value cannot be written from those sources.",
  "- Tiers: implementation (internal, reversible, no visible behaviour change): decide it and note it. Behaviour (options the issue lists or implies): take the most conservative option and record it with the alternatives. Product (public API or flags, wire or file formats, changed defaults, removals, destructive or security-relevant behaviour): never decide it; leave `chosen` empty.",
  "- Conservative, in order: no destructive or data-losing change; unchanged behaviour for everything the issue does not name; the smallest new public surface; reversible; consistent with existing patterns.",
  "- A product decision blocks only what depends on it. If the fix stands without the answer, fix the rest, leave that behaviour unchanged and list the point in openQuestions. If it does not, the status is blocked. Missing information needed to reproduce the bug is handled the same way (status cannot_reproduce).",
  "- No scope growth: adjacent problems go in followUps.",
].join("\n");

export function issueRef(issue: number): string {
  return `${ISSUE_REPO.owner}/${ISSUE_REPO.repo}#${issue}`;
}

/**
 * The complete issue snapshot as text, or why it cannot be handed over whole.
 * The snapshot is the run's authority and later comments take precedence, so
 * a prefix of it, or of its discussion, cannot stand for it.
 */
export function snapshotText(issue: Issue, comments: IssueComment[], commentsComplete: boolean): { text: string } | { problem: string } {
  if (!commentsComplete) return { problem: `${issueRef(issue.number)} has more comments than the run fetched, and later comments take precedence` };
  const parts = [`# ${issueRef(issue.number)}: ${issue.title}`, `State: ${issue.state}. Labels: ${issue.labels.join(", ") || "none"}. ${issue.url}`, "", issue.body.trim() || "(no description)"];
  for (const c of comments) {
    parts.push("", `## Comment by ${c.author ?? "unknown"}${c.createdAt !== null ? ` at ${c.createdAt}` : ""}`, c.body.trim());
  }
  const text = parts.join("\n");
  if (text.length > MAX_SNAPSHOT_CHARS) {
    return { problem: `the snapshot of ${issueRef(issue.number)} is ${text.length} characters, more than the ${MAX_SNAPSHOT_CHARS} an agent prompt carries whole` };
  }
  return { text };
}

export function planInstruction(args: { issue: number; request: string; snapshot: string }): string {
  return [
    `Plan a fix for ${issueRef(args.issue)} in this repository (apache/skywalking-banyandb). Do not modify any file.`,
    "",
    "Issue snapshot, the authority for this run (comments posted later are not part of it):",
    args.snapshot,
    "",
    "Operator request (it may add answers in a Decisions: block; the issue stays the authority):",
    args.request.trim(),
    "",
    "Read AGENTS.md and CLAUDE.md if present, the code the issue names, its tests and its production callers.",
    "A read-only reviewer checks this plan before you implement it.",
    "",
    UNCLEAR_POLICY,
    "",
    "Return a decision-record-v1 result. Every required field must be present, decisions and openQuestions too (empty arrays when there are none):",
    "- summary: the root cause and the fix in at most five sentences; details go in the fields below.",
    "- status: ready; blocked when a product decision or missing information stops the fix; cannot_reproduce when no failing test can be written from the sources. When not ready, include draftComment: a short issue comment asking the maintainers the question.",
    "- test: the regression test to add. package is the Go package (./pkg/timestamp); name is the top-level TestXxx function `go test -run` selects (for a Ginkgo suite, the suite's TestXxx, with focus set to the new spec's exact text; omit focus for a plain Go test); expectedValueSource says where the expected value comes from, independent of the fix.",
    "- productionCaller: the production code path the fix changes.",
    "- decisions: each unclear point with tier, options, chosen (empty for product points) and basis.",
    `- ${REACH}`,
    "- openQuestions for maintainers, followUps, needsE2E when the behaviour needs the Kind end-to-end tests, and title for the pull request.",
    `- scopeExceptions: only when the fix must change ${PROTECTED_PATHS.join(", ")}, with the reason.`,
  ].join("\n");
}

const REACH =
  "Reach: for every behaviour the fix changes, the basis of that decision names each caller and lifecycle path that depends on the old behaviour (shutdown and Close, context cancellation, error returns, panics, retries, concurrency, resource release), starting with the changed type's own Close, Stop and shutdown paths, and the test that covers it; a path no test covers is stated there as a risk. For a wait the fix makes longer or unbounded, say what happens when the awaited code ignores cancellation or never returns.";

/** The plan went back to the planner: the plan reviewer's findings, or the code review's after the supervisor re-entered Fix. */
export function planRevisionInstruction(args: { issue: number; feedback: string[]; changed: boolean }): string {
  return [
    `Revise your plan for ${issueRef(args.issue)}. Do not modify any file.`,
    ...(args.changed ? ["The working tree holds your previous change; plan what to change in it."] : []),
    "",
    ...args.feedback.map((f) => `- ${f}`),
    "",
    "Read the code again where a finding needs it. A finding you disagree with is answered in the basis of the decision it concerns, with the evidence.",
    REACH,
    "",
    "Return the full decision-record-v1 result again, with every required field.",
  ].join("\n");
}

export function planReviewInstruction(args: { issue: number; snapshot: string; record: DecisionRecord; previous?: string[]; known?: KnownPlanFindings }): string {
  const open = args.known?.open ?? [];
  const settled = args.known?.settled ?? [];
  const known = [
    ...(open.length > 0
      ? [
          "",
          "Open findings from an earlier pass. The planner has had a chance to answer each one (in a decision's basis, or by changing the plan). Give each one a status in `prior`: `resolved` (the plan no longer has the defect), `still_present`, or `withdrawn` (it was never a defect), with a reason. Do not report them again as findings.",
          ...open.map((f) => `- ${f.id} (${f.state}) ${f.description}`),
        ]
      : []),
    ...(settled.length > 0
      ? [
          "",
          "Settled findings. Do not report them again unless the defect is back in the plan; then report it again with its name in `finding`.",
          ...settled.map((f) => `- ${f.id} (${f.state}) ${f.description}`),
        ]
      : []),
  ];
  return [
    `You are an independent read-only reviewer of a plan to fix ${issueRef(args.issue)} in this repository (apache/skywalking-banyandb). Nothing is implemented yet${args.previous !== undefined ? " beyond the change already in the working tree" : ""}. Do not modify anything.`,
    "",
    "Issue snapshot:",
    args.snapshot,
    "",
    "The plan (decision record):",
    JSON.stringify(args.record, null, 2),
    ...(args.previous !== undefined && args.previous.length > 0 ? ["", "The plan was revised because of:", ...args.previous.map((f) => `- ${f}`)] : []),
    "",
    "Read the code the plan names, its callers and its tests before judging. Judge four axes:",
    "- spec: the plan fixes the issue's expected behaviour at its root cause, and changes nothing the issue does not name.",
    "- decisions: every unclear point has the right tier and a basis in the issue, a maintainer comment or the repository; behaviour points take the most conservative option; no product point is decided.",
    "- reach: for every behaviour the plan changes, search for each caller and lifecycle path that depends on the old behaviour: shutdown and Close, context cancellation, error returns, panics, retries, concurrency, resource release. Start with the changed type's own Close, Stop and shutdown paths, then its callers. For every wait the plan makes longer or unbounded, ask what happens when the awaited code ignores cancellation or never returns, and find such code among the callers. A path the plan does not name, a removed guarantee (a bound, a timeout, a cleanup, a cancellation) that other code or comments rely on, or a changed path no planned test covers is blocking.",
    "- test: the regression test's expected value comes from the issue, not from the new code; it fails by assertion on the base commit; its package and name exist or fit the repository's conventions.",
    "",
    UNCLEAR_POLICY,
    ...known,
    "",
    'Return verdict "approved" or "request_changes", a summary, and findings (axis spec, decisions, reach or test; severity blocking or minor; detail naming the file and function, finding set to a known finding\'s name when it reports that finding again and "" otherwise). Request changes only for blocking findings. prior gives a status for every open finding listed above (empty when there are none). If the plan decides or depends on a product question, set productDecision to the question for the maintainers; a question the plan leaves open, with that behaviour unchanged, is a finding, not a productDecision.',
  ].join("\n");
}

export function implementInstruction(args: { issue: number; plan: DecisionRecord; feedback?: string[] }): string {
  const { plan } = args;
  const excluded = writeScopeFor(plan).filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return [
    ...(args.feedback !== undefined && args.feedback.length > 0
      ? ["Your last change did not pass. Fix these and keep everything that already passes:", ...args.feedback.map((f) => `- ${f}`), ""]
      : []),
    `Implement the fix for ${issueRef(args.issue)} following this decision record:`,
    JSON.stringify(plan, null, 2),
    "",
    `- Write the regression test ${plan.test?.name ?? "(name it)"} in ${plan.test?.package ?? "(the affected package)"} first. Its expected value must come from ${plan.test?.expectedValueSource ?? "the issue"}, not from the new code's output.`,
    `- Change the production caller (${plan.productionCaller ?? "name it"}) so the test passes. Use run.Go rather than raw goroutines, and follow the repository's conventions.`,
    `- Add an entry for the fix under the current release (the first "## " section) of ${CHANGES_PATH}, in the matching subsection.`,
    `- Do not change ${excluded.join(", ")}. Do not commit, push, create branches or edit generated files.`,
    "- The controller checks your change in clean checkouts: the base commit with only your test files must fail the test by assertion; the full change must pass the test, `make test-ci` for the changed packages, and make license-check, build, lint and check. `make check` must leave no file changed, so run `make format` if you touch Go code.",
    "",
    UNCLEAR_POLICY,
    "",
    "Return the decision-record-v1 result again, updated with any decision you made while implementing.",
  ].join("\n");
}

/** RED: the base commit with only the test files applied. */
export function redCommands(test: NonNullable<DecisionRecord["test"]>): EnvironmentCommand[] {
  return [{ id: COMMAND.regression, argv: regressionArgv(test), timeoutMs: 30 * MINUTE }];
}

const AFFECTED_PACKAGES =
  'pkgs=$(git diff --name-only --diff-filter=d HEAD~1 HEAD -- "*.go" | while read -r f; do d=$(dirname "$f"); [ -d "$d" ] && echo "./$d"; done | sort -u | tr "\\n" " "); [ -n "$pkgs" ] || { echo "the change touches no Go package" >&2; exit 1; }; exec make test-ci PKG="$pkgs"';

/** GREEN and the build checks, in CI order, on the committed candidate. */
export function candidateCommands(test: NonNullable<DecisionRecord["test"]>): EnvironmentCommand[] {
  return [
    { id: COMMAND.changesDiff, argv: ["git", "diff", "--unified=0", "HEAD~1", "HEAD", "--", CHANGES_PATH] },
    { id: COMMAND.regression, argv: regressionArgv(test), timeoutMs: 30 * MINUTE },
    { id: COMMAND.testCi, argv: ["sh", "-c", AFFECTED_PACKAGES], timeoutMs: 60 * MINUTE },
    { id: COMMAND.license, argv: ["make", "license-check"], timeoutMs: 10 * MINUTE },
    { id: COMMAND.build, argv: ["make", "build"], timeoutMs: 30 * MINUTE },
    { id: COMMAND.lint, argv: ["make", "lint"], timeoutMs: 30 * MINUTE },
    { id: COMMAND.check, argv: ["make", "check"], timeoutMs: 30 * MINUTE },
  ];
}

const DELIVER =
  'set -eu; branch="$1"; n="$2"; shift 2; message=""; while [ "$n" -gt 0 ]; do message="$message$1"; shift; n=$((n - 1)); done; ' +
  'body=""; for part in "$@"; do body="$body$part"; done; ' +
  'if git show-ref --verify --quiet "refs/heads/$branch"; then echo "branch $branch already exists" >&2; exit 1; fi; ' +
  'index="$(mktemp -u)"; trap \'rm -f "$index"\' EXIT; ' +
  'GIT_INDEX_FILE="$index" git read-tree HEAD; GIT_INDEX_FILE="$index" git add -A; tree="$(GIT_INDEX_FILE="$index" git write-tree)"; ' +
  'commit="$(printf "%s\\n" "$message" | git commit-tree "$tree" -p HEAD)"; git branch "$branch" "$commit"; ' +
  'printf "%s\\n" "$body" > "$GRAPHLOOM_REPORT_FILE"; echo "$commit"';

function chunked(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 4_000) chunks.push(text.slice(i, i + 4_000));
  return chunks;
}

/**
 * Put the change on a local branch as one commit with `message`, without
 * touching the worktree, its index or its branch. The pull request body goes
 * to the command's report, which the controller keeps with the run's evidence.
 */
export function deliverCommands(branch: string, message: string, body: string): EnvironmentCommand[] {
  const messageChunks = chunked(message).slice(0, 4);
  return [{ id: COMMAND.deliver, argv: ["sh", "-c", DELIVER, "deliver", branch, String(messageChunks.length), ...messageChunks, ...chunked(body).slice(0, 54)] }];
}

/** The commit message: the title, the summary and the issue it fixes. */
export function commitMessage(args: { issue: number; issueTitle: string; record: DecisionRecord }): string {
  return [args.record.title?.trim() || `Fix ${args.issueTitle}`, "", args.record.summary.trim(), "", `Fixes ${issueRef(args.issue)}`].join("\n");
}

/** The pull request body, following BanyanDB's pull request template. */
export function pullRequestDescription(args: {
  issue: number;
  issueTitle: string;
  record: DecisionRecord;
  base: string;
  review: string;
  /** Critical or high review findings an independent verifier refuted. */
  dismissed?: string[];
}): string {
  const { record } = args;
  const decided = record.decisions.filter((d) => d.chosen?.trim());
  const lines = [
    `### Fix ${issueRef(args.issue)}: ${args.issueTitle}`,
    "- [x] Add a unit test to verify that the fix works.",
    "- [x] Explain briefly why the bug exists and how to fix it.",
    "",
    "## Summary",
    record.summary.trim(),
    ...(decided.length > 0
      ? ["", "## Decisions", ...decided.map((d) => `- ${d.point}: ${d.chosen!.trim()}. ${d.basis.trim()}${d.options.length > 1 ? ` Alternatives: ${d.options.filter((o) => o !== d.chosen).join("; ")}.` : ""}`)]
      : []),
    ...(record.openQuestions.length > 0 ? ["", "## Open questions", "This change leaves these behaviours unchanged:", ...record.openQuestions.map((q) => `- ${q}`)] : []),
    ...((record.followUps ?? []).length > 0 ? ["", "## Follow-ups", ...record.followUps!.map((f) => `- ${f}`)] : []),
    "",
    "## Test plan",
    `- ${record.test?.name ?? "The regression test"} in \`${record.test?.package ?? "?"}\` fails by assertion on ${args.base.slice(0, 12) || "the base commit"} with only the test files applied, and passes with the fix.`,
    "- `make test-ci` for the changed packages, `make license-check`, `make build`, `make lint` and `make check` pass.",
    `- ${args.review}`,
    ...((args.dismissed ?? []).length > 0
      ? ["- Critical or high review findings an independent verifier refuted; overrule any that is wrong:", ...args.dismissed!.map((d) => `  - ${d}`)]
      : []),
    ...(record.needsE2E === true ? ["- The end-to-end tests (Kind) were not run; this change needs them."] : []),
    "",
    `- [x] If this pull request closes/resolves/fixes an existing issue, replace the issue number. Fixes ${issueRef(args.issue)}.`,
    "- [x] Update the [`CHANGES` log](https://github.com/apache/skywalking-banyandb/blob/main/CHANGES.md).",
  ];
  return lines.join("\n");
}
