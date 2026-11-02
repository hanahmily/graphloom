// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

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
import { analyze, reportFlowOf, type Analysis } from "./analysis.js";
import { checkoutCommand, GIT_ENV, GUARD_REFUSED, guardCommand, headTreeCommand, ledgerReadCommand, pinnedBase, reviewDirCommand } from "./commands.js";
import {
  ANSWERER_JOB,
  ANSWERS_STAGE,
  CODING_AGENT,
  DRAFT_JSON,
  DRAFT_MD,
  DRAFT_STAGE,
  REQUIREMENT_CODE_REVIEW,
  REQUIREMENT_DRAFT,
  REVIEW_STAGE,
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
  GRAPH_ID,
  GRAPH_VERSION,
  QA_JSON,
  REVIEW_APPENDIX_HTML,
  REVIEW_DIR,
  REVIEW_HTML,
  REVIEW_MD,
} from "./constants.js";
import { checkBatch, DIAGRAMMER_JOB, DIAGRAMS_REFERENCES, DIAGRAMS_SCHEMA, DIAGRAMS_SCHEMA_NAME, diagramInputOf, planDiagrams, MAX_DIAGRAM_BYTES, MAX_DIAGRAMS, SKILL_DIR, skillMount } from "./diagrams.js";
import { commandRuns, describeCommand, environmentOutput, outputTail, succeeded, validatorEvidence, type CommandRun } from "./evidence.js";
import { INTERFACE_PATCH_BYTES } from "./digest.js";
import { LIMITS } from "./metrics/crap.js";
import { CHANGE_REPORT_SCHEMA, MAX_ITEM_CHARS } from "./report.js";
import { CLAIM_CHECK_SCHEMA } from "./claims.js";
import { REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME, reportSpec, type ReportFlow } from "./flow.js";
import { budgetShortfall, largeNeeds } from "./large.js";
import { largeCheckScope, planLargeReporter } from "./largeprompts.js";
import { measurementState, metricsDiffCommand, staticBaseCommand, staticCommand } from "./measurements.js";
import { coverageCommand, coverageConfinement, missingProbe, sandboxEnvironmentChecks, type CoveragePlan } from "./coverage.js";
import { planChecker, planReporter } from "./prompts.js";
import { assignmentProblem, type FileSpill } from "./fit.js";
import { isLarge } from "./mode.js";
import { harnessName, parseProfile, ProfileError, reviewerRole, verifierRole, ROLES, DISTINCT_PAIRS, type Profile, type Role } from "./profile.js";
import { ASPECTS, ruleGroups, ruleFileText, type Aspect } from "./aspects.js";
import { aspectFlow, aspectRecordId, aspectRecordJson, ASPECT_RECORD_SCHEMA, findingsOf, REVIEW_REFERENCES, REVIEW_SCHEMA, REVIEW_SCHEMA_NAME, VERIFY_REFERENCES, VERIFY_SCHEMA, VERIFY_SCHEMA_NAME, type AspectRecord } from "./review.js";
import { chooseScope, FRESH_START_REASON, scopeRecordJson, SCOPE_RECORD_ID, SCOPE_SCHEMA, type ScopeRecord } from "./reviewscope.js";
import { planReviewer, planVerifier, round1Verdicts } from "./reviewprompts.js";
import { draftWrites, readingOrder, recordedAspect, recordedRound1, recordedRules, recordedScope, round1Computed, ruleCommands } from "./reviewdraft.js";
import { round1Json, ROUND1_DIR, ROUND1_RECORD_ID } from "./round1.js";
import { COMMENTS_READ, createInput, ledgerPublishedCommand, publishFlow, publishPlan, REVIEWS_READ } from "./publish.js";
import { scopeLine, DRAFT_SCHEMA } from "./draft.js";
import { prepareTask } from "./prepare.js";
import { requestedPull, type PullRequest } from "./request.js";
import { secretFindings } from "./secrets.js";
import { readInput, snapshotState, type PullFile, type ReadSpec } from "./snapshot.js";
import { CLAIM_CHECK_SCHEMA_NAME } from "./claims.js";
import { diagramsOf, outputsOf, validatorById, writtenHtmlProblems } from "./validators.js";
import { appendixWriteCommands, htmlWriteCommands, partCommands, recordCommands, recordedNecessityJson, reportWriteCommands } from "./parts.js";
import { ANSWER_CHECK_REFERENCES, ANSWER_CHECK_SCHEMA, ANSWER_CHECK_SCHEMA_NAME, ANSWERS_REFERENCES, ANSWERS_REVISION_SCHEMA_NAME, ANSWERS_SCHEMA, ANSWERS_SCHEMA_NAME, answersFlow } from "./answers.js";
import { baseDirIn } from "./basetree.js";
import { sourceDirs } from "./inventory.js";
import { ledgerRead, priorShowCommand, writtenLedger } from "./ledger.js";
import { QUESTIONS_REFERENCES, QUESTIONS_SCHEMA, QUESTIONS_SCHEMA_NAME, requiredQuestions, type Question } from "./questions.js";
import { CLAIM_CHECK_REFERENCES } from "./claims.js";
import { necessityQuestion, NECESSITY_ID, NECESSITY_REFERENCES, NECESSITY_REVISION_SCHEMA_NAME, NECESSITY_SCHEMA, NECESSITY_SCHEMA_NAME, parseNecessityRecord, type NecessityRecord } from "./necessity.js";
import { principlesContext, principlesReadCommand, principlesReading, type Principle, type PrinciplesContext } from "./principles.js";
import { planAnswerChecker, planAnswerer, planNecessity, planNecessityChecker, planQuestioner } from "./qaprompts.js";
import { questionItems } from "./reportview.js";
import { afterNecessity, answerBatches, answerContext, batchedAnswers, batchRecordId, batchRecordJson, answerWrites, necessityFlow, necessityRecordCommands, necessityRecordOf, qaContext, qaOutputs, questionSet, questionerFlow, recordedNecessity, type QaContext } from "./qaflow.js";

export { GRAPH_ID, GRAPH_VERSION };

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
      statement: "The pull request's ledger ref (refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger) was read, or recorded absent. This version reports the whole pull request either way.",
      evidenceSchema: "command-report-v1",
    },
    {
      id: REQUIREMENT_REPORT,
      statement: `Every template section is present, with cited items or an explicit None. Every citation lies inside the pull request's diff on the side it names. Every changed file (a renamed file under both names, a deleted file too) and every detector fact is cited, and no item carries a severity, finding or verdict (the result contract has no such field). report.json, ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} hold exactly that report, with the mode (standard, or large with the limits passed) in report.json and in the header of ${REVIEW_MD}. In large mode (a pull request over the profile's maxFiles or maxPatchBytes) the report is high level: one reporter job (change-report-v1, the reporter role, a fresh read-only session with the head and base trees available read-only) is given a bounded digest and not the diff (the title, body and commit messages as untrusted blocks; the areas with their paths, files, lines added and deleted and patch bytes; the file list with its diffstat; the detector facts; the names of the exported symbols each area adds; and the patches of the interface files only, which are the files the profile's schema, config and interfaces routing globs match, **/*.proto, CHANGES.md and docs/**, at most ${INTERFACE_PATCH_BYTES} bytes of patch in all, the largest left out first with the files left out listed), describes the pull request at a high level (a purpose, an overview, the briefing fields, one item per conceptual change and the template sections; lifecycles and before/after rows are not required), may open any file of the head or the base to confirm a claim, and cites the files and lines each item rests on; an item's text is at most ${MAX_ITEM_CHARS} characters, as in standard mode. In large mode the reporter need not cite every changed file or list every detector fact: the plugin lists a file no item cites in "other" with its diffstat, and accounts for a fact the report leaves out with an item of its own; the generated files and a file for which the host gave no patch are listed in "other" with the reason. report.json records the areas with the number of items that cite each, and the Areas section of ${REVIEW_HTML} and ${REVIEW_MD} lists the areas (each with the reporter's label, its files and its lines added and deleted) and the command graphloom session open <run> --stage report, which opens the reporter's session. Before the reporter job the graph computes what large mode needs of the run's agent invocations, jobs and decisions and stops with those numbers when the remaining budgets cannot cover them. Every report, standard or large, opens with a briefing the reporter returns in its result: whatsNew (one bullet for each new capability, 1 to 5, each with cites), features (at most 3, each a name, a summary, at most 8 stages (id, label, kind source, process, transport, store, external or sink, a cite) and at most 12 flows (from, to, label, a cite): the path the data takes through a new feature, from where it enters to where it is stored), check (five lists of at most 8 one-line entries with cites: surfaces, behavior, compatibility, risks, tests) and areas (a label for each area id of a large report). Deterministic validation requires the bounds, unique stage ids, flows between two stages of their feature, and citations inside the diff on the side they name (in large mode a repository-relative path and a range of lines, whose quotes the claim check verifies in the tree). Each bullet (W1), feature (F1), stage (F1.s2), flow (F1.f3) and check entry (C.risks.1) is a claim of the claim check: an unsupported bullet or entry is dropped, an unsupported stage with its flows, an unsupported flow alone, and a feature left with fewer than two stages or no flow whole, each recorded under "Removed by the claim check". Plugin code, never a model, computes the scope (lines added and deleted for production code, tests, docs and generated or other files, from the file list, the profile's excludeRoots and its generated globs), the hotspots (the five functions with the highest CRAP, then complexity, a modified function that got worse shown as base → head) and the open questions (those whose status is needs author or partially answered, or N1 when its conclusion is questionable or unnecessary; answered ones are a count). After the claim check, whatever the claim check left (each feature's data flow, and every lifecycle entry) is drawn by one read-only diagram job (diagrams-v1, on the optional diagrammer role's harness, model and effort, the reporter's when the profile sets none) with the vendored diagram-design skill (${SKILL_DIR}, mounted read-only): one Data flow for each feature and one State machine for each lifecycle entry, at most ${MAX_DIAGRAMS} diagrams, each a complete self-contained HTML document of at most ${MAX_DIAGRAM_BYTES} characters that uses the skill's default style, system fonts and no motion. Each document must pass, as recorded evidence, the skill's own self_check.py --offline and verify-geometry.py (python3 in a confined command job with no network, on a scratch file), the inertness check of the document and of the <svg> the report embeds, and the label rule (every visible text is a label of the checked data the job was given: stage ids, labels and kinds, flow labels, state names, scopes, initial values, transition conditions and effects, read descriptions, and the skill's fixed words). One correction goes back to the same session; a diagram that still fails is drawn by plugin code instead (a layered layout with longest-path layers, cycles broken at depth-first back edges, barycentre ordering, boxes coloured by the stage's kind, flow labels and a legend; a lifecycle diagram of its own), and the report says so ("drawn by the plugin: the diagram-design drawing failed its checks (<reason>)"); a diagram never stops the run. ${REVIEW_HTML} is the one-page briefing, in this order: the Briefing (the purpose, what is new, the scope, the verdict: N1's conclusion, the principles touched with their verdicts, the number of questions that need the author), the data flow of each new feature, what you need to check, the hotspots, the areas (the sections with their item counts for a report with a single area or none), and the open questions; ${REVIEW_APPENDIX_HTML} holds every change item with its lifecycles and tables, the necessity answer, the full measurements and coverage note, the claim check's removals, the notes and all Q&A, and each of the two links to the other. ${REVIEW_MD} mirrors the briefing in plain text and holds the appendix's content under an Appendix heading, so it stays complete for agents. Both HTML files are rendered by plugin code from report.json, qa.json and necessity.json (no model writes the report's HTML; the only markup a model wrote that it holds is a skill diagram's <svg>, which plugin code re-serializes from an allow-list of elements and attributes, with its ids prefixed and its title and description its own) and is self-contained and inert, which a deterministic check on the written bytes enforces: no script, no external stylesheet, font or image, every text from a model or the pull request escaped, and their only links are hrefs to the pull request, its commits and its files on GitHub at the pinned head and base, and to each other. Each of report.json, ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} is written by one command when it fits (about 236,000 characters), otherwise as a bounded multi-part write: one command per part, each recorded as evidence, appended in order and renamed into place by the last part after it checks the digest every part carries; the validators reconstruct each file by concatenating the recorded parts in order and checking that digest.`,
      evidenceSchema: "change-report-v1",
    },
    {
      id: REQUIREMENT_MEASUREMENTS,
      statement: `For every function the pull request adds or modifies, complexity and nesting were measured by the pinned static tools (gometrics, tsmetrics) over the head tree, under bwrap with no network, and every value recomputes from its evidence. The files run in batches of at most 8, each tool printing compact JSON; a batch whose report does not fit one command report is split in two, down to one file, and a file whose own report still does not fit is listed as not measured (never a failed run). A modified function is also measured at the base: its file is read at the pinned base (git show <base>:<path>, read-only, recorded whole) and measured by the same tools, confined with no network and recomputed from the recorded text, so its row shows base → head and says whether an over-the-limit value was already there, or why the base is not known (a base that cannot be measured never fails the report). Coverage runs the pull request's own tests, so it runs only in the Docker sandbox (no network, a read-only dependency cache, a prepared checkout of the head, images pinned by digest and pulled in Fetch): ${profile.metrics.coverage ? "each function's statement coverage is attributed by line range from the sandbox's report (go test -coverprofile; the repository's own vitest with @vitest/coverage-v8), and its CRAP is recomputed, or the function says why it was not run (Docker or the image is not available, the profile's sandboxed setup failed, a package did not build offline, no vitest coverage provider in the repository) and its CRAP is shown as its upper bound" : "not run (coverage disabled by the profile), CRAP shown as its upper bound"}. Mutation arrives with a later version.`,
      evidenceSchema: "graphloom-metrics-v1",
    },
    {
      id: REQUIREMENT_CLAIMS,
      statement: `An independent ${checker} report checker, on a harness other than the reporter's, judged every report item against the diff, and every item left is supported with quotes that match the diff's text. An item that was not supported after one revision is removed and recorded, and its file is accounted for in "other". In large mode there is one check, of the one report, and the quotes of its claims are verified against the tree each claim's cite names (the head's working tree, or the base commit's file) by read-only commands whose output is evidence, not against patch text, since an item may cite lines that no patch shown to the reporter holds: a claim whose quote the tree does not show (no such file, no such text within three lines of the line given) is unsupported, with the revision and removal rules above. The briefing's claims (what is new W<n>, a feature F<n>, its stages F<n>.s<k> and flows F<n>.f<k>, the check entries C.<list>.<n>) are claims of the same check, dropped and recorded as the requirement above says.`,
      evidenceSchema: CLAIM_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_QUESTIONS,
      statement: `The necessity question N1 was asked first, before every other question: is the problem real on the base (the claimed problem quoted from the pull request's text, the base behavior traced through the base code with path:line citations, a failing test on the base optional and not available in this version), does the fix fit the system's design (the repository's design and architecture documents${profile.questions.designDocs.length > 0 ? ` (${profile.questions.designDocs.join(", ")})` : ""} and code comments searched, the design statement and the changed lines cited, and whether the change preserves or breaks them said)${principlesText(profile)}, and is there a simpler or existing way; it concludes necessary, questionable, unnecessary or needs author, in one line. An independent ${harnessName(profile.roles["answer-checker"])} answer checker verified each cited design statement, each trace step${profile.questions.principles !== undefined ? ", each principle verdict" : ""} and the conclusion, with searches of its own, and N1's checked answer and the decision it led to${profile.questions.principles !== undefined ? " (with the principles file's path, ref, commit and the verdicts)" : ""} are recorded in necessity.json. When N1 concludes unnecessary and the checker supports it, and the operator did not ask for every question, no other question is asked and the skip is recorded (only N1 is required). Otherwise every required question was asked: purpose for each change item whose purpose the pull request's text does not state (a stated purpose is recorded with a quote that matches that text instead), existing-reuse-common for each new symbol (one question: does the codebase already have the same or an equivalent, can an existing internal package or declared library do it, is there common logic that could be shared), missing-test for each new or modified symbol the test map finds no covering test for, split-function for each changed function with complexity of ${LIMITS.complexity} or more or nesting over ${LIMITS.nesting}, complexity-coverage for each function with measured coverage and CRAP of ${LIMITS.crap} or more or with unknown coverage and complexity of ${LIMITS.complexity} or more (an upper-bound CRAP alone asks nothing), and weak-test for each surviving mutant (none in this version: mutation testing arrives later). The groundwork behind them (symbols from the language packs, whole-repository searches over the pinned base commit, similarity, the dependency inventory, the test map) was read by read-only commands, and every changed function has a measurement record. In large mode (the report is large, or the pull request adds more than ${profile.limits.maxNewSymbols} new symbols; it is refused past ${profile.limits.hardMaxNewSymbols}) the questions are the high-level set, recorded in qa.json: purpose for each high-level change whose purpose the pull request's text does not state, and for each high-level change (one for each capability of the briefing's whatsNew, 3 to 5, ids W1 to W5, each with its cites, whatever the number of files, areas or report items) the one existing-reuse-common question (does the codebase already have the same or an equivalent of what it adds, can an existing library do it, is there common logic) and missing-test (which tests cover it, listing the new or modified functions in the cited files that the test map finds no covering test for); split-function, complexity-coverage, weak-test, the per-symbol questions and the per-function missing-test are not asked, while the measurements still show every function, the over-limit ones visible in the table.`,
      evidenceSchema: QUESTIONS_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_ANSWERS,
      statement: `N1 has its recorded answer first (when it is the only question, because it concluded unnecessary and the checker supports it, the Q&A says the remaining questions were skipped). Every other question has an answer from the ${harnessName(profile.roles.answerer)} answerer with evidence (citations that resolve in the tree they name, the searches run with their results, inventory entries) and a status of answered, partially answered or needs author. Every "none found" answer lists its whole-repository searches. The existing-reuse-common answer is one statement with one status and its evidence, addressing all three concerns (already exists, reusable library, common logic), and the checker judges it as a whole. Every cited metric equals its measurement record. Every proposal's line ranges lie inside its function and its names are new to the package. ${QA_JSON}, ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} (rendered from report.json, qa.json and necessity.json, with the same inert check) are written, each by one command or as a bounded multi-part write that the validators reconstruct and check against its digest, and the pull request's ledger ref was advanced by compare-and-swap from the value Fetch read with this head's report.json and qa.json (a ledger.json or ledger.md too large for the one ledger command is first written as a part set the write reads). In large mode the ${harnessName(profile.roles["batch-answerer"])} batch-answerer (the answerer role unless the profile names a batch-answerer; N1 keeps the answerer in every mode) answers the questions in batches of at most ${QUESTION_BATCH_SIZE} (the questions of a few change items per job), continuing its own session from one batch to the next; each answered batch passes the same deterministic checks and citation verification as the standard answers and is recorded as evidence (answers-record-<n>) that recomputes; ${QA_JSON} and ${REVIEW_MD} are written once, after the last batch.`,
      evidenceSchema: ANSWERS_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_GROUNDED,
      statement: `An independent ${harnessName(profile.roles["answer-checker"])} answer checker, on a harness other than the answerer's (and the batch-answerer's), re-checked every cited equivalent, library, duplicate and covering test, and every "none found" claim (each part of a combined answer separately) with searches of its own, against the trees, and had verified N1's cited design statements, trace steps${profile.questions.principles !== undefined ? ", principle verdicts" : ""} and conclusion. Every answer left is supported or partial; an answer still unsupported after one correction is needs author, with both statements recorded (for N1, its conclusion becomes questionable and every question is asked). In large mode each batch of answers is checked by its own answer checker job in a fresh session, with the same correction and downgrade rules.`,
      evidenceSchema: ANSWER_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_CODE_REVIEW,
      statement: `Unless round 1 found issues (the run then publishes round 1 and ends, and this requirement passes on that, see round1-gated): for each of the aspects correctness, maintainability and security, a read-only ${harnessName(profile.roles[reviewerRole("correctness")])} reviewer swept the review's scope with the aspect's rule file, and every finding it raised has a verdict from the aspect's verifier (${ASPECTS.map((a) => `${a}: ${harnessName(profile.roles[verifierRole(a)])}`).join(", ")}), a fresh read-only session on a harness other than the reviewer's. The Review stage is entered, in the same run, when round 1 found no issue; no human is asked. The scope is the whole pull request; in large mode it is the files of the areas that the briefing's risks, behavior and compatibility entries cite (every readable area when it cites none), and it is recorded once, in a review-scope record, with the reason every reviewer starts as it does: a fresh session seeded with review.md only (no conversation reaches a reviewer). Each aspect's effective rule file (the shipped rules with the profile's review.aspects.<aspect>.rules entries) is written to .graphloom/review/rules/<aspect>.json, every file of the scope falls under one of its entries, and the reviewer is told which. When the profile names a design principles file (design §8.1), each reviewer's assignment also lists the principles that apply to the review's scope (a glob matches a file of it, or the principle names none), with the file's path and commit and N1's verdict and the checker's judgment for each, and a comment that says the change breaks a principle names its id in the principle field (empty otherwise, and always empty when none applies); an id that was not given to the reviewer is rejected, and the verifier is shown the principle's statement and confirms only code that contradicts it as written. Each pass reviews every file of the scope and skips none, its comments are checked (a file of the scope, a side, a range, an aspect, a kind: a correctness finding is behavioral; a severity), and P3 nits are counted and not verified. The sweep follows issue-fix's review convergence on one candidate: every finding of a pass is verified in one pr-finding-verification-v1 job, a confirmation needs its own path:line witness, a refutation needs one to three quotes that the head's files show (otherwise the finding is disputed, as is one the verifier left uncertain or gave no verdict), another pass runs while a finding of the last pass is confirmed or disputed, at most 4 passes, and a sweep that ends at the cap is recorded unsaturated and does not fail the stage. A finding the verifier calls behavioral is unproven in this version (reproducing tests arrive with a later part of the review layer), so it is never drafted as P0 or P1. Each aspect's sweep is recorded in a review-aspect-<aspect> record, from which the validator recomputes the findings, their states and the harnesses.`,
      evidenceSchema: VERIFY_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_DRAFT,
      statement: `Unless round 1 found issues: the draft review is composed by plugin code from the aspects' records and the Q&A (no model writes it) and written whole to ${DRAFT_JSON} (pr-review-draft-v1, canonical) and ${DRAFT_MD} (its editable rendering), each as one command or a bounded multi-part write. Confirmed findings that claim no wrong behavior are the comments, grouped by aspect (correctness, security, maintainability), at most P2; confirmed findings of different aspects on overlapping lines of one file are one entry that lists every aspect; confirmed behavioral findings, which are unproven in this version, and disputed findings are listed under "Needs your judgment" and never drafted as P0 or P1; the Q&A items that need the author are pre-selected (none, once round 1 passed) and the rest listed under "Not selected"; a suggestion is kept only when the verifier says it fixes the finding, it is at most 20 lines and replaces exactly the commented RIGHT range; a comment outside a hunk of the file's patch is marked as going in the review body; the recommended verdict is request-changes only for a proven P0 or P1 finding (none in this version), approve only when nothing is open, and approve is drafted as comment; the summary is at most 1,200 characters. The draft holds no path inside .graphloom/ and no secret. ${REVIEW_MD}, ${REVIEW_HTML} and ${REVIEW_APPENDIX_HTML} are written again with a Review section: findings by severity with counts, each with its one-line claim, aspect badge, cite and checker verdict, collapsed except the P0 and P1 findings that stand, in the briefing; every finding in full and the draft in the appendix. They recompute from report.json, qa.json, necessity.json and the draft, with the same inert check. The Publish stage posts the draft's comments that are findings; this stage posts nothing.`,
      evidenceSchema: DRAFT_SCHEMA,
    },
    {
      id: REQUIREMENT_ROUND1,
      statement: `Round 1 (the report and the Q&A: the architecture and design level) is decided by plugin code from necessity.json and qa.json, with no model and no human, and recorded in round1/round1.json (pr-review-round1-v1). Its issues are: N1's conclusion when it is not necessary (questionable, unnecessary or needs author, a design principle the checker supports as broken included); every question whose answer needs the author; every partially answered question; every answer that found an existing equivalent, a reusable library or common logic (an existing-reuse-common answer that did not find "none"), even when it is fully answered; and every missing-test question whose answer cites no covering test, even when it is fully answered. Each issue carries its id (N1 or Q<n>), its kinds, the answer's status, its text and, where its place lies inside a hunk of the file's patch at the head, that anchor. Any issue blocks round 2: the run then publishes round 1 and ends (Review and Draft pass on that). With none, the same run continues into the review layer. The record recomputes from the recorded Q&A and necessity files and must equal what was written.`,
      evidenceSchema: "round1-v1",
    },
    {
      id: REQUIREMENT_PUBLISHED,
      statement: `The review was posted to the pull request as exactly one GitHub review of event COMMENT (never APPROVE or REQUEST_CHANGES), pinned to head <sha>, by the graphloom.github/create-pull-review executor, whose credential the plugin never sees, or a review of this head carrying the graph's head marker was already there and was found by reading the pull request's reviews before any post (an attempt whose outcome is unknown is reconciled the same way, and never repeated blind). Its body's first line is the verdict: "Review passed" when round 1 has no open issue and round 2 no open postable finding, else "Changes requested: <n> open". It carries round 1's issues when round 1 found any, else round 2's postable findings (the draft's comments that are findings); an item with a diff anchor is an inline comment (at most 50), the rest are in the body; each item ends with its marker (<!-- graphloom-finding: F3 --> or Q3, N1) and the body carries <!-- graphloom-review: <head> -->. The review's comments were read back and the ledger records the review id (reviewId on the head) and, for each item, the review and comment ids (github), by a compare-and-swap from the ledger value it read. The review's items and verdict recompute from the recorded round 1 and draft.`,
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
    // The reviews' verifiers are independent reviewers: the controller admits it from review evidence of a read-only review job.
    { requirementId: REQUIREMENT_CODE_REVIEW, validatorId: "code-review", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_DRAFT, validatorId: "draft-composed", version: "1" },
    { requirementId: REQUIREMENT_ROUND1, validatorId: "round1-gated", version: "1" },
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
      // Kind "review": the claims-checked requirement is judged by an independent reviewer, and the controller
      // admits one only from the review evidence of a read-only review job.
      { name: CLAIM_CHECK_SCHEMA_NAME, schema: asSchema(CLAIM_CHECK_SCHEMA), evidenceKind: "review", references: [...CLAIM_CHECK_REFERENCES] },
      { name: QUESTIONS_SCHEMA_NAME, schema: asSchema(QUESTIONS_SCHEMA), evidenceKind: "other", references: [...QUESTIONS_REFERENCES] },
      { name: ANSWERS_SCHEMA_NAME, schema: asSchema(ANSWERS_SCHEMA), evidenceKind: "other", references: [...ANSWERS_REFERENCES] },
      { name: ANSWERS_REVISION_SCHEMA_NAME, schema: asSchema(ANSWERS_SCHEMA), evidenceKind: "other", references: [...ANSWERS_REFERENCES] },
      { name: NECESSITY_SCHEMA_NAME, schema: asSchema(NECESSITY_SCHEMA), evidenceKind: "other", references: [...NECESSITY_REFERENCES] },
      { name: NECESSITY_REVISION_SCHEMA_NAME, schema: asSchema(NECESSITY_SCHEMA), evidenceKind: "other", references: [...NECESSITY_REFERENCES] },
      // Kind "review": answers-grounded is judged by an independent reviewer (a read-only review job on another harness).
      { name: ANSWER_CHECK_SCHEMA_NAME, schema: asSchema(ANSWER_CHECK_SCHEMA), evidenceKind: "review", references: [...ANSWER_CHECK_REFERENCES] },
      // The review layer (design §8.1): an aspect reviewer's pass, and the verifier's verdicts on its findings. Both are read-only review jobs.
      { name: REVIEW_SCHEMA_NAME, schema: asSchema(REVIEW_SCHEMA), evidenceKind: "review", references: [...REVIEW_REFERENCES] },
      { name: VERIFY_SCHEMA_NAME, schema: asSchema(VERIFY_SCHEMA), evidenceKind: "review", references: [...VERIFY_REFERENCES] },
    ],
    stages: [
      { id: FETCH_STAGE, name: "Fetch", requirementIds: [REQUIREMENT_SNAPSHOT, REQUIREMENT_CHECKED_OUT, REQUIREMENT_LEDGER] },
      { id: REPORT_STAGE, name: "Report", requirementIds: [REQUIREMENT_REPORT, REQUIREMENT_MEASUREMENTS, REQUIREMENT_CLAIMS] },
      { id: QUESTIONS_STAGE, name: "Questions", requirementIds: [REQUIREMENT_QUESTIONS] },
      { id: ANSWERS_STAGE, name: "Answers", requirementIds: [REQUIREMENT_ANSWERS, REQUIREMENT_GROUNDED] },
      { id: ROUND1_STAGE, name: "Round 1", requirementIds: [REQUIREMENT_ROUND1] },
      { id: REVIEW_STAGE, name: "Review", requirementIds: [REQUIREMENT_CODE_REVIEW] },
      { id: DRAFT_STAGE, name: "Draft", requirementIds: [REQUIREMENT_DRAFT] },
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
 * The roles the profile assigns harnesses to (design §13.1), for `graphloom
 * doctor --task`: the whole role set with its distinctness constraints.
 */
export function agentRoles(profile: Profile): AgentRoleDeclaration[] {
  return ROLES.map((role) => {
    const distinctFrom = DISTINCT_PAIRS.filter(([checked]) => checked === role).map(([, author]) => author);
    // diagrammer (the diagram job) is optional, falling back to the reporter's harness, model and effort.
    const setting =
      role === "diagrammer"
        ? `harnesses.${role} (optional; falls back to harnesses.reporter)`
        : role === "batch-answerer"
          ? `harnesses.${role} (optional; the answer batches of large mode; falls back to harnesses.answerer)`
          : role.startsWith("reviewer-")
            ? `harnesses.${role} (optional; the ${role.slice("reviewer-".length)} aspect's reviewer; falls back to harnesses.answerer, and must be on its harness: a reviewer starts from the answerer's session)`
            : role.startsWith("verifier-")
              ? `harnesses.${role} (optional; the ${role.slice("verifier-".length)} aspect's finding verifier; the first harness of the design's preference that is not its reviewer's)`
              : `harnesses.${role}`;
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

export function advancePullRequest(view: RunView): GraphDecision {
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
  // Round 2 (the review layer and its draft) runs in this run only when round 1 found no issue; with issues, their requirements pass on that and the run publishes round 1.
  if (stage.id === REVIEW_STAGE || stage.id === DRAFT_STAGE) {
    const round1 = recordedRound1(view.evidence);
    if (round1.state === "failed") return supervise({ reason: `the round-1 record does not read back: ${round1.reason}`, evidenceRefs: round1.refs }, "escalate an unreadable round-1 record");
    if (round1.state === "none") return supervise({ reason: "the review stage lost the round-1 record" }, "escalate a missing round-1 record");
    if (round1.value.issues.length > 0) return withPrivate(validate({ stageId: stage.id }, `round 1 found ${round1.value.issues.length} issue(s): ${stage.name} passes, round 2 runs on a later head after they are fixed`));
    return stage.id === REVIEW_STAGE ? review(ctx, view) : draftStage(ctx, view);
  }
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

/** Every stage is accepted: the run ends, with the verdict the posted review gives (design §9.4). */
function finished(ctx: Context, view: RunView): GraphDecision {
  const round1 = recordedRound1(view.evidence);
  const issues = round1.state === "read" ? round1.value.issues.length : 0;
  const a = analyze(view.evidence, ctx.profile, ctx.pr);
  const where = `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} at ${ctx.pr.head.slice(0, 12)}`;
  const posted = a.state === "ready" ? postedReview(view, ctx, a.analysis) : undefined;
  const link = posted?.url !== null && posted?.url !== undefined ? ` (${posted.url})` : "";
  const blocker = issues > 0 ? `round 1: changes requested: ${issues} issue${issues === 1 ? "" : "s"} open on ${where}; the review is posted${link}, and round 2 (the aspect reviewers) runs on a later head, once they are fixed` : `${posted?.verdict === "changes-requested" ? `round 2: changes requested: ${posted.open} open` : "review passed"} on ${where}; the review is posted${link}`;
  return withPrivate(stop({ reason: "complete", blocker, retryable: false }, issues > 0 ? "round 1 found issues: the review is posted and the run ends" : "both rounds ran: the review is posted and the run ends"));
}

interface Context {
  profile: Profile;
  definition: GraphDefinition;
  pr: PullRequest;
}

/** The latest run of command `id`: its result, and whether it failed since the operator's last resume (a failure before it is run again once). */
function commandState(view: RunView, id: string): { run: CommandRun | undefined; failed: boolean; retry: boolean } {
  const run = commandRuns(view.evidence, id).at(-1);
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
  const guard = commandState(view, COMMAND.guard);
  if (guard.failed && !guard.retry && guard.run !== undefined) {
    if (guard.run.command.exitCode === GUARD_REFUSED) {
      return stop({ reason: "incompatible task", blocker: `the pull request touches .graphloom/, which holds this graph's own files and which a pull request may not change: ${outputTail(guard.run.command, 300).replace(/\s+/g, " ")}`, evidenceRefs: [guard.run.record.ref], retryable: false }, "stop: the pull request touches .graphloom/");
    }
  }
  const checkout = commandState(view, COMMAND.checkout);
  const tree = commandState(view, COMMAND.headTree);
  const dir = commandState(view, COMMAND.reviewDir);
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
  const ledger = commandState(view, COMMAND.ledger);
  if (ledger.failed && !ledger.retry && ledger.run !== undefined) {
    return supervise({ reason: `the ledger read failed: ${describeCommand(ledger.run.command)}`, evidenceRefs: [ledger.run.record.ref] }, "escalate a failed ledger read");
  }
  if (ledger.run === undefined || ledger.retry) {
    return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the pull request's ledger ref", { commands: [ledgerReadCommand(pr.owner, pr.repo, pr.number)], env: { ...GIT_ENV } }), "read the ledger ref, or record it absent"));
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

/** Where a tool of the confined static job lives: the plugin's directory, and the Go and Node installations under a hidden home. */
function toolBinds(view: RunView, batches: ReadonlyArray<{ language: string }>): Array<{ path: string; readOnly: boolean }> | undefined {
  const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT);
  if (root === undefined) return undefined;
  const binds = [{ path: root, readOnly: true }];
  const goRoot = environmentOutput(view.evidence, "go-root");
  if (batches.some((b) => b.language === "go") && goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/") binds.push({ path: goRoot, readOnly: true });
  const nodeRoot = path.dirname(path.dirname(process.execPath));
  if (batches.some((b) => b.language === "typescript") && nodeRoot !== "/" && nodeRoot !== ".") binds.push({ path: nodeRoot, readOnly: true });
  return binds;
}

function measureAndWrite(ctx: Context, view: RunView, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }>): GraphDecision {
  const { profile, pr } = ctx;
  const m = measurementState(view.evidence, analysis.snapshot.files, profile, retryOf(view));
  switch (m.state) {
    case "observe":
      return withPrivate(observe({ paths: m.paths }, "observe the changed files the static tools measure, so their records can be recomputed from the head's bytes"));
    case "diff": {
      const diff = commandState(view, COMMAND.metricsDiff);
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
      const planned = planNecessityChecker({ pr, snapshot: c.ctx.analysis.snapshot, question: necessityQuestion(), answer, designDocs: c.ctx.designDocs, context: c.ctx.context, retry: nf.retry, ...(c.ctx.principles !== undefined ? { principles: c.ctx.principles } : {}), ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
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
      const required = requiredQuestions({ view: c.ctx.view, groundwork: c.ctx.groundwork, large: isLarge(c.ctx.mode) }, new Map());
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const planned = planQuestioner({ pr, snapshot: c.ctx.analysis.snapshot, view: c.ctx.view, groundwork: c.ctx.groundwork, required, feedback: flow.feedback, kind: flow.kind, large: isLarge(c.ctx.mode), ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
      const assignment = planned.text;
      const written = writeSpills(view, QUESTIONS_STAGE, planned.spills);
      if (written !== undefined) return written;
      const from = flow.kind === "first" ? undefined : jobSession(view, QUESTIONS_STAGE, QUESTIONER_JOB);
      const itemIds = questionItems(c.ctx.view).map((i) => i.id);
      const symbolIds = c.ctx.groundwork.symbols.map((x) => x.id);
      const references = idRefs({ "purposes[].item": idSet(itemIds), "questions[].item": idSet(itemIds), "questions[].symbol": idSet(["", ...symbolIds]) });
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
  const flow = answersFlow(view.evidence, answerContext(c.ctx, rest), c.ctx.base, retryOf(view));
  if (flow.state === "done") return writeAnswers(ctx, view, c.ctx, set, [rec.record.final, ...flow.final], rec.record);
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
      const planned = planAnswerChecker({ pr, snapshot: c.analysis.snapshot, groundwork: c.groundwork, questions: rest, answers: flow.answers, retry: flow.retry, mountedDirs: mounted, ...(baseDir !== undefined ? { baseDir } : {}), ...(reviewDirOf(view) !== undefined ? { reviewDir: reviewDirOf(view)! } : {}) });
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
  const w = answerWrites(view.evidence, c, set, final, necessity);
  if (w.qa === undefined || w.texts === undefined) return stop({ reason: "incompatible task", blocker: w.problem ?? "the Q&A cannot be written", retryable: false }, "stop: the Q&A cannot be written");
  // qa.json, the whole review.md and review.html: each one command when it fits, else a bounded multi-part write (design §6.6).
  const next = nextWrite(view, w.qa, { failed: "writing the Q&A failed", settle: "the written Q&A keeps differing from the one the evidence recomputes" });
  if (next === undefined) return recordLedger(ctx, view, c, w);
  if ("decision" in next) return next.decision;
  const secrets = [...secretFindings(w.texts.json), ...secretFindings(w.texts.markdown), ...secretFindings(w.texts.html), ...secretFindings(w.texts.appendix)];
  if (secrets.length > 0) {
    return stop({ reason: "report refused", blocker: `the Q&A would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a Q&A that holds a secret");
  }
  const inert = [...writtenHtmlProblems(w.texts.html, ctx.pr, c.base), ...writtenHtmlProblems(w.texts.appendix, ctx.pr, c.base)];
  if (inert.length > 0) return supervise({ reason: `review.html or review-appendix.html would not be self-contained and inert: ${inert.slice(0, 3).join("; ")}` }, "escalate a report file that fails its own inertness check");
  return withPrivate(dispatch(commandJob(ANSWERS_STAGE, writeInstruction(next.command, `Write ${QA_JSON} and ${REVIEW_MD}`), { commands: [next.command] }), "write qa.json, the whole review.md (Briefing, Appendix) and the HTML briefing review.html with its appendix review-appendix.html"));
}

function recordLedger(ctx: Context, view: RunView, c: QaContext, w: ReturnType<typeof answerWrites>): GraphDecision {
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
      return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Read the pull request's ledger ref again", { commands: [ledgerReadCommand(c.pr.owner, c.pr.repo, c.pr.number)], env: { ...GIT_ENV } }), "read the ledger ref again: it moved since Fetch read it"));
    }
  }
  const lr = commandState(view, COMMAND.ledger);
  if (lr.failed && lr.run !== undefined) return supervise({ reason: `the ledger read failed: ${describeCommand(lr.run.command)}`, evidenceRefs: [lr.run.record.ref] }, "escalate a failed ledger read");
  if (w.prior?.state === "missing" || (w.prior?.state === "unreadable" && retryOf(view)(w.prior.run))) {
    return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Read the prior ledger's ledger.json", { commands: [priorShowCommand(w.old, process.execPath)], continueOnFailure: true, env: { ...GIT_ENV } }), "read the prior ledger.json, so the new one keeps its heads"));
  }
  if (w.prior?.state === "unreadable") {
    return supervise({ reason: w.problem ?? "the prior ledger cannot be read", evidenceRefs: [w.prior.run.record.ref] }, "escalate a prior ledger that cannot be read: it is never overwritten");
  }
  if (w.ledger === undefined) return stop({ reason: "incompatible task", blocker: w.problem ?? "the ledger files cannot be written", retryable: false }, "stop: the ledger files do not fit one command");
  if (lw.run !== undefined && !lw.failed && sameArgv(lw.run.command.argv, w.ledger.argv)) return validateStage(ctx, view, ANSWERS_STAGE);
  if (commandRuns(view.evidence, COMMAND.ledgerWrite).length >= 6) return supervise({ reason: "the ledger write keeps differing from the one the evidence recomputes" }, "escalate a ledger write that does not settle");
  // A ledger.json or ledger.md too large for the ledger write's one command is written first as a part set (design §6.6); the write reads those files.
  const parts = nextWrite(view, w.ledgerParts ?? [], { failed: "writing the ledger files failed", settle: "the written ledger files keep differing from the ones the evidence recomputes" });
  if (parts !== undefined) {
    if ("decision" in parts) return parts.decision;
    return withPrivate(dispatch(commandJob(ANSWERS_STAGE, writeInstruction(parts.command, "Write the ledger files"), { commands: [parts.command] }), "write the ledger's ledger.json and ledger.md as parts: they do not fit the ledger write's one command"));
  }
  return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Advance the pull request's ledger ref by compare-and-swap (no repository code runs)", { commands: [w.ledger], env: { ...GIT_ENV } }), "record this head's report and Q&A in the ledger, from the value Fetch read"));
}

// ---- the review layer (design §8) ----

const REVIEW_COMMAND_WORDS = { failed: "recording the review failed", settle: "the review's record keeps differing from the one the evidence recomputes" };

/** The review: the scope, base and rule files first, then each aspect's sweep (passes, verification, the check of refutations' quotes), each recorded when it ends. */
function review(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return supervise({ reason: a.state === "pending" ? `the review stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  const { analysis } = a;
  const flow = reportFlowOf(view.evidence, analysis, retryOf(view));
  if (flow.state !== "done") return supervise({ reason: "the review stage lost the finished report" }, "escalate a missing report");
  const scope = recordedScope(view.evidence);
  if (scope.state === "failed") return supervise({ reason: `the review's scope record does not read back: ${scope.reason}`, evidenceRefs: scope.refs }, "escalate an unreadable scope record");
  if (scope.state === "none") return startReview(ctx, view, analysis, flow.final.briefing.check);
  const s = scope.value;
  const base = pinnedBase(view.evidence);
  const files = new Set(s.files);
  // The design principles that apply to the review's scope, and what round 1 concluded of them (design §8.1); none when the profile names no file or none applies.
  const configured = profile.questions.principles;
  const reading = configured !== undefined && base !== undefined ? principlesReading(view.evidence, configured, base) : undefined;
  const scoped: PrinciplesContext | undefined = reading?.state === "read" ? principlesContext(reading.read, analysis.snapshot.files.filter((f) => files.has(f.path))) : undefined;
  const reviewPrinciples = scoped !== undefined && scoped.read.file === "present" && scoped.applicable.length > 0 ? scoped : undefined;
  const principleIds = new Set((reviewPrinciples?.applicable ?? []).map((p) => p.id));
  const necessityRecord = recordedNecessityJson(view.evidence);
  const round1 = round1Verdicts(necessityRecord.state === "read" ? parseNecessityRecord(necessityRecord.value) : undefined);
  const records: AspectRecord[] = [];
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
    const f = aspectFlow(view.evidence.slice(from + 1), { aspect, scope: files, principles: principleIds, earlier, base, retryable: (r) => isStaleFailure(r.record, view) });
    const reviewDir = reviewDirOf(view);
    const baseDir = baseTreeDir(view, { baseTree: true });
    switch (f.state) {
      case "supervise":
        return supervise({ reason: f.reason, evidenceRefs: f.refs }, "hand the unresolved review to the supervisor");
      case "quotes":
        return withPrivate(dispatch(commandJob(REVIEW_STAGE, "Check the refutations' quotes against the head", { commands: f.commands.slice(0, 16), env: { ...GIT_ENV } }), "check each refutation's quotes against the head's files"));
      case "pass": {
        const role = reviewerRole(aspect);
        const planned = planReviewer({
          pr,
          snapshot: analysis.snapshot,
          aspect,
          pass: f.n,
          files: readingOrder(view.evidence, s.files),
          scopeLine: scopeLine(s),
          groups: rules.groups,
          known: f.known,
          feedback: f.feedback,
          ...(reviewPrinciples !== undefined ? { principles: reviewPrinciples, round1 } : {}),
          ...(baseDir !== undefined ? { baseDir } : {}),
          ...(reviewDir !== undefined ? { reviewDir } : {}),
        });
        const written = writeSpills(view, REVIEW_STAGE, planned.spills);
        if (written !== undefined) return written;
        const known = ["", ...f.known.map((k) => k.id)];
        const job = agentJob(ctx, view, { jobId: role, stageId: REVIEW_STAGE, purpose: "review", instruction: `Review the ${aspect} aspect (pass ${f.n})`, schema: REVIEW_SCHEMA_NAME, harness: profile.roles[role], role, assignment: planned.text, readOnlyBinds: mounted, references: idRefs({ [REVIEW_REFERENCES[0]!]: idSet(known), [REVIEW_REFERENCES[1]!]: idSet(["", ...principleIds], (id) => oneLineText(reviewPrinciples?.applicable.find((p) => p.id === id)?.statement ?? "").slice(0, 300)) }) }, analysis.snapshot.files);
        if ("problem" in job) return refused(job);
        return dispatchAgent(view, job, `review the ${aspect} aspect (pass ${f.n}) in a fresh read-only ${harnessName(profile.roles[role])} session (${s.context.reason})`);
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
        };
        const id = aspectRecordId(aspect);
        return recordStep(view, REVIEW_STAGE, id, recordCommands(id, "review", aspectRecordJson(record)), `the ${aspect} review`);
      }
    }
  }
  return validateStage(ctx, view, REVIEW_STAGE);
}

/** Decides the scope and writes the rule files and the scope record, in that order (the record last: it marks the start complete). */
function startReview(ctx: Context, view: RunView, analysis: Analysis, check: Parameters<typeof chooseScope>[0]["check"]): GraphDecision {
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
    harnesses: Object.fromEntries(ASPECTS.map((a) => [a, { reviewer: profile.roles[reviewerRole(a)], verifier: profile.roles[verifierRole(a)] }])),
  };
  const commands = [...ASPECTS.flatMap((a) => ruleCommands(a, profile.review.rules[a])), ...recordCommands(SCOPE_RECORD_ID, "review", scopeRecordJson(record))];
  const next = nextWrite(view, commands, REVIEW_COMMAND_WORDS);
  if (next === undefined) return supervise({ reason: "the review's scope record was written as recomputed but does not read back" }, "escalate a scope record that does not read back");
  if ("decision" in next) return next.decision;
  return withPrivate(dispatch(commandJob(REVIEW_STAGE, writeInstruction(next.command, "Record the review's scope as evidence"), { commands: [next.command] }), "write the aspects' rule files and record the review's scope"));
}

/** The Draft stage: the draft and the report files with the Review section, written whole, then validated. */
function draftStage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return supervise({ reason: a.state === "pending" ? `the draft stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  const w = draftWrites(view.evidence, a.analysis, pr, pinnedBase(view.evidence));
  if (w.state === "pending") return supervise({ reason: `the draft cannot be composed: ${w.reason}` }, "escalate a missing review record");
  if (w.state === "failed") return supervise({ reason: w.reason, evidenceRefs: w.refs }, "escalate an unreadable review record");
  const t = w.writes.texts;
  const secrets = Object.values(t).flatMap((x) => secretFindings(x));
  if (secrets.length > 0) return stop({ reason: "report refused", blocker: `the draft would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a draft that holds a secret");
  const inert = [...writtenHtmlProblems(t.html, pr, pinnedBase(view.evidence)), ...writtenHtmlProblems(t.appendix, pr, pinnedBase(view.evidence))];
  if (inert.length > 0) return supervise({ reason: `review.html or review-appendix.html would not be self-contained and inert: ${inert.slice(0, 3).join("; ")}` }, "escalate a report file that fails its own inertness check");
  const next = nextWrite(view, w.writes.commands, { failed: "writing the draft failed", settle: "the written draft keeps differing from the one the evidence recomputes" });
  if (next === undefined) return validateStage(ctx, view, DRAFT_STAGE);
  if ("decision" in next) return next.decision;
  return withPrivate(dispatch(commandJob(DRAFT_STAGE, writeInstruction(next.command, "Write the draft review"), { commands: [next.command] }), "write draft.json, draft.md and the report files with the Review section"));
}

// ---- round 1 and publishing (design §9.4, §8.5) ----

/** The Round 1 stage: the issues of the report and the Q&A, computed by plugin code and recorded once, then validated. */
function round1Stage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return supervise({ reason: a.state === "pending" ? `the round-1 stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  const computed = round1Computed(view.evidence, a.analysis, pr, profile);
  if (computed.state === "pending") return supervise({ reason: `round 1 cannot be decided: ${computed.reason}` }, "escalate a missing Q&A artifact");
  const rec = recordedRound1(view.evidence);
  if (rec.state === "failed") return supervise({ reason: `the round-1 record does not read back: ${rec.reason}`, evidenceRefs: rec.refs }, "escalate an unreadable round-1 record");
  if (rec.state === "read" && round1Json(rec.value) === round1Json(computed.record)) return validateStage(ctx, view, ROUND1_STAGE);
  const n = computed.record.issues.length;
  return recordStep(view, ROUND1_STAGE, ROUND1_RECORD_ID, recordCommands(ROUND1_RECORD_ID, ROUND1_DIR, round1Json(computed.record)), `round 1 (${n} issue${n === 1 ? "" : "s"})`);
}

/** The verdict and link of the review the evidence shows posted, once the Publish stage is done. */
function postedReview(view: RunView, ctx: Context, analysis: Analysis): { url: string | null; verdict: "passed" | "changes-requested"; open: number } | undefined {
  const p = publishPlan(view.evidence, analysis, ctx.pr, pinnedBase(view.evidence));
  if (p.state !== "ready") return undefined;
  const flow = publishFlow(view.evidence, p.plan, ctx.pr);
  return flow.state === "done" ? { url: flow.posted.url, verdict: p.plan.verdict, open: p.plan.open } : undefined;
}

/**
 * The Publish stage: read the pull request's reviews, post the one review unless this head already has it, read its comments back,
 * and record the ids in the ledger. The reads are the executors' own (reads of the review and its comments); the one write is
 * `create-pull-review`, whose credential binding is the runner's, never the plugin's.
 */
function publishStage(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") return supervise({ reason: a.state === "pending" ? `the publish stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  const p = publishPlan(view.evidence, a.analysis, pr, pinnedBase(view.evidence));
  if (p.state === "pending") return supervise({ reason: `the review cannot be composed: ${p.reason}` }, "escalate a missing record");
  if (p.state === "failed") return supervise({ reason: p.reason, evidenceRefs: p.refs }, "escalate an unreadable record");
  const secrets = secretFindings(JSON.stringify(createInput(pr, p.plan)));
  if (secrets.length > 0) return stop({ reason: "report refused", blocker: `the review would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not posted`, retryable: false }, "refuse to post a review that holds a secret");
  const flow = publishFlow(view.evidence, p.plan, pr);
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
      return withPrivate(dispatch(commandJob(PUBLISH_STAGE, "Record the published review in the pull request's ledger by compare-and-swap (no repository code runs)", { commands: [ledgerPublishedCommand(pr, flow.patch, process.execPath)], env: { ...GIT_ENV } }), `record review ${flow.posted.reviewId} and its comments' ids in the ledger`));
    }
    case "done":
      return validateStage(ctx, view, PUBLISH_STAGE);
  }
}
