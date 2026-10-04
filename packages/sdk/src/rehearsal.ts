/**
 * Plugin-declared rehearsal data (docs/design-graph-rehearsal.md §4.4): a
 * bundle's `entryPoints.rehearsal` module exports a `GraphRehearsal`, whose
 * scenarios drive a stand-in model through the real controller, plugin host
 * and harness adapters for zero provider calls. The SDK ships no scenario
 * data and no plugin vocabulary — only the shape a scenario takes, and the
 * generic checks (schema synthesis, assignment fidelity) that apply to any
 * contract by the strings the plugin itself declared.
 */

import { parsePath, type PathSegment, type ReferenceSet } from "./result-contract.js";
import type { GraphDecision } from "./types.js";

/** Budget overrides a scenario needs beyond the rehearsal's small defaults. */
export interface RehearsalBudgets {
  agentInvocations?: number;
  jobs?: number;
  decisions?: number;
  corrections?: number;
  waitMs?: number;
  activeMs?: number;
  recoveryReserve?: number;
}

/**
 * Instead of a well-formed result: the turn ends without submitting one, a
 * harness process exits non-zero with a summary, or the model goes silent
 * for `ms` (bounded by the rehearsal's shortened watchdogs, never the real
 * ones). Exercises the paths a happy-path reply never reaches.
 */
export type RehearsalFailure =
  | { kind: "no-result" }
  | { kind: "exit"; summary: string }
  | { kind: "hang"; ms: number };

/** One reply a stand-in gives for one contract, consumed in order; the scenario's last reply for a contract repeats. */
export interface RehearsalReply {
  /** The structured result, checked against the contract's schema and (§4.3) against the rendered assignment. */
  output?: unknown;
  /** Files the stand-in leaves in the worktree before submitting, as a work job's agent would. */
  effects?: Array<{ path: string; bytes: string }>;
  /** Properties of `output` the assignment need not name: the harness or controller supplies them. */
  harnessSupplied?: string[];
  /** In place of `output`: the stand-in fails the turn instead of succeeding. */
  fail?: RehearsalFailure;
}

/** A canned command result, used when the rehearsal stubs command jobs. */
export interface RehearsalCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** Fail this many calls (a non-zero exit) before the result above is given, for the retry-timing path. */
  failTimes?: number;
  retryAfterMs?: number;
}

/** What a scenario must reach, so the evaluator judges the run instead of only finishing it. */
export interface RehearsalExpectation {
  status: "succeeded" | "stopped";
  receipts?: string[];
  /** Agent dispatches for one stage without a receipt, the ceiling this scenario means to stay under. */
  maxAgentDispatches?: number;
  stopReason?: string;
  /** Recovery triggers this scenario means to reach, in order; any other recovery entry is a finding. */
  recovery?: string[];
  /** How many times each executor id was invoked. */
  executorCalls?: Record<string, number>;
}

export interface RehearsalScenario {
  /** Replies by the contract name the plugin declared in `resultContracts`. */
  results: Record<string, RehearsalReply[]>;
  /** Canned command results by command id, used when commands are stubbed. */
  commands?: Record<string, RehearsalCommandResult>;
  /** Recorded GitHub (or other read-executor) payloads by executor id, used with offline replay. */
  reads?: Record<string, unknown[]>;
  /** Supervisor decisions, in order, when the scenario tests recovery. Absent means none is expected. */
  supervisor?: GraphDecision[];
  /** Smaller or larger than the rehearsal defaults when the scenario needs it. */
  budgets?: RehearsalBudgets;
  expect: RehearsalExpectation;
}

export interface GraphRehearsal {
  /** "happy" is the convention a plugin without a reason to name otherwise should use. */
  scenarios: Record<string, RehearsalScenario>;
}

/**
 * The smallest instance of `schema` that validates against the same subset
 * `validateResultShape` checks: required properties only, the first `enum`
 * value where one is declared, `[]` for an array, and the property's own
 * name as a placeholder string. Used when a contract has no scenario reply —
 * every graph is rehearsable this way — and a result the plugin's own
 * parser then refuses is itself a finding (the contract admits what the
 * parser refuses), not a synthesis bug.
 */
export function synthesizeFromSchema(schema: Record<string, unknown>, propertyName = "value"): unknown {
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues !== undefined && enumValues.length > 0) return enumValues[0];
  const type = schema.type as string | undefined;
  switch (type) {
    case "object": {
      const required = (schema.required as string[] | undefined) ?? [];
      const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
      const value: Record<string, unknown> = {};
      for (const key of required) {
        value[key] = synthesizeFromSchema(properties[key] ?? {}, key);
      }
      return value;
    }
    case "array":
      return [];
    case "string":
      return propertyName;
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return propertyName;
  }
}

/**
 * Whether `assignment` names `field` (a top-level property name): the full
 * string, matched case-insensitively as a whole word, so "summary" matches
 * "Summary:" but not "summarized". Proves only that the prompt is not silent
 * about the field — not that it explains it well (§4.3).
 */
export function assignmentNamesField(assignment: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(assignment);
}

/**
 * A stand-in is about to emit `output`'s own top-level properties; each must
 * be named in the rendered `assignment` it was given, or be declared
 * `harnessSupplied` by the reply. Returns the property names that are
 * neither, in declaration order — a real model cannot produce what it was
 * never asked for, and this is the defect a perfect stand-in working from an
 * imperfect prompt would otherwise paper over.
 */
export function checkAssignmentFidelity(
  assignment: string,
  output: unknown,
  harnessSupplied: readonly string[] = [],
): string[] {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return [];
  const supplied = new Set(harnessSupplied);
  const missing: string[] = [];
  for (const field of Object.keys(output as Record<string, unknown>)) {
    if (supplied.has(field)) continue;
    if (!assignmentNamesField(assignment, field)) missing.push(field);
  }
  return missing;
}

/** What `mutateAdversarially` picked, so a stand-in can script the harness-specific reaction (Pi's own in-turn retry needs the original output; the others do not). */
export type AdversarialMutation = "scope-violation" | "reference-description" | "dropped-property";

export interface AdversarialResult {
  mutation: AdversarialMutation;
  reply: RehearsalReply;
}

/**
 * `--adversarial` (§4.4): corrupts a happy reply to prove the robustness
 * machinery itself — not any one plugin's own logic — is wired on this
 * machine. Picks the first applicable strategy, in priority order, from what
 * the reply and contract actually offer; `undefined` when none apply (a
 * scripted failure already exercises its own path, or the reply has nothing
 * to corrupt):
 *
 * 1. An effect outside the job's write scope, when the reply has any effect
 *    at all — the controller's own post-hoc worktree diff fails the job as a
 *    scope violation, for any harness, uniformly (§4.7).
 * 2. A reference leaf set to its own shown description instead of its id,
 *    when the contract declares `references` and `knownReferences` names at
 *    least one description — `checkReferences` (result-contract.ts)
 *    reconciles it, and the evidence records `repaired`.
 * 3. Otherwise, the first required property dropped — Pi's own
 *    `submit_result` tool rejects it in-turn and the model gets a chance to
 *    resubmit (§4.2); Claude Code and Codex have no further turn to correct
 *    it in, so the job fails as `contract_violation`.
 */
export function mutateAdversarially(
  reply: RehearsalReply,
  contract: { schema: Record<string, unknown>; references?: string[]; knownReferences?: Record<string, ReferenceSet> },
): AdversarialResult | undefined {
  if (reply.output === undefined) return undefined;
  if (reply.effects !== undefined && reply.effects.length > 0) {
    return {
      mutation: "scope-violation",
      reply: {
        ...reply,
        // A sibling path inside the worktree, not a parent of it: the
        // controller's own scope check diffs the worktree's own git status,
        // which cannot see a write that landed outside it at all. No job's
        // own writeScope legitimately names this file.
        effects: [...reply.effects, { path: ".graphloom-adversarial-stray-write", bytes: "adversarial: write outside scope\n" }],
      },
    };
  }
  for (const path of contract.references ?? []) {
    const descriptions = contract.knownReferences?.[path]?.descriptions;
    const description = descriptions !== undefined ? Object.values(descriptions)[0] : undefined;
    if (description === undefined) continue;
    const mutated = setAtPath(reply.output, parsePath(path), description);
    if (mutated !== reply.output) return { mutation: "reference-description", reply: { ...reply, output: mutated } };
  }
  const required = (contract.schema.required as string[] | undefined) ?? [];
  if (required.length > 0 && isPlainObject(reply.output) && required[0]! in reply.output) {
    const { [required[0]!]: _dropped, ...rest } = reply.output;
    return { mutation: "dropped-property", reply: { ...reply, output: rest } };
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Sets the leaf `value` reaches to `at`, leaving every path it did not touch unchanged; no-op if `at` does not resolve (an absent field, or an empty array with nothing to mutate). */
function setAtPath(node: unknown, segments: PathSegment[], value: string): unknown {
  if (segments.length === 0) return node;
  const [head, ...rest] = segments;
  if (!isPlainObject(node) || !(head!.name in node)) return node;
  const child = node[head!.name];
  // The array flag names head.name's own value, so it must be navigated to
  // before it can be iterated — not the parent object this call received.
  if (head!.array) {
    if (!Array.isArray(child) || child.length === 0) return node;
    const [first, ...others] = child;
    const mutatedFirst = setAtPath(first, rest, value);
    return mutatedFirst === first ? node : { ...node, [head!.name]: [mutatedFirst, ...others] };
  }
  if (rest.length > 0) {
    const mutatedChild = setAtPath(child, rest, value);
    return mutatedChild === child ? node : { ...node, [head!.name]: mutatedChild };
  }
  return { ...node, [head!.name]: value };
}
