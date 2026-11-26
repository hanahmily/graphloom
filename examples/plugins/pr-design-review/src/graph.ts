// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The design review (design-pr-review-split §3): round 1 of a pull-request review as its own graph. Fetch → Report → Questions →
 * Answers → Round 1 → Publish: a neutral, cited change report with static measurements, the necessity question N1 and the
 * design-level questions per high-level change with grounded answers, the round-1 gate, and one posted review of the open items,
 * or nothing when round 1 is clean. The detail review (round 2) is `pr-review`'s; no run starts another (§6).
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  dispatch,
  isStaleFailure,
  jsonSchemaProblem,
  MAX_EXECUTOR_INPUT_BYTES,
  observe,
  stop,
  supervise,
  validate,
  type AgentRoleDeclaration,
  type EnvironmentCommand,
  type GraphBudgetDefaults,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type ReferenceSet,
  type Requirement,
  type RunView,
  type ValidationResult,
  type ValidatorBinding,
} from "@graphloom/sdk";
import { attemptEvidence, noteAttempt, readAttempts } from "./kit/attempt.js";
import { commandJobProblem, fitJob } from "./kit/bounds.js";
import { analyze, reportFlowOf, type Analysis } from "./kit/analysis.js";
import { checkoutCommand, GIT_ENV, GUARD_REFUSED, guardCommand, headTreeCommand, ledgerReadCommand, pinnedBase, reviewDirCommand } from "./kit/commands.js";
import {
  ANSWERER_JOB,
  ANSWERS_STAGE,
  CODING_AGENT,
  COMMAND,
  ENV_PLUGIN_ROOT,
  ENV_WORKTREE,
  FETCH_STAGE,
  LEDGER_MOVED,
  NECESSITY_JSON,
  QUESTION_BATCH_SIZE,
  QUESTIONER_JOB,
  QUESTIONS_STAGE,
  REPORTER_JOB,
  REPORT_STAGE,
  REQUIREMENT_ANSWERS,
  CREATE_PULL_REVIEW,
  GET_VIEWER,
  PUBLISH_STAGE,
  REQUIREMENT_PUBLISHED,
  REQUIREMENT_ROUND1,
  ROUND1_STAGE,
  REQUIREMENT_CHECKED_OUT,
  REQUIREMENT_CLAIMS,
  REQUIREMENT_GROUNDED,
  REQUIREMENT_LEDGER,
  REQUIREMENT_MEASUREMENTS,
  REQUIREMENT_QUESTIONS,
  REQUIREMENT_REPORT,
  REQUIREMENT_SNAPSHOT,
  QA_JSON,
  REVIEW_APPENDIX_HTML,
  REVIEW_DIR,
  REVIEW_HTML,
  REVIEW_MD,
} from "./kit/constants.js";
import { claimRecordCommands } from "./kit/claimrecord.js";
import { GRAPH_ID, GRAPH_VERSION } from "./version.js";
import { checkBatch, DIAGRAMMER_JOB, DIAGRAMS_REFERENCES, DIAGRAMS_SCHEMA, DIAGRAMS_SCHEMA_NAME, diagramInputOf, planDiagrams, MAX_DIAGRAM_BYTES, MAX_DIAGRAMS, SKILL_DIR, skillMount } from "./kit/diagrams.js";
import { commandRuns, describeCommand, environmentOutput, outputTail, succeeded, validatorEvidence, type CommandRun } from "./kit/evidence.js";
import { INTERFACE_PATCH_BYTES } from "./kit/digest.js";
import { CHANGE_REPORT_SCHEMA, MAX_ITEM_CHARS } from "./kit/report.js";
import { CLAIM_CHECK_REFERENCES, CLAIM_CHECK_SCHEMA, CLAIM_CHECK_SCHEMA_NAME } from "./kit/claims.js";
import { REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME, reportSpec, type ReportFlow } from "./kit/flow.js";
import { budgetShortfall, largeNeeds } from "./kit/large.js";
import { largeCheckScope, planLargeReporter } from "./kit/largeprompts.js";
import { measurementState, STATIC_ONLY_NOTE, staticBaseCommand, staticCommand } from "./kit/measurements.js";
import { planChecker, planReporter } from "./kit/prompts.js";
import { assignmentProblem, type FileSpill } from "./kit/fit.js";
import { isLarge } from "./kit/mode.js";
import { harnessName, parseProfile, ProfileError, ROLES, DISTINCT_PAIRS, type Profile, type Role } from "./kit/profile.js";
import { COMMENTS_READ, REVIEWS_READ } from "./kit/post.js";
import { requestedPull, type PullRequest } from "./kit/request.js";
import { secretFindings } from "./kit/secrets.js";
import { readInput, snapshotState, type PullFile, type ReadSpec } from "./kit/snapshot.js";
import { appendixWriteCommands, htmlWriteCommands, partCommands, recordCommands, reportWriteCommands } from "./kit/parts.js";
import { baseDirIn } from "./kit/basetree.js";
import { sourceDirs } from "./kit/inventory.js";
import { ledgerRead, oldValue, priorState, writtenLedger } from "./kit/ledger.js";
import { principlesReadCommand, type Principle } from "./kit/principles.js";
import { round1Computed, round1Json, recordedRound1, ROUND1_DIR, ROUND1_RECORD_ID } from "./round1.js";
import { incrementalReads } from "./incremental.js";
import { registryFromEvidence } from "./prior.js";
import { authorReplies } from "./replies.js";
import { createInput, publishFlow, publishPlan } from "./publish.js";
import { prepareTask } from "./prepare.js";
import { diagramsOf, outputsOf, validatorById, writtenHtmlProblems } from "./validators.js";
import { ANSWER_CHECK_REFERENCES, ANSWER_CHECK_SCHEMA, ANSWER_CHECK_SCHEMA_NAME, ANSWERS_REFERENCES, ANSWERS_REVISION_SCHEMA_NAME, ANSWERS_SCHEMA, ANSWERS_SCHEMA_NAME, answersFlow } from "./answers.js";
import { ADDED_TYPE, DESIGN_SECTIONS, MAX_ADDED_QUESTIONS, otherItems, QUESTIONS_REFERENCES, QUESTIONS_SCHEMA, QUESTIONS_SCHEMA_NAME, requiredQuestions, type Question } from "./questions.js";
import { necessityQuestion, NECESSITY_ID, NECESSITY_REFERENCES, NECESSITY_REVISION_SCHEMA_NAME, NECESSITY_SCHEMA, NECESSITY_SCHEMA_NAME, type NecessityRecord } from "./necessity.js";
import { planAnswerChecker, planAnswerer, planNecessity, planNecessityChecker, planQuestioner } from "./qaprompts.js";
import { afterNecessity, batchedAnswers, batchRecordId, batchRecordJson, answerWrites, necessityFlow, necessityRecordCommands, necessityRecordOf, qaContext, qaOutputs, questionSet, questionerFlow, recordedNecessity, restFlow, type AnswerWrites, type QaContext } from "./qaflow.js";

export { GRAPH_ID, GRAPH_VERSION };

/** The graph's profile parser: one operator profile may serve both review graphs (design-pr-review-split §7.2). */
export const profileOf = (config: unknown): Profile => parseProfile(config, GRAPH_ID);

const asSchema = (schema: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/** The ids a job's contract field is constrained to: the contract's `enum`, with each id's description for reconciling a value that names the thing instead. */
const idSet = (ids: readonly string[], describe?: (id: string) => string): ReferenceSet => ({ ids: [...ids], ...(describe !== undefined ? { descriptions: Object.fromEntries(ids.filter((i) => i !== "").map((i) => [i, describe(i)])) } : {}) });
const oneLineText = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Per-job id sets for a contract's reference paths; a path with no ids is left unconstrained (an empty enum would allow nothing). */
const idRefs = (sets: Record<string, ReferenceSet>): Record<string, ReferenceSet> => Object.fromEntries(Object.entries(sets).filter(([, v]) => v.ids.length > 0));
const principleRefs = (path: string, ps: readonly Principle[]): Record<string, ReferenceSet> => idRefs({ [path]: idSet(ps.map((p) => p.id), (id) => oneLineText(ps.find((p) => p.id === id)?.statement ?? "").slice(0, 300)) });
const questionRefs = (path: string, qs: readonly Question[]): Record<string, ReferenceSet> => idRefs({ [path]: idSet(qs.map((q) => q.id), (id) => oneLineText(qs.find((q) => q.id === id)?.text ?? "")) });

/** What N1's requirement says of the project's design principles (design §7.5.1), when the profile names a file. */
function principlesText(profile: Profile): string {
  const cfg = profile.questions.principles;
  if (cfg === undefined) return "";
  return `; the project's design principles file ${cfg.path} was read read-only at ${cfg.ref !== undefined ? `the ref ${cfg.ref}` : "the pinned base commit"}, never from the pull request's head, the ref resolved once to a commit and the file recorded whole as evidence (a missing file is recorded as absent and changes nothing, and a pull request that changes the file is flagged and still judged by the version read), and the answer gives one verdict (preserves, breaks or not-applicable) with an explanation and path:line citations for each principle that applies (its globs match a changed file, or it names none), each applicable principle exactly once, preserves and breaks each cited; when the answer checker supports a breaks verdict, a necessary conclusion becomes questionable and names the broken principle, every other conclusion stays as it is, no principle break skips a question, and a break the checker does not support is recorded with both statements and changes nothing`;
}

/** The defaults the design gives a run (design-pr-review-graph §13.3), under the profile's own and the task's. */
const DEFAULT_BUDGETS: GraphBudgetDefaults = { agentInvocations: 1_200, jobs: 220, decisions: 240, corrections: 12, activeMs: 4 * 3_600_000, waitMs: 6 * 3_600_000 };

/** The roles of the design review (design-pr-review-split §2): no reviewer or verifier, which are `pr-review`'s. */
export const DESIGN_ROLES: readonly Role[] = ROLES.filter((r) => !r.startsWith("reviewer-") && !r.startsWith("verifier-"));

/** Environment checks the graph adds to the profile's: where the worktree, the plugin and Go live (for the confined static tools). No Docker: this graph never runs the sandbox. */
function generatedChecks(): EnvironmentCommand[] {
  return [
    { id: ENV_WORKTREE, argv: ["sh", "-c", "pwd -P"] },
    {
      id: ENV_PLUGIN_ROOT,
      argv: ["sh", "-c", 'r=${GRAPHLOOM_PLUGIN_ROOT:-}; [ -n "$r" ] || { echo "GRAPHLOOM_PLUGIN_ROOT is not set: GraphLoom sets it to the plugin\'s directory for environment checks" >&2; exit 127; }; cd "$r" && pwd -P'],
    },
    // An inherited GOROOT naming a toolchain go cannot find stops go; the root go finds for itself is the one to bind then.
    { id: "go-root", argv: ["sh", "-c", "go env GOROOT 2>/dev/null || (unset GOROOT; go env GOROOT) 2>/dev/null || true"] },
  ];
}

/** The graph definition for a profile. The stage list is fixed per plugin version, whatever the profile says. */
export function definitionFor(profile: Profile): GraphDefinition {
  const checker = harnessName(profile.roles["report-checker"]);
  const requirements: Requirement[] = [
    {
      id: REQUIREMENT_SNAPSHOT,
      statement: `The pull request's metadata, every changed file with its patch, every commit, review, review comment and review thread (with resolution), and the head's check runs were read completely from GitHub for the one head the request names. It has at most ${profile.limits.hardMaxFiles} files and ${profile.limits.hardMaxPatchBytes} bytes of patch (past them it is refused). Over ${profile.limits.maxFiles} files or ${profile.limits.maxPatchBytes} bytes of patch it is reviewed in large mode, which is recorded with the limit passed and its value, and its changed files are partitioned into areas by a deterministic rule (by first path segment; a group over ${profile.limits.areaMaxBytes} bytes of patch splits by its next segment, or into runs of files by path; sibling groups under ${profile.limits.areaMinBytes} bytes merge; files under the profile's excludeRoots form the generated area) that is recomputed from the files; a file for which the host gave no patch is recorded as such, never a failure. It touches nothing under .graphloom/.`,
      evidenceSchema: "github-read-v1",
    },
    {
      id: REQUIREMENT_CHECKED_OUT,
      statement: "The worktree holds exactly the head's tree on the pinned merge base, materialized by `git checkout --no-overlay` with hooks off and no global or system Git configuration, so no repository code ran to produce it; .graphloom/review/ exists with its own .gitignore.",
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_LEDGER,
      statement: "The pull request's ledger ref (refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger) was read, or recorded absent, and of it the design section only (or a v1 ledger, migrated in memory). When the design section holds the Q&A of an earlier head, N1's carry inputs were read with no repository code: that head's qa.json and necessity.json, the delta since it over the head files N1's answer cites (git diff -U0 between the two heads, reduced to its file and hunk headers), and for each base file N1 cites whether it differs between the two bases; or the reason N1 is asked again was recorded (no head, no necessity.json, a skipped Q&A, an earlier commit that is not in the review clone, a delta that cannot be read, or questions.incremental false). Every other question is asked on every head. No Docker image is probed: this graph never runs the sandbox.",
      evidenceSchema: "command-report-v1",
    },
    {
      id: REQUIREMENT_REPORT,
      statement: `Every template section is present, with cited items or an explicit None. Every citation lies inside the pull request's diff on the side it names. Every changed file (a renamed file under both names, a deleted file too) and every detector fact is cited, and no item carries a severity, finding or verdict (the result contract has no such field). report.json, ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} hold exactly that report, with the mode (standard, or large with the limits passed) in report.json and in the header of ${REVIEW_MD}. In large mode (a pull request over the profile's maxFiles or maxPatchBytes) the report is high level: one reporter job (change-report-v1, the reporter role, a fresh read-only session with the head and base trees available read-only) is given a bounded digest and not the diff (the title, body and commit messages as untrusted blocks; the areas with their paths, files, lines added and deleted and patch bytes; the file list with its diffstat; the detector facts; the names of the exported symbols each area adds; and the patches of the interface files only, at most ${INTERFACE_PATCH_BYTES} bytes of patch in all), describes the pull request at a high level and cites the files and lines each item rests on; an item's text is at most ${MAX_ITEM_CHARS} characters. In large mode the plugin lists a file no item cites in "other" with its diffstat, and accounts for a fact the report leaves out with an item of its own. Before the reporter job the graph computes what large mode needs of the run's agent invocations, jobs and decisions and stops with those numbers when the remaining budgets cannot cover them. Every report opens with a briefing the reporter returns in its result: whatsNew (one entry for each new capability, a high-level change W1 to W5, each with cites and its card), features (at most 3, each with at most 8 stages and 12 flows: the path the data takes through a new feature), check (five lists of at most 8 one-line entries with cites: surfaces, behavior, compatibility, risks, tests) and areas (a label for each area id of a large report); each is a claim of the claim check, dropped and recorded under "Removed by the claim check" when unsupported. Plugin code, never a model, computes the scope (lines added and deleted for production code, tests, docs and generated or other files), the hotspots (the five functions with the highest complexity, then nesting, a modified function that got worse shown as base → head) and the open items for the author (round 1's open items, computed by the function the Round 1 stage records them with, so the briefing counts and lists the same items the posted review does). After the claim check, each feature's data flow and every lifecycle entry is drawn by one read-only diagram job (diagrams-v1, on the diagrammer role) with the vendored diagram-design skill (${SKILL_DIR}, mounted read-only), at most ${MAX_DIAGRAMS} diagrams, each a self-contained HTML document of at most ${MAX_DIAGRAM_BYTES} characters that passes the skill's own self_check.py --offline and verify-geometry.py in a confined command job with no network, the inertness check and the label rule; one correction goes back to the same session, and a diagram that still fails is drawn by plugin code instead, which the report says; a diagram never stops the run. ${REVIEW_HTML} is the one-page briefing and ${REVIEW_APPENDIX_HTML} everything else; ${REVIEW_MD} mirrors both in plain text. Both HTML files are rendered by plugin code from report.json, qa.json and necessity.json and are self-contained and inert, which a deterministic check on the written bytes enforces. Each file is written by one command when it fits, otherwise as a bounded multi-part write whose parts the validators concatenate and check against the digest every part carries.`,
      evidenceSchema: "change-report-v1",
    },
    {
      id: REQUIREMENT_MEASUREMENTS,
      statement: `For every function the pull request adds or modifies, complexity and nesting were measured by the pinned static tools (gometrics, tsmetrics) over the head tree, under bwrap with no network, and every value recomputes from its evidence. The changed lines' hunk headers are read by one git diff -U0 command, or, when its report does not fit one command report, by groups of the measured files halved in the pull request's order down to one file, and a file whose own headers still do not fit is listed as not measured (never a failed run). The files run in batches of at most 8, each tool printing compact JSON; a batch whose report does not fit one command report is split in two, down to one file, and a file whose own report still does not fit is listed as not measured (never a failed run). A modified function is also measured at the base: its file is read at the pinned base (git show <base>:<path>, read-only, recorded whole) and measured by the same tools, confined with no network and recomputed from the recorded text, so its row shows base → head and says whether an over-the-limit value was already there, or why the base is not known. The table has the columns Function, Change, Complexity and Nesting. No coverage, CRAP or mutation is measured, required or accepted, and no Docker sandbox runs: ${STATIC_ONLY_NOTE} No measurement makes a question or a round-1 item.`,
      evidenceSchema: "graphloom-metrics-v1",
    },
    {
      id: REQUIREMENT_CLAIMS,
      statement: `An independent ${checker} report checker, on a harness other than the reporter's, judged every report item against the diff, and every item left is supported with quotes that match the diff's text. An item that was not supported after one revision is removed and recorded, and its file is accounted for in "other". In large mode there is one check, of the one report, and the quotes of its claims are verified against the tree each claim's cite names by read-only commands whose output is evidence. The briefing's claims (what is new W<n>, a feature F<n>, its stages and flows, the check entries) are claims of the same check, dropped and recorded as the report requirement says.`,
      evidenceSchema: CLAIM_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_QUESTIONS,
      statement: `The necessity question N1 was asked first, before every other question: is the problem real on the base (the claimed problem quoted from the pull request's text, the base behavior traced through the base code with path:line citations), does the fix fit the system's design (the repository's design and architecture documents${profile.questions.designDocs.length > 0 ? ` (${profile.questions.designDocs.join(", ")})` : ""} and code comments searched, the design statement and the changed lines cited, and whether the change preserves or breaks them said)${principlesText(profile)}, and is there a simpler or existing way; it concludes necessary, questionable, unnecessary or needs author, in one line. An independent ${harnessName(profile.roles["answer-checker"])} answer checker verified each cited design statement, each trace step${profile.questions.principles !== undefined ? ", each principle verdict" : ""} and the conclusion, with searches of its own, and N1's checked answer and the decision it led to are recorded in necessity.json. When N1 concludes unnecessary and the checker supports it, and the operator did not ask for every question, no other question is asked and the skip is recorded. On a later head N1 is carried when it concluded necessary, asked every question, none of its citations changed, the principles file is the same commit and the pull request's text still holds its quotes (then no N1 job runs); questions.incremental false asks it again. Otherwise every required question was asked, on every head: for every high-level change (a capability of the briefing's whatsNew, W1 to W5, or, when the claim check kept none, one of the report's coarsest change items standing in for it), in standard and large mode alike, purpose when the pull request's text does not state it (a stated purpose is recorded with a quote that matches that text instead), and existing-feature (does the codebase already have this feature or mechanism, or does a declared library do it; one question, one answer). The questioner may add at most ${MAX_ADDED_QUESTIONS} design-level questions: each of type ${ADDED_TYPE}, with an empty symbol, about a high-level change or a change item of the ${DESIGN_SECTIONS.join(", ")} sections; a violation goes back to the questioner as a correction. No question is required from a measurement, a test map or a symbol: missing-test, split-function, complexity-coverage, weak-test and per-symbol reuse are pr-review's. The groundwork behind them (the dependency inventory, the purpose lookup, symbols for the report's digest, the base export) was read by read-only commands.`,
      evidenceSchema: QUESTIONS_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_ANSWERS,
      statement: `N1 has its recorded answer first (when it is the only question, because it concluded unnecessary and the checker supports it, the Q&A says the remaining questions were skipped). Every other question has an answer from the ${harnessName(profile.roles.answerer)} answerer with evidence (citations that resolve in the tree they name, the searches run with their results, inventory entries) and a status of answered, partially answered or needs author. Every "none found" answer lists its whole-repository searches. The existing-feature answer is one statement with one status and its evidence. No answer proposes a split, a test outline or an assertion. ${QA_JSON}, ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} (rendered from report.json, qa.json and necessity.json, with the same inert check) are written, each by one command or as a bounded multi-part write, and the ledger's design section was advanced by compare-and-swap from the value Fetch read with this head's report.json, qa.json and necessity.json (the review section carried as it was). In large mode the ${harnessName(profile.roles["batch-answerer"])} batch-answerer answers the questions in batches of at most ${QUESTION_BATCH_SIZE}, each batch passing the same checks and recorded as evidence (answers-record-<n>).`,
      evidenceSchema: ANSWERS_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_GROUNDED,
      statement: `An independent ${harnessName(profile.roles["answer-checker"])} answer checker, on a harness other than the answerer's (and the batch-answerer's), re-checked N1, every cited equivalent, mechanism and library, and every "none found" claim with searches of its own, against the trees. Every answer left is supported or partial; an answer still unsupported after one correction is needs author, with both statements recorded (for N1, its conclusion becomes questionable and every question is asked). In large mode each batch of answers is checked by its own answer checker job in a fresh session, with the same correction and downgrade rules.`,
      evidenceSchema: ANSWER_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_ROUND1,
      statement: `Round 1 is decided by plugin code from necessity.json and qa.json, with no model and no human, and recorded in round1/round1.json (pr-design-review-round1-v1). Its open items are: N1's conclusion when it is not necessary (a design principle the checker supports as broken included); every question whose answer needs the author or is partially answered; and every existing-feature answer that names an equivalent outside the code the pull request changes (a citation in a base or head file the pull request does not add, modify, rename or delete, or a declared library): a "none found" answer or one that says nothing is reusable is noted, never an item, an equivalent inside changed files is noted, an outside equivalent the pull request already reuses (the answer's equivalent says reusedByPullRequest, its sites are added lines of the diff naming it, and the checker supports the claim) is noted, not an item, while the answer stays an item for any outside citation no such reused equivalent alone lists, and answers citing one outside equivalent merge into one item that covers the others. The kinds are necessity, needs-author, partial and existing; a missing test is not a round-1 item. An item is anchored where its answer's evidence lies in the diff: the first line inside a hunk at the head of the first head citation, in the answer's order, that has one; with no such citation, at the first head cite of the change it is about when that lies in a hunk, else it goes in the review body. Earlier open items are judged against this head by their stable key: fixed when no open item has that key, still open when one does. The record recomputes from the recorded Q&A and necessity files and must equal what was written.`,
      evidenceSchema: "round1-v1",
    },
    {
      id: REQUIREMENT_PUBLISHED,
      statement: `When round 1 has open items, they were posted to the pull request as exactly one GitHub review of event COMMENT (never APPROVE or REQUEST_CHANGES), pinned to head <sha>, by the graphloom.github/create-pull-review executor, whose credential the plugin never sees, with the idempotency key design-<head12>, or a review of this head carrying this graph's head marker and this run's nonce was already there and was found by reading the pull request's reviews before any post (a review carrying graphloom-review is never this graph's). Its body's first line is "Changes requested: <n> open" (the open round-1 items, earlier ones included), its second the head marker <!-- graphloom-design-review: <head> <nonce> -->, its third says it is the design review (round 1) and that the PR review (pr-review) reviews the details; an item with a diff anchor is an inline comment (at most 50), the rest are in the body, each ending with its marker; on a later head the body lists what became of the items an earlier review posted. When round 1 is clean, nothing is posted${profile.comments.designPassedNote ? ", except the note this profile asks for (comments.designPassedNote): one COMMENT review with no item whose first line is \"Design review passed\", then the head marker, then one line saying the PR review follows, posted, reconciled and recorded like any review of this graph" : " (comments.designPassedNote is off), and no write grant is needed"}. In every case the ledger's design section records the head, its result (items or clean), its open count and any review and comment ids, advanced by compare-and-swap from this run's Answers write; the review section is never written. The review and the ledger record recompute from the recorded round 1 and the ledger's earlier items.`,
      evidenceSchema: "publish-v1",
    },
  ];
  const bindings: ValidatorBinding[] = [
    { requirementId: REQUIREMENT_SNAPSHOT, validatorId: "pr-snapshot", version: "1" },
    { requirementId: REQUIREMENT_CHECKED_OUT, validatorId: "head-tree", version: "1" },
    { requirementId: REQUIREMENT_LEDGER, validatorId: "review-scope", version: "1" },
    { requirementId: REQUIREMENT_REPORT, validatorId: "change-report", version: "1" },
    { requirementId: REQUIREMENT_MEASUREMENTS, validatorId: "measurements", version: "1" },
    { requirementId: REQUIREMENT_CLAIMS, validatorId: "claims-checked", version: "1", independence: "separate-reviewer" },
    // N1's check is review evidence: the controller admits it only from a read-only review job on another operation.
    { requirementId: REQUIREMENT_QUESTIONS, validatorId: "questions-complete", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_ANSWERS, validatorId: "answers-complete", version: "1" },
    { requirementId: REQUIREMENT_GROUNDED, validatorId: "answers-grounded", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_ROUND1, validatorId: "round1-gated", version: "1" },
    { requirementId: REQUIREMENT_PUBLISHED, validatorId: "review-published", version: "1" },
  ];
  return {
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    privateStateSchema: "pr-design-review-private-v1",
    resultContracts: [
      { name: REPORTER_SCHEMA_NAME, schema: asSchema(CHANGE_REPORT_SCHEMA), evidenceKind: "other" },
      { name: REVISION_SCHEMA_NAME, schema: asSchema(CHANGE_REPORT_SCHEMA), evidenceKind: "other" },
      // The diagram job (design §6.10): the checked data flows and lifecycle entries drawn with the vendored diagram-design skill.
      { name: DIAGRAMS_SCHEMA_NAME, schema: asSchema(DIAGRAMS_SCHEMA), evidenceKind: "other", references: [...DIAGRAMS_REFERENCES] },
      // Kind "review": claims-checked is judged by an independent reviewer, admitted only from a read-only review job's evidence.
      { name: CLAIM_CHECK_SCHEMA_NAME, schema: asSchema(CLAIM_CHECK_SCHEMA), evidenceKind: "review", references: [...CLAIM_CHECK_REFERENCES] },
      { name: QUESTIONS_SCHEMA_NAME, schema: asSchema(QUESTIONS_SCHEMA), evidenceKind: "other", references: [...QUESTIONS_REFERENCES] },
      { name: ANSWERS_SCHEMA_NAME, schema: asSchema(ANSWERS_SCHEMA), evidenceKind: "other", references: [...ANSWERS_REFERENCES] },
      { name: ANSWERS_REVISION_SCHEMA_NAME, schema: asSchema(ANSWERS_SCHEMA), evidenceKind: "other", references: [...ANSWERS_REFERENCES] },
      { name: NECESSITY_SCHEMA_NAME, schema: asSchema(NECESSITY_SCHEMA), evidenceKind: "other", references: [...NECESSITY_REFERENCES] },
      { name: NECESSITY_REVISION_SCHEMA_NAME, schema: asSchema(NECESSITY_SCHEMA), evidenceKind: "other", references: [...NECESSITY_REFERENCES] },
      // Kind "review": answers-grounded is judged by an independent reviewer (a read-only review job on another harness).
      { name: ANSWER_CHECK_SCHEMA_NAME, schema: asSchema(ANSWER_CHECK_SCHEMA), evidenceKind: "review", references: [...ANSWER_CHECK_REFERENCES] },
    ],
    stages: [
      { id: FETCH_STAGE, name: "Fetch", requirementIds: [REQUIREMENT_SNAPSHOT, REQUIREMENT_CHECKED_OUT, REQUIREMENT_LEDGER] },
      { id: REPORT_STAGE, name: "Report", requirementIds: [REQUIREMENT_REPORT, REQUIREMENT_MEASUREMENTS, REQUIREMENT_CLAIMS] },
      { id: QUESTIONS_STAGE, name: "Questions", requirementIds: [REQUIREMENT_QUESTIONS] },
      { id: ANSWERS_STAGE, name: "Answers", requirementIds: [REQUIREMENT_ANSWERS, REQUIREMENT_GROUNDED] },
      { id: ROUND1_STAGE, name: "Round 1", requirementIds: [REQUIREMENT_ROUND1] },
      { id: PUBLISH_STAGE, name: "Publish", requirementIds: [REQUIREMENT_PUBLISHED] },
    ],
    requirements,
    defaultValidators: bindings,
    environment: { checks: [...structuredClone(profile.environment.checks), ...generatedChecks()] },
    defaultBudgets: { ...DEFAULT_BUDGETS, ...(profile.budgets ?? {}) },
    agentRoles: agentRoles(profile),
    supervisor: structuredClone(profile.supervisorPreference),
  };
}

/**
 * The roles the profile assigns harnesses to (design §13.1), for `graphloom doctor --task`: the design review's roles with their
 * distinctness constraints. The reviewer and verifier roles are `pr-review`'s, accepted unread in a shared profile.
 */
export function agentRoles(profile: Profile): AgentRoleDeclaration[] {
  return DESIGN_ROLES.map((role) => {
    const distinctFrom = DISTINCT_PAIRS.filter(([checked, author]) => checked === role && DESIGN_ROLES.includes(author)).map(([, author]) => author);
    const setting =
      role === "diagrammer"
        ? `harnesses.${role} (optional; falls back to harnesses.reporter)`
        : role === "batch-answerer"
          ? `harnesses.${role} (optional; the answer batches of large mode; falls back to harnesses.answerer)`
          : `harnesses.${role}`;
    return { role, harness: profile.roles[role], access: "read" as const, ...(distinctFrom.length > 0 ? { distinctFrom } : {}), setting };
  });
}

/** The graph: its definition and routing both come from the task's profile (`config`). */
export function createGraph(): GraphPlugin {
  return {
    describe: (config?: unknown) => definitionFor(profileOf(config)),
    advance: advancePullRequest,
    prepareTask,
  };
}

const withPrivate = (decision: GraphDecision): GraphDecision => ({ ...decision, privateState: JSON.stringify({ v: 1 }) });

/** One call of the graph: it reasons from the evidence of the live candidate and of the stages' current attempts (`attemptEvidence`), and keeps the attempts it has seen. */
export function advancePullRequest(view: RunView): GraphDecision {
  const attempts = noteAttempt(readAttempts(view.privateState), view);
  const scoped: RunView = { ...view, evidence: attemptEvidence(view.evidence, view.candidateDigest, attempts) };
  return { ...withinCommandBounds(advance(scoped)), privateState: JSON.stringify(attempts) };
}

/**
 * A command job the command executor would reject for one of its input bounds is never dispatched: a rejected job
 * leaves no run, so the graph would plan the same job again. The supervisor is asked to repair the planning instead.
 */
function withinCommandBounds(decision: GraphDecision): GraphDecision {
  if (decision.action.type !== "dispatch") return decision;
  const problem = commandJobProblem(decision.action.job);
  if (problem === undefined) return decision;
  return supervise({ reason: `the graph planned a command job the command executor would reject before running it: ${problem}` }, "escalate a planned command over the command executor's input bounds");
}

function advance(view: RunView): GraphDecision {
  let profile: Profile;
  try {
    profile = profileOf(view.config);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return stop({ reason: "incompatible task", blocker: err.message, retryable: false }, "reject a task without a usable profile");
  }
  const pr = requestedPull(view.task.request, profile, GRAPH_ID);
  if ("problem" in pr) return stop({ reason: "incompatible task", blocker: pr.problem, retryable: false }, "reject a request that names no pull request of the profile's project");
  const definition = definitionFor(profile);
  const stage = definition.stages.find((s) => !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) || view.openAttempt?.[s.id] === true);
  const ctx: Context = { profile, definition, pr };
  if (stage === undefined) return finished(ctx, view);
  switch (stage.id) {
    case FETCH_STAGE:
      return fetch(ctx, view);
    case REPORT_STAGE:
      return report(ctx, view);
    case QUESTIONS_STAGE:
      return questions(ctx, view);
    case ANSWERS_STAGE:
      return answers(ctx, view);
    case ROUND1_STAGE:
      return round1Stage(ctx, view);
    default:
      return publishStage(ctx, view);
  }
}

/**
 * The line a finished run ends with (design-pr-review-split §3.7), data in the run's result: with open items, what was posted;
 * clean, that nothing was posted (or the note was) and the next command, which starts nothing by itself (§6).
 */
export function resultLine(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, profileName: string, open: number, url: string | null | undefined, noted: boolean): string {
  const link = url !== null && url !== undefined ? ` (${url})` : "";
  if (open > 0) return `design review: changes requested: ${open} open on ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 7)}; posted${link}`;
  const posted = noted ? `the design-review-passed note is posted${link}` : "nothing posted";
  return `design review clean at ${pr.head.slice(0, 7)}; ${posted}. Next: graphloom task new pr-review ${pr.owner}/${pr.repo}#${pr.number} --profile ${profileName}`;
}

/** Every stage is accepted: the run ends complete, with the line that says what round 1 found (design-pr-review-split §3.7). */
function finished(ctx: Context, view: RunView): GraphDecision {
  const a = analyze(view.evidence, ctx.profile, ctx.pr);
  const p = a.state === "ready" ? publishPlan(view.evidence, a.analysis, ctx.pr, ctx.profile.comments) : undefined;
  const plan = p?.state === "ready" ? p.plan : undefined;
  const flow = plan !== undefined ? publishFlow(view.evidence, plan, ctx.pr) : undefined;
  const url = flow?.state === "done" ? flow.posted?.url : undefined;
  const open = plan?.open ?? 0;
  const blocker = resultLine(ctx.pr, ctx.profile.name, open, url, plan?.note === true);
  return withPrivate(stop({ reason: "complete", blocker, retryable: false }, open > 0 ? "round 1 has open items: the design review is posted and the run ends" : "round 1 is clean: the run ends, and the next command is named, not run"));
}

interface Context {
  profile: Profile;
  definition: GraphDefinition;
  pr: PullRequest;
}

/** The latest run of command `id`: its result, and whether it failed since the operator's last resume (a failure before it is run again once). */
function commandState(view: RunView, id: string, expected?: EnvironmentCommand): { run: CommandRun | undefined; failed: boolean; retry: boolean } {
  // With `expected`, only a run of that very argv is the graph's own: a command a supervisor named with the same id does not stand for it.
  const run = commandRuns(view.evidence, id).filter((r) => expected === undefined || sameArgv(r.command.argv, expected.argv)).at(-1);
  if (run === undefined) return { run, failed: false, retry: false };
  const ok = succeeded(run.command);
  return { run, failed: !ok, retry: !ok && isStaleFailure(run.record, view) };
}

function commandJob(stageId: string, instruction: string, commands: JobSpec["input"] & object, extra: Partial<JobSpec> = {}): JobSpec {
  return { stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction, input: commands, ...extra };
}

function githubJob(spec: ReadSpec, input: Record<string, unknown>, stageId: string = FETCH_STAGE): JobSpec {
  return { stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `Read the ${spec.label}`, executor: spec.pin, input };
}

function fetch(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  // The head is checked out first, then the pull request is read: evidence is judged against the workspace
  // change it was produced under, and the checkout changes it, so a read made before would no longer count.
  const guard = commandState(view, COMMAND.guard, guardCommand(pr.head));
  if (guard.failed && !guard.retry && guard.run !== undefined) {
    if (guard.run.command.exitCode === GUARD_REFUSED) {
      return stop({ reason: "incompatible task", blocker: `the pull request touches .graphloom/, which holds this graph's own files and which a pull request may not change: ${outputTail(guard.run.command, 300).replace(/\s+/g, " ")}`, evidenceRefs: [guard.run.record.ref], retryable: false }, "stop: the pull request touches .graphloom/");
    }
  }
  const checkout = commandState(view, COMMAND.checkout, checkoutCommand(pr.head));
  const tree = commandState(view, COMMAND.headTree, headTreeCommand(pr.head));
  const dir = commandState(view, COMMAND.reviewDir, reviewDirCommand());
  const checked = [guard, checkout, tree, dir];
  const failed = checked.find((c) => c.failed && !c.retry);
  if (failed?.run !== undefined) {
    return supervise({ reason: `the checkout of the head failed: ${describeCommand(failed.run.command)}: ${outputTail(failed.run.command)}`, evidenceRefs: [failed.run.record.ref] }, "escalate a failed checkout");
  }
  if (checked.some((c) => c.run === undefined || c.retry)) {
    // One writer job with fixed argv: the only job of the run that changes the worktree's tracked files (design §4).
    const job: JobSpec = {
      stageId: FETCH_STAGE,
      kind: "command",
      purpose: "work",
      writeScope: ["."],
      instruction: "Materialize the pull request's head in the worktree (no hook, no filter, no repository code)",
      input: { commands: [guardCommand(pr.head), checkoutCommand(pr.head), headTreeCommand(pr.head), reviewDirCommand()], env: { ...GIT_ENV } },
    };
    return withPrivate(dispatch(job, `check out head ${pr.head.slice(0, 12)} over the pinned merge base`));
  }
  const s = snapshotState(view.evidence, pr, profile.limits, profile.questions.excludeRoots);
  if (s.state === "reading") return withPrivate(dispatch(githubJob(s.next, readInput(s.next, pr, s.cursor)), s.why));
  if (s.state === "incompatible") return stop({ reason: "incompatible task", blocker: s.problem, evidenceRefs: s.refs.slice(-10), retryable: false }, "stop: this pull request cannot be reported");
  const ledger = commandState(view, COMMAND.ledger, ledgerReadCommand(pr.owner, pr.repo, pr.number));
  if (ledger.failed && !ledger.retry && ledger.run !== undefined) {
    return supervise({ reason: `the ledger read failed: ${describeCommand(ledger.run.command)}`, evidenceRefs: [ledger.run.record.ref] }, "escalate a failed ledger read");
  }
  if (ledger.run === undefined || ledger.retry) {
    return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the pull request's ledger ref", { commands: [ledgerReadCommand(pr.owner, pr.repo, pr.number)], env: { ...GIT_ENV } }), "read the ledger ref, or record it absent"));
  }
  // A ledger an earlier run left is read whole here (its heads, question keys and posted items), so this run continues its ids and re-checks its items (design §9).
  const ledgerValue = ledgerRead(view.evidence);
  if (ledgerValue !== undefined && ledgerValue.ledger.present) {
    const prior = priorState(view.evidence, oldValue(ledgerValue.ledger));
    if (prior.state === "missing" || (prior.state === "unreadable" && retryOf(view)(prior.run))) {
      const commands = prior.state === "missing" ? prior.next : [{ id: prior.run.command.id, argv: prior.run.command.argv }];
      return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the prior ledger's ledger.json", { commands, continueOnFailure: true, env: { ...GIT_ENV } }), "read the prior ledger.json, so this run continues its ids and re-checks the items it posted"));
    }
    if (prior.state === "unreadable") return supervise({ reason: `the prior ledger's ledger.json cannot be read (${prior.reason}); the ledger is not overwritten`, evidenceRefs: [prior.run.record.ref] }, "escalate a prior ledger that cannot be read");
    // A later head carries N1 when nothing it rests on changed (design-pr-review-split §3.5): its carry inputs are read here. A read
    // that cannot be made is not a stop: N1 is then asked again, with the reason recorded.
    const reads = incrementalReads(view.evidence, { ledger: ledgerValue.ledger.sha, registry: registryFromEvidence(view.evidence), enabled: profile.questions.incremental, head: pr.head, files: s.snapshot.files.map((f) => f.path), base: pinnedBase(view.evidence), node: process.execPath });
    if (reads.state === "run") return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the earlier Q&A and the delta since the last reviewed head (read-only git; no repository code)", { commands: reads.commands, continueOnFailure: true, env: { ...GIT_ENV } }), reads.why));
  }
  // The project's design principles file, read from the profile's ref or the pinned base, never the head (design §7.5.1).
  const configured = profile.questions.principles;
  const pinned = pinnedBase(view.evidence);
  if (configured !== undefined && pinned !== undefined) {
    const principles = commandState(view, COMMAND.principles);
    const mine = principles.run !== undefined && sameArgv(principles.run.command.argv, principlesReadCommand(configured, pinned).argv);
    if (principles.failed && !principles.retry && principles.run !== undefined && mine) {
      return supervise({ reason: `reading the design principles file failed: ${describeCommand(principles.run.command)}: ${outputTail(principles.run.command)}`, evidenceRefs: [principles.run.record.ref] }, "escalate a failed principles read");
    }
    if (principles.run === undefined || principles.retry || !mine) {
      return withPrivate(dispatch(commandJob(FETCH_STAGE, `Read the design principles file ${configured.path}`, { commands: [principlesReadCommand(configured, pinned)], env: { ...GIT_ENV } }), `read ${configured.path} at ${configured.ref ?? `the pinned base ${pinned.slice(0, 12)}`}, or record it absent`));
    }
  }
  // No Docker image is probed: the design review never runs the sandbox (design-pr-review-split §3.1).
  return validateStage(ctx, view, FETCH_STAGE);
}

/** Judges the stage's requirements with the shipped validators first, so a failure goes to the supervisor with its reason instead of looping. */
function validateStage(ctx: Context, view: RunView, stageId: string): GraphDecision {
  const stage = ctx.definition.stages.find((s) => s.id === stageId)!;
  const failures: string[] = [];
  for (const id of stage.requirementIds) {
    const binding = ctx.definition.defaultValidators.find((b) => b.requirementId === id)!;
    const statement = ctx.definition.requirements.find((r) => r.id === id)!.statement;
    const result = validatorById(binding.validatorId)!.evaluate({ requirementId: id, statement, evidence: validatorEvidence(view.evidence, view.candidateDigest), ...(view.candidateDigest !== undefined ? { candidateDigest: view.candidateDigest } : {}), config: view.config }) as ValidationResult;
    if (result.status !== "passed") failures.push(`${id}: ${result.reason}`);
  }
  if (failures.length > 0) {
    return supervise({ reason: `the ${stage.name} stage does not validate: ${failures.slice(0, 3).join("; ")}` }, `hand the failing ${stage.name} requirements to the supervisor`);
  }
  return withPrivate(validate({ stageId }, `validate ${stage.name} from the recorded evidence`));
}

/** The most paths one bwrap confinement can mask (`confinementProblem`'s bound). */
const MAX_MASKS = 64;

/**
 * The paths of repository-provided agent configuration (design §12.1) to hide from an agent: the usual
 * top-level ones, and for every file the pull request adds or changes under such a name, the topmost path
 * that carries it (`a/.claude` for `a/.claude/x/y`, `docs/CLAUDE.md` for itself). More than the confinement
 * can mask, or a path no mask can name, is refused, never left exposed.
 */
export function agentConfigMasks(worktree: string, changed: readonly string[]): { masks: string[] } | { problem: string } {
  const names = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", ".claude", ".codex", ".agents", ".pi", ".mcp.json", ".opencode"];
  const roots = new Set(names);
  for (const p of changed) {
    const segments = p.split("/");
    const at = segments.findIndex((seg) => names.includes(seg));
    if (at < 0) continue;
    const prefix = segments.slice(0, at + 1).join("/");
    if (/[\n\u0000]/.test(prefix) || segments.includes("..")) return { problem: `the pull request changes ${JSON.stringify(p)}, an agent-configuration path that no confinement mask can name` };
    roots.add(prefix);
  }
  if (roots.size > MAX_MASKS) return { problem: `the pull request adds or changes agent configuration in ${roots.size} places, more than the ${MAX_MASKS} paths one confinement can hide from the agents` };
  return { masks: [...roots].map((p) => path.posix.join(worktree, p)) };
}

/** What a job that cannot be built asks for: the pull request is refused when it is the pull request's fault, else the supervisor decides. */
function refused(job: { problem: string; incompatible?: true }): GraphDecision {
  if (job.incompatible === true) return stop({ reason: "incompatible task", blocker: job.problem, retryable: false }, "stop: the agents cannot be confined for this pull request");
  return supervise({ reason: job.problem }, "escalate a missing worktree path");
}

function agentJob(ctx: Context, view: RunView, spec: { jobId?: string; stageId?: string; purpose: "diagnostic" | "review"; instruction: string; schema: string; harness: string; role: Role; assignment: string; continueFrom?: string; readOnlyBinds?: readonly string[]; references?: Record<string, ReferenceSet> }, files: readonly PullFile[]): JobSpec | { problem: string; incompatible?: true } {
  const worktree = environmentOutput(view.evidence, ENV_WORKTREE);
  if (worktree === undefined || !path.isAbsolute(worktree)) return { problem: "the environment check recorded no worktree path, which the confinement masks need" };
  // The one guard of every agent job: an assignment past the executor's bound is caught here, naming the job and what to shrink, not by the executor.
  const tooBig = assignmentProblem(spec.instruction, spec.assignment);
  if (tooBig !== undefined) return { problem: tooBig, incompatible: true };
  const masks = agentConfigMasks(worktree, files.flatMap((f) => [f.path, ...(f.previousPath !== null ? [f.previousPath] : [])]));
  if ("problem" in masks) return { problem: masks.problem, incompatible: true };
  // The role's model and effort travel as the job's harness options; a role that sets neither inherits the harness's own.
  const { model, effort } = ctx.profile.roleSettings[spec.role] ?? {};
  const harnessOptions = model !== undefined || effort !== undefined ? { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) } : undefined;
  return {
    ...(spec.jobId !== undefined ? { jobId: spec.jobId } : {}),
    stageId: spec.stageId ?? REPORT_STAGE,
    kind: "agent",
    purpose: spec.purpose,
    readOnly: true,
    instruction: spec.instruction,
    resultSchema: spec.schema,
    executor: CODING_AGENT,
    input: { assignment: spec.assignment, harness: spec.harness, ...(harnessOptions !== undefined ? { harnessOptions } : {}) },
    // The id fields of the contract are constrained to the ids this job lists (an enum in the schema the harness enforces).
    ...(spec.references !== undefined && Object.keys(spec.references).length > 0 ? { knownReferences: spec.references } : {}),
    // Untrusted-read confinement (design §12.2): home hidden, repository agent configuration masked, no GitHub token.
    confinement: { kind: "bwrap", network: true, mask: masks.masks, binds: (spec.readOnlyBinds ?? []).map((p) => ({ path: p, readOnly: true })) },
    ...(ctx.profile.agentTimeoutMs !== undefined ? { timeoutMs: ctx.profile.agentTimeoutMs } : {}),
    ...(spec.continueFrom !== undefined ? { continueFrom: spec.continueFrom } : {}),
  };
}

/** The absolute `.graphloom/review/` directory of the worktree, where the report and the files an assignment points to are, once the environment check recorded the worktree. */
function reviewDirOf(view: RunView): string | undefined {
  const worktree = environmentOutput(view.evidence, ENV_WORKTREE);
  return worktree !== undefined && path.isAbsolute(worktree) ? path.posix.join(worktree, REVIEW_DIR) : undefined;
}

/**
 * The write of the files an assignment points to instead of inlining (`fit.ts`), before the agent job that names them: each
 * is a bounded multi-part write like an artifact (design §6.6), skipped once it ran as written. Undefined when all are written.
 */
function writeSpills(view: RunView, stageId: string, spills: readonly FileSpill[]): GraphDecision | undefined {
  const commands = spills.flatMap((s) => partCommands(`spill-${s.name.replace(/\.md$/, "")}`, `${REVIEW_DIR}/${s.name}`, s.text));
  const next = nextWrite(view, commands, { failed: "writing a file for an agent to read failed", settle: "a file for an agent to read keeps differing from the one the evidence recomputes" });
  if (next === undefined) return undefined;
  if ("decision" in next) return next.decision;
  const part = partOf(next.command);
  return withPrivate(dispatch(commandJob(stageId, writeInstruction(next.command, `Write ${part?.path ?? "a file for an agent to read"}`), { commands: [next.command] }), `write ${part?.path ?? "a file"} for the next agent job to read: its input does not fit the job's assignment`));
}

/** Where the base commit's files are exported for the agents (design §7.3), when the groundwork recorded the export. */
function baseTreeDir(view: RunView, groundwork: { baseTree?: unknown }): string | undefined {
  const worktree = environmentOutput(view.evidence, ENV_WORKTREE);
  return groundwork.baseTree !== undefined && worktree !== undefined && path.isAbsolute(worktree) ? baseDirIn(worktree) : undefined;
}

/** The newest session of job `jobId` in `stageId`, which no later job has continued. */
function jobSession(view: RunView, stageId: string, jobId: string): string | undefined {
  const sessions = (view.agentSessions ?? []).filter((s) => s.stageId === stageId && s.dispatchKey === jobId && s.status === "ok" && s.generation <= view.generation);
  const continued = new Set(sessions.map((s) => s.continuedFrom).filter((s) => s !== undefined));
  return sessions.filter((s) => !continued.has(s.operationId)).at(-1)?.operationId;
}

/** Only agent work spends an invocation; a job that cannot fit what an executor accepts stops the run, naming the limit. */
function dispatchAgent(view: RunView, job: JobSpec, summary: string): GraphDecision {
  if (view.budgets.agentInvocations <= 0) return stop({ reason: "budgets exhausted", blocker: "no agent invocations left", retryable: false }, `cannot ${summary}`);
  const executorId = job.executor?.id ?? CODING_AGENT.id;
  const shape = view.executors?.find((e) => e.id === executorId)?.inputShape;
  const problem = shape !== undefined ? jsonSchemaProblem(shape.schema, job.input) : undefined;
  if (problem !== undefined) {
    return stop({ reason: "incompatible task", blocker: `the input to ${summary} does not fit what ${executorId} declares: ${problem}; the pull request's files, facts and text are too large together`, retryable: false }, `stop: the input to ${summary} does not fit ${executorId}'s declared input shape`);
  }
  const sent = Buffer.byteLength(JSON.stringify(job.input ?? null), "utf8");
  if (sent > MAX_EXECUTOR_INPUT_BYTES) {
    return stop({ reason: "incompatible task", blocker: `the input to ${summary} is ${sent} bytes once serialized, more than the ${MAX_EXECUTOR_INPUT_BYTES} an executor input carries`, retryable: false }, `stop: the input to ${summary} does not fit an executor input`);
  }
  return withPrivate(dispatch(job, summary));
}

function report(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") {
    return supervise({ reason: a.state === "pending" ? `the report stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  }
  const { analysis } = a;
  const flow = reportFlowOf(view.evidence, analysis, retryOf(view));
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved report to the supervisor");
    case "verify":
      return withPrivate(
        dispatch(
          commandJob(REPORT_STAGE, "Check the claims' quotes against the trees (read-only)", { commands: flow.commands.slice(0, 16), env: { ...GIT_ENV } }),
          "verify each quote the claim checker gave for a claim in the tree its cite names (every claim of a large report); no repository code runs",
        ),
      );
    case "reporter": {
      const large = isLarge(analysis.snapshot.mode) && analysis.snapshot.partition !== undefined;
      // Before the first reporter job: stop with the numbers when the run's budgets cannot cover large mode (design §6.9).
      if (large && flow.kind === "first") {
        const short = budgetShortfall(largeNeeds(analysis.snapshot.partition!.areas.filter((x) => x.kind === "read").length), view.budgets);
        if (short !== undefined) return stop({ reason: "budgets exhausted", blocker: short, retryable: false }, "stop before the reporter: the run's budgets cannot cover large mode");
      }
      const planned = large
        ? planLargeReporter({ pr, snapshot: analysis.snapshot, partition: analysis.snapshot.partition!, sections: analysis.sections, facts: analysis.facts, kind: flow.kind, feedback: flow.feedback, ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) })
        : planReporter({ pr, snapshot: analysis.snapshot, sections: analysis.sections, facts: analysis.facts, candidates: analysis.ctx.candidates ?? [], kind: flow.kind, feedback: flow.feedback, ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, REPORT_STAGE, planned.spills);
      if (written !== undefined) return written;
      const from = flow.kind === "first" ? undefined : jobSession(view, REPORT_STAGE, REPORTER_JOB);
      const job = agentJob(ctx, view, { jobId: REPORTER_JOB, purpose: "diagnostic", instruction: large ? "Write the high-level change report" : "Write the change report", schema: flow.schema, harness: profile.roles.reporter, role: "reporter", assignment, ...(from !== undefined ? { continueFrom: from } : {}) }, analysis.snapshot.files);
      if ("problem" in job) return refused(job);
      const why = { first: "write the change report (read-only, confined)", correction: "correct the report: deterministic validation found problems", revision: "revise the report: the claim check did not support some items" }[flow.kind];
      return dispatchAgent(view, job, why);
    }
    case "checker": {
      const targets = reportSpec(analysis.ctx).targets(flow.report);
      const planned = planChecker({ pr, snapshot: analysis.snapshot, report: flow.report, targets, retry: flow.retry, ...(analysis.ctx.large === true ? { scope: largeCheckScope() } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, REPORT_STAGE, planned.spills);
      if (written !== undefined) return written;
      const references = idRefs({ [CLAIM_CHECK_REFERENCES[0]!]: idSet(targets.map((t) => t.id), (id) => oneLineText(targets.find((t) => t.id === id)?.text ?? "").slice(0, 300)) });
      const job = agentJob(ctx, view, { purpose: "review", instruction: "Check the report's claims against the diff", schema: CLAIM_CHECK_SCHEMA_NAME, harness: profile.roles["report-checker"], role: "report-checker", assignment, references }, analysis.snapshot.files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check every report item with a fresh read-only ${harnessName(profile.roles["report-checker"])} session`);
    }
    case "done": {
      // The diagrams are drawn and checked once the report's claims are (design §6.10); the plugin's own drawing stands in for one that fails.
      // The claim checks are recorded first, so a reentry after a later review of the same candidate can accept the report again.
      const checks = nextWrite(view, claimRecordCommands(view.evidence), { failed: "recording the claim checks failed", settle: "the recorded claim checks keep differing from the ones the evidence holds" });
      if (checks !== undefined) {
        if ("decision" in checks) return checks.decision;
        return withPrivate(dispatch(commandJob(REPORT_STAGE, writeInstruction(checks.command, "Record the claim checks as evidence"), { commands: [checks.command] }), "record the report's claim checks, so a later review of the same candidate does not hide them from the report's validators"));
      }
      const drawn = diagramStep(ctx, view, analysis, flow);
      return drawn ?? measureAndWrite(ctx, view, analysis, flow);
    }
  }
}

/**
 * The diagram job (design §6.10): a read-only agent draws the checked data flows and lifecycle entries with the skill, the
 * skill's checks run on each document in a confined command, and one correction goes back to the same session. Undefined when
 * the diagrams are resolved (drawn by the skill, or left to the plugin with a note); a diagram never stops the run.
 */
function diagramStep(ctx: Context, view: RunView, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }>): GraphDecision | undefined {
  const { profile, pr } = ctx;
  const d = diagramsOf(view.evidence, flow);
  switch (d.state) {
    case "resolved":
      return undefined;
    case "unavailable":
      return supervise({ reason: d.reason }, "escalate a missing plugin path");
    case "verify": {
      const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT)!;
      const commands = checkBatch(d.commands);
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Check the diagram documents with the skill's own checks (self_check.py and verify-geometry.py on a scratch file; no network; no repository code runs)",
        input: { commands, continueOnFailure: true },
        confinement: { kind: "bwrap", network: false, mask: [], binds: [{ path: root, readOnly: true }] },
      };
      return withPrivate(dispatch(job, `run the diagram skill's checks on ${commands.length} document(s), confined with no network`));
    }
    case "agent": {
      const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT)!;
      const mount = skillMount(root);
      const planned = planDiagrams({ owner: pr.owner, repo: pr.repo, number: pr.number, mount, input: diagramInputOf(flow.final), specs: d.specs, kind: d.kind, feedback: d.feedback, ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, REPORT_STAGE, planned.spills);
      if (written !== undefined) return written;
      const from = d.kind === "first" ? undefined : jobSession(view, REPORT_STAGE, DIAGRAMMER_JOB);
      const references = idRefs({ [DIAGRAMS_REFERENCES[0]!]: idSet(d.specs.map((s) => s.id)) });
      const job = agentJob(ctx, view, { jobId: DIAGRAMMER_JOB, purpose: "diagnostic", instruction: "Draw the features' data flows and the lifecycle state machines with the diagram-design skill", schema: DIAGRAMS_SCHEMA_NAME, harness: profile.roles.diagrammer, role: "diagrammer", assignment, readOnlyBinds: [mount], references, ...(from !== undefined ? { continueFrom: from } : {}) }, analysis.snapshot.files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, d.kind === "first" ? "draw the checked data flows and lifecycle entries with the diagram-design skill (read-only, confined)" : "correct the diagrams: the plugin's or the skill's checks found problems");
    }
  }
}

/** What a write that is still to be done needs next: the command to run, or the decision that stops it. */
type NextWrite = { command: EnvironmentCommand } | { decision: GraphDecision };

/**
 * The first command of a write (one command, or the parts of a multi-part artifact, in order) that has not run as
 * written (design §6.6): its latest run succeeded with this very argv. A command that failed goes to the supervisor
 * until the operator resumes, and one that keeps differing from what the evidence recomputes goes there too.
 * Undefined when every command ran as written.
 */
function nextWrite(view: RunView, commands: readonly EnvironmentCommand[], words: { failed: string; settle: string }): NextWrite | undefined {
  for (const command of commands) {
    const st = commandState(view, command.id);
    if (st.run !== undefined && !st.failed && sameArgv(st.run.command.argv, command.argv)) continue;
    if (st.failed && !st.retry && st.run !== undefined) {
      return { decision: supervise({ reason: `${words.failed}: ${describeCommand(st.run.command)}: ${outputTail(st.run.command)}`, evidenceRefs: [st.run.record.ref] }, `escalate: ${words.failed}`) };
    }
    if (commandRuns(view.evidence, command.id).length >= 4) return { decision: supervise({ reason: words.settle }, `escalate: ${words.settle}`) };
    return { command };
  }
  return undefined;
}

/** Which part of a multi-part artifact a command writes, or undefined for a single command that writes its whole artifact. */
function partOf(command: EnvironmentCommand): { path: string; k: number; n: number } | undefined {
  if (!/-p\d+$/.test(command.id)) return undefined;
  const [path, k, n] = [command.argv[4], Number(command.argv[5]), Number(command.argv[6])];
  return path === undefined || !Number.isSafeInteger(k) || !Number.isSafeInteger(n) ? undefined : { path, k, n };
}

/** The job instruction of a write command: its own for a single command, `Write <path>` or `Write part 2 of 3 of <path>` for a part. */
function writeInstruction(command: EnvironmentCommand, single: string): string {
  const p = partOf(command);
  return p === undefined ? single : p.n === 1 ? `Write ${p.path}` : `Write part ${p.k} of ${p.n} of ${p.path}`;
}

/** Records a checked step of a large run as evidence (an answered batch): one command, or a part set when it does not fit one; a record that keeps failing goes to the supervisor. */
function recordStep(view: RunView, stageId: string, id: string, commands: EnvironmentCommand[], what: string): GraphDecision {
  const next = nextWrite(view, commands, { failed: `recording ${what} failed`, settle: `the record of ${what} keeps failing` });
  if (next === undefined) return supervise({ reason: `the record of ${what} was written as recomputed but does not read back` }, `escalate a record that does not read back (${id})`);
  if ("decision" in next) return next.decision;
  const part = partOf(next.command);
  const instruction = part === undefined ? `Record ${what} as evidence` : `Record ${what} as evidence (part ${part.k} of ${part.n})`;
  return withPrivate(dispatch(commandJob(stageId, instruction, { commands: [next.command] }), `record ${what} as evidence, so a later review cannot supersede it`));
}

/** Where a tool of the confined static job lives: the plugin's directory, the Go and Node installations and the `typescript` package under a hidden home. */
function toolBinds(view: RunView, batches: ReadonlyArray<{ language: string }>): Array<{ path: string; readOnly: boolean }> | undefined {
  const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT);
  if (root === undefined) return undefined;
  const binds = [{ path: root, readOnly: true }];
  const goRoot = environmentOutput(view.evidence, "go-root");
  if (batches.some((b) => b.language === "go") && goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/") binds.push({ path: goRoot, readOnly: true });
  const nodeRoot = path.dirname(path.dirname(process.execPath));
  if (batches.some((b) => b.language === "typescript")) {
    if (nodeRoot !== "/" && nodeRoot !== ".") binds.push({ path: nodeRoot, readOnly: true });
    for (const dir of runtimePackageDirs(root, ["typescript"])) {
      if (!binds.some((b) => dir === b.path || dir.startsWith(`${b.path}${path.sep}`))) binds.push({ path: dir, readOnly: true });
    }
  }
  return binds;
}

/**
 * The directories of the packages the tools import at run time, as Node resolves them from the plugin: the package's
 * location and its real location. In a release install the plugin lives beneath the operator's home, which the confined
 * job hides, and `typescript` sits in an ancestor `node_modules` the plugin directory's own bind does not cover.
 * A package that does not resolve adds nothing (the tool then fails with Node's own message).
 */
export function runtimePackageDirs(pluginRoot: string, names: readonly string[]): string[] {
  const found = new Set<string>();
  const from = createRequire(path.join(pluginRoot, "package.json"));
  for (const name of names) {
    try {
      let dir = path.dirname(from.resolve(name));
      for (; ; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, "package.json")) && path.basename(dir) === name.split("/").pop()) break;
        if (path.dirname(dir) === dir) throw new Error("no package directory");
      }
      found.add(dir);
      found.add(realpathSync(dir));
    } catch {
      // not resolvable from here
    }
  }
  return [...found];
}

function measureAndWrite(ctx: Context, view: RunView, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }>): GraphDecision {
  const { profile, pr } = ctx;
  const m = measurementState(view.evidence, analysis.snapshot.files, profile, retryOf(view), environmentOutput(view.evidence, ENV_PLUGIN_ROOT));
  switch (m.state) {
    case "observe":
      return withPrivate(observe({ paths: m.paths }, "observe the changed files the static tools measure, so their records can be recomputed from the head's bytes"));
    case "diff": {
      // One command lists every measured file's hunk headers; when its report does not fit, the files are listed again in groups (design §6.8).
      const commands = fitJob(m.commands);
      const whole = commands.length === 1 && commands[0]!.id === COMMAND.metricsDiff;
      if (whole) return withPrivate(dispatch(commandJob(REPORT_STAGE, "List the changed lines (git diff -U0 -w)", { commands, env: { ...GIT_ENV } }), "list the head-side changed lines for the static metrics tools"));
      return withPrivate(dispatch(commandJob(REPORT_STAGE, `List the changed lines (git diff -U0 -w) of ${commands.length} group(s) of files`, { commands, continueOnFailure: true, env: { ...GIT_ENV } }), `list the head-side changed lines in ${commands.length} group(s) of files, so each group's hunk headers fit one command report`));
    }
    case "tools": {
      const binds = toolBinds(view, m.batches);
      if (binds === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the static tools run from" }, "escalate a missing plugin path");
      const generated = profile.metrics.generated;
      const goRoot = environmentOutput(view.evidence, "go-root");
      const goBin = goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/" ? path.join(goRoot, "bin", "go") : "go";
      // As many batches as one job carries within the command executor's bounds.
      const commands = fitJob(m.batches.map((b) => staticCommand(b, m.hunks, binds[0]!.path, generated, process.execPath, goBin)));
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Measure the changed functions' complexity and nesting (parse only; no network; no repository code runs)",
        input: { commands, continueOnFailure: true },
        confinement: { kind: "bwrap", network: false, mask: [], binds },
      };
      return withPrivate(dispatch(job, `measure ${commands.length} batch(es) of changed files with the static metrics tools, confined with no network`));
    }
    case "baseFiles":
      // The modified functions' base files, as `git show <base>:<path>` prints them: read-only, no repository code.
      return withPrivate(dispatch(commandJob(REPORT_STAGE, "Read the base versions of the modified files (git show <base>:<path>)", { commands: fitJob(m.commands), continueOnFailure: true, env: { ...GIT_ENV } }), `read ${fitJob(m.commands).length} base file(s) so each modified function can be measured at the base too`));
    case "baseTools": {
      const binds = toolBinds(view, m.batches);
      if (binds === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the static tools run from" }, "escalate a missing plugin path");
      const goRoot = environmentOutput(view.evidence, "go-root");
      const goBin = goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/" ? path.join(goRoot, "bin", "go") : "go";
      const commands = fitJob(m.batches.map((b) => staticBaseCommand(b, m.base, binds[0]!.path, profile.metrics.generated, process.execPath, goBin)));
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Measure the modified functions at the base: complexity and nesting by the same static tools over the base files (parse only; no network; no repository code runs)",
        input: { commands, continueOnFailure: true, env: { ...GIT_ENV } },
        confinement: { kind: "bwrap", network: false, mask: [], binds },
      };
      return withPrivate(dispatch(job, `measure ${commands.length} base file(s) with the static metrics tools, confined with no network`));
    }
    case "probe":
    case "coverage":
      // A static-only profile never reaches the sandbox (design-pr-review-split §3.4).
      return supervise({ reason: "the measurements asked for the Docker sandbox, which the design review never runs" }, "escalate a sandboxed measurement in a static-only graph");
    case "failed":
      return supervise({ reason: `the measurements failed: ${m.problems.slice(0, 3).join("; ")}`, evidenceRefs: m.refs.slice(-10) }, "hand the failed measurements to the supervisor");
    default:
      break;
  }
  const outputs = outputsOf(view.evidence, profile, pr, analysis, flow, m);
  // report.json, review.md, review.html and review-appendix.html: each one command when it fits, else a bounded multi-part write (design §6.6).
  const commands = [...reportWriteCommands(outputs.json, outputs.markdown), ...htmlWriteCommands(outputs.html, false), ...appendixWriteCommands(outputs.appendix, false)];
  const next = nextWrite(view, commands, { failed: "writing the report failed", settle: "the written report keeps differing from the one the evidence recomputes" });
  if (next === undefined) return validateStage(ctx, view, REPORT_STAGE);
  if ("decision" in next) return next.decision;
  const secrets = [...secretFindings(outputs.json), ...secretFindings(outputs.markdown), ...secretFindings(outputs.html), ...secretFindings(outputs.appendix)];
  if (secrets.length > 0) {
    return stop({ reason: "report refused", blocker: `the report would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a report that holds a secret");
  }
  const inert = [...writtenHtmlProblems(outputs.html, pr, pinnedBase(view.evidence)), ...writtenHtmlProblems(outputs.appendix, pr, pinnedBase(view.evidence))];
  if (inert.length > 0) return supervise({ reason: `review.html or review-appendix.html would not be self-contained and inert: ${inert.slice(0, 3).join("; ")}` }, "escalate a report file that fails its own inertness check");
  const idNotes = flow.reading.notes.length > 0 ? `; claim-check ids normalized: ${flow.reading.notes.slice(0, 4).join("; ")}` : "";
  return withPrivate(dispatch(commandJob(REPORT_STAGE, writeInstruction(next.command, `Write ${REVIEW_MD} and report.json`), { commands: [next.command] }), `write report.json, the readable review.md, the HTML briefing review.html and its appendix review-appendix.html${idNotes}`));
}

/** Whether a failed command may run again: the operator resumed since it failed. */
const retryOf = (view: RunView) => (run: CommandRun): boolean => isStaleFailure(run.record, view);

/** What the groundwork still needs, as the decision that gets it (or stops the run). */
function groundworkDecision(step: Extract<ReturnType<typeof qaContext>, { state: "groundwork" }>["step"], stageId: string): GraphDecision {
  switch (step.state) {
    case "observe":
      return withPrivate(observe({ paths: step.paths }, "observe the changed source files the symbol extraction reads, so symbols come from the head's bytes"));
    case "run":
      return withPrivate(dispatch(commandJob(stageId, "Read the base commit for the groundwork (declarations, searches, dependencies)", { commands: step.commands, env: { ...GIT_ENV } }), step.why));
    case "failed":
      return supervise({ reason: `the groundwork could not be read: ${step.problems.join("; ")}`, evidenceRefs: step.refs.slice(-10) }, "hand a failed groundwork read to the supervisor");
    case "incompatible":
      return stop({ reason: "incompatible task", blocker: step.problem, retryable: false }, "stop: the pull request is past a profile limit");
  }
}

function questions(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const c = qaContext(view.evidence, profile, pr, retryOf(view));
  if (c.state === "pending") return supervise({ reason: `the Questions stage lost what it reads: ${c.reason}` }, "escalate a missing report or snapshot");
  if (c.state === "groundwork") return groundworkDecision(c.step, QUESTIONS_STAGE);
  const files = c.ctx.analysis.snapshot.files;
  // N1, the necessity question, comes first (design §7.5): answered and checked before any other question is asked.
  const nf = necessityFlow(view.evidence, c.ctx, retryOf(view));
  switch (nf.state) {
    case "supervise":
      return supervise({ reason: nf.reason, evidenceRefs: nf.refs }, "hand the unresolved necessity answer to the supervisor");
    case "answerer": {
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const planned = planNecessity({ pr, snapshot: c.ctx.analysis.snapshot, view: c.ctx.view, designDocs: c.ctx.designDocs, context: c.ctx.context, kind: nf.kind, feedback: nf.feedback, ...(c.ctx.principles !== undefined ? { principles: c.ctx.principles } : {}), ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, QUESTIONS_STAGE, planned.spills);
      if (written !== undefined) return written;
      const from = nf.kind === "first" ? undefined : jobSession(view, QUESTIONS_STAGE, ANSWERER_JOB);
      const references = principleRefs(NECESSITY_REFERENCES[0]!, c.ctx.principles?.applicable ?? []);
      const job = agentJob(ctx, view, { jobId: ANSWERER_JOB, stageId: QUESTIONS_STAGE, purpose: "diagnostic", instruction: "Answer the necessity question N1 from the whole codebase", schema: nf.schema, harness: profile.roles.answerer, role: "answerer", assignment, references, ...(from !== undefined ? { continueFrom: from } : {}) }, files);
      if ("problem" in job) return refused(job);
      const why = { first: "answer the necessity question N1 (read-only, confined): is the problem real, does the fix fit the design, is there a simpler way", correction: "correct the necessity answer: deterministic validation found problems", revision: "revise the necessity answer: the answer checker did not support it" }[nf.kind];
      return dispatchAgent(view, job, why);
    }
    case "verify":
      return withPrivate(dispatch(commandJob(QUESTIONS_STAGE, "Check the necessity answer's citations against the trees", { commands: nf.commands.slice(0, 16), env: { ...GIT_ENV } }), "resolve each citation of the necessity answer in the tree it names"));
    case "checker": {
      const answer = nf.answers.get(NECESSITY_ID)!;
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const planned = planNecessityChecker({ pr, snapshot: c.ctx.analysis.snapshot, question: necessityQuestion(), answer, replies: authorReplies(c.ctx.prior.items, c.ctx.analysis.snapshot.threads), designDocs: c.ctx.designDocs, context: c.ctx.context, retry: nf.retry, ...(c.ctx.principles !== undefined ? { principles: c.ctx.principles } : {}), ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, QUESTIONS_STAGE, planned.spills);
      if (written !== undefined) return written;
      const references = idRefs({ ...questionRefs(ANSWER_CHECK_REFERENCES[0]!, [necessityQuestion()]), ...principleRefs(ANSWER_CHECK_REFERENCES[1]!, c.ctx.principles?.applicable ?? []) });
      const job = agentJob(ctx, view, { stageId: QUESTIONS_STAGE, purpose: "review", instruction: "Check the necessity answer against the trees", schema: ANSWER_CHECK_SCHEMA_NAME, harness: profile.roles["answer-checker"], role: "answer-checker", assignment, references }, files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check the necessity answer with a fresh read-only ${harnessName(profile.roles["answer-checker"])} session`);
    }
    case "done":
      break;
  }
  const record: NecessityRecord = necessityRecordOf(c.ctx, nf.final[0]!, pr.askAll === true);
  // necessity.json: one command, or a bounded multi-part write when it does not fit one (design §6.6).
  const necessityWrite = nextWrite(view, necessityRecordCommands(record), { failed: "recording the necessity answer failed", settle: "the recorded necessity answer keeps differing from the one the evidence recomputes" });
  if (necessityWrite !== undefined) {
    if ("decision" in necessityWrite) return necessityWrite.decision;
    return withPrivate(dispatch(commandJob(QUESTIONS_STAGE, writeInstruction(necessityWrite.command, `Record N1's checked answer and its decision in ${NECESSITY_JSON}`), { commands: [necessityWrite.command] }), `record N1's outcome (${record.decision.action === "skip" ? "the other questions are skipped" : "every question is asked"}) as evidence`));
  }
  if (record.decision.action === "skip") return validateStage(ctx, view, QUESTIONS_STAGE);
  const flow = questionerFlow(view.evidence, c.ctx);
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved questions to the supervisor");
    case "questioner": {
      const required = requiredQuestions({ view: c.ctx.view, groundwork: c.ctx.groundwork }, new Map());
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const planned = planQuestioner({ pr, snapshot: c.ctx.analysis.snapshot, view: c.ctx.view, groundwork: c.ctx.groundwork, required, feedback: flow.feedback, kind: flow.kind, large: isLarge(c.ctx.mode), ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, QUESTIONS_STAGE, planned.spills);
      if (written !== undefined) return written;
      const from = flow.kind === "first" ? undefined : jobSession(view, QUESTIONS_STAGE, QUESTIONER_JOB);
      // The ids a question may name (design-pr-review-split §3.3): a purpose is about a high-level change, a required or added
      // question about a high-level change or a design-level change item, and no question names a symbol.
      const changeIds = (c.ctx.view.changes ?? []).map((i) => i.id);
      const references = idRefs({ "purposes[].item": idSet(changeIds), "questions[].item": idSet(otherItems(c.ctx.view).map((i) => i.id)), "questions[].symbol": idSet([""]) });
      const job = agentJob(ctx, view, { jobId: QUESTIONER_JOB, stageId: QUESTIONS_STAGE, purpose: "diagnostic", instruction: "Ask the questions (ask only; never answer)", schema: QUESTIONS_SCHEMA_NAME, harness: profile.roles.questioner, role: "questioner", assignment, references, ...(from !== undefined ? { continueFrom: from } : {}) }, files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, flow.kind === "first" ? "ask the questions (read-only, confined)" : "correct the questions: deterministic validation found problems");
    }
    case "done":
      return validateStage(ctx, view, QUESTIONS_STAGE);
  }
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function answers(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const c = qaContext(view.evidence, profile, pr, retryOf(view));
  if (c.state === "pending") return supervise({ reason: `the Answers stage lost what it reads: ${c.reason}` }, "escalate a missing report or snapshot");
  if (c.state === "groundwork") return supervise({ reason: `the Answers stage lost the groundwork the questions rest on (${c.step.state})` }, "escalate a missing groundwork");
  // N1's checked answer and decision are the recorded evidence of the Questions stage (design §7.5).
  const rec = recordedNecessity(view.evidence);
  if (rec.state !== "read") return supervise({ reason: `the Answers stage lost the necessity record (${rec.state === "failed" ? rec.reason : "none was written"})` }, "escalate a missing necessity record");
  const skipped = rec.record.decision.action === "skip";
  let output: Parameters<typeof questionSet>[1];
  if (!skipped) {
    const qf = questionerFlow(view.evidence, c.ctx);
    if (qf.state !== "done") return supervise({ reason: `the Answers stage lost the questions (${qf.state})` }, "escalate missing questions");
    output = qf.output;
  }
  const set = questionSet(c.ctx, output, skipped);
  // A confirmed unnecessary N1 is the only question: nothing else is answered or checked.
  if (skipped) return writeAnswers(ctx, view, c.ctx, set, [rec.record.final], rec.record);
  const rest = afterNecessity(set);
  // Large mode (design §7.6): the answerer takes the questions in batches, and each answered batch is recorded as evidence.
  if (isLarge(c.ctx.mode)) {
    const b = batchedAnswers(view.evidence, c.ctx, rest, retryOf(view));
    switch (b.state) {
      case "supervise":
        return supervise({ reason: b.reason, evidenceRefs: b.refs }, "hand the unresolved answers to the supervisor");
      case "record": {
        const id = batchRecordId(b.index);
        return recordStep(view, ANSWERS_STAGE, id, recordCommands(id, "answers", batchRecordJson(b.record)), `answer batch ${b.index + 1}`);
      }
      case "done":
        return writeAnswers(ctx, view, c.ctx, set, [rec.record.final, ...b.final], rec.record);
      case "batch":
        // qa.json and review.md are written once, after the last batch.
        return answerStep(ctx, view, c.ctx, b.questions, b.flow, { continueFirst: b.index > 0, batch: `batch ${b.index + 1} of ${b.total}` });
    }
  }
  // Questions an earlier head answered and the update did not touch are carried (design §9.3): only the others are answered, and with none left no job runs.
  const flow = restFlow(view.evidence, c.ctx, rest, retryOf(view));
  if (flow.state === "done") return writeAnswers(ctx, view, c.ctx, set, [rec.record.final, ...set.carried, ...flow.final], rec.record);
  return answerStep(ctx, view, c.ctx, rest, flow, { continueFirst: false });
}

/** The agent or command job an answers flow asks for: the answerer, the citation check, or the answer checker. In large mode `questions` is one batch. */
function answerStep(ctx: Context, view: RunView, c: QaContext, rest: readonly Question[], flow: Exclude<ReturnType<typeof answersFlow>, { state: "done" }>, opts: { continueFirst: boolean; batch?: string }): GraphDecision {
  const { profile, pr } = ctx;
  const files = c.analysis.snapshot.files;
  const of = opts.batch !== undefined ? ` (${opts.batch})` : "";
  // Large mode's batches have their own answerer role (design §13.1), which falls back to the answerer; N1 and standard mode use the answerer.
  const answerRole: Role = opts.batch !== undefined ? "batch-answerer" : "answerer";
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved answers to the supervisor");
    case "answerer": {
      const mounted = sourceDirs(c.groundwork.inventory);
      const baseDir = baseTreeDir(view, c.groundwork);
      const planned = planAnswerer({ pr, snapshot: c.analysis.snapshot, view: c.view, groundwork: c.groundwork, questions: rest, kind: flow.kind, feedback: flow.feedback, ...(flow.only !== undefined ? { only: flow.only } : {}), mountedDirs: mounted, ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, ANSWERS_STAGE, planned.spills);
      if (written !== undefined) return written;
      const from = flow.kind === "first" && !opts.continueFirst ? undefined : jobSession(view, ANSWERS_STAGE, ANSWERER_JOB);
      // Untrusted-read confinement, with the dependency source mounted read-only (design §7.3).
      const references = questionRefs(ANSWERS_REFERENCES[0]!, flow.only !== undefined ? rest.filter((q) => flow.only!.includes(q.id)) : rest);
      const job = agentJob(ctx, view, { jobId: ANSWERER_JOB, stageId: ANSWERS_STAGE, purpose: "diagnostic", instruction: `Answer the questions${of} from the whole codebase`, schema: flow.schema, harness: profile.roles[answerRole], role: answerRole, assignment, readOnlyBinds: mounted, references, ...(from !== undefined ? { continueFrom: from } : {}) }, files);
      if ("problem" in job) return refused(job);
      const why = { first: `answer the questions${of} (read-only, confined, dependency source mounted read-only)`, correction: "correct the answers: deterministic validation found problems", revision: "revise the answers: the answer checker did not support some" }[flow.kind];
      return dispatchAgent(view, job, why);
    }
    case "verify":
      return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Check the answers' citations and proposed names against the trees", { commands: flow.commands.slice(0, 16), env: { ...GIT_ENV } }), "resolve each citation in the tree it names, and each proposed name in the package"));
    case "checker": {
      const mounted = sourceDirs(c.groundwork.inventory);
      const baseDir = baseTreeDir(view, c.groundwork);
      const planned = planAnswerChecker({ pr, snapshot: c.analysis.snapshot, groundwork: c.groundwork, replies: authorReplies(c.prior.items, c.analysis.snapshot.threads), questions: rest, answers: flow.answers, retry: flow.retry, mountedDirs: mounted, ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, ANSWERS_STAGE, planned.spills);
      if (written !== undefined) return written;
      // The same dependency source, read-only, so a library or dependency citation can be re-checked where it points.
      const job = agentJob(ctx, view, { stageId: ANSWERS_STAGE, purpose: "review", instruction: `Check the answers${of} against the trees`, schema: ANSWER_CHECK_SCHEMA_NAME, harness: profile.roles["answer-checker"], role: "answer-checker", assignment, readOnlyBinds: mounted, references: questionRefs(ANSWER_CHECK_REFERENCES[0]!, rest) }, files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check every answer${of} with a fresh read-only ${harnessName(profile.roles["answer-checker"])} session`);
    }
  }
}

/** After the answers: write qa.json and review.md, advance the ledger by compare-and-swap, then validate the stage. */
function writeAnswers(ctx: Context, view: RunView, c: QaContext, set: ReturnType<typeof questionSet>, final: Parameters<typeof qaOutputs>[2], necessity: NecessityRecord): GraphDecision {
  return writeAnswerFiles(ctx, view, answerWrites(view.evidence, c, set, final, necessity), c.base);
}

/** The Answers stage's writes: qa.json, the whole review.md and the two HTML pages, then the ledger. */
function writeAnswerFiles(ctx: Context, view: RunView, w: AnswerWrites, base: string | undefined): GraphDecision {
  if (w.qa === undefined || w.texts === undefined) return stop({ reason: "incompatible task", blocker: w.problem ?? "the Q&A cannot be written", retryable: false }, "stop: the Q&A cannot be written");
  // qa.json, the whole review.md and review.html: each one command when it fits, else a bounded multi-part write (design §6.6).
  const next = nextWrite(view, w.qa, { failed: "writing the Q&A failed", settle: "the written Q&A keeps differing from the one the evidence recomputes" });
  if (next === undefined) return recordLedger(ctx, view, w);
  if ("decision" in next) return next.decision;
  const secrets = [...secretFindings(w.texts.json), ...secretFindings(w.texts.markdown), ...secretFindings(w.texts.html), ...secretFindings(w.texts.appendix)];
  if (secrets.length > 0) {
    return stop({ reason: "report refused", blocker: `the Q&A would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a Q&A that holds a secret");
  }
  const inert = [...writtenHtmlProblems(w.texts.html, ctx.pr, base), ...writtenHtmlProblems(w.texts.appendix, ctx.pr, base)];
  if (inert.length > 0) return supervise({ reason: `review.html or review-appendix.html would not be self-contained and inert: ${inert.slice(0, 3).join("; ")}` }, "escalate a report file that fails its own inertness check");
  return withPrivate(dispatch(commandJob(ANSWERS_STAGE, writeInstruction(next.command, `Write ${QA_JSON} and ${REVIEW_MD}`), { commands: [next.command] }), "write qa.json, the whole review.md (Briefing, Appendix) and the HTML briefing review.html with its appendix review-appendix.html"));
}

function recordLedger(ctx: Context, view: RunView, w: AnswerWrites): GraphDecision {
  const read = ledgerRead(view.evidence);
  const lw = commandState(view, COMMAND.ledgerWrite);
  if (read === undefined || w.old === undefined) return supervise({ reason: w.problem ?? "the ledger value Fetch read is not in the evidence" }, "escalate a missing ledger read");
  const ref = writtenLedger(lw.run?.command.argv ?? [])?.ref ?? "the ledger ref";
  if (lw.run !== undefined && lw.failed) {
    if (!lw.retry) {
      if (lw.run.command.exitCode === LEDGER_MOVED) {
        return stop({ reason: "ledger moved", blocker: `another run advanced ${ref} after Fetch read it; resume to read it again and record this head after it`, evidenceRefs: [lw.run.record.ref], retryable: true }, "stop: lost the compare-and-swap on the ledger");
      }
      return supervise({ reason: `advancing the ledger failed: ${describeCommand(lw.run.command)}: ${outputTail(lw.run.command)}`, evidenceRefs: [lw.run.record.ref] }, "escalate a failed ledger write");
    }
    // After the operator's resume: read the ledger again first, since the value the write swapped from was stale.
    const at = (r: string): number => view.evidence.findIndex((e) => e.ref === r);
    if (at(read.run.record.ref) < at(lw.run.record.ref)) {
      return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Read the pull request's ledger ref again", { commands: [ledgerReadCommand(ctx.pr.owner, ctx.pr.repo, ctx.pr.number)], env: { ...GIT_ENV } }), "read the ledger ref again: it moved since Fetch read it"));
    }
  }
  const lr = commandState(view, COMMAND.ledger, ledgerReadCommand(ctx.pr.owner, ctx.pr.repo, ctx.pr.number));
  if (lr.failed && lr.run !== undefined) return supervise({ reason: `the ledger read failed: ${describeCommand(lr.run.command)}`, evidenceRefs: [lr.run.record.ref] }, "escalate a failed ledger read");
  if (w.prior?.state === "missing" || (w.prior?.state === "unreadable" && retryOf(view)(w.prior.run))) {
    return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Read the prior ledger's ledger.json", { commands: w.prior?.state === "missing" ? w.prior.next : [{ id: w.prior!.run.command.id, argv: w.prior!.run.command.argv }], continueOnFailure: true, env: { ...GIT_ENV } }), "read the prior ledger.json, so the new one keeps its heads"));
  }
  if (w.prior?.state === "unreadable") {
    return supervise({ reason: w.problem ?? "the prior ledger cannot be read", evidenceRefs: [w.prior.run.record.ref] }, "escalate a prior ledger that cannot be read: it is never overwritten");
  }
  if (w.ledger === undefined) return stop({ reason: "incompatible task", blocker: w.problem ?? "the ledger files cannot be written", retryable: false }, "stop: the ledger files do not fit one command");
  if (lw.run !== undefined && !lw.failed && sameArgv(lw.run.command.argv, w.ledger.argv)) return validateStage(ctx, view, ANSWERS_STAGE);
  if (commandRuns(view.evidence, COMMAND.ledgerWrite).length >= 6) return supervise({ reason: "the ledger write keeps differing from the one the evidence recomputes" }, "escalate a ledger write that does not settle");
  // The files the write reads are written first as part sets (design §6.6): the review section a migration of a v1 ledger builds (design-pr-review-split §5.4), and a design ledger.json or ledger.md too large for the write's one command.
  const parts = nextWrite(view, w.ledgerParts ?? [], { failed: "writing the ledger files failed", settle: "the written ledger files keep differing from the ones the evidence recomputes" });
  if (parts !== undefined) {
    if ("decision" in parts) return parts.decision;
    return withPrivate(dispatch(commandJob(ANSWERS_STAGE, writeInstruction(parts.command, "Write the ledger files"), { commands: [parts.command] }), "write the ledger files the section write reads, as parts: a migrated review section, or a design section too large for its one command"));
  }
  return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Advance the pull request's ledger ref by compare-and-swap (no repository code runs)", { commands: [w.ledger], env: { ...GIT_ENV } }), "record this head's report and Q&A in the ledger, from the value Fetch read"));
}

// ---- round 1 and publishing (design §9.4, §8.5) ----

/** The Round 1 stage: the issues of the report and the Q&A, computed by plugin code and recorded once, then validated. */
function round1Stage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return supervise({ reason: a.state === "pending" ? `the round-1 stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  const computed = round1Computed(view.evidence, a.analysis, pr);
  if (computed.state === "pending") return supervise({ reason: `round 1 cannot be decided: ${computed.reason}` }, "escalate a missing Q&A artifact");
  const rec = recordedRound1(view.evidence);
  if (rec.state === "failed") return supervise({ reason: `the round-1 record does not read back: ${rec.reason}`, evidenceRefs: rec.refs }, "escalate an unreadable round-1 record");
  if (rec.state === "read" && round1Json(rec.value) === round1Json(computed.record)) return validateStage(ctx, view, ROUND1_STAGE);
  const n = computed.record.issues.length;
  return recordStep(view, ROUND1_STAGE, ROUND1_RECORD_ID, recordCommands(ROUND1_RECORD_ID, ROUND1_DIR, round1Json(computed.record)), `round 1 (${n} open item${n === 1 ? "" : "s"})`);
}

/** The stop reason of a review the run is not allowed to post. */
export const POSTING_NOT_ENABLED = "posting not enabled";

/** What the stop says when round 1 has a review to post (open items, or the note) and the runner withholds the write. */
function postingNotEnabled(open: number): string {
  const enable = "set the runner config's github.writeTokenEnv and resume to post";
  const what = open > 0 ? `round 1 has ${open} open item${open === 1 ? "" : "s"}` : "round 1 is clean and the profile asks for the design-review-passed note";
  return `${what}; posting is not enabled (${enable}). The report is ${REVIEW_HTML} and the round-1 record ${REVIEW_DIR}/${ROUND1_DIR}/${ROUND1_RECORD_ID}.json, in the run's worktree`;
}

/**
 * Whether the review's write is withheld. The runner's grants are declared data on the run view (`executors[].effectGranted`);
 * a runner that reports none leaves the write to the controller's own refusal and recovery.
 */
function writeWithheld(view: RunView): boolean {
  return view.executors?.find((e) => e.id === CREATE_PULL_REVIEW.id)?.effectGranted === false;
}

/**
 * The Publish stage (design-pr-review-split §3.7). With open items (or the profile's note): read the pull request's reviews, post
 * the one review unless this head already has it, read its comments back. Then, posted or not, record this head's outcome in the
 * ledger's design section. A clean round 1 with no note makes no GitHub call at all, so it needs no write grant.
 */
function publishStage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return supervise({ reason: a.state === "pending" ? `the publish stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  const p = publishPlan(view.evidence, a.analysis, pr, profile.comments);
  if (p.state === "pending") return supervise({ reason: `the review cannot be composed: ${p.reason}` }, "escalate a missing record");
  if (p.state === "failed") return supervise({ reason: p.reason, evidenceRefs: p.refs }, "escalate an unreadable record");
  if (p.plan.problem !== undefined) return supervise({ reason: p.plan.problem }, "escalate a review whose items cannot all be made readable");
  if (p.plan.post) {
    const secrets = secretFindings(JSON.stringify(createInput(pr, p.plan)));
    if (secrets.length > 0) return stop({ reason: "report refused", blocker: `the review would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not posted`, retryable: false }, "refuse to post a review that holds a secret");
  }
  const flow = publishFlow(view.evidence, p.plan, pr);
  // Posting is the operator's to enable: without the grant the report is the result, and the run ends here instead of failing the write into the supervisor.
  if ((flow.state === "viewer" || flow.state === "reviews" || flow.state === "create") && writeWithheld(view)) {
    return stop({ reason: POSTING_NOT_ENABLED, blocker: postingNotEnabled(p.plan.open), retryable: false }, "stop: round 1 has a review to post and the runner does not grant its write");
  }
  const base = { owner: pr.owner, repo: pr.repo, number: pr.number };
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved publication to the supervisor");
    case "viewer":
      return withPrivate(dispatch({ stageId: PUBLISH_STAGE, kind: "command", purpose: "diagnostic", readOnly: true, instruction: "Read who the GitHub credential authenticates as", executor: GET_VIEWER, input: base }, flow.why));
    case "reviews":
      return withPrivate(dispatch(githubJob(REVIEWS_READ, { ...base, perPage: 100, maxPages: 10, ...(flow.cursor !== undefined ? { cursor: flow.cursor } : {}) }, PUBLISH_STAGE), flow.why));
    case "comments":
      return withPrivate(dispatch(githubJob(COMMENTS_READ, { ...base, perPage: 100, maxPages: 10, ...(flow.cursor !== undefined ? { cursor: flow.cursor } : {}) }, PUBLISH_STAGE), flow.why));
    case "create": {
      const input = createInput(pr, p.plan);
      const sent = Buffer.byteLength(JSON.stringify(input), "utf8");
      if (sent > MAX_EXECUTOR_INPUT_BYTES) return stop({ reason: "incompatible task", blocker: `the review is ${sent} bytes once serialized, more than the ${MAX_EXECUTOR_INPUT_BYTES} an executor input carries`, retryable: false }, "stop: the review does not fit an executor input");
      const job: JobSpec = { stageId: PUBLISH_STAGE, kind: "command", purpose: "diagnostic", effect: "write", instruction: `Post the design review (${p.plan.firstLine}) to ${pr.owner}/${pr.repo}#${pr.number} as one COMMENT review at head ${pr.head.slice(0, 12)}`, executor: CREATE_PULL_REVIEW, input };
      return withPrivate(dispatch(job, flow.why));
    }
    case "ledger": {
      const lw = commandState(view, COMMAND.ledgerPublished);
      const what = flow.posted !== undefined ? `review ${flow.posted.reviewId}` : "this head as clean";
      if (lw.run !== undefined && lw.failed && !lw.retry) {
        if (lw.run.command.exitCode === LEDGER_MOVED) return stop({ reason: "ledger moved", blocker: `another run advanced the ledger's design section while this one recorded ${what}; resume to record it again`, evidenceRefs: [lw.run.record.ref], retryable: true }, "stop: lost the compare-and-swap on the ledger");
        return supervise({ reason: `recording ${what} in the ledger failed: ${describeCommand(lw.run.command)}: ${outputTail(lw.run.command)}`, evidenceRefs: [lw.run.record.ref] }, "escalate a failed ledger write");
      }
      if (commandRuns(view.evidence, COMMAND.ledgerPublished).length >= 4) return supervise({ reason: "the ledger write of this head's outcome keeps differing from the one the evidence recomputes" }, "escalate a ledger write that does not settle");
      // The patch is written first, as a part set with a digest (it can be far past one argument), and the ledger command reads the file.
      const parts = nextWrite(view, flow.parts, { failed: "writing this head's ledger patch failed", settle: "the written ledger patch keeps differing from the one the evidence recomputes" });
      if (parts !== undefined) {
        if ("decision" in parts) return parts.decision;
        return withPrivate(dispatch(commandJob(PUBLISH_STAGE, writeInstruction(parts.command, "Write this head's ledger patch"), { commands: [parts.command] }), "write the patch that records this head's outcome in the ledger, in parts with a digest"));
      }
      return withPrivate(dispatch(commandJob(PUBLISH_STAGE, "Record this head's outcome in the ledger's design section by compare-and-swap (no repository code runs)", { commands: [flow.command], env: { ...GIT_ENV } }), flow.posted !== undefined ? `record review ${flow.posted.reviewId} and its comments' ids in the ledger` : "record this head as clean in the ledger: nothing is posted"));
    }
    case "done":
      return validateStage(ctx, view, PUBLISH_STAGE);
  }
}
