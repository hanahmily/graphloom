import {
  dispatch,
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
  exactGreetingValidator,
  independentReviewValidator,
  type FileBytesPayload,
  type ReviewVerdictPayload,
  type WorkspaceManifestPayload,
} from "./validators.js";

export interface HelloPrivateState {
  writeCorrections: number;
  writerDispatched: boolean;
  observedWrite: boolean;
  reviewerDispatched: boolean;
}

const definition: GraphDefinition = {
  graphId: "hello",
  version: "0.1.0",
  privateStateSchema: "hello-private-v1",
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
      { reason: "budgets exhausted", blocker: "finite limits reached" },
      "cannot continue without budget",
    );
  }

  if (!isCompatibleGreetingTask(view.task.request)) {
    return stop(
      {
        reason: "incompatible task",
        blocker: "request is not a GREETING.txt hello exercise",
      },
      "reject unrelated request",
    );
  }

  const state = readPrivate(view);
  const writeOk = validReceipt(view, WRITE_STAGE);
  const reviewOk = validReceipt(view, REVIEW_STAGE);

  if (reviewOk && writeOk) {
    return stop(
      { reason: "complete", blocker: "none" },
      "Write and Review receipts present — host completes the run",
    );
  }

  if (!writeOk) {
    return advanceWrite(view, state);
  }
  return advanceReview(view, state);
}

function advanceWrite(view: RunView, state: HelloPrivateState): GraphDecision {
  const file = latestPayload<FileBytesPayload>(view, "file");
  const manifest = latestPayload<WorkspaceManifestPayload>(view, "workspace");

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

  if (!file || !manifest) {
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
    if (state.writeCorrections < MAX_KNOWN_WRITE_CORRECTIONS) {
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
          writeCorrections: state.writeCorrections + 1,
          writerDispatched: true,
          observedWrite: false,
          reviewerDispatched: false,
        },
      );
    }
    return supervise(
      {
        reason: `write defect after ${state.writeCorrections} corrections: ${check.reason}`,
        evidenceRefs: view.evidence.map((e) => e.ref),
      },
      "escalate repeated write failure",
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
  const review = latestPayload<ReviewVerdictPayload>(view, "review");

  if (!state.reviewerDispatched && !review) {
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
      { reason: "reviewer dispatched but no verdict evidence" },
      "unfamiliar review-stage state",
      serializePrivate(state),
    );
  }

  const check = independentReviewValidator.evaluate({
    requirementId: REQUIREMENT_REVIEW,
    statement: definition.requirements[1]!.statement,
    evidence: view.evidence,
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
          evidenceRefs: view.evidence.filter((e) => e.kind === "review").map((e) => e.ref),
        },
        "review request_changes — reenter Write",
      ),
      {
        writeCorrections: state.writeCorrections,
        writerDispatched: false,
        observedWrite: false,
        reviewerDispatched: false,
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

function latestPayload<T>(view: RunView, kind: string): T | undefined {
  for (let i = view.evidence.length - 1; i >= 0; i -= 1) {
    const ev = view.evidence[i];
    if (ev && ev.kind === kind && ev.payload !== undefined) {
      return ev.payload as T;
    }
  }
  return undefined;
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
  };
}

function serializePrivate(state: HelloPrivateState): string {
  return JSON.stringify(state);
}

function withPrivate(decision: GraphDecision, state: HelloPrivateState): GraphDecision {
  return { ...decision, privateState: serializePrivate(state) };
}
