// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { writeScopeExceptions, writeScopeExcludes, type EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import type { DecisionRecord } from "./decision-record.js";
import { acceptanceItems } from "./acceptance.js";
import { contextPrompt, type ContextDocument } from "./context.js";
import { writeScopeFor } from "./decision-record.js";
import type { Issue, IssueComment } from "./evidence.js";
import { checkCommands, commandLabel, contextRefs, commandsFor, commandSummary, commandTier, enforcedProtectedPaths, finalCommands, issueRef, listAnd, type CommandTier, type Profile, type ProfileCommand } from "./profile.js";
import { ISSUES_DIR, ISSUES_FILE, ISSUES_MARKDOWN } from "./issues.js";

export const MAX_SNAPSHOT_CHARS = 200_000;

/** What the planner and the implementer are asked for `change`, so the delivered text describes the whole change. */
const CHANGE_FIELD =
  "- change: what the change as a whole does and why, against the base commit, in a few sentences for a reviewer who has not seen this run. It becomes the commit message and the pull request summary, so keep it current every round: describe the end state, not this round's edits. Leave out review issue ids, files under .graphloom/, what you did or did not run, and first-person narration.";

export const UNCLEAR_POLICY = [
  "Unclear points (issue descriptions are often incomplete):",
  "- Sources, highest first: the issue's explicit acceptance criteria; its expected-behaviour section; maintainer or assignee comments, later over earlier; a linked design document; existing code patterns and tests; your judgement.",
  "- A point is unclear when the regression test's expected value cannot be written from those sources.",
  "- Tiers: implementation (internal, reversible, no visible behaviour change): decide it and note it. Behaviour (options the issue lists or implies): take the most conservative option and record it with the alternatives. Product (public API or flags, wire or file formats, changed defaults, removals, destructive or security-relevant behaviour): never decide it; leave `chosen` empty.",
  "- Conservative, in order: no destructive or data-losing change; unchanged behaviour for everything the issue does not name; the smallest new public surface; reversible; consistent with existing patterns.",
  "- A product decision blocks only what depends on it. If the fix stands without the answer, fix the rest, leave that behaviour unchanged and list the point in openQuestions. If it does not, the status is blocked. Missing information needed to reproduce the bug is handled the same way (status cannot_reproduce).",
  "- No scope growth: adjacent problems go in followUps.",
].join("\n");

/**
 * The complete issue snapshot as text, or why it cannot be handed over whole.
 * The snapshot is the run's authority and later comments take precedence, so
 * a prefix of it, or of its discussion, cannot stand for it.
 */
export function snapshotText(profile: Profile, issue: Issue, comments: IssueComment[], commentsComplete: boolean): { text: string } | { problem: string } {
  const ref = issueRef(profile, issue.number);
  if (!commentsComplete) return { problem: `${ref} has more comments than the run fetched, and later comments take precedence` };
  const parts = [`# ${ref}: ${issue.title}`, `State: ${issue.state}. Labels: ${issue.labels.join(", ") || "none"}. ${issue.url}`, "", issue.body.trim() || "(no description)"];
  for (const c of comments) {
    parts.push("", `## Comment by ${c.author ?? "unknown"}${c.createdAt !== null ? ` at ${c.createdAt}` : ""}`, c.body.trim());
  }
  const text = parts.join("\n");
  if (text.length > MAX_SNAPSHOT_CHARS) {
    return { problem: `the snapshot of ${ref} is ${text.length} characters, more than the ${MAX_SNAPSHOT_CHARS} an agent prompt carries whole` };
  }
  return { text };
}

/** The planner's acceptance list (decision-record-v2, since issue-fix 0.10.0); the implementer's coverage answers it. */
const ACCEPTANCE_FIELD =
  "- acceptance: what the issue asks for, as [{id, text}]: one item for each checkbox of its acceptance criteria and each line of its oracle, in the issue's own words (ids A1, A2, …). You may group lines that one change covers together; say so in the text. Leave it empty only when the issue states no criteria. The implementer must cover every item before it returns ready, and a controller check sends the change back when one is not covered.";

/** The context documents as a block of a prompt, under the heading that says what they are; nothing when there are none. */
function contextSection(context: ContextDocument[] | undefined): string[] {
  return contextPrompt(context);
}

export function planInstruction(profile: Profile, args: { issue: number; request: string; snapshot: string; context?: ContextDocument[] }): string {
  const e2e = profile.planning.e2e !== undefined ? `needsE2E when the behaviour needs ${profile.planning.e2e}, ` : "";
  return [
    `Plan a fix for ${issueRef(profile, args.issue)} in this repository (${profile.project}). Do not modify any file.`,
    "",
    "Issue snapshot, the authority for this run (comments posted later are not part of it):",
    args.snapshot,
    ...contextSection(args.context),
    "",
    "Operator request (it may add answers in a Decisions: block; the issue stays the authority):",
    args.request.trim(),
    "",
    "Read AGENTS.md and CLAUDE.md if present, the code the issue names, its tests and its production callers.",
    "A read-only reviewer checks this plan before you implement it.",
    ...notes(profile),
    "",
    UNCLEAR_POLICY,
    "",
    "Return a decision-record-v2 result. Every required field must be present, decisions and openQuestions too (empty arrays when there are none):",
    "- summary: the root cause and the fix in at most five sentences; details go in the fields below.",
    CHANGE_FIELD,
    "- status: ready; blocked when a product decision or missing information stops the fix; cannot_reproduce when no failing test can be written from the sources. When not ready, include draftComment: a short issue comment asking the maintainers the question.",
    `- test: the regression test to add. ${profile.runner.testFieldHelp}; expectedValueSource says where the expected value comes from, independent of the fix.`,
    "- productionCaller: the production code path the fix changes.",
    "- decisions: each unclear point with tier, options, chosen (empty for product points) and basis.",
    `- ${profile.planning.reach}`,
    `- openQuestions for maintainers, followUps, ${e2e}and title for the pull request.`,
    ACCEPTANCE_FIELD + ((args.context ?? []).length > 0 ? " Where the issue defers to a context document, one item per requirement of that document the issue assigns to this change; an item's text may cite the document by its name." : ""),
    ...(enforcedProtectedPaths(profile).length > 0 ? [`- scopeExceptions: only when the fix must change ${enforcedProtectedPaths(profile).join(", ")}, with the reason.`] : []),
  ].join("\n");
}

/**
 * The generated files a check regenerates, which the implementer may write: by
 * running the command, not by hand. Empty when no command declares `writes`.
 */
function regeneratedNote(profile: Profile): string {
  const lines = profile.commands.filter((c) => (c.writes ?? []).length > 0).map((c) => `${c.writes!.join(", ")} (regenerate with ${commandLabel(c)})`);
  return lines.length > 0 ? `, except what a check regenerates, which you may write by running it: ${lines.join("; ")}` : "";
}

/** The profile's planning notes, as a block of the prompt; nothing when it has none. */
function notes(profile: Profile): string[] {
  const list = profile.planning.notes ?? [];
  return list.length > 0 ? ["", `About ${profile.project}:`, ...list.map((n) => `- ${n}`)] : [];
}

/** The plan went back to the planner: the code review's confirmed findings, after the supervisor re-entered Fix. */
export function planRevisionInstruction(profile: Profile, args: { issue: number; feedback: string[]; changed: boolean }): string {
  return [
    `Revise your plan for ${issueRef(profile, args.issue)}. Do not modify any file.`,
    ...(args.changed ? ["The working tree holds your previous change; plan what to change in it."] : []),
    "",
    ...args.feedback.map((f) => `- ${f}`),
    "",
    "Read the code again where a finding needs it. A finding you disagree with is answered in the basis of the decision it concerns, with the evidence.",
    profile.planning.reach,
    ...notes(profile),
    "",
    "Return the full decision-record-v2 result again, with every required field.",
  ].join("\n");
}

/** What the implementer is told the controller checks: the profile's own words, or one sentence built from its commands. */
function checksNote(profile: Profile): string {
  if (profile.implementation.checks !== undefined) return `- ${profile.implementation.checks}`;
  const further = checkCommands(profile).map(commandSummary);
  const final = finalCommands(profile).map(commandSummary);
  return `- The controller checks your change in clean checkouts: the base commit with only your test files must fail the test by assertion; the full change must pass the test${further.length > 0 ? ` and ${listAnd(further)}` : ""}, and the checks must leave no file changed.${final.length > 0 ? ` Once code review has passed it runs ${listAnd(final)} once on the reviewed change, and sends the change back to you when that fails.` : ""}`;
}

/**
 * The cheap checks the implementer runs itself before returning `ready`: the
 * regression test, then the profile's `implementation.selfCheck` commands.
 * What ran is reported in the record's `selfChecks`; the graph still runs its
 * own checks and does not take the report as proof.
 */
function selfCheckNote(profile: Profile, plan: DecisionRecord): string[] {
  const commands = profile.implementation.selfCheck ?? [];
  if (commands.length === 0) return [];
  const test = plan.test !== undefined ? [`the regression test (${profile.runner.label(plan.test)})`] : [];
  return [
    `- Before you return status ready, run these yourself and fix what they report: ${[...test, ...commands.map((c) => `\`${c}\``)].join("; ")}. The controller runs its own checks afterwards and does not take your word for it, but a failure it finds costs a full round of checks. List each command you ran, with its result, in the record's selfChecks.`,
  ]
}

/**
 * What the implementer owes for the plan's acceptance list: finish every item
 * and map it to code and tests. Nothing for a plan without a list.
 */
function coverageNote(plan: DecisionRecord): string[] {
  const items = acceptanceItems(plan);
  if (items.length === 0) return [];
  return [
    `- The record's acceptance lists ${items.length} item(s): ${items.map((i) => i.id).join(", ")}. Finish every one before you return status ready; a change that skips an item is sent back before code review. In the record's coverage give one entry per item, {id, files, tests}: files are the production files that implement it, and tests are {file, name} for each test that covers it, name being the test's own title as written in that file (the string passed to it() or test(), or the Go TestXxx name). Name only files that exist in your change and titles that appear in their file: the controller checks each.`,
  ];
}

/** How the implementer marks a review issue fixed; only given once the run has issues. */
export function issuesProtocol(): string {
  return (
    `- Code review issues are tracked in ${ISSUES_FILE} (readable copy ${ISSUES_MARKDOWN}), which the graph owns. When you fix an \`open\` or \`reopened\` issue, set its \`status\` to \`fixed\` and append to its \`history\` one entry ` +
    `{"actor": "fixer", "from": "<its old status>", "to": "fixed", "note": "<what you changed, with file:line>"}. Change nothing else in that file: do not mark an issue done or dismissed, and do not add, delete or reword issues. ` +
    "The code reviewer verifies every fixed issue against the code and either marks it done or reopens it with a note; the graph rejects any other edit and restores the file. Git ignores the file, so it is never part of your change."
  );
}

export function implementInstruction(profile: Profile, args: { issue: number; plan: DecisionRecord; feedback?: string[]; issues?: boolean; context?: ContextDocument[] }): string {
  const { plan } = args;
  const scope = writeScopeFor(plan, profile);
  const excluded = writeScopeExcludes(scope);
  const exceptions = writeScopeExceptions(scope);
  const regenerated = regeneratedNote(profile);
  return [
    ...(args.feedback !== undefined && args.feedback.length > 0
      ? ["Your last change did not pass. Fix these and keep everything that already passes:", ...args.feedback.map((f) => `- ${f}`), ""]
      : []),
    `Implement the fix for ${issueRef(profile, args.issue)} following this decision record:`,
    JSON.stringify(plan, null, 2),
    ...contextSection(args.context),
    "",
    `- Write the regression test ${plan.test?.name ?? "(name it)"} in ${plan.test?.package ?? "(the affected package)"} first. Its expected value must come from ${plan.test?.expectedValueSource ?? "the issue"}, not from the new code's output.`,
    `- Change the production caller (${plan.productionCaller ?? "name it"}) so the test passes. ${profile.implementation.conventions}`,
    ...(profile.changelog !== undefined ? [`- Add an entry for the fix under the current release (the first "## " section) of ${profile.changelog.path}, in the matching subsection.`] : []),
    `- ${excluded.length > 0 ? `Do not change ${excluded.join(", ")}${exceptions.length > 0 ? `, except ${exceptions.join(", ")}, which a check regenerates` : ""}. ` : ""}${regenerated === "" ? "Do not commit, push, create branches or edit generated files." : `Do not commit, push or create branches. Do not edit generated files by hand${regenerated}.`}`,
    checksNote(profile),
    ...selfCheckNote(profile, plan),
    ...coverageNote(plan),
    ...(args.issues === true ? [issuesProtocol()] : []),
    ...notes(profile),
    "",
    UNCLEAR_POLICY,
    "",
    "Return the decision-record-v2 result again, updated with any decision you made while implementing.",
    "- summary is your report on this pass and goes to the graph only; it may say what you fixed or ran.",
    CHANGE_FIELD,
  ].join("\n");
}

/** RED: the base commit with only the test files applied. */
export function redCommands(profile: Profile, test: NonNullable<DecisionRecord["test"]>): EnvironmentCommand[] {
  return [{ id: COMMAND.regression, argv: profile.runner.argv(test), timeoutMs: profile.regressionTimeoutMs }];
}

/** GREEN and the profile's further and build checks, in its order, on the committed candidate. */
export function candidateCommands(profile: Profile, test: NonNullable<DecisionRecord["test"]>, tier?: CommandTier): EnvironmentCommand[] {
  const command = (c: ProfileCommand) => ({ id: c.id, argv: [...c.argv], ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}) });
  // Without a tier, every command in one job; with one, the cheap job carries
  // GREEN and the changelog diff, and the full job only the full commands.
  const first = tier === undefined || tier === "cheap";
  return [
    ...(first && profile.changelog !== undefined ? [{ id: COMMAND.changesDiff, argv: ["git", "diff", "--unified=0", "HEAD~1", "HEAD", "--", profile.changelog.path] }] : []),
    ...(first ? [{ id: COMMAND.regression, argv: profile.runner.argv(test), timeoutMs: profile.regressionTimeoutMs }] : []),
    ...checkCommands(profile).filter((c) => tier === undefined || commandTier(c) === tier).map(command),
  ];
}

/** The `final` tier commands, in the profile's order: one job in a checkout of the candidate whose code review converged. */
export function finalJobCommands(profile: Profile): EnvironmentCommand[] {
  return finalCommands(profile).map((c) => ({ id: c.id, argv: [...c.argv], ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}) }));
}

const DELIVER =
  'set -eu; branch="$1"; n="$2"; shift 2; message=""; while [ "$n" -gt 0 ]; do message="$message$1"; shift; n=$((n - 1)); done; ' +
  'body=""; for part in "$@"; do body="$body$part"; done; ' +
  'if git show-ref --verify --quiet "refs/heads/$branch"; then echo "branch $branch already exists" >&2; exit 1; fi; ' +
  'index="$(mktemp -u)"; trap \'rm -f "$index"\' EXIT; ' +
  // The issues file is the graph's, never part of the change, even where the repository does not ignore it.
  // After staging, that directory is put back to exactly what HEAD has (nothing, usually): naming a path
  // the repository already ignores in a pathspec (GraphLoom's .gitignore has .graphloom/) makes `git add`
  // exit 1, and dropping the directory outright would delete files a repository itself tracks there.
  `GIT_INDEX_FILE="$index" git read-tree HEAD; GIT_INDEX_FILE="$index" git add -A -- .; ` +
  `GIT_INDEX_FILE="$index" git rm -r -q --cached --ignore-unmatch -- ${ISSUES_DIR}; ` +
  `if git ls-tree -r --name-only HEAD -- ${ISSUES_DIR} | grep -q .; then GIT_INDEX_FILE="$index" git reset -q HEAD -- ${ISSUES_DIR}; fi; ` +
  `tree="$(GIT_INDEX_FILE="$index" git write-tree)"; ` +
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

/**
 * Text that belongs to a run's own bookkeeping rather than to the change: a
 * review issue or finding id (I3, F1, whole words), the graph's private
 * directory, or first person narration of a round. Sentences with any of these
 * are dropped; the decision record is asked to keep them out, this is the net
 * under that. Narration is a sentence that starts with "I" and a word ("I
 * fixed", "I'm", "I did not"), or says "I did not/ran/verified..." mid-sentence;
 * "I/O errors are retried", "I2C" and quoted or backticked text are not.
 */
const TRACKER_OR_PRIVATE = /\.graphloom\b|\b[IF]\d+\b/;
const NARRATION = /^(?:[-*]\s+)?(?:I\s+[a-z]|I['’](?:m|ve|ll|d)\b)|\bI\s+(?:did\s+not|didn['’]t|have\s+not|haven['’]t|ran|re-ran|confirmed|verified|fixed|added|checked)\b/;
const isBookkeeping = (sentence: string): boolean => TRACKER_OR_PRIVATE.test(sentence) || NARRATION.test(sentence.replace(/"[^"]*"|`[^`]*`/g, ""));

/** `text` without the sentences that carry bookkeeping; empty when nothing is left. */
export function withoutBookkeeping(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((sentence) => !isBookkeeping(sentence)).join(" "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The change as the commit and the pull request describe it. The decision
 * record's `change` is current every round; the round's `summary` is never
 * delivered when a `change` exists, because after a correction it reports only
 * that round's delta. A v1 record has no `change`: the plan's `change` or
 * summary (written before any round) stands in, then the record's own
 * summary, then the title.
 */
export function changeDescription(record: DecisionRecord, plan?: DecisionRecord): string {
  for (const text of [record.change, plan?.change, plan?.summary, record.summary]) {
    const clean = typeof text === "string" ? withoutBookkeeping(text) : "";
    if (clean !== "") return clean;
  }
  return record.title?.trim() ?? "";
}

/**
 * Whether a follow-up belongs in the pull request. A note about re-running a
 * check the graph pins and ran itself, or about the host it ran on, goes stale
 * once the environment is fixed, and the run's evidence already answers it. So
 * a sentence is dropped only when it names a pinned command explicitly (its argv
 * as written, or its id in backticks) AND talks about re-running or the
 * environment; the rest of the note stays, and the note goes only when
 * nothing is left. A bare word such as "build" or "disk" never drops one.
 */
export function deliverableFollowUp(profile: Profile, note: string): string | undefined {
  // Explicit references: the label or the command as the Test plan names it in backticks (`make test-ci`),
  // the id in backticks, or the id after the tool that runs it ("make lint"). Never a bare substring.
  const namesPinned = (sentence: string): boolean =>
    profile.commands.some((c) => {
      const named = [commandLabel(c), ...(commandSummary(c).match(/`[^`]+`/g) ?? []).map((t) => t.slice(1, -1)), `\`${c.id}\``];
      return named.some((n) => sentence.includes(n)) || new RegExp(`\\b(?:make|npm run|npx)\\s+${c.id.replace(/[^\w-]/g, "")}\\b`).test(sentence);
    });
  const staleCheck = /\b(?:re-?run(?:ning)?|run\s+again|free\s+disk|disk\s+space|sandbox|environment|checkout)\b/i;
  // Judged sentence by sentence, on the sanitized text, so a useful sentence survives a stale one beside it.
  const kept = withoutBookkeeping(note)
    .split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((sentence) => !(namesPinned(sentence) && staleCheck.test(sentence))).join(" "))
    .join("\n")
    .trim();
  return kept === "" ? undefined : kept;
}

/**
 * `text` without any reference to the repositories a profile keeps private
 * when its pull requests do not link the issue (`pullRequest.reference`): the
 * issues repository and every context document's repository, as `owner/repo#N`,
 * `owner/repo:path@ref` or a github.com link. A line that lost one is tidied.
 * Without `reference` the text is returned as it is.
 */
export function withoutPrivateReferences(profile: Profile, text: string): string {
  if (profile.pullRequest.reference === undefined) return text;
  const repos = [`${profile.issues.owner}/${profile.issues.repo}`, ...contextRefs(profile).flatMap((d) => (d.repo !== undefined ? [d.repo] : []))];
  const names = [...new Set(repos)].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const found = new RegExp(`(?:https?://github\\.com/)?(?:${names})(?:[#:@/][^\\s)\\]>"'\`,;]*)?`, "i");
  const all = new RegExp(found.source, "gi");
  return text
    .split("\n")
    .map((line) => (found.test(line) ? line.replace(all, "").replace(/\((?:see|per|in|from|cf\.?|ref\.?)?\s*\)/gi, "").replace(/[ \t]+([,.;:])/g, "$1").replace(/[ \t]{2,}/g, " ").trimEnd() : line))
    .join("\n");
}

/** What the change is for under a profile's `reference`: `Implements <subject> <title>`, with no reference to the issue. */
const implementsLine = (profile: Profile, issueTitle: string): string => `Implements ${profile.pullRequest.reference!.subject} ${issueTitle}`;

/** The commit message: the title, the change and the issue it fixes (or, under `pullRequest.reference`, what it implements, with no reference to the issue). */
export function commitMessage(profile: Profile, args: { issue: number; issueTitle: string; record: DecisionRecord; plan?: DecisionRecord }): string {
  const { reference } = profile.pullRequest;
  const title = args.record.title?.trim() || (reference !== undefined ? `Implement ${reference.subject} ${args.issueTitle}` : `Fix ${args.issueTitle}`);
  const trailer = reference !== undefined ? implementsLine(profile, args.issueTitle) : `Fixes ${issueRef(profile, args.issue)}`;
  return withoutPrivateReferences(profile, [title, "", changeDescription(args.record, args.plan), "", trailer].join("\n"));
}

/** The pull request body, following the profile's pull request template. */
export function pullRequestDescription(
  profile: Profile,
  args: {
    issue: number;
    issueTitle: string;
    record: DecisionRecord;
    /** The planner's record, for a `record` without `change`. */
    plan?: DecisionRecord;
    /** The pinned checks the run's evidence shows passed on the delivered candidate (`commandSummary`); the profile's own list when absent. */
    verified?: string[];
    base: string;
    review: string;
    /** Critical or high review findings an independent verifier refuted. */
    dismissed?: string[];
    /** Critical or high review comments raised after the discovery rounds closed. */
    reviewFollowUps?: string[];
    /** The review issues table's rows (issues.ts issueTableRows), when the run tracked any. */
    issues?: string[];
    /** What the final tier's commands reported, one section each (final.ts finalSections). */
    sections?: Array<{ heading: string; lines: string[] }>;
  },
): string {
  const { record } = args;
  const ref = issueRef(profile, args.issue);
  const decided = record.decisions.filter((d) => d.chosen?.trim());
  const checks = args.verified ?? [...commandsFor(profile, "passes"), ...commandsFor(profile, "builds")].map(commandSummary);
  // Everything the implementer wrote that the body repeats goes through withoutBookkeeping.
  const followUps = (record.followUps ?? []).flatMap((f) => deliverableFollowUp(profile, f) ?? []);
  const questions = record.openQuestions.map(withoutBookkeeping).filter((q) => q !== "");
  // A decision whose point or choice is nothing but bookkeeping is left out, rather than shown as written.
  const decisions = decided.flatMap((d) => {
    const point = withoutBookkeeping(d.point);
    const chosen = withoutBookkeeping(d.chosen!);
    if (point === "" || chosen === "") return [];
    const basis = withoutBookkeeping(d.basis);
    const others = d.options.filter((o) => o !== d.chosen).map(withoutBookkeeping).filter((o) => o !== "");
    return [`- ${point}: ${chosen}.${basis !== "" ? ` ${basis}` : ""}${d.options.length > 1 && others.length > 0 ? ` Alternatives: ${others.join("; ")}.` : ""}`];
  });
  const lines = [
    profile.pullRequest.reference !== undefined ? `### ${implementsLine(profile, args.issueTitle)}` : `### Fix ${ref}: ${args.issueTitle}`,
    ...profile.pullRequest.checklist,
    "",
    "## Summary",
    changeDescription(record, args.plan),
    ...(decisions.length > 0
      ? ["", "## Decisions", ...decisions]
      : []),
    ...(questions.length > 0 ? ["", "## Open questions", "This change leaves these behaviours unchanged:", ...questions.map((q) => `- ${q}`)] : []),
    ...(followUps.length > 0 || (args.reviewFollowUps ?? []).length > 0
      ? ["", "## Follow-ups", ...followUps.map((f) => `- ${f}`), ...(args.reviewFollowUps ?? []).map((f) => `- Code review: ${f}`)]
      : []),
    "",
    "## Test plan",
    `- ${record.test?.name ?? "The regression test"} in \`${record.test?.package ?? "?"}\` fails by assertion on ${args.base.slice(0, 12) || "the base commit"} with only the test files applied, and passes with the fix.`,
    ...(checks.length > 0 ? [`- ${listAnd(checks)} pass.`] : []),
    `- ${args.review}`,
    ...((args.dismissed ?? []).length > 0
      ? ["- Critical or high review findings an independent verifier refuted; overrule any that is wrong:", ...args.dismissed!.map((d) => `  - ${d}`)]
      : []),
    ...(record.needsE2E === true && profile.pullRequest.e2eNote !== undefined ? [`- ${profile.pullRequest.e2eNote}`] : []),
    ...(args.sections ?? []).flatMap((s) => ["", `## ${s.heading}`, ...s.lines]),
    ...((args.issues ?? []).length > 0
      ? ["", "## Review issues", "Critical and high code review findings, as the run tracked them: done ones the reviewer verified fixed, dismissed ones an independent verifier refuted.", "", ...args.issues!]
      : []),
    ...(profile.pullRequest.footer.length > 0 ? ["", ...profile.pullRequest.footer.map((l) => l.replaceAll("{issue}", ref))] : []),
  ];
  return withoutPrivateReferences(profile, lines.join("\n"));
}
