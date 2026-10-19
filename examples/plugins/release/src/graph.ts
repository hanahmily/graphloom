import {
  dispatch,
  executorFailureOf,
  isStaleFailure,
  observe,
  reenter,
  stop,
  supervise,
  validate,
  type EvidenceRecord,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type RunView,
  type ValidationResult,
} from "@graphloom/sdk";
import {
  BUMP_STAGE,
  CHANGELOG_PATH,
  CHANGELOG_STAGE,
  MAX_STAGE_CORRECTIONS,
  REQUIREMENT_ENTRY,
  REQUIREMENT_REVIEW,
  REQUIREMENT_SCOPE,
  REQUIREMENT_VERSION,
  REVIEW_STAGE,
  VERSION_PATH,
} from "./constants.js";
import { latestReview, validatorById } from "./validators.js";

/**
 * Where the graph is within the current stage. A stage whose worker already
 * ran is observed before it is redone: after a repair activation or a
 * restart, work already in the worktree only needs validating again.
 */
export interface ReleasePrivateState {
  stageId: string;
  generation: number;
  dispatched: boolean;
  observed: boolean;
  corrections: number;
  /** Work stages whose worker has run in this run. */
  ran: string[];
  /** The reviewer's request, carried into the changelog rewrite. */
  feedback?: string;
}

/** The writer has nothing to say beyond "I wrote it"; Observe confirms the bytes. */
const WRITER_RESULT_SCHEMA: Record<string, unknown> = { type: "object" };

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["approved", "request_changes"] }, summary: { type: "string" } },
  required: ["verdict", "summary"],
};

const definition: GraphDefinition = {
  graphId: "release",
  version: "0.1.0",
  privateStateSchema: "release-private-v1",
  resultContracts: [
    { name: "writer-result-v1", schema: WRITER_RESULT_SCHEMA, evidenceKind: "other" },
    { name: "review-verdict-v1", schema: REVIEW_SCHEMA, evidenceKind: "review" },
  ],
  stages: [
    { id: BUMP_STAGE, name: "Bump version", requirementIds: [REQUIREMENT_VERSION] },
    { id: CHANGELOG_STAGE, name: "Changelog", requirementIds: [REQUIREMENT_ENTRY, REQUIREMENT_SCOPE] },
    { id: REVIEW_STAGE, name: "Review", requirementIds: [REQUIREMENT_REVIEW] },
  ],
  requirements: [
    {
      id: REQUIREMENT_VERSION,
      statement: "VERSION holds exactly one semantic version (MAJOR.MINOR.PATCH) followed by a newline.",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: REQUIREMENT_ENTRY,
      statement:
        'The first release section of CHANGELOG.md below any [Unreleased] section is headed "## [X.Y.Z]" for the version in VERSION, optionally followed by " - YYYY-MM-DD", and lists at least one change as a "- " bullet.',
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: REQUIREMENT_SCOPE,
      statement:
        "VERSION and CHANGELOG.md are both changed, and they are the only changed paths in the workspace (excluding Git metadata).",
      evidenceSchema: "workspace-manifest-v1",
    },
    {
      id: REQUIREMENT_REVIEW,
      statement:
        "An independent read-only reviewer approves that VERSION and the new CHANGELOG.md entry match the requested release.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: REQUIREMENT_VERSION, validatorId: "semver-file", version: "1" },
    { requirementId: REQUIREMENT_ENTRY, validatorId: "changelog-entry", version: "1" },
    { requirementId: REQUIREMENT_SCOPE, validatorId: "release-scope", version: "1" },
    {
      requirementId: REQUIREMENT_REVIEW,
      validatorId: "independent-reviewer",
      version: "1",
      independence: "separate-reviewer",
    },
  ],
};

export function createGraph(): GraphPlugin {
  return {
    describe: () => JSON.parse(JSON.stringify(definition)) as GraphDefinition,
    advance: advanceRelease,
  };
}

export function advanceRelease(view: RunView): GraphDecision {
  const version = requestedVersion(view.task.request);
  if (version === undefined) {
    return stop(
      { reason: "incompatible task", blocker: "the request names no MAJOR.MINOR.PATCH version to release", retryable: false },
      "reject a request without a release version",
    );
  }
  const stage = definition.stages.find(
    (s) =>
      !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) ||
      view.openAttempt?.[s.id] === true,
  );
  if (stage === undefined) {
    return stop({ reason: "complete", blocker: "none" }, "every stage has valid receipts");
  }
  const prior = readPrivate(view);
  // The first decision since the operator's latest resume (each decision records its generation).
  const resumed = view.resume !== undefined && prior.generation < view.resume.generation;
  const state = enterStage(prior, stage.id, view.generation);
  return stage.id === REVIEW_STAGE ? advanceReview(view, state, version) : advanceWork(view, state, version, resumed);
}

function advanceWork(view: RunView, state: ReleasePrivateState, version: string, resumed: boolean): GraphDecision {
  const stageId = state.stageId;
  // A resume retries what failed (design-typescript-core.md §8): a writer
  // whose last run failed before the operator's latest resume runs again,
  // rather than having the files it never wrote observed and validated.
  if (!state.dispatched || (resumed && failedBeforeResume(view, stageId))) {
    return dispatchAgent(
      view,
      workJob(stageId, workInstruction(stageId, view.task.request, version, state.feedback)),
      `dispatch the ${stageId} writer`,
      { ...state, dispatched: true, observed: false, ran: addOnce(state.ran, stageId) },
    );
  }
  if (!state.observed) {
    return withPrivate(
      observe(
        { paths: stageId === BUMP_STAGE ? [VERSION_PATH] : [VERSION_PATH, CHANGELOG_PATH], includeWorkspaceManifest: true },
        `observe the ${stageId} result`,
      ),
      { ...state, observed: true },
    );
  }

  const requirementIds = definition.stages.find((s) => s.id === stageId)!.requirementIds;
  const evidence = currentEvidence(view);
  const results = requirementIds.map((id) => evaluate(id, evidence));
  if (results.every((r) => r.status === "passed")) {
    return withPrivate(validate({ stageId, requirementIds }, `validate ${stageId} from the observed files`), state);
  }
  const failure = results.find((r) => r.status === "failed");
  if (failure && state.corrections < MAX_STAGE_CORRECTIONS && view.budgets.corrections > 0) {
    return dispatchAgent(
      view,
      workJob(stageId, [`The previous attempt failed validation: ${failure.reason}`, workInstruction(stageId, view.task.request, version)].join("\n")),
      `correct the ${stageId} result`,
      { ...state, observed: false, corrections: state.corrections + 1 },
    );
  }
  const reason = (failure ?? results.find((r) => r.status !== "passed"))!.reason;
  return supervise(
    { reason: `${stageId} ${failure ? "still fails validation" : "cannot be validated"}: ${reason}`, evidenceRefs: evidence.map((e) => e.ref) },
    `escalate the ${stageId} stage`,
    JSON.stringify(state),
  );
}

function advanceReview(view: RunView, state: ReleasePrivateState, version: string): GraphDecision {
  if (!state.dispatched) {
    return dispatchAgent(
      view,
      {
        stageId: REVIEW_STAGE,
        kind: "agent",
        purpose: "review",
        instruction: reviewInstruction(view.task.request, version),
        resultSchema: "review-verdict-v1",
        readOnly: true,
      },
      "dispatch an independent read-only reviewer",
      { ...state, dispatched: true },
    );
  }
  const evidence = currentEvidence(view);
  const review = latestReview(evidence);
  if (review?.verdict === "approved") {
    return withPrivate(validate({ stageId: REVIEW_STAGE, requirementIds: [REQUIREMENT_REVIEW] }, "validate the approved release"), state);
  }
  if (review?.verdict === "request_changes" && view.budgets.corrections > 0) {
    const summary = review.summary ?? "the reviewer requested changes";
    return withPrivate(
      reenter(
        { stageId: CHANGELOG_STAGE, reason: summary, evidenceRefs: evidence.filter((e) => e.kind === "review").map((e) => e.ref) },
        "rewrite the changelog entry with the reviewer's request",
      ),
      {
        ...state,
        stageId: CHANGELOG_STAGE,
        dispatched: false,
        observed: false,
        corrections: 0,
        feedback: summary,
      },
    );
  }
  return supervise(
    { reason: review ? `reviewer requested changes with no correction budget left: ${review.summary ?? ""}` : "the reviewer returned no verdict", evidenceRefs: evidence.map((e) => e.ref) },
    "escalate the review stage",
    JSON.stringify(state),
  );
}

/** The stage's last work job failed before the latest resume, and nothing of the stage was recorded since. */
function failedBeforeResume(view: RunView, stageId: string): boolean {
  let last = view.evidence.length - 1;
  while (last >= 0) {
    const failure = executorFailureOf(view.evidence[last]!);
    if (failure?.stageId === stageId && failure.purpose === "work") break;
    last -= 1;
  }
  if (last < 0 || !isStaleFailure(view.evidence[last]!, view)) return false;
  return !view.evidence.slice(last + 1).some((e) => e.kind === "file" || e.kind === "workspace");
}

/** Carry the state into `stageId` at `generation`, resetting what no longer holds. */
function enterStage(state: ReleasePrivateState, stageId: string, generation: number): ReleasePrivateState {
  if (state.stageId !== stageId) {
    const { feedback: _dropped, ...rest } = state;
    return {
      ...rest,
      stageId,
      generation,
      dispatched: stageId !== REVIEW_STAGE && state.ran.includes(stageId),
      observed: false,
      corrections: 0,
    };
  }
  if (state.generation !== generation) {
    // Earlier observations and verdicts are stale in a new generation.
    return { ...state, generation, observed: false, ...(stageId === REVIEW_STAGE ? { dispatched: false } : {}) };
  }
  return state;
}

function evaluate(requirementId: string, evidence: EvidenceRecord[]): ValidationResult {
  const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
  const statement = definition.requirements.find((r) => r.id === requirementId)!.statement;
  return validatorById(binding.validatorId)!.evaluate({ requirementId, statement, evidence });
}

function currentEvidence(view: RunView): EvidenceRecord[] {
  return view.evidence.filter((e) => e.candidateDigest === undefined || e.candidateDigest === view.candidateDigest);
}

export function requestedVersion(request: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(request)?.[1];
}

function workJob(stageId: string, instruction: string): JobSpec {
  return {
    stageId,
    kind: "agent",
    purpose: "work",
    instruction,
    resultSchema: "writer-result-v1",
    writeScope: [stageId === BUMP_STAGE ? VERSION_PATH : CHANGELOG_PATH],
  };
}

function workInstruction(stageId: string, request: string, version: string, feedback?: string): string {
  const lines =
    stageId === BUMP_STAGE
      ? [request.trim(), `Write ${VERSION_PATH} containing exactly ${JSON.stringify(`${version}\n`)}.`]
      : [
          request.trim(),
          `Add a section for ${version} to ${CHANGELOG_PATH} (create the file if it is missing), below any "## [Unreleased]" section and above older releases.`,
          `Head it "## [${version}] - YYYY-MM-DD" with today's date, and list the changes as "- " bullets.`,
          ...(feedback !== undefined ? [`An independent reviewer asked for changes: ${feedback}`] : []),
        ];
  return [...lines, "Do not modify any other paths."].join("\n");
}

function reviewInstruction(request: string, version: string): string {
  return [
    "You are an independent read-only reviewer.",
    "Do not modify the workspace.",
    `Confirm ${VERSION_PATH} holds ${version} and that the ${version} section of ${CHANGELOG_PATH} accurately describes the requested release.`,
    `Task: ${request.trim()}`,
    'Return verdict "approved" or "request_changes" with a short summary.',
  ].join("\n");
}

function readPrivate(view: RunView): ReleasePrivateState {
  const blank: ReleasePrivateState = {
    stageId: BUMP_STAGE,
    generation: view.generation,
    dispatched: false,
    observed: false,
    corrections: 0,
    ran: [],
  };
  if (!view.privateState) return blank;
  try {
    return { ...blank, ...(JSON.parse(view.privateState) as Partial<ReleasePrivateState>) };
  } catch {
    return blank;
  }
}

function addOnce(list: string[], item: string): string[] {
  return list.includes(item) ? list : [...list, item];
}

/** Only agent work spends an invocation; observing and validating stay open after the last one. */
function dispatchAgent(view: RunView, job: JobSpec, summary: string, state: ReleasePrivateState): GraphDecision {
  if (view.budgets.agentInvocations <= 0) {
    return stop({ reason: "budgets exhausted", blocker: "no agent invocations left", retryable: false }, `cannot ${summary}`);
  }
  return withPrivate(dispatch(job, summary), state);
}

function withPrivate(decision: GraphDecision, state: ReleasePrivateState): GraphDecision {
  return { ...decision, privateState: JSON.stringify(state) };
}
