import { builtinPinForKind, type ExecutorView, type GraphDecision, type JobKind } from "@graphloom/sdk";

/**
 * The supervisor's model encodes JSON arrays inside a tool call's untyped
 * `job.input` as `{"item": [...]}` (or `{"item": x}` for one element). Guided
 * by the target executor's declared input schema, this turns that encoding
 * back into the array the schema expects, and only there: an object where the
 * schema expects an object (even one with an `item` key) is never touched, and
 * neither is any input whose executor declares no shape.
 */

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypes(schema: Record<string, Json>): string[] {
  const t = schema.type;
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

function walk(value: Json, schema: Json, at: string, paths: string[]): Json {
  if (!isRecord(schema)) return value;
  const types = schemaTypes(schema);
  let current = value;
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
  const record = job as Record<string, Json>;
  if (executors === undefined || record.input === undefined) return { job, paths: [] };
  const id = targetExecutorId(record);
  const schema = id === undefined ? undefined : executors.find((e) => e.id === id)?.inputShape?.schema;
  if (schema === undefined) return { job, paths: [] };
  const paths: string[] = [];
  const input = walk(record.input, schema, "job.input", paths);
  return paths.length === 0 ? { job, paths } : { job: { ...job, input }, paths };
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
  return `Normalized {"item": …} to plain arrays at ${paths.join(", ")}; pass arrays directly next time.`;
}
