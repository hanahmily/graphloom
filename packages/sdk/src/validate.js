import { PROTOCOL_VERSION } from "./types.js";
const MAX_WIRE_BYTES = 1_000_000;
export class WireValidationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "WireValidationError";
        this.code = code;
    }
}
export function parseJsonBounded(raw, maxBytes = MAX_WIRE_BYTES) {
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        throw new WireValidationError("oversized", `payload exceeds ${maxBytes} bytes`);
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new WireValidationError("malformed", "payload is not valid JSON");
    }
}
export function assertWireRequest(value) {
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
            return obj;
        case "advance":
            assertRunView(obj["view"]);
            return obj;
        case "evaluate":
            asObject(obj["input"], "input");
            return obj;
        default:
            throw new WireValidationError("unknown", `unknown request kind: ${kind}`);
    }
}
export function assertWireResponse(value) {
    const obj = asObject(value, "response");
    assertProtocol(obj);
    const kind = requireString(obj, "kind");
    switch (kind) {
        case "describe_ok":
            assertGraphDefinition(obj["definition"]);
            return obj;
        case "advance_ok":
            assertGraphDecision(obj["decision"]);
            return obj;
        case "evaluate_ok":
            asObject(obj["result"], "result");
            return obj;
        case "error":
            requireString(obj, "code");
            requireString(obj, "message");
            return obj;
        default:
            throw new WireValidationError("unknown", `unknown response kind: ${kind}`);
    }
}
export function assertGraphDefinition(value) {
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
    return obj;
}
export function assertGraphDecision(value) {
    const obj = asObject(value, "decision");
    requireString(obj, "reason");
    assertGraphAction(obj["action"]);
    return obj;
}
export function assertGraphAction(value) {
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
    return obj;
}
export function assertRunView(value) {
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
    return obj;
}
function assertProtocol(obj) {
    const v = obj["protocolVersion"];
    if (v !== PROTOCOL_VERSION) {
        throw new WireValidationError("malformed", `protocolVersion must be ${PROTOCOL_VERSION}, got ${String(v)}`);
    }
}
function asObject(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new WireValidationError("malformed", `${label} must be an object`);
    }
    return value;
}
function requireString(obj, key) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) {
        throw new WireValidationError("malformed", `${key} must be a non-empty string`);
    }
    return v;
}
function requireNumber(obj, key) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new WireValidationError("malformed", `${key} must be a finite number`);
    }
    return v;
}
function requireArray(obj, key) {
    const v = obj[key];
    if (!Array.isArray(v)) {
        throw new WireValidationError("malformed", `${key} must be an array`);
    }
    return v;
}
//# sourceMappingURL=validate.js.map