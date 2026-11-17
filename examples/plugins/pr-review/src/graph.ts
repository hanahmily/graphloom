// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * pr-review 1.x (design-pr-review-split §4): round 2 only, runnable alone. Fetch → Report → Review → Draft → Publish (the Checks
 * stage exists only when the profile has `checks`, which this version refuses as a later field, so there is none). The reviewers'
 * context is the design review's report of this head or of an earlier head with a usable delta, else a report-only prelude, else,
 * only on `--no-report`, the pull request's metadata and patches (§4.2). The maintainability reviewer is given deterministic leads
 * (§4.3). The run posts one `COMMENT` review whose first line is the verdict, counting round 1's open items when the design review
 * ran on the pull request, and records it in the ledger's `review` section only (§4.5, §5).
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  dispatch,
  isStaleFailure,
  jsonSchemaProblem,
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_JOB_TIMEOUT_MS,
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
import { analyze, reportFlowOf, type Analysis } from "./kit/analysis.js";
import { checkoutCommand, GIT_ENV, GUARD_REFUSED, guardCommand, headTreeCommand, ledgerReadCommand, pinnedBase, reviewDirCommand } from "./kit/commands.js";
import {
  CODING_AGENT,
  COMMAND,
  CONTEXT_JSON,
  CREATE_PULL_REVIEW,
  DRAFT_JSON,
  DRAFT_MD,
  DRAFT_STAGE,
  ENV_PLUGIN_ROOT,
  ENV_WORKTREE,
  FETCH_STAGE,
  GET_VIEWER,
  LEDGER_MOVED,
  PART_BASE,
  PUBLISH_STAGE,
  REPORTER_JOB,
  REPORT_STAGE,
  REQUIREMENT_CHECKED_OUT,
  REQUIREMENT_CLAIMS,
  REQUIREMENT_CODE_REVIEW,
  REQUIREMENT_CONTEXT,
  REQUIREMENT_DRAFT,
  REQUIREMENT_FINDINGS_PROVEN,
  REQUIREMENT_LEADS,
  REQUIREMENT_LEDGER,
  REQUIREMENT_LEDGER_RECORDED,
  REQUIREMENT_MEASUREMENTS,
  REQUIREMENT_PUBLISHED,
  REQUIREMENT_REPORT,
  REQUIREMENT_SNAPSHOT,
  REVIEW_APPENDIX_HTML,
  REVIEW_DIR,
  REVIEW_HTML,
  REVIEW_MD,
  REVIEW_STAGE,
} from "./kit/constants.js";
import { claimRecordCommands } from "./kit/claimrecord.js";
import { GRAPH_ID, GRAPH_VERSION } from "./version.js";
import { checkBatch, DIAGRAMMER_JOB, DIAGRAMS_REFERENCES, DIAGRAMS_SCHEMA, DIAGRAMS_SCHEMA_NAME, diagramInputOf, planDiagrams, MAX_DIAGRAM_BYTES, MAX_DIAGRAMS, SKILL_DIR, skillMount } from "./kit/diagrams.js";
import { commandRuns, describeCommand, environmentOutput, outputTail, succeeded, validatorEvidence, type CommandRun } from "./kit/evidence.js";
import { INTERFACE_PATCH_BYTES } from "./kit/digest.js";
import { LIMITS } from "./kit/metrics/crap.js";
import { CHANGE_REPORT_SCHEMA, MAX_ITEM_CHARS } from "./kit/report.js";
import { CLAIM_CHECK_REFERENCES, CLAIM_CHECK_SCHEMA, CLAIM_CHECK_SCHEMA_NAME } from "./kit/claims.js";
import { REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME, reportSpec, type ReportFlow } from "./kit/flow.js";
import { budgetShortfall, largeNeeds } from "./kit/large.js";
import { largeCheckScope, planLargeReporter } from "./kit/largeprompts.js";
import { measurementState, metricsDiffCommand, staticBaseCommand, staticCommand, type MeasurementState } from "./kit/measurements.js";
import { coverageCommand, coverageConfinement, missingProbe, sandboxEnvironmentChecks, type CoveragePlan } from "./kit/coverage.js";
import { planChecker, planReporter } from "./kit/prompts.js";
import { assignmentProblem, type FileSpill } from "./kit/fit.js";
import { isLarge } from "./kit/mode.js";
import { harnessName, parseProfile, ProfileError, REVIEW_ROLES, reviewerRole, verifierRole, DISTINCT_PAIRS, type Profile, type Role } from "./kit/profile.js";
import { ASPECTS, ruleGroups, ruleFileText } from "./kit/aspects.js";
import { groundworkState, type GroundworkState } from "./kit/groundwork.js";
import { principlesContext, principlesReadCommand, principlesReading, type PrinciplesContext } from "./kit/principles.js";
import { appendixWriteCommands, htmlWriteCommands, partCommands, recordCommands, reportWriteCommands } from "./kit/parts.js";
import { requestedPull, type PullRequest } from "./kit/request.js";
import { secretFindings } from "./kit/secrets.js";
import { readInput, snapshotState, type PullFile, type ReadSpec } from "./kit/snapshot.js";
import { ledgerRead, oldValue, priorState } from "./kit/ledger.js";
import { reproEnv, reproJob, reproRunsIn } from "./reproplan.js";
import { aspectFlow, aspectRecordId, aspectRecordJson, ASPECT_RECORD_SCHEMA, findingsOf, REVIEW_REFERENCES, REVIEW_SCHEMA, REVIEW_SCHEMA_NAME, VERIFY_REFERENCES, VERIFY_SCHEMA, VERIFY_SCHEMA_NAME, type AspectRecord } from "./review.js";
import { chooseScope, FRESH_START_REASON, scopeRecordJson, SCOPE_RECORD_ID, SCOPE_SCHEMA, type ScopeRecord } from "./reviewscope.js";
import { planReviewer, planVerifier, round1Verdicts } from "./reviewprompts.js";
import { draftWrites, readingOrder, recordedAspect, recordedRules, recordedScope, ruleCommands } from "./reviewdraft.js";
import { registryFromEvidence } from "./prior.js";
import { aspectPrior } from "./priorreview.js";
import { COMMENTS_READ, createInput, publishFlow, publishPlan, REVIEWS_READ } from "./publish.js";
import { scopeLine, DRAFT_SCHEMA } from "./draft.js";
import { prepareTask } from "./prepare.js";
import { contextJson, decideContext, type ContextRecord } from "./context.js";
import { computeLeads, correctnessContext, MAX_LEADS } from "./leads.js";
import { contextReport, designState, recordedContext } from "./runcontext.js";
import { reviewLedgerWrite } from "./reviewledger.js";
import { contextOutputs, diagramsOf, groundworkOptions, leadInputOf, outputsOf, validatorById, writtenHtmlProblems } from "./validators.js";
import { baseDirIn } from "./kit/basetree.js";

export { GRAPH_ID, GRAPH_VERSION };

const asSchema = (schema: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/** The ids a job's contract field is constrained to: the contract's `enum`, with each id's description for reconciling a value that names the thing instead. */
const idSet = (ids: readonly string[], describe?: (id: string) => string): ReferenceSet => ({ ids: [...ids], ...(describe !== undefined ? { descriptions: Object.fromEntries(ids.filter((i) => i !== "").map((i) => [i, describe(i)])) } : {}) });
const oneLineText = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Per-job id sets for a contract's reference paths; a path with no ids is left unconstrained (an empty enum would allow nothing). */
const idRefs = (sets: Record<string, ReferenceSet>): Record<string, ReferenceSet> => Object.fromEntries(Object.entries(sets).filter(([, v]) => v.ids.length > 0));

/** The defaults the design gives a pr-review run (design §13.3), under the profile's own and the task's. */
const DEFAULT_BUDGETS: GraphBudgetDefaults = { agentInvocations: 1_200, jobs: 220, decisions: 240, corrections: 12, activeMs: 4 * 3_600_000, waitMs: 6 * 3_600_000 };

/** Environment checks the graph adds to the profile's: where the worktree, the plugin and Go live (for the confined static tools), and the state of the sandbox images (reported by `graphloom check` and `doctor --task`, never failing the run). */
function generatedChecks(profile: Profile): EnvironmentCommand[] {
  return [
    { id: ENV_WORKTREE, argv: ["sh", "-c", "pwd -P"] },
    {
      id: ENV_PLUGIN_ROOT,
      argv: ["sh", "-c", 'r=${GRAPHLOOM_PLUGIN_ROOT:-}; [ -n "$r" ] || { echo "GRAPHLOOM_PLUGIN_ROOT is not set: GraphLoom sets it to the plugin\'s directory for environment checks" >&2; exit 127; }; cd "$r" && pwd -P'],
    },
    { id: "go-root", argv: ["sh", "-c", "go env GOROOT 2>/dev/null || true"] },
    ...sandboxEnvironmentChecks(profile),
  ];
}

/** The graph definition for a profile. The stage list is fixed per plugin version, whatever the profile or the request says. */
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
      statement: "The pull request's ledger ref (refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger) was read, or recorded absent; a graphloom-pr-ledger-v1 ledger is migrated in memory. Its review section (the earlier findings) and its design section (the design review's heads and open items) were read, or recorded absent. When the design section holds a head D, D's report.json, qa.json and necessity.json were read from the ledger commit, and, when D is not this head, the delta from D to this head (git diff -U0 over this head's files and the files D's report cites, reduced to its file and hunk headers) and whether D's base is in the review clone, with no repository code; or the reason they are not usable was recorded (no design head, a file missing or not of D, D and this head not of one mode, D or its base not in the review clone, a delta that is cut or does not fit). The sandbox images were checked by digest.",
      evidenceSchema: "command-report-v1",
    },
    {
      id: REQUIREMENT_CONTEXT,
      statement: `The reviewers' context source was decided by plugin code and recorded in ${CONTEXT_JSON} (pr-review-context-v1), the first that applies: design-review (the design section's report of D, used as it is when D is this head, or with the "Since this report" delta when D is an earlier head whose delta is usable; a round-1 report with open items is used all the same), else prelude (a report-only prelude of this run), else none, which is taken only when the task's request says "without a report" (graphloom task new pr-review … --no-report) and no design report is usable. The record names the source, D and its base for design-review, the delta's files and hunks, the reasons each earlier source was not used, and whether the request asked for no report; the validator recomputes it from the ledger reads, the delta and the pinned request.`,
      evidenceSchema: "command-report-v1",
    },
    {
      id: REQUIREMENT_REPORT,
      statement: `When the context source is prelude: every template section is present, with cited items or an explicit None; every citation lies inside the pull request's diff on the side it names; every changed file (a renamed file under both names, a deleted file too) and every detector fact is cited, and no item carries a severity, finding or verdict. report.json, ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} hold exactly that report, rendered by plugin code (a briefing with what is new, the scope, the features' data flow drawn with the vendored diagram-design skill (${SKILL_DIR}) or by the plugin when a drawing fails its checks, at most ${MAX_DIAGRAMS} diagrams of at most ${MAX_DIAGRAM_BYTES} characters, what to check, the hotspots and the areas), the briefing's verdict line saying there is no design review in this run and no open questions or Q&A part. In large mode (over the profile's maxFiles or maxPatchBytes) one reporter job is given a bounded digest (the interface files' patches at most ${INTERFACE_PATCH_BYTES} bytes) and reports at a high level; an item's text is at most ${MAX_ITEM_CHARS} characters. When the source is design-review or none, the Report stage writes no report of its own: ${REVIEW_MD} is the reviewers' seed, rendered by plugin code from D's report, necessity and Q&A records with this run's measurements (and the delta when D is another head), or, for none, from the pull request's metadata as untrusted blocks, its file list with the diffstat and the patches of the files in the review's scope; it recomputes from the evidence. Every HTML file is self-contained and inert, and every file is written by one command or a bounded multi-part write that the validators reconstruct and check against its digest.`,
      evidenceSchema: "change-report-v1",
    },
    {
      id: REQUIREMENT_MEASUREMENTS,
      statement: `Whatever the context source: for every function the pull request adds or modifies, complexity and nesting were measured by the pinned static tools (gometrics, tsmetrics) over the head tree, under bwrap with no network, and every value recomputes from its evidence; a modified function is also measured at the base (its file read with git show <base>:<path>), or says why the base is not known. Coverage runs the pull request's own tests, so it runs only in the Docker sandbox (no network, a read-only dependency cache, a prepared checkout of the head, images pinned by digest and pulled in Fetch): ${profile.metrics.coverage ? "each function's statement coverage is attributed by line range from the sandbox's report, and its CRAP is recomputed, or the function says why it was not run and its CRAP is shown as its upper bound" : "not run (coverage disabled by the profile), CRAP shown as its upper bound"}. Mutation arrives with a later version. The leads are computed from these records.`,
      evidenceSchema: "graphloom-metrics-v1",
    },
    {
      id: REQUIREMENT_CLAIMS,
      statement: `When the context source is prelude: an independent ${checker} report checker, on a harness other than the reporter's, in a read-only review job, judged every report item and briefing claim against the diff (in large mode against the trees its cites name), and every item left is supported with quotes that match; an item not supported after one revision is removed and recorded. When the source is design-review or none, no report of this run's is checked and the requirement passes on the recorded source.`,
      evidenceSchema: CLAIM_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_CODE_REVIEW,
      statement: `For each of the aspects correctness, maintainability and security, a read-only reviewer (${ASPECTS.map((a) => `${a}: ${harnessName(profile.roles[reviewerRole(a)])}`).join(", ")}) swept the review's scope with the aspect's rule file, and every finding it raised has a verdict from the aspect's verifier (${ASPECTS.map((a) => `${a}: ${harnessName(profile.roles[verifierRole(a)])}`).join(", ")}), a fresh read-only session on a harness other than the reviewer's. The scope is the whole pull request; in large mode it is the files of the areas that the context report's risks, behavior and compatibility entries cite (a design review's cites mapped to this head, a cite whose file left the pull request dropped), every readable area when it cites none or there is no report. It is recorded once, in a review-scope record that names the context source, which equals ${CONTEXT_JSON}'s, with the reason every reviewer starts as it does: a fresh session seeded with ${REVIEW_MD} only. Each aspect's effective rule file is written to .graphloom/review/rules/<aspect>.json and covers the scope (the maintainability rule's focus includes reuse, complexity, test coverage and test quality, and the leads it is given; whether a whole feature already exists is out of its scope only when the context is the design review). The design principles that apply to the scope are listed with round 1's verdicts from D's necessity record when the source is design-review, and "round 1: not run" otherwise. The sweep follows issue-fix's review convergence (a confirmation needs its own path:line witness, a refutation one to three quotes the head shows, at most 4 passes; a sweep that ends at the cap is recorded unsaturated). The groundwork the leads rest on (symbols, the test map, and, up to ${profile.limits.maxNewSymbols} new symbols, the whole-repository searches over the pinned base) was read by read-only commands.`,
      evidenceSchema: VERIFY_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_LEADS,
      statement: `Before the first pass, plugin code computed the leads of the review's scope from the measurement records, the test map and the search reports: untested-feature (a high-level change of the context report whose every new or modified function in the files its cites name has no covering test: the test map finds none and coverage, when measured, executed none of their statements; none without a report), missing-test (such a function outside an untested-feature lead), weak-test (a surviving mutant at a covered site; none when coverage was not measured), split-function (complexity of ${LIMITS.complexity} or more or nesting over ${LIMITS.nesting}, with whether the excess is inherited, made worse or introduced), crap (measured coverage and CRAP of ${LIMITS.crap} or more, or unknown coverage and complexity of ${LIMITS.complexity} or more) and reuse (a new symbol whose search found a name or signature hit, or a body at least ${profile.questions.similarity} similar, outside the changed files, or another new symbol over that similarity; none past ${profile.limits.maxNewSymbols} new symbols). At most ${MAX_LEADS} are given to the maintainability reviewer's first pass, untested-feature first, then by kind and path; the rest are recorded as not given. Every lead given has exactly one status from that reviewer: raised (naming the comment it raised, which is then an ordinary finding, verified and prioritized) or not-an-issue (with a reason); a missing, repeated or unknown lead goes back to the same session as a correction. The correctness reviewer was given the surviving mutants and untested functions of its scope as context. The leads and their statuses are recorded in review-aspect-maintainability (pr-review-aspect-v2) and recompute from the evidence.`,
      evidenceSchema: VERIFY_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_FINDINGS_PROVEN,
      statement: `Every behavioral finding is proven only when the graph's own run of its reproducing test says so, recomputed from the recorded evidence (design §8.2): the reviewer's test text (at most ${profile.review.repro.maxTestBytes} bytes) was run twice by one command job in the Docker sandbox, built and ran exactly the named test, failed in both runs attributably to the cited behavior, and the verifier confirmed the finding and judged that the test demonstrates it. Every other behavioral finding is unproven with its reason, never drafted as P0 or P1 and never makes the verdict request-changes; ${profile.review.repro.enabled ? `at most ${Math.floor(profile.review.repro.timeBudgetMs / profile.review.repro.perFindingMs)} tests run on one head` : "no test runs (review.repro.enabled is false)"}. A finding raised from an untested-feature lead is proven by its recorded test map and coverage, not by a test: the lead recomputes from the evidence and the verifier confirmed that no test of the pull request or the base exercises the feature; it is the one non-behavioral finding that may be drafted at P1.`,
      evidenceSchema: VERIFY_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_DRAFT,
      statement: `The draft review is composed by plugin code from the aspects' records (no model writes it) and written whole to ${DRAFT_JSON} (pr-review-draft-v2, canonical) and ${DRAFT_MD}. Confirmed findings are the comments, grouped by aspect, at most P2 unless proven (or, for a confirmed untested-feature finding, P1); confirmed findings of different aspects on overlapping lines of one file are one entry; unproven behavioral and disputed findings are listed under "Needs your judgment". No Q&A item is drafted: the draft lists round 1's open items (the design section's latest head with a recorded outcome, each with a link to its comment or "not posted"), says the design review has no open item, or says round 1 was not run. The recommended verdict is request-changes only for a proven P0 or P1 finding or a confirmed untested-feature finding at P1, approve only when nothing is open, and approve is drafted as comment. ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} (the HTML only when there is a report: not for none) are written again with a Review section and the leads in the appendix, with the same inert check.`,
      evidenceSchema: DRAFT_SCHEMA,
    },
    {
      id: REQUIREMENT_LEDGER_RECORDED,
      statement: "The ledger's review section was advanced by compare-and-swap from the value Fetch read, with this head, its context source (and D), the round-1 head and open count it counts, and its lead counts; the design section was carried from the ref's current value unchanged (a v1 ledger is migrated by this write: the top-level ledger.json, the migrated design section with the v1 commit's report, Q&A and necessity record, and the review section). A section that moved since its baseline stops the run retryably (ledger moved).",
      evidenceSchema: "command-report-v1",
    },
    {
      id: REQUIREMENT_PUBLISHED,
      statement: "The review was posted to the pull request as exactly one GitHub review of event COMMENT (never APPROVE or REQUEST_CHANGES), pinned to head <sha>, by the graphloom.github/create-pull-review executor with the idempotency key review-<head12>, whose credential the plugin never sees, or a review of this head carrying <!-- graphloom-review: <head> <nonce> --> was already there and was found by reading the pull request's reviews before any post (a review carrying graphloom-design-review is never this graph's). Its body's first line is the verdict: \"Review passed\" when no finding (new or earlier) is open and no round-1 item is open, else \"Changes requested: <n> open\", n counting the open findings, earlier ones included, and the open round-1 items listed (without a round-1 record, the findings only). The body says what round 1 left open, with links, or that round 1 was not run; nothing of round 1 is posted again. Round 2's postable findings are inline when anchored (at most 50), the rest in the body, each with its <!-- graphloom-finding: F<n> --> marker; on a later head the body says what became of the earlier findings. The review's comments were read back and the ledger's review section records the review id, its verdict and each item's ids, advanced by compare-and-swap from this run's ledger-recorded write.",
      evidenceSchema: "publish-v1",
    },
  ];
  const bindings: ValidatorBinding[] = [
    { requirementId: REQUIREMENT_SNAPSHOT, validatorId: "pr-snapshot", version: "1" },
    { requirementId: REQUIREMENT_CHECKED_OUT, validatorId: "head-tree", version: "1" },
    { requirementId: REQUIREMENT_LEDGER, validatorId: "review-scope", version: "1" },
    { requirementId: REQUIREMENT_CONTEXT, validatorId: "review-context", version: "1" },
    { requirementId: REQUIREMENT_REPORT, validatorId: "change-report", version: "1" },
    { requirementId: REQUIREMENT_MEASUREMENTS, validatorId: "measurements", version: "1" },
    // Not bound as a separate reviewer: a run whose context is the design review's has no claim check of its own (the controller would
    // find no review evidence in the Report stage), so the validator itself requires that a prelude's checks are read-only review jobs.
    { requirementId: REQUIREMENT_CLAIMS, validatorId: "claims-checked", version: "1" },
    // The reviews' verifiers are independent reviewers: the controller admits it from review evidence of a read-only review job.
    { requirementId: REQUIREMENT_CODE_REVIEW, validatorId: "code-review", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_LEADS, validatorId: "leads-judged", version: "1" },
    { requirementId: REQUIREMENT_FINDINGS_PROVEN, validatorId: "findings-proven", version: "1" },
    { requirementId: REQUIREMENT_DRAFT, validatorId: "draft-composed", version: "1" },
    { requirementId: REQUIREMENT_LEDGER_RECORDED, validatorId: "ledger-cas", version: "1" },
    { requirementId: REQUIREMENT_PUBLISHED, validatorId: "review-published", version: "1" },
  ];
  return {
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    privateStateSchema: "pr-review-private-v1",
    resultContracts: [
      { name: REPORTER_SCHEMA_NAME, schema: asSchema(CHANGE_REPORT_SCHEMA), evidenceKind: "other" },
      { name: REVISION_SCHEMA_NAME, schema: asSchema(CHANGE_REPORT_SCHEMA), evidenceKind: "other" },
      // The diagram job (design §6.10): the checked data flows and lifecycle entries drawn with the vendored diagram-design skill.
      { name: DIAGRAMS_SCHEMA_NAME, schema: asSchema(DIAGRAMS_SCHEMA), evidenceKind: "other", references: [...DIAGRAMS_REFERENCES] },
      // Kind "review": the claim check is judged by an independent reviewer, a read-only review job.
      { name: CLAIM_CHECK_SCHEMA_NAME, schema: asSchema(CLAIM_CHECK_SCHEMA), evidenceKind: "review", references: [...CLAIM_CHECK_REFERENCES] },
      // The review layer (design §8.1): an aspect reviewer's pass, and the verifier's verdicts on its findings. Both are read-only review jobs.
      { name: REVIEW_SCHEMA_NAME, schema: asSchema(REVIEW_SCHEMA), evidenceKind: "review", references: [...REVIEW_REFERENCES] },
      { name: VERIFY_SCHEMA_NAME, schema: asSchema(VERIFY_SCHEMA), evidenceKind: "review", references: [...VERIFY_REFERENCES] },
    ],
    stages: [
      { id: FETCH_STAGE, name: "Fetch", requirementIds: [REQUIREMENT_SNAPSHOT, REQUIREMENT_CHECKED_OUT, REQUIREMENT_LEDGER] },
      { id: REPORT_STAGE, name: "Report", requirementIds: [REQUIREMENT_CONTEXT, REQUIREMENT_REPORT, REQUIREMENT_MEASUREMENTS, REQUIREMENT_CLAIMS] },
      { id: REVIEW_STAGE, name: "Review", requirementIds: [REQUIREMENT_CODE_REVIEW, REQUIREMENT_LEADS, REQUIREMENT_FINDINGS_PROVEN] },
      { id: DRAFT_STAGE, name: "Draft", requirementIds: [REQUIREMENT_DRAFT, REQUIREMENT_LEDGER_RECORDED] },
      { id: PUBLISH_STAGE, name: "Publish", requirementIds: [REQUIREMENT_PUBLISHED] },
    ],
    requirements,
    defaultValidators: bindings,
    environment: { checks: [...structuredClone(profile.environment.checks), ...generatedChecks(profile)] },
    defaultBudgets: { ...DEFAULT_BUDGETS, ...(profile.budgets ?? {}) },
    agentRoles: agentRoles(profile),
    supervisor: structuredClone(profile.supervisorPreference),
  };
}

/**
 * The roles the profile assigns harnesses to (design §13.1), for `graphloom doctor --task`: pr-review's own (the prelude's reporter,
 * diagrammer and report-checker, and each aspect's reviewer and verifier) with their distinctness constraints.
 */
export function agentRoles(profile: Profile): AgentRoleDeclaration[] {
  return REVIEW_ROLES.map((role) => {
    const distinctFrom = DISTINCT_PAIRS.filter(([checked, author]) => checked === role && REVIEW_ROLES.includes(author)).map(([, author]) => author);
    const setting =
      role === "diagrammer"
        ? `harnesses.${role} (optional; falls back to harnesses.reporter; the report-only prelude only)`
        : role === "reporter" || role === "report-checker"
          ? `harnesses.${role} (the report-only prelude only)`
          : role.startsWith("reviewer-")
            ? `harnesses.${role} (optional; the ${role.slice("reviewer-".length)} aspect's reviewer; defaults to claude-code)`
            : `harnesses.${role} (optional; the ${role.slice("verifier-".length)} aspect's finding verifier; the first harness of the design's preference that is not its reviewer's)`;
    return { role, harness: profile.roles[role], access: "read" as const, ...(distinctFrom.length > 0 ? { distinctFrom } : {}), setting };
  });
}

/** The graph: its definition and routing both come from the task's profile (`config`). */
export function createGraph(): GraphPlugin {
  return {
    describe: (config?: unknown) => definitionFor(parseProfile(config)),
    advance: advancePullRequest,
    prepareTask,
  };
}

const withPrivate = (decision: GraphDecision): GraphDecision => ({ ...decision, privateState: JSON.stringify({ v: 1 }) });

/** One call of the graph: it reasons from the evidence of the live candidate and of the stages' current attempts (`attemptEvidence`), and keeps the attempts it has seen. */
export function advancePullRequest(view: RunView): GraphDecision {
  const attempts = noteAttempt(readAttempts(view.privateState), view);
  const scoped: RunView = { ...view, evidence: attemptEvidence(view.evidence, view.candidateDigest, attempts) };
  return { ...advance(scoped), privateState: JSON.stringify(attempts) };
}

function advance(view: RunView): GraphDecision {
  let profile: Profile;
  try {
    profile = parseProfile(view.config);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return stop({ reason: "incompatible task", blocker: err.message, retryable: false }, "reject a task without a usable profile");
  }
  const pr = requestedPull(view.task.request, profile);
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
    case REVIEW_STAGE:
      return review(ctx, view);
    case DRAFT_STAGE:
      return draftStage(ctx, view);
    default:
      return publishStage(ctx, view);
  }
}

/** Every stage is accepted: the run ends, with the verdict the posted review gives (design-pr-review-split §4.5). */
function finished(ctx: Context, view: RunView): GraphDecision {
  const where = `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} at ${ctx.pr.head.slice(0, 12)}`;
  const posted = postedReview(view, ctx);
  const link = posted?.url !== null && posted?.url !== undefined ? ` (${posted.url})` : "";
  const blocker = `${posted === undefined ? "review" : posted.verdict === "changes-requested" ? `changes requested: ${posted.open} open` : "review passed"} on ${where}; the review is posted${link}`;
  return withPrivate(stop({ reason: "complete", blocker, retryable: false }, "round 2 ran: the review is posted and the run ends"));
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
  if (s.state === "incompatible") return stop({ reason: "incompatible task", blocker: s.problem, evidenceRefs: s.refs.slice(-10), retryable: false }, "stop: this pull request cannot be reviewed");
  const ledger = commandState(view, COMMAND.ledger, ledgerReadCommand(pr.owner, pr.repo, pr.number));
  if (ledger.failed && !ledger.retry && ledger.run !== undefined) {
    return supervise({ reason: `the ledger read failed: ${describeCommand(ledger.run.command)}`, evidenceRefs: [ledger.run.record.ref] }, "escalate a failed ledger read");
  }
  if (ledger.run === undefined || ledger.retry) {
    return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the pull request's ledger ref", { commands: [ledgerReadCommand(pr.owner, pr.repo, pr.number)], env: { ...GIT_ENV } }), "read the ledger ref, or record it absent"));
  }
  // A ledger an earlier run left is read whole here: its two sections (a v1 ledger migrated in memory, design-pr-review-split §5.4).
  const ledgerValue = ledgerRead(view.evidence);
  if (ledgerValue !== undefined && ledgerValue.ledger.present) {
    const prior = priorState(view.evidence, oldValue(ledgerValue.ledger));
    if (prior.state === "missing" || (prior.state === "unreadable" && retryOf(view)(prior.run))) {
      const commands = prior.state === "missing" ? prior.next : [{ id: prior.run.command.id, argv: prior.run.command.argv }];
      return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the prior ledger's sections", { commands, continueOnFailure: true, env: { ...GIT_ENV } }), "read the prior ledger's review and design sections, so this run continues its finding ids and lists round 1's open items"));
    }
    if (prior.state === "unreadable") return supervise({ reason: `the prior ledger cannot be read (${prior.reason}); the ledger is not overwritten`, evidenceRefs: [prior.run.record.ref] }, "escalate a prior ledger that cannot be read");
  }
  // The design head's report, Q&A and necessity record, and the delta from it to this head (design-pr-review-split §4.2). A read
  // that cannot be made is not a stop: the context is then the next source, with the reason recorded.
  const reads = designState(view.evidence, pr, { snapshot: s.snapshot });
  if (reads.state === "run") return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the design review's report, Q&A and necessity record, and the delta since its head (read-only git; no repository code)", { commands: reads.commands.slice(0, 16), continueOnFailure: true, env: { ...GIT_ENV } }), reads.why));
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
  // The sandbox images are checked, and pulled by digest when missing, here: before the run's no-network jobs, never during one.
  const probe = missingProbe(view.evidence, profile);
  if (probe.length > 0) return withPrivate(dispatch(sandboxProbeJob(FETCH_STAGE, probe), "check the Docker sandbox images by digest, and pull a missing one, before any sandboxed job"));
  return validateStage(ctx, view, FETCH_STAGE);
}

/** The image checks (and pulls) and the host cache lookups: graph commands that run no pull request code, from `/`. */
export function sandboxProbeJob(stageId: string, commands: EnvironmentCommand[]): JobSpec {
  return commandJob(stageId, "Check the Docker sandbox images by digest, pulling a missing one", { commands, continueOnFailure: true }, { timeoutMs: Math.min(MAX_JOB_TIMEOUT_MS, 35 * 60_000 * Math.max(1, commands.length)) });
}

/** The coverage job (design §12.2): the pull request's own tests, in the Docker sandbox, over a prepared checkout of the head. */
export function coverageJob(plan: CoveragePlan, root: string): JobSpec {
  const language = plan.language === "go" ? "Go" : "TypeScript";
  return {
    stageId: REPORT_STAGE,
    kind: "command",
    purpose: "diagnostic",
    readOnly: true,
    instruction: `Measure the changed ${language} functions' statement coverage with the pull request's own tests (Docker sandbox: no network, read-only dependency cache, a checkout of the head)`,
    input: { commands: plan.commands.map((c) => coverageCommand(c, root, plan.sandbox.wallClockMs)), continueOnFailure: true },
    checkout: { from: "candidate" },
    confinement: coverageConfinement(plan, root),
    timeoutMs: Math.min(MAX_JOB_TIMEOUT_MS, (plan.sandbox.wallClockMs + 120_000) * plan.commands.length + 10 * 60_000),
  };
}

/** Judges the stage's requirements with the shipped validators first, so a failure goes to the supervisor with its reason instead of looping. */
function validateStage(ctx: Context, view: RunView, stageId: string): GraphDecision {
  const stage = ctx.definition.stages.find((s) => s.id === stageId)!;
  const failures: string[] = [];
  for (const id of stage.requirementIds) {
    const binding = ctx.definition.defaultValidators.find((b) => b.requirementId === id)!;
    const statement = ctx.definition.requirements.find((r) => r.id === id)!.statement;
    const result = validatorById(binding.validatorId)!.evaluate({ requirementId: id, statement, evidence: validatorEvidence(view.evidence, view.candidateDigest), ...(view.candidateDigest !== undefined ? { candidateDigest: view.candidateDigest } : {}), config: view.config, request: view.task.request }) as ValidationResult;
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

/**
 * The Report stage (design-pr-review-split §4.1): the context source first, decided by plugin code from Fetch's reads and the
 * request and recorded in context.json; then the report-only prelude when the source is `prelude` (reporter, claim check, diagrams);
 * then, whatever the source, the measurements; then the report's files (the prelude) or the reviewers' seed review.md.
 */
function report(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") {
    return supervise({ reason: a.state === "pending" ? `the report stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  }
  const { analysis } = a;
  const reads = designState(view.evidence, pr, analysis);
  if (reads.state === "run") return withPrivate(dispatch(commandJob(REPORT_STAGE, "Read the design review's report, Q&A and necessity record, and the delta since its head (read-only git; no repository code)", { commands: reads.commands.slice(0, 16), continueOnFailure: true, env: { ...GIT_ENV } }), reads.why));
  const context = decideContext(reads, pr.noReport === true);
  const recorded = nextWrite(view, partCommands(PART_BASE.contextJson, CONTEXT_JSON, contextJson(context)), { failed: "recording the context source failed", settle: "the recorded context source keeps differing from the one the evidence recomputes" });
  if (recorded !== undefined) {
    if ("decision" in recorded) return recorded.decision;
    return withPrivate(dispatch(commandJob(REPORT_STAGE, writeInstruction(recorded.command, `Record the context source in ${CONTEXT_JSON}`), { commands: [recorded.command] }), `record the reviewers' context source: ${context.source}${context.reasons.length > 0 ? ` (${context.reasons[0]})` : ""}`));
  }
  if (context.source !== "prelude") return measureAndWrite(ctx, view, analysis, undefined, context);
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
      const why = { first: "write the change report of the report-only prelude (read-only, confined)", correction: "correct the report: deterministic validation found problems", revision: "revise the report: the claim check did not support some items" }[flow.kind];
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
      return drawn ?? measureAndWrite(ctx, view, analysis, flow, context);
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

/** The measurements, whatever the context source, then the report's files (the prelude) or the reviewers' seed review.md (design-review, none). */
function measureAndWrite(ctx: Context, view: RunView, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }> | undefined, context: ContextRecord): GraphDecision {
  const { profile, pr } = ctx;
  const m = measurementState(view.evidence, analysis.snapshot.files, profile, retryOf(view), environmentOutput(view.evidence, ENV_PLUGIN_ROOT));
  switch (m.state) {
    case "observe":
      return withPrivate(observe({ paths: m.paths }, "observe the changed files the static tools measure, so their records can be recomputed from the head's bytes"));
    case "diff": {
      const diff = commandState(view, COMMAND.metricsDiff, metricsDiffCommand());
      if (diff.failed && !diff.retry && diff.run !== undefined) return supervise({ reason: `the changed-lines diff failed: ${describeCommand(diff.run.command)}`, evidenceRefs: [diff.run.record.ref] }, "escalate a failed diff");
      return withPrivate(dispatch(commandJob(REPORT_STAGE, "List the changed lines (git diff -U0 -w)", { commands: [metricsDiffCommand()], env: { ...GIT_ENV } }), "list the head-side changed lines for the static metrics tools"));
    }
    case "tools": {
      const binds = toolBinds(view, m.batches);
      if (binds === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the static tools run from" }, "escalate a missing plugin path");
      const batches = m.batches.slice(0, 16);
      const generated = profile.metrics.generated;
      const goRoot = environmentOutput(view.evidence, "go-root");
      const goBin = goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/" ? path.join(goRoot, "bin", "go") : "go";
      const commands = batches.map((b) => staticCommand(b, m.hunks, binds[0]!.path, generated, process.execPath, goBin));
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Measure the changed functions' complexity and nesting (parse only; no network; no repository code runs)",
        input: { commands, continueOnFailure: true },
        confinement: { kind: "bwrap", network: false, mask: [], binds },
      };
      return withPrivate(dispatch(job, `measure ${batches.length} batch(es) of changed files with the static metrics tools, confined with no network`));
    }
    case "baseFiles":
      // The modified functions' base files, as `git show <base>:<path>` prints them: read-only, no repository code.
      return withPrivate(dispatch(commandJob(REPORT_STAGE, "Read the base versions of the modified files (git show <base>:<path>)", { commands: m.commands.slice(0, 16), continueOnFailure: true, env: { ...GIT_ENV } }), `read ${Math.min(16, m.commands.length)} base file(s) so each modified function can be measured at the base too`));
    case "baseTools": {
      const binds = toolBinds(view, m.batches);
      if (binds === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the static tools run from" }, "escalate a missing plugin path");
      const batches = m.batches.slice(0, 16);
      const goRoot = environmentOutput(view.evidence, "go-root");
      const goBin = goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/" ? path.join(goRoot, "bin", "go") : "go";
      const commands = batches.map((b) => staticBaseCommand(b, m.base, binds[0]!.path, profile.metrics.generated, process.execPath, goBin));
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Measure the modified functions at the base: complexity and nesting by the same static tools over the base files (parse only; no network; no repository code runs)",
        input: { commands, continueOnFailure: true, env: { ...GIT_ENV } },
        confinement: { kind: "bwrap", network: false, mask: [], binds },
      };
      return withPrivate(dispatch(job, `measure ${batches.length} base file(s) with the static metrics tools, confined with no network`));
    }
    case "probe":
      return withPrivate(dispatch(sandboxProbeJob(REPORT_STAGE, m.commands), "check the Docker sandbox images by digest: Fetch did not record them"));
    case "coverage": {
      const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT);
      if (root === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the coverage scripts run from" }, "escalate a missing plugin path");
      return withPrivate(dispatch(coverageJob(m.plan, root), `measure statement coverage of the changed ${m.plan.language} functions in the Docker sandbox over a checkout of the head`));
    }
    case "failed":
      return supervise({ reason: `the measurements failed: ${m.problems.slice(0, 3).join("; ")}`, evidenceRefs: m.refs.slice(-10) }, "hand the failed measurements to the supervisor");
    default:
      break;
  }
  if (flow === undefined) {
    // design-review or none: the reviewers' seed review.md, rendered by plugin code (design-pr-review-split §4.2).
    const seed = contextOutputs(view.evidence, profile, pr, analysis, context, m);
    if ("pending" in seed) return supervise({ reason: `the reviewers' seed cannot be written: ${seed.pending}` }, "escalate a context that does not read back");
    const next = nextWrite(view, partCommands(PART_BASE.seedMd, REVIEW_MD, seed.markdown), { failed: "writing the reviewers' seed failed", settle: "the written seed keeps differing from the one the evidence recomputes" });
    if (next === undefined) return validateStage(ctx, view, REPORT_STAGE);
    if ("decision" in next) return next.decision;
    const secrets = secretFindings(seed.markdown);
    if (secrets.length > 0) return stop({ reason: "report refused", blocker: `the reviewers' seed would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a seed that holds a secret");
    return withPrivate(dispatch(commandJob(REPORT_STAGE, writeInstruction(next.command, `Write ${REVIEW_MD}, the reviewers' seed`), { commands: [next.command] }), context.source === "design-review" ? "write review.md from the design review's report, necessity answer and Q&A, with this run's measurements" : "write review.md from the pull request's metadata, its file list and the patches in scope (no report: --no-report)"));
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
  return withPrivate(dispatch(commandJob(REPORT_STAGE, writeInstruction(next.command, `Write ${REVIEW_MD} and report.json`), { commands: [next.command] }), `write the prelude's report.json, the readable review.md, the HTML briefing review.html and its appendix review-appendix.html${idNotes}`));
}

/** Whether a failed command may run again: the operator resumed since it failed. */
const retryOf = (view: RunView) => (run: CommandRun): boolean => isStaleFailure(run.record, view);

/** What the groundwork still needs, as the decision that gets it (or stops the run). */
function groundworkDecision(step: Exclude<GroundworkState, { state: "ready" }>, stageId: string): GraphDecision {
  switch (step.state) {
    case "observe":
      return withPrivate(observe({ paths: step.paths }, "observe the changed source files the symbol extraction reads, so symbols come from the head's bytes"));
    case "run":
      return withPrivate(dispatch(commandJob(stageId, "Read the base commit for the groundwork of the leads (declarations, searches, dependencies)", { commands: step.commands, env: { ...GIT_ENV } }), step.why));
    case "failed":
      return supervise({ reason: `the groundwork could not be read: ${step.problems.join("; ")}`, evidenceRefs: step.refs.slice(-10) }, "hand a failed groundwork read to the supervisor");
    case "incompatible":
      return stop({ reason: "incompatible task", blocker: step.problem, retryable: false }, "stop: the pull request is past a profile limit");
  }
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- the review layer (design §8; design-pr-review-split §4.3) ----

const REVIEW_COMMAND_WORDS = { failed: "recording the review failed", settle: "the review's record keeps differing from the one the evidence recomputes" };

/** What the Review, Draft and Publish stages read of the run so far: the snapshot, the recorded context and the measurements. */
function reviewInputs(ctx: Context, view: RunView, stage: string): { analysis: Analysis; context: ContextRecord; m: MeasurementState } | { decision: GraphDecision } {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return { decision: supervise({ reason: a.state === "pending" ? `the ${stage} stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot") };
  const c = recordedContext(view.evidence);
  if (c.state !== "read") return { decision: supervise({ reason: `the ${stage} stage lost the context record: ${c.state === "failed" ? c.reason : "context.json was not written"}`, ...(c.state === "failed" ? { evidenceRefs: c.refs } : {}) }, "escalate a missing context record") };
  const m = measurementState(view.evidence, a.analysis.snapshot.files, profile);
  if (m.state !== "ready" && m.state !== "none") return { decision: supervise({ reason: `the ${stage} stage lost the measurements (${m.state})` }, "escalate missing measurements") };
  return { analysis: a.analysis, context: c.value, m };
}

/** The review: the groundwork and the scope, base and rule files first, then each aspect's sweep (passes, verification, the check of refutations' quotes), each recorded when it ends. */
function review(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const inputs = reviewInputs(ctx, view, "review");
  if ("decision" in inputs) return inputs.decision;
  const { analysis, context, m } = inputs;
  const report = contextReport(view.evidence, pr, analysis, context, m, profile);
  if ("pending" in report) return supervise({ reason: `the review stage cannot read its context's report: ${report.pending}` }, "escalate a missing context report");
  const base = pinnedBase(view.evidence);
  if (base === undefined) return supervise({ reason: "the review stage lost the pinned base" }, "escalate a missing base");
  // The groundwork the leads rest on (design-pr-review-split §4.3): symbols, the test map and the searches, read-only over the base.
  const g = groundworkState(groundworkOptions(view.evidence, analysis, profile, base, retryOf(view)));
  if (g.state !== "ready") return groundworkDecision(g, REVIEW_STAGE);
  const scope = recordedScope(view.evidence);
  if (scope.state === "failed") return supervise({ reason: `the review's scope record does not read back: ${scope.reason}`, evidenceRefs: scope.refs }, "escalate an unreadable scope record");
  if (scope.state === "none") return startReview(ctx, view, analysis, report.check, context);
  const s = scope.value;
  const files = new Set(s.files);
  const leads = leadsOf(analysis, profile, s.files, report, m, g.groundwork);
  // The design principles that apply to the review's scope, and what round 1 concluded of them when it is the context (design §8.1).
  const configured = profile.questions.principles;
  const reading = configured !== undefined ? principlesReading(view.evidence, configured, base) : undefined;
  const scoped: PrinciplesContext | undefined = reading?.state === "read" ? principlesContext(reading.read, analysis.snapshot.files.filter((f) => files.has(f.path))) : undefined;
  const reviewPrinciples = scoped !== undefined && scoped.read.file === "present" && scoped.applicable.length > 0 ? scoped : undefined;
  const principleIds = new Set((reviewPrinciples?.applicable ?? []).map((p) => p.id));
  const round1 = context.source === "design-review" ? round1Verdicts(report.records?.necessityJson) : undefined;
  const records: AspectRecord[] = [];
  // What earlier heads left open (design §9.3): each aspect's sweep re-judges its own earlier findings and drops a new comment over one.
  const registry = registryFromEvidence(view.evidence);
  let from = view.evidence.findIndex((e) => e.ref === scope.refs.at(-1));
  const mounted: string[] = [];
  for (const aspect of ASPECTS) {
    const rules = recordedRules(view.evidence, aspect, s.files);
    if (rules.state !== "read") return supervise({ reason: rules.state === "failed" ? rules.reason : `the ${aspect} rule file was not written` }, "escalate a rule file that does not cover the scope: no review runs with a generic rule");
    const rec = recordedAspect(view.evidence, aspect);
    if (rec.state === "failed") return supervise({ reason: rec.reason, evidenceRefs: rec.refs }, "escalate an unreadable aspect record");
    if (rec.state === "read") {
      records.push(rec.value);
      from = Math.max(from, view.evidence.findIndex((e) => e.ref === rec.refs.at(-1)));
      continue;
    }
    const earlier = findingsOf(records);
    const ap = aspectPrior(registry, aspect, analysis.snapshot.files, files);
    const mine = aspect === "maintainability" ? leads : [];
    const f = aspectFlow(view.evidence.slice(from + 1), { aspect, scope: files, principles: principleIds, earlier, firstId: registry.nextF, prior: ap.given, suppress: ap.suppress, base, retryable: (r) => isStaleFailure(r.record, view), repro: reproEnv(view.evidence, profile, reproRunsIn(view.evidence.slice(0, from + 1))), leads: mine });
    const reviewDir = reviewDirOf(view);
    const baseDir = baseTreeDir(view, g.groundwork);
    switch (f.state) {
      case "supervise":
        return supervise({ reason: f.reason, evidenceRefs: f.refs }, "hand the unresolved review to the supervisor");
      case "repro": {
        const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT);
        if (root === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the reproducing-test script runs from" }, "escalate a missing plugin path");
        const job = reproJob(REVIEW_STAGE, view.evidence, profile, f.run, root);
        if ("problem" in job) return supervise({ reason: `${f.finding.id}'s test cannot be run: ${job.problem}` }, "escalate a reproducing test that cannot be dispatched");
        return withPrivate(dispatch(job, `run ${f.finding.id}'s reproducing test (${f.finding.severity}, ${f.plan.language}) twice in the Docker sandbox over a checkout of the head, before the verifier reads it`));
      }
      case "quotes":
        return withPrivate(dispatch(commandJob(REVIEW_STAGE, "Check the refutations' quotes against the head", { commands: f.commands.slice(0, 16), env: { ...GIT_ENV } }), "check each refutation's quotes against the head's files"));
      case "pass": {
        const role = reviewerRole(aspect);
        const planned = planReviewer({
          pr,
          snapshot: analysis.snapshot,
          aspect,
          pass: f.n,
          files: readingOrder(report.json, s.files),
          scopeLine: scopeLine(s),
          groups: rules.groups,
          known: f.known,
          prior: f.prior,
          feedback: f.feedback,
          repro: profile.review.repro,
          source: context.source,
          designHead: context.head,
          ...(f.leads.length > 0 ? { leads: f.leads, leadTotal: mine.length } : {}),
          ...(aspect === "correctness" ? { testGaps: correctnessContext(leads) } : {}),
          ...(reviewPrinciples !== undefined ? { principles: reviewPrinciples, round1 } : {}),
          ...(baseDir !== undefined ? { baseDir } : {}),
          ...(reviewDir !== undefined ? { reviewDir } : {}),
        });
        const written = writeSpills(view, REVIEW_STAGE, planned.spills);
        if (written !== undefined) return written;
        const known = ["", ...f.known.map((k) => k.id)];
        // A correction (a missing lead status, an unknown principle id, a file left out) goes back to the same session (design-pr-review-split §4.3).
        const continued = f.feedback.length > 0 ? jobSession(view, REVIEW_STAGE, role) : undefined;
        const job = agentJob(ctx, view, { jobId: role, stageId: REVIEW_STAGE, purpose: "review", instruction: `Review the ${aspect} aspect (pass ${f.n})`, schema: REVIEW_SCHEMA_NAME, harness: profile.roles[role], role, assignment: planned.text, readOnlyBinds: mounted, ...(continued !== undefined ? { continueFrom: continued } : {}), references: idRefs({ [REVIEW_REFERENCES[0]!]: idSet(known), [REVIEW_REFERENCES[2]!]: idSet(f.prior.map((x) => x.id)), [REVIEW_REFERENCES[1]!]: idSet(["", ...principleIds], (id) => oneLineText(reviewPrinciples?.applicable.find((p) => p.id === id)?.statement ?? "").slice(0, 300)), [REVIEW_REFERENCES[3]!]: idSet(f.leads.map((l) => l.id), (id) => oneLineText(f.leads.find((l) => l.id === id)?.facts[0] ?? "").slice(0, 300)) }) }, analysis.snapshot.files);
        if ("problem" in job) return refused(job);
        return dispatchAgent(view, job, `${continued !== undefined ? "correct" : "review"} the ${aspect} aspect (pass ${f.n}) in ${continued !== undefined ? "the same" : "a fresh"} read-only ${harnessName(profile.roles[role])} session (${s.context.reason})${f.leads.length > 0 ? `, with ${f.leads.length} lead(s) to judge` : ""}`);
      }
      case "verify": {
        const role = verifierRole(aspect);
        const planned = planVerifier({ pr, snapshot: analysis.snapshot, aspect, pass: f.n, findings: f.findings, feedback: f.feedback, ...(scoped !== undefined ? { principles: new Map(scoped.parsed.principles.map((p) => [p.id, p] as const)) } : {}), ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDir !== undefined ? { reviewDir } : {}) });
        const written = writeSpills(view, REVIEW_STAGE, planned.spills);
        if (written !== undefined) return written;
        const job = agentJob(ctx, view, { jobId: role, stageId: REVIEW_STAGE, purpose: "review", instruction: `Verify the ${aspect} pass ${f.n} findings`, schema: VERIFY_SCHEMA_NAME, harness: profile.roles[role], role, assignment: planned.text, readOnlyBinds: mounted, references: idRefs({ [VERIFY_REFERENCES[0]!]: idSet(f.findings.map((x) => x.id)) }) }, analysis.snapshot.files);
        if ("problem" in job) return refused(job);
        return dispatchAgent(view, job, `verify the ${aspect} findings with a fresh read-only ${harnessName(profile.roles[role])} session on another harness than the reviewer's`);
      }
      case "done": {
        const record: AspectRecord = {
          schema: ASPECT_RECORD_SCHEMA,
          aspect,
          reviewer: profile.roles[reviewerRole(aspect)],
          verifier: profile.roles[verifierRole(aspect)],
          context: s.context,
          scopeFiles: s.files.length,
          passes: f.passes,
          findings: f.findings,
          unsaturated: f.unsaturated,
          ...(ap.given.length + ap.settled.length > 0 ? { prior: [...f.prior, ...ap.settled].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))) } : {}),
          leads: f.leads,
        };
        const id = aspectRecordId(aspect);
        return recordStep(view, REVIEW_STAGE, id, recordCommands(id, "review", aspectRecordJson(record)), `the ${aspect} review`);
      }
    }
  }
  return validateStage(ctx, view, REVIEW_STAGE);
}

/** Decides the scope and writes the rule files and the scope record, in that order (the record last: it marks the start complete). */
function startReview(ctx: Context, view: RunView, analysis: Analysis, check: Parameters<typeof chooseScope>[0]["check"], context: ContextRecord): GraphDecision {
  const { profile } = ctx;
  const choice = chooseScope({ mode: analysis.snapshot.mode, files: analysis.snapshot.files, partition: analysis.snapshot.partition, check });
  if (choice.files.length === 0) return supervise({ reason: "the review's scope holds no file to review" }, "escalate an empty review scope");
  for (const aspect of ASPECTS) {
    const g = ruleGroups(ruleFileText(aspect, profile.review.rules[aspect]), choice.files);
    if (g.state === "failed") return supervise({ reason: `the ${aspect} rule file does not cover the scope: ${g.problems.join("; ")}` }, "escalate a rule file that does not cover the scope");
  }
  const record: ScopeRecord = {
    schema: SCOPE_SCHEMA,
    mode: choice.mode,
    source: choice.source,
    areas: choice.areas,
    files: choice.files,
    context: { kind: "seeded", reason: FRESH_START_REASON },
    contextSource: context.source,
    harnesses: Object.fromEntries(ASPECTS.map((a) => [a, { reviewer: profile.roles[reviewerRole(a)], verifier: profile.roles[verifierRole(a)] }])),
  };
  const commands = [...ASPECTS.flatMap((a) => ruleCommands(a, profile.review.rules[a])), ...recordCommands(SCOPE_RECORD_ID, "review", scopeRecordJson(record))];
  const next = nextWrite(view, commands, REVIEW_COMMAND_WORDS);
  if (next === undefined) return supervise({ reason: "the review's scope record was written as recomputed but does not read back" }, "escalate a scope record that does not read back");
  if ("decision" in next) return next.decision;
  return withPrivate(dispatch(commandJob(REVIEW_STAGE, writeInstruction(next.command, "Record the review's scope as evidence"), { commands: [next.command] }), "write the aspects' rule files and record the review's scope"));
}

/** The Draft stage: the draft and the report files with the Review section, written whole, then the ledger's review section, then validated. */
function draftStage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const inputs = reviewInputs(ctx, view, "draft");
  if ("decision" in inputs) return inputs.decision;
  const w = draftWrites(view.evidence, inputs.analysis, pr, pinnedBase(view.evidence), inputs.context, inputs.m, profile);
  if (w.state === "pending") return supervise({ reason: `the draft cannot be composed: ${w.reason}` }, "escalate a missing review record");
  if (w.state === "failed") return supervise({ reason: w.reason, evidenceRefs: w.refs }, "escalate an unreadable review record");
  const t = w.writes.texts;
  const secrets = Object.values(t).flatMap((x) => (x === undefined ? [] : secretFindings(x)));
  if (secrets.length > 0) return stop({ reason: "report refused", blocker: `the draft would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a draft that holds a secret");
  const also = inputs.context.head !== undefined ? [inputs.context.head, ...(inputs.context.base !== undefined ? [inputs.context.base] : [])] : [];
  const inert = [...(t.html !== undefined ? writtenHtmlProblems(t.html, pr, pinnedBase(view.evidence), also) : []), ...(t.appendix !== undefined ? writtenHtmlProblems(t.appendix, pr, pinnedBase(view.evidence), also) : [])];
  if (inert.length > 0) return supervise({ reason: `review.html or review-appendix.html would not be self-contained and inert: ${inert.slice(0, 3).join("; ")}` }, "escalate a report file that fails its own inertness check");
  const next = nextWrite(view, w.writes.commands, { failed: "writing the draft failed", settle: "the written draft keeps differing from the one the evidence recomputes" });
  if (next !== undefined) {
    if ("decision" in next) return next.decision;
    return withPrivate(dispatch(commandJob(DRAFT_STAGE, writeInstruction(next.command, "Write the draft review"), { commands: [next.command] }), `write draft.json, draft.md and the report files with the Review section`));
  }
  return recordReviewLedger(ctx, view, w.writes.draft);
}

/** The ledger's review section after the draft (design-pr-review-split §4.1 `ledger-recorded`), by compare-and-swap from the value Fetch read. */
function recordReviewLedger(ctx: Context, view: RunView, draft: Parameters<typeof reviewLedgerWrite>[2]): GraphDecision {
  const { pr } = ctx;
  const read = ledgerRead(view.evidence);
  const lw = commandState(view, COMMAND.reviewLedgerWrite);
  if (read === undefined) return supervise({ reason: "the ledger value Fetch read is not in the evidence" }, "escalate a missing ledger read");
  if (lw.run !== undefined && lw.failed) {
    if (!lw.retry) {
      if (lw.run.command.exitCode === LEDGER_MOVED) {
        return stop({ reason: "ledger moved", blocker: `another run advanced the ledger's review section after Fetch read it; resume to read it again and record this head after it`, evidenceRefs: [lw.run.record.ref], retryable: true }, "stop: lost the compare-and-swap on the ledger");
      }
      return supervise({ reason: `advancing the ledger failed: ${describeCommand(lw.run.command)}: ${outputTail(lw.run.command)}`, evidenceRefs: [lw.run.record.ref] }, "escalate a failed ledger write");
    }
    // After the operator's resume: read the ledger again first, since the value the write swapped from was stale.
    const at = (r: string): number => view.evidence.findIndex((e) => e.ref === r);
    if (at(read.run.record.ref) < at(lw.run.record.ref)) {
      return withPrivate(dispatch(commandJob(DRAFT_STAGE, "Read the pull request's ledger ref again", { commands: [ledgerReadCommand(pr.owner, pr.repo, pr.number)], env: { ...GIT_ENV } }), "read the ledger ref again: it moved since Fetch read it"));
    }
  }
  const lr = commandState(view, COMMAND.ledger, ledgerReadCommand(pr.owner, pr.repo, pr.number));
  if (lr.failed && lr.run !== undefined) return supervise({ reason: `the ledger read failed: ${describeCommand(lr.run.command)}`, evidenceRefs: [lr.run.record.ref] }, "escalate a failed ledger read");
  const plan = reviewLedgerWrite(view.evidence, pr, draft);
  if (plan.state === "read") return withPrivate(dispatch(commandJob(DRAFT_STAGE, "Read the prior ledger's sections", { commands: plan.commands, continueOnFailure: true, env: { ...GIT_ENV } }), "read the prior ledger's sections, so the new review section keeps its heads and findings"));
  if (plan.state === "problem") return supervise({ reason: plan.reason, evidenceRefs: plan.refs }, "escalate a prior ledger that cannot be read: it is never overwritten");
  if (lw.run !== undefined && !lw.failed && sameArgv(lw.run.command.argv, plan.write.argv)) return validateStage(ctx, view, DRAFT_STAGE);
  if (commandRuns(view.evidence, COMMAND.reviewLedgerWrite).length >= 6) return supervise({ reason: "the ledger write keeps differing from the one the evidence recomputes" }, "escalate a ledger write that does not settle");
  // The files the write reads are written first as part sets (design §6.6): the design section a migration of a v1 ledger builds, and a review ledger.json or ledger.md too large for the write's one command.
  const parts = nextWrite(view, plan.parts, { failed: "writing the ledger files failed", settle: "the written ledger files keep differing from the ones the evidence recomputes" });
  if (parts !== undefined) {
    if ("decision" in parts) return parts.decision;
    return withPrivate(dispatch(commandJob(DRAFT_STAGE, writeInstruction(parts.command, "Write the ledger files"), { commands: [parts.command] }), "write the ledger files the section write reads, as parts: a migrated design section, or a review section too large for its one command"));
  }
  return withPrivate(dispatch(commandJob(DRAFT_STAGE, "Advance the ledger's review section by compare-and-swap (no repository code runs)", { commands: [plan.write], env: { ...GIT_ENV } }), "record this head, its context source and the round-1 head it counts in the ledger's review section, from the value Fetch read"));
}

// ---- publishing (design §8.5; design-pr-review-split §4.5) ----

/** The verdict and link of the review the evidence shows posted, once the Publish stage is done. */
function postedReview(view: RunView, ctx: Context): { url: string | null; verdict: "passed" | "changes-requested"; open: number } | undefined {
  const inputs = reviewInputs(ctx, view, "publish");
  if ("decision" in inputs) return undefined;
  const p = publishPlan(view.evidence, inputs.analysis, ctx.pr, pinnedBase(view.evidence), inputs.context, inputs.m, ctx.profile);
  if (p.state !== "ready") return undefined;
  const flow = publishFlow(view.evidence, p.plan, p.draft, ctx.pr);
  return flow.state === "done" ? { url: flow.posted.url, verdict: p.plan.verdict, open: p.plan.open } : undefined;
}

/** The stop reason of a draft the run is not allowed to post. */
export const POSTING_NOT_ENABLED = "posting not enabled";

/** What the stop says, naming only what exists: the draft, and the report (`review.html`, or `review.md` when there is no report). */
function postingNotEnabled(context: ContextRecord): string {
  return `draft ready; posting is not enabled (set the runner config's github.writeTokenEnv and resume to post). The draft is ${DRAFT_MD} and the report ${context.source === "none" ? REVIEW_MD : REVIEW_HTML}, in the run's worktree`;
}

/**
 * The Publish stage: read the pull request's reviews, post the one review unless this head already has it, read its comments back,
 * and record the ids in the ledger's review section. The reads are the executors' own; the one write is `create-pull-review`, whose
 * credential binding is the runner's, never the plugin's.
 */
function publishStage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const inputs = reviewInputs(ctx, view, "publish");
  if ("decision" in inputs) return inputs.decision;
  const p = publishPlan(view.evidence, inputs.analysis, pr, pinnedBase(view.evidence), inputs.context, inputs.m, profile);
  if (p.state === "pending") return supervise({ reason: `the review cannot be composed: ${p.reason}` }, "escalate a missing record");
  if (p.state === "failed") return supervise({ reason: p.reason, evidenceRefs: p.refs }, "escalate an unreadable record");
  if (p.plan.problem !== undefined) return supervise({ reason: p.plan.problem }, "escalate a review whose items cannot all be made readable");
  const secrets = secretFindings(JSON.stringify(createInput(pr, p.plan)));
  if (secrets.length > 0) return stop({ reason: "report refused", blocker: `the review would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not posted`, retryable: false }, "refuse to post a review that holds a secret");
  const flow = publishFlow(view.evidence, p.plan, p.draft, pr);
  // Posting is the operator's to enable: without the grant the draft is the result, and the run ends here instead of failing the write into the supervisor.
  if ((flow.state === "viewer" || flow.state === "reviews" || flow.state === "create") && writeWithheld(view)) {
    return stop({ reason: POSTING_NOT_ENABLED, blocker: postingNotEnabled(inputs.context), retryable: false }, "stop: the review is ready and the runner does not grant its write");
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
      const job: JobSpec = { stageId: PUBLISH_STAGE, kind: "command", purpose: "diagnostic", effect: "write", instruction: `Post the review (${p.plan.firstLine}) to ${pr.owner}/${pr.repo}#${pr.number} as one COMMENT review at head ${pr.head.slice(0, 12)}`, executor: CREATE_PULL_REVIEW, input };
      return withPrivate(dispatch(job, flow.why));
    }
    case "ledger": {
      const lw = commandState(view, COMMAND.ledgerPublished);
      if (lw.run !== undefined && lw.failed && !lw.retry) {
        if (lw.run.command.exitCode === LEDGER_MOVED) return stop({ reason: "ledger moved", blocker: `another run advanced the ledger while this one recorded its review ${flow.posted.reviewId}; resume to record it again`, evidenceRefs: [lw.run.record.ref], retryable: true }, "stop: lost the compare-and-swap on the ledger");
        return supervise({ reason: `recording the published review in the ledger failed: ${describeCommand(lw.run.command)}: ${outputTail(lw.run.command)}`, evidenceRefs: [lw.run.record.ref] }, "escalate a failed ledger write");
      }
      if (commandRuns(view.evidence, COMMAND.ledgerPublished).length >= 4) return supervise({ reason: "the ledger write of the published review keeps differing from the one the evidence recomputes" }, "escalate a ledger write that does not settle");
      // The patch is written first, as a part set with a digest (it can be far past one argument), and the ledger command reads the file.
      const parts = nextWrite(view, flow.parts, { failed: "writing the published review's ledger patch failed", settle: "the written ledger patch keeps differing from the one the evidence recomputes" });
      if (parts !== undefined) {
        if ("decision" in parts) return parts.decision;
        return withPrivate(dispatch(commandJob(PUBLISH_STAGE, writeInstruction(parts.command, "Write the published review's ledger patch"), { commands: [parts.command] }), "write the patch that records the published review in the ledger, in parts with a digest"));
      }
      return withPrivate(dispatch(commandJob(PUBLISH_STAGE, "Record the published review in the ledger's review section by compare-and-swap (no repository code runs)", { commands: [flow.command], env: { ...GIT_ENV } }), `record review ${flow.posted.reviewId} and its comments' ids in the ledger`));
    }
    case "done":
      return validateStage(ctx, view, PUBLISH_STAGE);
  }
}

/** The leads of the review's scope (design-pr-review-split §4.3), from the measurements, the groundwork and the context's report. */
function leadsOf(analysis: Analysis, profile: Profile, scopeFiles: readonly string[], report: Parameters<typeof leadInputOf>[3], m: MeasurementState, groundwork: Parameters<typeof leadInputOf>[5]): ReturnType<typeof computeLeads> {
  return computeLeads(leadInputOf(analysis, profile, scopeFiles, report, m, groundwork));
}

/**
 * Whether the review's write is withheld. The runner's grants are declared data on the run view (`executors[].effectGranted`);
 * a runner that reports none leaves the write to the controller's own refusal and recovery.
 */
function writeWithheld(view: RunView): boolean {
  return view.executors?.find((e) => e.id === CREATE_PULL_REVIEW.id)?.effectGranted === false;
}
