import type { GraphRehearsal, RehearsalExpectation, RehearsalReply, RehearsalScenario } from "./rehearsal.js";
import { PROTOCOL_VERSION, type GraphAction, type GraphDecision, type GraphDefinition, type RunView, type ValidationInput, type ValidationResult, type WireRequest, type WireResponse } from "./types.js";

/**
 * A run's RunView grows with its evidence (command stdout/stderr tails, file
 * snapshots, issue bodies); a long-lived graph legitimately passes several MB
 * of advance() input well before any run is actually pathological. This stays
 * a sanity bound against a runaway/looping plugin, not a tight protocol limit.
 */
const MAX_WIRE_BYTES = 16_000_000;
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
    case "rehearsal":
      requireString(obj, "entry");
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
    case "rehearsal_ok":
      if (obj["rehearsal"] !== undefined) assertGraphRehearsal(obj["rehearsal"]);
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
  const records = [...requireArray(obj, "evidence")];
  if (obj["history"] !== undefined) records.push(...requireArray(obj, "history"));
  for (const item of records) {
    const e = asObject(item, "evidence");
    requireString(e, "ref");
    requireString(e, "kind");
    requireNumber(e, "generation");
  }
  if (obj["candidateFingerprint"] !== undefined && typeof obj["candidateFingerprint"] !== "string") {
    throw new WireValidationError("malformed", "candidateFingerprint must be a string");
  }
  if (obj["candidateDigest"] !== undefined && typeof obj["candidateDigest"] !== "string") {
    throw new WireValidationError("malformed", "candidateDigest must be a string");
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

const REHEARSAL_STATUSES = new Set(["succeeded", "stopped"]);
const REHEARSAL_FAILURE_KINDS = new Set(["no-result", "exit", "hang"]);

/**
 * A bundle's rehearsal entry is imported inside the already-isolated plugin
 * child (worker.ts), never the CLI process directly — the same sandbox
 * `createGraph` gets, since it is the same untrusted bundle code. This
 * validates the `GraphRehearsal` the wire protocol carries back, loosely
 * matching `assertGraphDefinition`'s rigor: enough to stop a malformed
 * export from corrupting the parent's own assumptions, not a re-check of
 * every reply's `output` shape (validateResultShape already does that
 * against the plugin's own declared contracts, downstream).
 */
export function assertGraphRehearsal(value: unknown): GraphRehearsal {
  const obj = asObject(value, "rehearsal");
  const scenarios = asObject(obj["scenarios"], "rehearsal.scenarios");
  for (const [name, raw] of Object.entries(scenarios)) {
    assertRehearsalScenario(raw, `rehearsal.scenarios[${JSON.stringify(name)}]`);
  }
  return obj as unknown as GraphRehearsal;
}

function assertRehearsalScenario(value: unknown, label: string): RehearsalScenario {
  const obj = asObject(value, label);
  const results = asObject(obj["results"], `${label}.results`);
  for (const name of Object.keys(results)) {
    requireArray(results, name).forEach((reply, i) => assertRehearsalReply(reply, `${label}.results[${JSON.stringify(name)}][${i}]`));
  }
  if (obj["commands"] !== undefined) asObject(obj["commands"], `${label}.commands`);
  if (obj["reads"] !== undefined) asObject(obj["reads"], `${label}.reads`);
  if (obj["supervisor"] !== undefined) {
    for (const decision of requireArray(obj, "supervisor")) assertGraphDecision(decision);
  }
  if (obj["budgets"] !== undefined) asObject(obj["budgets"], `${label}.budgets`);
  assertRehearsalExpectation(obj["expect"], `${label}.expect`);
  return obj as unknown as RehearsalScenario;
}

function assertRehearsalReply(value: unknown, label: string): RehearsalReply {
  const obj = asObject(value, label);
  if (obj["effects"] !== undefined) {
    for (const [i, effect] of requireArray(obj, "effects").entries()) {
      const e = asObject(effect, `${label}.effects[${i}]`);
      requireString(e, "path");
      requireString(e, "bytes");
    }
  }
  if (obj["harnessSupplied"] !== undefined) {
    for (const name of requireArray(obj, "harnessSupplied")) {
      if (typeof name !== "string") throw new WireValidationError("malformed", `${label}.harnessSupplied must be strings`);
    }
  }
  if (obj["fail"] !== undefined) {
    const fail = asObject(obj["fail"], `${label}.fail`);
    const kind = requireString(fail, "kind");
    if (!REHEARSAL_FAILURE_KINDS.has(kind)) throw new WireValidationError("malformed", `${label}.fail.kind must be one of ${[...REHEARSAL_FAILURE_KINDS].join(", ")}`);
  }
  return obj as unknown as RehearsalReply;
}

function assertRehearsalExpectation(value: unknown, label: string): RehearsalExpectation {
  const obj = asObject(value, label);
  const status = requireString(obj, "status");
  if (!REHEARSAL_STATUSES.has(status)) throw new WireValidationError("malformed", `${label}.status must be one of ${[...REHEARSAL_STATUSES].join(", ")}`);
  if (obj["receipts"] !== undefined) requireArray(obj, "receipts");
  if (obj["recovery"] !== undefined) requireArray(obj, "recovery");
  return obj as unknown as RehearsalExpectation;
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
  if (obj["environment"] !== undefined) assertEnvironment(obj["environment"]);
  if (obj["resultContracts"] !== undefined) assertResultContracts(obj["resultContracts"]);
  return obj as unknown as GraphDefinition;
}

const EVIDENCE_KINDS = new Set(["file", "command", "workspace", "review", "other"]);

/** Defense in depth for a crashed or malformed plugin process: the controller never trusts this shape, only compares strings inside it. */
function assertResultContracts(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new WireValidationError("malformed", "resultContracts must be an array");
  }
  value.forEach((raw, i) => {
    const label = `resultContracts[${i}]`;
    const c = asObject(raw, label);
    requireString(c, "name");
    asObject(c["schema"], `${label}.schema`);
    if (!EVIDENCE_KINDS.has(c["evidenceKind"] as string)) {
      throw new WireValidationError("malformed", `${label}.evidenceKind must be one of ${[...EVIDENCE_KINDS].join(", ")}`);
    }
    if (c["references"] !== undefined) {
      requireArray(c, "references").forEach((ref, j) => {
        if (typeof ref !== "string" || ref.length === 0) {
          throw new WireValidationError("malformed", `${label}.references[${j}] must be a non-empty string`);
        }
      });
    }
  });
}

const ENVIRONMENT_COMMAND_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function assertEnvironment(value: unknown): void {
  const env = asObject(value, "environment");
  const ids = new Set<string>();
  for (const key of ["checks", "prepare"]) {
    if (env[key] === undefined) continue;
    requireArray(env, key).forEach((raw, i) => {
      const label = `environment.${key}[${i}]`;
      const c = asObject(raw, label);
      const id = requireString(c, "id");
      if (!ENVIRONMENT_COMMAND_ID.test(id) || ids.has(id)) {
        throw new WireValidationError("malformed", `${label}.id must be a unique name of letters, digits, ".", "_" or "-"`);
      }
      ids.add(id);
      const argv = requireArray(c, "argv");
      if (argv.length === 0 || !argv.every((a) => typeof a === "string") || (argv[0] as string).length === 0) {
        throw new WireValidationError("malformed", `${label}.argv must be a non-empty array of strings`);
      }
      if (c["timeoutMs"] !== undefined && (typeof c["timeoutMs"] !== "number" || !Number.isSafeInteger(c["timeoutMs"]) || c["timeoutMs"] < 1)) {
        throw new WireValidationError("malformed", `${label}.timeoutMs must be a positive integer`);
      }
    });
  }
  if (ids.size > 16) throw new WireValidationError("malformed", "environment declares more than 16 commands");
  if (env["pinnedFiles"] !== undefined) {
    requireArray(env, "pinnedFiles").forEach((raw, i) => {
      const label = `environment.pinnedFiles[${i}]`;
      const f = asObject(raw, label);
      const file = requireString(f, "path");
      if (file.startsWith("/") || file.split("/").includes("..")) {
        throw new WireValidationError("malformed", `${label}.path must stay inside the repository`);
      }
      if (!SHA256.test(requireString(f, "sha256"))) {
        throw new WireValidationError("malformed", `${label}.sha256 must be a lowercase hex SHA-256`);
      }
    });
  }
}

export function assertGraphDecision(value: unknown): GraphDecision {
  const obj = asObject(value, "decision");
  requireString(obj, "reason");
  assertGraphAction(obj["action"]);
  const evidence = obj["evidence"];
  if (evidence !== undefined && (!Array.isArray(evidence) || !evidence.every((e) => typeof e === "string"))) {
    throw new WireValidationError("malformed", "decision.evidence must be an array of strings");
  }
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
  const key = ACTION_SPEC_KEYS[type]!;
  const spec = obj[key];
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new WireValidationError("malformed", `${type} action needs a ${key} object`);
  }
  return obj as unknown as GraphAction;
}

/** The property that holds each action type's spec. */
export const ACTION_SPEC_KEYS: Record<string, string> = {
  dispatch: "job",
  observe: "observe",
  validate: "validate",
  reenter: "reenter",
  supervise: "supervise",
  qualify_repair: "qualify",
  activate_repair: "activate",
  return: "return",
  stop: "stop",
};

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
  if (obj["agentSessions"] !== undefined) assertAgentSessions(requireArray(obj, "agentSessions"));
  if (obj["repairAuthority"] !== undefined) assertRepairAuthority(obj["repairAuthority"]);
  return obj as unknown as RunView;
}

function assertRepairAuthority(value: unknown): void {
  const authority = asObject(value, "repairAuthority");
  if (authority["contract"] !== "source-repairable" && authority["contract"] !== "opaque") {
    throw new WireValidationError("malformed", "repairAuthority.contract must be source-repairable or opaque");
  }
  const grants = asObject(authority["grants"], "repairAuthority.grants");
  for (const key of ["sourceRepair", "validatorSubstitution", "executorRepair"]) {
    if (typeof grants[key] !== "boolean") {
      throw new WireValidationError("malformed", `repairAuthority.grants.${key} must be boolean`);
    }
  }
}

const SESSION_STATUSES = ["ok", "failed", "conflict"];

/** A graph picks `continueFrom` from these entries, so each must be well formed. */
function assertAgentSessions(sessions: unknown[]): void {
  sessions.forEach((raw, i) => {
    const s = asObject(raw, `agentSessions[${i}]`);
    for (const key of ["operationId", "stageId", "dispatchKey", "executorId"]) requireString(s, key);
    requireNumber(s, "attempt");
    requireNumber(s, "generation");
    if (!SESSION_STATUSES.includes(s["status"] as string)) {
      throw new WireValidationError("malformed", `agentSessions[${i}].status must be one of ${SESSION_STATUSES.join(", ")}`);
    }
    if (s["continuedFrom"] !== undefined) requireString(s, "continuedFrom");
  });
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
