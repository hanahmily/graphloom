// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { WireValidationError, type CaseFinding, type GraphDecision } from "@graphloom/sdk";
import { parseSupervisorDecision } from "./decision.js";

/** `inspect` rounds one decision turn may take before the host asks for a decision (§4.2). */
export const MAX_INSPECT_ROUNDS = 4;
/** Requests one `inspect` reply may carry. */
export const MAX_INSPECT_REQUESTS = 8;

/** One request for GraphLoom's own inspection: an inspection tool name and its arguments. */
export interface InspectRequest {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A JSON-reply supervisor's final message (design-supervisor-harnesses.md
 * §4.2): a decision with the findings it carries, a request to inspect, or a
 * model switch.
 */
export type SupervisorReply =
  | { kind: "decision"; decision: GraphDecision; findings: CaseFinding[] }
  | { kind: "inspect"; requests: InspectRequest[] }
  | { kind: "switch_model"; provider: string; modelId: string; reason: string };

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;
const FINDING_KINDS = new Set(["fact", "refuted", "open"]);
const DEPENDS_ON = new Set(["candidate", "plugin"]);

function malformed(message: string): WireValidationError {
  return new WireValidationError("malformed", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The reply's JSON object: a fenced block first, else the whole text. */
function replyObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(FENCED_JSON);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isObject(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function parseInspect(value: unknown): InspectRequest[] {
  if (!Array.isArray(value) || value.length === 0) throw malformed("inspect must be a non-empty array of {tool, args} requests");
  if (value.length > MAX_INSPECT_REQUESTS) throw malformed(`inspect takes at most ${MAX_INSPECT_REQUESTS} requests at a time`);
  return value.map((entry, i) => {
    if (!isObject(entry) || typeof entry.tool !== "string" || entry.tool === "") {
      throw malformed(`inspect[${i}] must be an object with a tool name`);
    }
    if (entry.args !== undefined && !isObject(entry.args)) throw malformed(`inspect[${i}].args must be an object`);
    return { tool: entry.tool, args: (entry.args as Record<string, unknown> | undefined) ?? {} };
  });
}

function parseSwitch(value: unknown): { provider: string; modelId: string; reason: string } {
  if (!isObject(value)) throw malformed("switch_model must be an object {provider, modelId, reason}");
  for (const key of ["provider", "modelId", "reason"] as const) {
    if (typeof value[key] !== "string" || value[key] === "") throw malformed(`switch_model.${key} must be a non-empty string`);
  }
  return { provider: value.provider as string, modelId: value.modelId as string, reason: value.reason as string };
}

function parseFindings(value: unknown): CaseFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw malformed("findings must be an array");
  return value.map((entry, i) => {
    if (!isObject(entry)) throw malformed(`findings[${i}] must be an object`);
    if (typeof entry.kind !== "string" || !FINDING_KINDS.has(entry.kind)) throw malformed(`findings[${i}].kind must be fact, refuted, or open`);
    if (typeof entry.text !== "string" || entry.text.trim() === "") throw malformed(`findings[${i}].text must be a non-empty string`);
    if (entry.evidence !== undefined && (!Array.isArray(entry.evidence) || !entry.evidence.every((e) => typeof e === "string"))) {
      throw malformed(`findings[${i}].evidence must be an array of strings`);
    }
    if (entry.dependsOn !== undefined && (!Array.isArray(entry.dependsOn) || !entry.dependsOn.every((d) => typeof d === "string" && DEPENDS_ON.has(d)))) {
      throw malformed(`findings[${i}].dependsOn must list candidate and/or plugin`);
    }
    return {
      kind: entry.kind as CaseFinding["kind"],
      text: entry.text,
      ...(entry.evidence !== undefined ? { evidence: entry.evidence as string[] } : {}),
      ...(entry.dependsOn !== undefined ? { dependsOn: entry.dependsOn as NonNullable<CaseFinding["dependsOn"]> } : {}),
    };
  });
}

/**
 * Read a JSON-reply supervisor's final message. `inspect` and `switch_model`
 * are recognized here; anything else is a decision, read by
 * `parseSupervisorDecision` (which nests flattened action fields and refuses
 * Accept) after its `findings` are taken off. Throws a `malformed`
 * WireValidationError for a reply that is none of them.
 */
export function parseSupervisorReply(text: string): SupervisorReply {
  const obj = replyObject(text);
  if (obj !== undefined && !("action" in obj)) {
    if ("inspect" in obj) return { kind: "inspect", requests: parseInspect(obj.inspect) };
    if ("switch_model" in obj) return { kind: "switch_model", ...parseSwitch(obj.switch_model) };
  }
  if (obj === undefined || !("findings" in obj)) {
    return { kind: "decision", decision: parseSupervisorDecision(text), findings: [] };
  }
  const { findings, ...decision } = obj;
  const parsedFindings = parseFindings(findings);
  return { kind: "decision", decision: parseSupervisorDecision(JSON.stringify(decision)), findings: parsedFindings };
}
