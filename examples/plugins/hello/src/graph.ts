// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import {
  dispatch,
  executorFailureOf,
  isStaleFailure,
  observe,
  reenter,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type RunView,
} from "@graphloom/sdk";
import {
  GREETING_BYTES,
  GREETING_PATH,
  MAX_KNOWN_WRITE_CORRECTIONS,
  REQUIREMENT_GREETING,
  REQUIREMENT_REVIEW,
  REVIEW_STAGE,
  WRITE_STAGE,
} from "./constants.js";
import {
  asFileBytesPayload,
  asReviewVerdictPayload,
  asWorkspaceManifestPayload,
  exactGreetingValidator,
  independentReviewValidator,
  latestEvidencePayload,
  type FileBytesPayload,
  type ReviewVerdictPayload,
  type WorkspaceManifestPayload,
} from "./validators.js";

export interface HelloPrivateState {
  writeCorrections: number;
  writerDispatched: boolean;
  observedWrite: boolean;
  reviewerDispatched: boolean;
  /** Evidence length at last Write reentry — older review verdicts are ignored. */
  reviewEvidenceFromIndex: number;
}

/**
 * The writer has nothing to say beyond "I wrote it" — the controller's own
 * Observe confirms the bytes — so its contract accepts any object the model
 * submits. Declaring one at all still gets the job a real, enforced shape
 * (an object) instead of no constraint whatsoever.
 */
const WRITER_RESULT_SCHEMA: Record<string, unknown> = { type: "object" };

/** What today's cli-runner.ts hardcoded as REVIEW_SCHEMA; the schema is hello's own, not the composition root's. */
const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { axis: { type: "string" }, severity: { type: "string" }, detail: { type: "string" } },
        required: ["detail"],
        additionalProperties: false,
      },
    },
    productDecision: { type: "string" },
  },
  required: ["verdict", "summary"],
  additionalProperties: false,
};

const definition: GraphDefinition = {
  graphId: "hello",
  version: "0.1.1",
  privateStateSchema: "hello-private-v1",
  resultContracts: [
    { name: "writer-result-v1", schema: WRITER_RESULT_SCHEMA, evidenceKind: "other" },
    { name: "review-verdict-v1", schema: REVIEW_SCHEMA, evidenceKind: "review" },
  ],
  stages: [
    {
      id: WRITE_STAGE,
      name: "Write",
      requirementIds: [REQUIREMENT_GREETING],
    },
    {
      id: REVIEW_STAGE,
      name: "Review",
      requirementIds: [REQUIREMENT_REVIEW],
    },
  ],
  requirements: [
    {
      id: REQUIREMENT_GREETING,
      statement:
        "GREETING.txt contains exactly the UTF-8 bytes Hello, GraphLoom!\\n and is the only changed path in the workspace (excluding Git metadata).",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: REQUIREMENT_REVIEW,
      statement:
        "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    {
      requirementId: REQUIREMENT_GREETING,
      validatorId: "exact-greeting",
      version: "1",
    },
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
    describe(): GraphDefinition {
      return structuredClone(definition);
    },
    advance(view: RunView): GraphDecision {
      return advanceHello(view);
    },
  };
}

export function advanceHello(view: RunView): GraphDecision {
  if (view.budgets.corrections <= 0 && view.budgets.agentInvocations <= 0) {
    return stop(
      { reason: "budgets exhausted", blocker: "finite limits reached", retryable: false },
      "cannot continue without budget",
    );
  }

  if (!isCompatibleGreetingTask(view.task.request)) {
    return stop(
      {
        reason: "incompatible task",
        blocker: "request is not a GREETING.txt hello exercise",
        retryable: false,
      },
      "reject unrelated request",
    );
  }

  const state = readPrivate(view);
  const writeOpen = !validReceipt(view, WRITE_STAGE) || view.openAttempt?.[WRITE_STAGE] === true;
  const reviewOpen = !validReceipt(view, REVIEW_STAGE) || view.openAttempt?.[REVIEW_STAGE] === true;

  if (!reviewOpen && !writeOpen) {
    return stop(
      { reason: "complete", blocker: "none" },
      "Write and Review receipts present — host completes the run",
    );
  }

  if (writeOpen) {
    return advanceWrite(view, state);
  }
  return advanceReview(view, state);
}

function advanceWrite(view: RunView, state: HelloPrivateState): GraphDecision {
  const file = typedLatest<FileBytesPayload>(view, "file", asFileBytesPayload);
  const manifest = typedLatest<WorkspaceManifestPayload>(
    view,
    "workspace",
    asWorkspaceManifestPayload,
  );

  if (!state.writerDispatched) {
    return withPrivate(
      dispatch(
        {
          stageId: WRITE_STAGE,
          kind: "agent",
          purpose: "work",
          instruction: writerInstruction(view.task.request),
          resultSchema: "writer-result-v1",
          writeScope: [GREETING_PATH],
        },
        "dispatch writer for GREETING.txt",
      ),
      { ...state, writerDispatched: true },
    );
  }

  // After a correction or Write reentry, observedWrite is cleared so we must
  // re-observe even when older file/workspace evidence is still on the view.
  if (!state.observedWrite || !file || !manifest) {
    return withPrivate(
      observe(
        { paths: [GREETING_PATH], includeWorkspaceManifest: true },
        "observe greeting bytes and workspace manifest",
      ),
      { ...state, observedWrite: true },
    );
  }

  const check = exactGreetingValidator.evaluate({
    requirementId: REQUIREMENT_GREETING,
    statement: definition.requirements[0]!.statement,
    evidence: view.evidence,
  });

  if (check.status === "passed") {
    return withPrivate(
      validate(
        { stageId: WRITE_STAGE, requirementIds: [REQUIREMENT_GREETING] },
        "schedule Write validation from observed evidence",
      ),
      state,
    );
  }

  if (check.status === "failed") {
    const underPluginCap = state.writeCorrections < MAX_KNOWN_WRITE_CORRECTIONS;
    const hasCorrectionBudget = view.budgets.corrections > 0;
    if (underPluginCap && hasCorrectionBudget) {
      return withPrivate(
        dispatch(
          {
            stageId: WRITE_STAGE,
            kind: "agent",
            purpose: "work",
            instruction: correctionInstruction(check.reason),
            resultSchema: "writer-result-v1",
            writeScope: [GREETING_PATH],
          },
          "known content/scope defect — dispatch correction",
        ),
        {
          ...state,
          writeCorrections: state.writeCorrections + 1,
          writerDispatched: true,
          observedWrite: false,
          reviewerDispatched: false,
        },
      );
    }
    return supervise(
      {
        reason: !hasCorrectionBudget
          ? `write defect with exhausted correction budget: ${check.reason}`
          : `write defect after ${state.writeCorrections} corrections: ${check.reason}`,
        evidenceRefs: view.evidence.map((e) => e.ref),
      },
      "escalate write failure",
      serializePrivate(state),
    );
  }

  return supervise(
    {
      reason: check.reason,
      evidenceRefs: view.evidence.map((e) => e.ref),
    },
    "inconclusive write evidence — supervise",
    serializePrivate(state),
  );
}

function advanceReview(view: RunView, state: HelloPrivateState): GraphDecision {
  const review = latestReviewSinceCutoff(view, state);
  // A resume retries what failed (design-typescript-core.md §8): a reviewer
  // that failed before the operator's latest resume runs again, while one
  // that failed since the resume goes to the supervisor.
  const reviewerFailures = view.evidence.slice(state.reviewEvidenceFromIndex).filter((e) => executorFailureOf(e)?.stageId === REVIEW_STAGE);
  const retryReviewer = reviewerFailures.length > 0 && reviewerFailures.every((e) => isStaleFailure(e, view));

  if ((!state.reviewerDispatched || retryReviewer) && !review) {
    return withPrivate(
      dispatch(
        {
          stageId: REVIEW_STAGE,
          kind: "agent",
          purpose: "review",
          instruction: reviewerInstruction(view.task.request),
          resultSchema: "review-verdict-v1",
          readOnly: true,
        },
        "dispatch independent read-only reviewer",
      ),
      { ...state, reviewerDispatched: true },
    );
  }

  if (!review) {
    return supervise(
      { reason: "reviewer dispatched but no fresh verdict evidence" },
      "unfamiliar review-stage state",
      serializePrivate(state),
    );
  }

  const freshEvidence = freshReviewEvidence(view, state);
  const check = independentReviewValidator.evaluate({
    requirementId: REQUIREMENT_REVIEW,
    statement: definition.requirements[1]!.statement,
    evidence: freshEvidence,
  });

  if (check.status === "passed") {
    return withPrivate(
      validate(
        { stageId: REVIEW_STAGE, requirementIds: [REQUIREMENT_REVIEW] },
        "schedule Review validation from reviewer verdict",
      ),
      state,
    );
  }

  if (check.status === "failed" && review.verdict === "request_changes") {
    return withPrivate(
      reenter(
        {
          stageId: WRITE_STAGE,
          reason: check.reason,
          evidenceRefs: freshEvidence.filter((e) => e.kind === "review").map((e) => e.ref),
        },
        "review request_changes — reenter Write",
      ),
      {
        writeCorrections: state.writeCorrections,
        writerDispatched: false,
        observedWrite: false,
        reviewerDispatched: false,
        // Ignore all evidence through the current review when Write restarts.
        reviewEvidenceFromIndex: view.evidence.length,
      },
    );
  }

  return supervise(
    {
      reason: check.reason,
      evidenceRefs: view.evidence.map((e) => e.ref),
    },
    "unfamiliar review outcome — supervise",
    serializePrivate(state),
  );
}

function isCompatibleGreetingTask(request: string): boolean {
  const lower = request.toLowerCase();
  return lower.includes("greeting.txt") || lower.includes("hello, graphloom");
}

function writerInstruction(request: string): string {
  return [
    request.trim(),
    `Create ${GREETING_PATH} with exact UTF-8 bytes: ${JSON.stringify(GREETING_BYTES)}`,
    "Do not modify any other paths.",
  ].join("\n");
}

function correctionInstruction(reason: string): string {
  return [
    `Previous attempt failed validation: ${reason}`,
    `Rewrite ${GREETING_PATH} so it contains exactly ${JSON.stringify(GREETING_BYTES)}`,
    "Do not modify any other paths.",
  ].join("\n");
}

function reviewerInstruction(request: string): string {
  return [
    "You are an independent read-only reviewer.",
    "Do not modify the workspace.",
    `Confirm ${GREETING_PATH} matches the task and contains exactly ${JSON.stringify(GREETING_BYTES)}.`,
    `Task: ${request.trim()}`,
    'Return verdict "approved" or "request_changes" with a short summary.',
  ].join("\n");
}

function validReceipt(view: RunView, stageId: string): boolean {
  return view.receipts.some((r) => r.stageId === stageId && r.valid);
}

function typedLatest<T>(
  view: RunView,
  kind: string,
  guard: (value: unknown) => T | undefined,
): T | undefined {
  const raw = latestEvidencePayload(view.evidence, kind);
  if (raw === undefined) {
    return undefined;
  }
  return guard(raw);
}

function latestReviewSinceCutoff(
  view: RunView,
  state: HelloPrivateState,
): ReviewVerdictPayload | undefined {
  const slice = freshReviewEvidence(view, state);
  const raw = latestEvidencePayload(slice, "review");
  if (raw === undefined) {
    return undefined;
  }
  return asReviewVerdictPayload(raw);
}

function freshReviewEvidence(view: RunView, state: HelloPrivateState) {
  return view.evidence.slice(state.reviewEvidenceFromIndex).filter(
    (e) => e.candidateDigest === undefined || e.candidateDigest === view.candidateDigest,
  );
}

function readPrivate(view: RunView): HelloPrivateState {
  if (!view.privateState) {
    return blankPrivate();
  }
  try {
    const parsed = JSON.parse(view.privateState) as Partial<HelloPrivateState>;
    return {
      writeCorrections: parsed.writeCorrections ?? 0,
      writerDispatched: parsed.writerDispatched ?? false,
      observedWrite: parsed.observedWrite ?? false,
      reviewerDispatched: parsed.reviewerDispatched ?? false,
      reviewEvidenceFromIndex: parsed.reviewEvidenceFromIndex ?? 0,
    };
  } catch {
    return blankPrivate();
  }
}

function blankPrivate(): HelloPrivateState {
  return {
    writeCorrections: 0,
    writerDispatched: false,
    observedWrite: false,
    reviewerDispatched: false,
    reviewEvidenceFromIndex: 0,
  };
}

function serializePrivate(state: HelloPrivateState): string {
  return JSON.stringify(state);
}

function withPrivate(decision: GraphDecision, state: HelloPrivateState): GraphDecision {
  return { ...decision, privateState: serializePrivate(state) };
}
