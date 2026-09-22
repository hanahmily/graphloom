import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
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
    const fileRaw = latestEvidencePayload(input.evidence, "file");
    const manifestRaw = latestEvidencePayload(input.evidence, "workspace");
    if (fileRaw === undefined || manifestRaw === undefined) {
      return {
        status: "inconclusive",
        reason: "missing file bytes and/or workspace change manifest",
      };
    }
    const file = asFileBytesPayload(fileRaw);
    const manifest = asWorkspaceManifestPayload(manifestRaw);
    if (!file || !manifest) {
      return {
        status: "inconclusive",
        reason: "malformed file bytes and/or workspace change manifest",
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
    const reviewRaw = latestEvidencePayload(input.evidence, "review");
    if (reviewRaw === undefined) {
      return { status: "inconclusive", reason: "missing review verdict evidence" };
    }
    const review = asReviewVerdictPayload(reviewRaw);
    if (!review) {
      return { status: "inconclusive", reason: "malformed review verdict evidence" };
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

/** Newest matching evidence first. */
export function latestEvidencePayload(
  evidence: EvidenceRecord[],
  kind: string,
): unknown | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const ev = evidence[i];
    if (ev && ev.kind === kind && ev.payload !== undefined) {
      return ev.payload;
    }
  }
  return undefined;
}

export function asFileBytesPayload(value: unknown): FileBytesPayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.bytes !== "string") {
    return undefined;
  }
  return { path: obj.path, bytes: obj.bytes };
}

export function asWorkspaceManifestPayload(
  value: unknown,
): WorkspaceManifestPayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.changedPaths)) {
    return undefined;
  }
  if (!obj.changedPaths.every((p) => typeof p === "string")) {
    return undefined;
  }
  return { changedPaths: obj.changedPaths as string[] };
}

export function asReviewVerdictPayload(value: unknown): ReviewVerdictPayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (obj.verdict !== "approved" && obj.verdict !== "request_changes") {
    return undefined;
  }
  const out: ReviewVerdictPayload = { verdict: obj.verdict };
  if (obj.summary !== undefined) {
    if (typeof obj.summary !== "string") {
      return undefined;
    }
    out.summary = obj.summary;
  }
  return out;
}
