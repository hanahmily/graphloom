// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import {
  builtinPinForKind,
  MAX_JOB_TIMEOUT_MS,
  MAX_TIMEOUT_CONTINUATIONS,
  type ExecutorView,
  type GraphDecision,
  type JobKind,
} from "@graphloom/sdk";

/**
 * The supervisor's model encodes JSON arrays inside a tool call's untyped
 * `job.input` as `{"item": [...]}` (or `{"item": x}` for one element), writes
 * numbers and booleans as strings ("120000", "true"), and at times leaves a
 * field of the input (a command's `id`, `continueOnFailure`) on the job itself.
 * Guided by the target executor's declared input schema, this turns each back
 * into what the schema expects, and only there: an object where the schema
 * expects an object (even one with an `item` key) is never touched, a string
 * stays a string where the schema allows one, and neither is any input whose
 * executor declares no shape.
 */

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypes(schema: Record<string, Json>): string[] {
  const t = schema.type;
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

/** The number or boolean a string spells, when the schema allows that type and the string is exactly its spelling. */
function scalarOf(text: string, types: readonly string[]): number | boolean | undefined {
  if (types.includes("boolean") && (text === "true" || text === "false")) return text === "true";
  if ((types.includes("integer") || types.includes("number")) && /^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n) && (types.includes("number") || Number.isInteger(n))) return n;
  }
  return undefined;
}

/** The fields a job itself carries (JobSpec); any other key on a dispatch's job belongs to its input. */
const JOB_FIELDS: ReadonlySet<string> = new Set([
  "jobId", "stageId", "kind", "purpose", "instruction", "resultSchema", "writeScope", "readOnly", "executor", "input",
  "effect", "tools", "continueFrom", "timeoutMs", "timeoutContinuations", "checkout", "confinement",
]);

/**
 * A key the model wrote on the job that the executor's input schema places inside the input: at the input's top level,
 * or in the one element of an array property whose items require it (`id` of a lone command). Moved only when the target
 * lacks it, so nothing the model put in the right place is overridden.
 */
function adoptStrays(job: Record<string, Json>, input: Json, schema: Record<string, Json>, paths: string[]): { job: Record<string, Json>; input: Json } {
  if (!isRecord(input) || !isRecord(schema.properties)) return { job, input };
  let nextJob = job;
  let nextInput: Record<string, Json> = input;
  for (const [key, value] of Object.entries(job)) {
    if (JOB_FIELDS.has(key) || Object.hasOwn(nextInput, key)) continue;
    let target: string | undefined;
    if (Object.hasOwn(schema.properties, key)) {
      nextInput = { ...nextInput, [key]: value };
      target = `job.input.${key}`;
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        const items = isRecord(sub) && isRecord(sub.items) ? sub.items : undefined;
        const list = nextInput[name];
        if (items === undefined || !isRecord(items.properties) || !Object.hasOwn(items.properties, key)) continue;
        if (!Array.isArray(list) || list.length !== 1 || !isRecord(list[0]) || Object.hasOwn(list[0], key)) continue;
        nextInput = { ...nextInput, [name]: [{ ...list[0], [key]: value }] };
        target = `job.input.${name}[0].${key}`;
        break;
      }
    }
    if (target === undefined) continue;
    const { [key]: _moved, ...rest } = nextJob;
    nextJob = rest;
    paths.push(`${target} (moved from job.${key})`);
  }
  return { job: nextJob, input: nextInput };
}

function walk(value: Json, schema: Json, at: string, paths: string[]): Json {
  if (!isRecord(schema)) return value;
  const types = schemaTypes(schema);
  let current = value;
  // The same untyped encoding stringifies scalars: read "120000" and "true" against an integer or boolean position.
  if (typeof current === "string" && !types.includes("string")) {
    const scalar = scalarOf(current, types);
    const inRange =
      typeof scalar !== "number" ||
      ((typeof schema.minimum !== "number" || scalar >= schema.minimum) && (typeof schema.maximum !== "number" || scalar <= schema.maximum));
    if (scalar !== undefined && inRange) {
      paths.push(`${at} (string to ${typeof scalar})`);
      return scalar;
    }
  }
  // An array-only position: the one place `{"item": …}` is unwrapped.
  if (types.includes("array") && !types.includes("object") && isRecord(current)) {
    const keys = Object.keys(current);
    if (keys.length === 1 && keys[0] === "item") {
      const inner = current.item;
      current = Array.isArray(inner) ? inner : [inner];
      paths.push(at);
    }
  }
  if (Array.isArray(current) && types.includes("array") && isRecord(schema.items)) {
    let changed = false;
    const next = current.map((element, i) => {
      const walked = walk(element, schema.items, `${at}[${i}]`, paths);
      if (walked !== element) changed = true;
      return walked;
    });
    return changed ? next : current;
  }
  if (isRecord(current) && isRecord(schema.properties)) {
    let copy: Record<string, Json> | undefined;
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(current, key)) continue;
      const walked = walk(current[key], sub, `${at}.${key}`, paths);
      if (walked !== current[key]) {
        copy ??= { ...current };
        copy[key] = walked;
      }
    }
    return copy ?? current;
  }
  return current;
}

/**
 * The job's own typed fields (JobSpec) with the limits the controller enforces. A value outside a range is never
 * converted: it stays as written and is refused with the range, as before.
 */
const JOB_FIELD_SCHEMA: Record<string, Json> = {
  type: "object",
  properties: {
    readOnly: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_JOB_TIMEOUT_MS },
    timeoutContinuations: { type: "integer", minimum: 0, maximum: MAX_TIMEOUT_CONTINUATIONS },
    confinement: {
      type: "object",
      properties: {
        network: { type: "boolean" },
        binds: { type: "array", items: { type: "object", properties: { readOnly: { type: "boolean" } } } },
        cpus: { type: "number", maximum: 1024 },
        pids: { type: "integer", minimum: 1, maximum: 4_194_304 },
        wallClockMs: { type: "integer", minimum: 1, maximum: MAX_JOB_TIMEOUT_MS },
      },
    },
  },
};

/** The executor id a job targets: its own pin, else its kind's built-in default (as admission resolves it). */
function targetExecutorId(job: Record<string, Json>): string | undefined {
  const pin = job.executor;
  if (isRecord(pin) && typeof pin.id === "string") return pin.id;
  if (job.kind === "agent" || job.kind === "command") return builtinPinForKind(job.kind as JobKind).id;
  return undefined;
}

/** `job` with its `input` normalized against the target executor's declared schema, and the paths changed. */
export function normalizeJobInput<T extends object>(
  job: T,
  executors: readonly ExecutorView[] | undefined,
): { job: T; paths: string[] } {
  const paths: string[] = [];
  // The job's own fields first: they are typed whatever executor the job targets.
  const original = job;
  job = walk(job, JOB_FIELD_SCHEMA, "job", paths) as T;
  const record = job as Record<string, Json>;
  if (executors === undefined || record.input === undefined) return { job, paths };
  const id = targetExecutorId(record);
  const schema = id === undefined ? undefined : executors.find((e) => e.id === id)?.inputShape?.schema;
  if (schema === undefined) return { job, paths };
  const walked = walk(record.input, schema, "job.input", paths);
  const strays = adoptStrays(record, walked, schema as Record<string, Json>, paths);
  // What moved in arrives with the same encoding, so it is read against the schema too.
  const input = strays.input === walked ? walked : walk(strays.input, schema, "job.input", paths);
  const adopted = strays.job;
  return job === original && paths.length === 0 ? { job, paths } : { job: { ...adopted, input } as T, paths };
}

/** A dispatch decision with its job input normalized; any other proposal is returned as it is. */
export function normalizeProposalInput<P extends object>(
  proposal: P,
  executors: readonly ExecutorView[] | undefined,
): { proposal: P; paths: string[] } {
  const action = (proposal as { action?: GraphDecision["action"] }).action;
  if (action === undefined || action.type !== "dispatch" || !isRecord(action.job)) return { proposal, paths: [] };
  const { job, paths } = normalizeJobInput(action.job, executors);
  return paths.length === 0 ? { proposal, paths } : { proposal: { ...proposal, action: { ...action, job } }, paths };
}

/** The sentence reported back to the model and recorded with the episode. */
export function normalizationNote(paths: readonly string[]): string {
  return `Normalized the job input at ${paths.join(", ")} ({"item": …} read as arrays, stringified numbers and booleans as typed values, stray job fields moved into the input, and the job\'s own timeoutMs, timeoutContinuations, readOnly and confinement limits as numbers and booleans); pass typed JSON and keep each field inside its own object next time.`;
}
