import type { EnvironmentCommand, Receipt } from "@graphloom/sdk";
import { CHANGES_PATH, COMMAND, ISSUE_REPO, PROTECTED_PATHS } from "./constants.js";
import type { DecisionRecord } from "./decision-record.js";
import { writeScopeFor } from "./decision-record.js";
import type { Issue, IssueComment } from "./evidence.js";
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
    "",
    UNCLEAR_POLICY,
    "",
    "Return a decision-record-v1 result. Every required field must be present, decisions and openQuestions too (empty arrays when there are none):",
    "- summary: the root cause and the fix in at most five sentences; details go in the fields below.",
    "- status: ready; blocked when a product decision or missing information stops the fix; cannot_reproduce when no failing test can be written from the sources. When not ready, include draftComment: a short issue comment asking the maintainers the question.",
    "- test: the regression test to add. package is the Go package (./pkg/timestamp); name is the top-level TestXxx function `go test -run` selects (for a Ginkgo suite, the suite's TestXxx, with focus set to the new spec's exact text; omit focus for a plain Go test); expectedValueSource says where the expected value comes from, independent of the fix.",
    "- productionCaller: the production code path the fix changes.",
    "- decisions: each unclear point with tier, options, chosen (empty for product points) and basis.",
    "- openQuestions for maintainers, followUps, needsE2E when the behaviour needs the Kind end-to-end tests, and title for the pull request.",
    `- scopeExceptions: only when the fix must change ${PROTECTED_PATHS.join(", ")}, with the reason.`,
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

export function reviewInstruction(args: {
  issue: number;
  snapshot: string;
  record: DecisionRecord;
  base: string;
  paths: string[];
  checks: string[];
}): string {
  return [
    `You are an independent read-only reviewer of a fix for ${issueRef(args.issue)} in this repository. Do not modify anything.`,
    "",
    "Issue snapshot:",
    args.snapshot,
    "",
    "The implementer's decision record:",
    JSON.stringify(args.record, null, 2),
    "",
    `The change is every difference from base commit ${args.base} in the working tree (read it with git diff ${args.base}, including new files). Changed paths: ${args.paths.join(", ")}.`,
    "Checks the controller ran on exactly this change:",
    ...args.checks.map((c) => `- ${c}`),
    "",
    "Judge two axes:",
    "- Spec: the change delivers the issue's expected behaviour; each decision has the right tier and a basis in the issue, a maintainer comment or the repository; nothing outside the issue changed.",
    "- Standards: run.Go instead of raw goroutines; a behavioural test whose expected value comes from an independent source; the named production caller is wired to the fix; the `bydb file compatible change` label noted when on-disk formats move.",
    "",
    UNCLEAR_POLICY,
    "",
    'Return verdict "approved" or "request_changes", a summary, and findings (axis spec or standards, severity blocking or minor, detail). If a choice the change makes is really a product decision, set productDecision to the question for the maintainers; a question the change leaves open, with that behaviour unchanged, is a finding, not a productDecision.',
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
  'set -eu; branch="$1"; shift; message=""; for part in "$@"; do message="$message$part"; done; ' +
  'if git show-ref --verify --quiet "refs/heads/$branch"; then echo "branch $branch already exists" >&2; exit 1; fi; ' +
  'index="$(mktemp -u)"; trap \'rm -f "$index"\' EXIT; ' +
  'GIT_INDEX_FILE="$index" git read-tree HEAD; GIT_INDEX_FILE="$index" git add -A; tree="$(GIT_INDEX_FILE="$index" git write-tree)"; ' +
  'commit="$(printf "%s\\n" "$message" | git commit-tree "$tree" -p HEAD)"; git branch "$branch" "$commit"; ' +
  'printf "%s\\n" "$message" > "$GRAPHLOOM_REPORT_FILE"; echo "$commit"';

/**
 * Put the change on a local branch as one commit whose message is the draft
 * pull request, without touching the worktree, its index or its branch.
 */
export function deliverCommands(branch: string, message: string): EnvironmentCommand[] {
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += 4_000) chunks.push(message.slice(i, i + 4_000));
  return [{ id: COMMAND.deliver, argv: ["sh", "-c", DELIVER, "deliver", branch, ...chunks.slice(0, 59)] }];
}

export function pullRequestDescription(args: {
  issue: number;
  issueTitle: string;
  record: DecisionRecord;
  base: string;
  receipts: Receipt[];
  checks: string[];
}): string {
  const { record } = args;
  const receipt = (requirementId: string) => args.receipts.find((r) => r.valid && r.requirementId === requirementId)?.id ?? "no receipt";
  const decisions = record.decisions;
  const lines = [
    record.title?.trim() || `Fix ${args.issueTitle}`,
    "",
    `Fixes ${issueRef(args.issue)}`,
    "",
    "## Summary",
    record.summary.trim(),
    "",
    "## Decisions",
    ...(decisions.length === 0
      ? ["None."]
      : decisions.map((d) => `- ${d.point} (${d.tier}): ${d.chosen?.trim() || "left unchanged"}. ${d.basis.trim()}${d.options.length > 0 ? ` Options: ${d.options.join("; ")}.` : ""}`)),
    "",
    "## Open questions",
    ...(record.openQuestions.length === 0 ? ["None."] : record.openQuestions.map((q) => `- ${q}`)),
    ...((record.followUps ?? []).length > 0 ? ["", "## Follow-ups", ...record.followUps!.map((f) => `- ${f}`)] : []),
    "",
    "## Test plan",
    `- RED: ${record.test?.name ?? "the regression test"} in ${record.test?.package ?? "?"} fails by assertion on ${args.base.slice(0, 12)} with only the test files applied (receipt ${receipt("reproduces")}).`,
    `- GREEN: the same test and \`make test-ci\` for the changed packages pass on the change (receipt ${receipt("passes")}).`,
    `- Build: make license-check, build, lint and check pass (receipt ${receipt("builds")}).`,
    ...args.checks.map((c) => `- ${c}`),
    ...(record.needsE2E === true ? ["- End-to-end tests (Kind) were not run; this change needs them."] : []),
  ];
  return lines.join("\n");
}
