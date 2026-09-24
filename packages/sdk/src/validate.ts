import { PROTOCOL_VERSION, type GraphAction, type GraphDecision, type GraphDefinition, type RunView, type ValidationInput, type ValidationResult, type WireRequest, type WireResponse } from "./types.js";

const MAX_WIRE_BYTES = 1_000_000;
const VALIDATION_STATUSES = new Set(["passed", "failed", "inconclusive"]);

export class WireValidationError extends Error {
  readonly code: "malformed" | "stale" | "oversized" | "unknown";

  constructor(code: WireValidationError["code"], message: string) {
    super(message);
    this.name = "WireValidationError";
    this.code = code;
  }
}

export function parseJsonBounded(raw: string, maxBytes = MAX_WIRE_BYTES): unknown {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new WireValidationError("oversized", `payload exceeds ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new WireValidationError("malformed", "payload is not valid JSON");
  }
}

export function assertWireRequest(value: unknown): WireRequest {
  const obj = asObject(value, "request");
  assertProtocol(obj);
  requireString(obj, "runId");
  requireString(obj, "operationId");
  requireNumber(obj, "generation");
  requireNumber(obj, "expectedStateRevision");
  requireString(obj, "activeVersion");
  const kind = requireString(obj, "kind");
  switch (kind) {
    case "describe":
      return obj as unknown as WireRequest;
    case "advance":
      assertRunView(obj["view"]);
      return obj as unknown as WireRequest;
    case "evaluate":
      requireString(obj, "validatorId");
      assertValidationInput(obj["input"]);
      return obj as unknown as WireRequest;
    default:
      throw new WireValidationError("unknown", `unknown request kind: ${kind}`);
  }
}

export function assertWireResponse(value: unknown): WireResponse {
  const obj = asObject(value, "response");
  assertProtocol(obj);
  requireString(obj, "runId");
  requireString(obj, "operationId");
  requireNumber(obj, "generation");
  requireNumber(obj, "expectedStateRevision");
  requireString(obj, "activeVersion");
  const kind = requireString(obj, "kind");
  switch (kind) {
    case "describe_ok":
      assertGraphDefinition(obj["definition"]);
      return obj as unknown as WireResponse;
    case "advance_ok":
      assertGraphDecision(obj["decision"]);
      return obj as unknown as WireResponse;
    case "evaluate_ok":
      assertValidationResult(obj["result"]);
      return obj as unknown as WireResponse;
    case "error":
      requireString(obj, "code");
      requireString(obj, "message");
      return obj as unknown as WireResponse;
    default:
      throw new WireValidationError("unknown", `unknown response kind: ${kind}`);
  }
}

export function assertValidationInput(value: unknown): ValidationInput {
  const obj = asObject(value, "input");
  requireString(obj, "requirementId");
  requireString(obj, "statement");
  const evidence = requireArray(obj, "evidence");
  for (const item of evidence) {
    const e = asObject(item, "evidence");
    requireString(e, "ref");
    requireString(e, "kind");
    requireNumber(e, "generation");
  }
  if (obj["candidateFingerprint"] !== undefined && typeof obj["candidateFingerprint"] !== "string") {
    throw new WireValidationError("malformed", "candidateFingerprint must be a string");
  }
  return obj as unknown as ValidationInput;
}

export function assertValidationResult(value: unknown): ValidationResult {
  const obj = asObject(value, "result");
  const status = requireString(obj, "status");
  if (!VALIDATION_STATUSES.has(status)) {
    throw new WireValidationError("malformed", `invalid validation status: ${status}`);
  }
  requireString(obj, "reason");
  if (obj["evidenceRefs"] !== undefined) {
    const refs = requireArray(obj, "evidenceRefs");
    for (const ref of refs) {
      if (typeof ref !== "string" || ref.length === 0) {
        throw new WireValidationError("malformed", "evidenceRefs must be non-empty strings");
      }
    }
  }
  return obj as unknown as ValidationResult;
}

export function assertGraphDefinition(value: unknown): GraphDefinition {
  const obj = asObject(value, "definition");
  requireString(obj, "graphId");
  requireString(obj, "version");
  const stages = requireArray(obj, "stages");
  const requirements = requireArray(obj, "requirements");
  requireArray(obj, "defaultValidators");
  if (stages.length === 0) {
    throw new WireValidationError("malformed", "definition.stages must be non-empty");
  }
  for (const stage of stages) {
    const s = asObject(stage, "stage");
    requireString(s, "id");
    requireString(s, "name");
    requireArray(s, "requirementIds");
  }
  for (const req of requirements) {
    const r = asObject(req, "requirement");
    requireString(r, "id");
    requireString(r, "statement");
    requireString(r, "evidenceSchema");
  }
  return obj as unknown as GraphDefinition;
}

export function assertGraphDecision(value: unknown): GraphDecision {
  const obj = asObject(value, "decision");
  requireString(obj, "reason");
  assertGraphAction(obj["action"]);
  return obj as unknown as GraphDecision;
}

export function assertGraphAction(value: unknown): GraphAction {
  const obj = asObject(value, "action");
  const type = requireString(obj, "type");
  const allowed = new Set([
    "dispatch",
    "observe",
    "validate",
    "reenter",
    "supervise",
    "qualify_repair",
    "activate_repair",
    "return",
    "stop",
  ]);
  if (!allowed.has(type)) {
    throw new WireValidationError("malformed", `unsupported action type: ${type}`);
  }
  if (type === "accept") {
    throw new WireValidationError("malformed", "Accept is not a plugin/supervisor action");
  }
  return obj as unknown as GraphAction;
}

export function assertRunView(value: unknown): RunView {
  const obj = asObject(value, "view");
  requireString(obj, "runId");
  asObject(obj["task"], "task");
  asObject(obj["current"], "current");
  requireArray(obj, "receipts");
  requireArray(obj, "evidence");
  requireArray(obj, "outstanding");
  asObject(obj["budgets"], "budgets");
  requireArray(obj, "validatorBindings");
  requireNumber(obj, "generation");
  requireNumber(obj, "stateRevision");
  requireString(obj, "activeVersion");
  return obj as unknown as RunView;
}

function assertProtocol(obj: Record<string, unknown>): void {
  const v = obj["protocolVersion"];
  if (v !== PROTOCOL_VERSION) {
    throw new WireValidationError(
      "malformed",
      `protocolVersion must be ${PROTOCOL_VERSION}, got ${String(v)}`,
    );
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireValidationError("malformed", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new WireValidationError("malformed", `${key} must be a non-empty string`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WireValidationError("malformed", `${key} must be a finite number`);
  }
  return v;
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new WireValidationError("malformed", `${key} must be an array`);
  }
  return v;
}
