import type { ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { GREETING_BYTES, GREETING_PATH } from "./constants.js";

export interface FileBytesPayload {
  path: string;
  bytes: string;
}

export interface WorkspaceManifestPayload {
  changedPaths: string[];
}

export interface ReviewVerdictPayload {
  verdict: "approved" | "request_changes";
  summary?: string;
}

/** Exact greeting bytes and sole-path scope from controller observations. */
export const exactGreetingValidator: Validator = {
  evaluate(input: ValidationInput): ValidationResult {
    const file = findPayload<FileBytesPayload>(input, "file");
    const manifest = findPayload<WorkspaceManifestPayload>(input, "workspace");
    if (!file || !manifest) {
      return {
        status: "inconclusive",
        reason: "missing file bytes and/or workspace change manifest",
      };
    }
    if (file.path !== GREETING_PATH) {
      return {
        status: "failed",
        reason: `expected path ${GREETING_PATH}, observed ${file.path}`,
      };
    }
    if (file.bytes !== GREETING_BYTES) {
      return {
        status: "failed",
        reason: "GREETING.txt bytes do not match the required greeting",
      };
    }
    const extras = manifest.changedPaths.filter((p) => p !== GREETING_PATH);
    if (extras.length > 0 || !manifest.changedPaths.includes(GREETING_PATH)) {
      return {
        status: "failed",
        reason:
          extras.length > 0
            ? `unrelated paths changed: ${extras.join(", ")}`
            : `${GREETING_PATH} missing from change manifest`,
      };
    }
    return {
      status: "passed",
      reason: "exact greeting bytes and sole-path scope",
    };
  },
};

/** Independent reviewer verdict — does not trust the writer. */
export const independentReviewValidator: Validator = {
  evaluate(input: ValidationInput): ValidationResult {
    const review = findPayload<ReviewVerdictPayload>(input, "review");
    if (!review) {
      return { status: "inconclusive", reason: "missing review verdict evidence" };
    }
    if (review.verdict === "approved") {
      return { status: "passed", reason: review.summary ?? "reviewer approved" };
    }
    if (review.verdict === "request_changes") {
      return {
        status: "failed",
        reason: review.summary ?? "reviewer requested changes",
      };
    }
    return { status: "inconclusive", reason: "unrecognized review verdict" };
  },
};

export function validatorById(id: string): Validator | undefined {
  switch (id) {
    case "exact-greeting":
      return exactGreetingValidator;
    case "independent-reviewer":
      return independentReviewValidator;
    default:
      return undefined;
  }
}

function findPayload<T>(input: ValidationInput, kind: string): T | undefined {
  for (const ev of input.evidence) {
    if (ev.kind === kind && ev.payload !== undefined) {
      return ev.payload as T;
    }
  }
  return undefined;
}
