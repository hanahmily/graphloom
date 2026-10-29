// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Task preparation (docs/design-typescript-core.md §16): a graph's optional
 * `prepareTask` hook turns the arguments of `graphloom task new` into a task
 * plan, a short list of generic steps as data. The CLI validates the plan
 * (`validateTaskPlan`) and executes it; neither it, the SDK nor the controller
 * learns what the arguments name.
 */

/** What the CLI read and hands the hook: bounded data, never a file, process or network. */
export interface PrepareTaskInput {
  /** The words after `<graph>`, verbatim. */
  args: string[];
  repo: {
    /** Fetch URLs, as `git remote -v` lists them. */
    remotes: Array<{ name: string; url: string }>;
    /** HEAD's commit. */
    head: string;
  };
  /** The parsed JSON of `--profile`, unread by the CLI. */
  profile?: unknown;
  options: { dryRun: boolean };
}

/** A usage or input error, printed as is. */
export interface TaskPlanRefusal {
  refused: string;
}

export type TaskPlanStep =
  | { kind: "fetch"; remote: string; refspec: string; intoRef: string }
  | { kind: "resolve"; name: string; revParse: string }
  | { kind: "resolve"; name: string; mergeBase: [string, string] }
  | { kind: "updateRef"; from: string; to: string }
  | { kind: "writeTask"; path: string; fields: Record<string, string> };

export interface TaskPlan {
  /** One line for the operator, at most 200 characters. */
  summary: string;
  /** At most 16 steps, executed in order. */
  steps: TaskPlanStep[];
}

export type PrepareTaskReply = TaskPlan | TaskPlanRefusal;

export const MAX_TASK_PLAN_STEPS = 16;
export const MAX_TASK_PLAN_NAMES = 8;
export const MAX_TASK_PLAN_BYTES = 64 * 1024;
export const MAX_TASK_PLAN_SUMMARY = 200;
export const MAX_TASK_FIELD_BYTES = 4 * 1024;
/** The task fields a plan may set: strings only, and never `graph`, `repo` or `config`, which the CLI writes itself. */
export const TASK_PLAN_FIELDS: readonly string[] = ["request", "base"];

const NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const REFERENCE = /\$\{([^}]*)\}/g;
/** A stand-in for a bound value (a full object id) while a plan is checked before it runs. */
const OID_STAND_IN = "0".repeat(40);

export class TaskPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPlanError";
  }
}

/** The graph's own ref namespace: the only place a plan may write refs. */
export function taskPlanNamespace(graphId: string): string {
  return `refs/graphloom/${graphId}/`;
}

/** A reply that refuses the task rather than planning it. */
export function isTaskPlanRefusal(value: unknown): value is TaskPlanRefusal {
  return value !== null && typeof value === "object" && typeof (value as { refused?: unknown }).refused === "string";
}

/** The `${name}` references in `text`, in order; throws when a `${` is not a well-formed one. */
export function planReferences(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(REFERENCE)) names.push(m[1]!);
  const open = (text.match(/\$\{/g) ?? []).length;
  if (open !== names.length) throw new TaskPlanError(`${JSON.stringify(text)} has a malformed \${name} reference`);
  for (const name of names) if (!NAME.test(name)) throw new TaskPlanError(`reference \${${name}} is not a valid name`);
  return names;
}

/** Replace each `${name}` with its value; an unbound name throws. */
export function substitutePlan(text: string, values: ReadonlyMap<string, string>): string {
  planReferences(text);
  return text.replace(REFERENCE, (_m, name: string) => {
    const v = values.get(name);
    if (v === undefined) throw new TaskPlanError(`\${${name}} is not bound`);
    return v;
  });
}

/**
 * `git check-ref-format` for a full ref name, without Git: the rules of
 * git-check-ref-format(1) a plan could trip. The CLI also asks Git itself
 * before it writes anything.
 */
export function refFormatProblem(ref: string): string | undefined {
  if (ref === "" || ref === "@") return "is empty or @";
  if (ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")) return "starts or ends with / or ends with .";
  if (/[\u0000- \u007f~^:?*[\\]/.test(ref)) return "holds a space, control or one of ~ ^ : ? * [ \\";
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return "holds .. or @{ or an empty component";
  for (const part of ref.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock")) return `component ${JSON.stringify(part)} starts with . or ends with .lock`;
  }
  return undefined;
}

function problem(index: number, step: unknown, rule: string): TaskPlanError {
  const kind = step !== null && typeof step === "object" ? String((step as { kind?: unknown }).kind) : typeof step;
  return new TaskPlanError(`task plan step ${index + 1} (${kind}): ${rule}`);
}

function exactKeys(index: number, step: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(step)) {
    if (!allowed.includes(key)) throw problem(index, step, `unexpected property ${JSON.stringify(key)}`);
  }
}

function str(index: number, step: Record<string, unknown>, key: string): string {
  const v = step[key];
  if (typeof v !== "string" || v === "" || v.includes("\u0000")) throw problem(index, step, `${key} must be a non-empty string without NUL`);
  return v;
}

/** `https://` with no user information, in a remote's place. */
function remoteProblem(remote: string): string | undefined {
  if (remote.includes("://")) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return "is not a valid URL";
    }
    if (url.protocol !== "https:") return `uses ${url.protocol.slice(0, -1)}://; only https:// is fetched`;
    if (url.username !== "" || url.password !== "") return "carries user information";
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) return "is neither a configured remote's name nor an https:// URL";
  return undefined;
}

/**
 * Check a hook's reply at run time and return it typed, or throw a
 * `TaskPlanError` naming the step and the rule. Nothing has run when this
 * throws: the whole plan is refused. No step kind runs a command, so an
 * unknown `kind` or an extra property is refused, never ignored.
 */
export function validateTaskPlan(plan: unknown, graphId: string): TaskPlan {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) throw new TaskPlanError("task plan must be an object");
  let json: string;
  try {
    json = JSON.stringify(plan);
  } catch {
    throw new TaskPlanError("task plan is not JSON");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_TASK_PLAN_BYTES) throw new TaskPlanError(`task plan is larger than ${MAX_TASK_PLAN_BYTES} bytes`);
  const obj = plan as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "summary" && key !== "steps") throw new TaskPlanError(`task plan has an unexpected property ${JSON.stringify(key)}`);
  }
  if (typeof obj["summary"] !== "string" || obj["summary"].trim() === "" || obj["summary"].length > MAX_TASK_PLAN_SUMMARY || /[\r\n]/.test(obj["summary"])) {
    throw new TaskPlanError(`task plan summary must be one line of 1 to ${MAX_TASK_PLAN_SUMMARY} characters`);
  }
  const steps = obj["steps"];
  if (!Array.isArray(steps) || steps.length === 0) throw new TaskPlanError("task plan needs at least one step");
  if (steps.length > MAX_TASK_PLAN_STEPS) throw new TaskPlanError(`task plan has ${steps.length} steps, more than ${MAX_TASK_PLAN_STEPS}`);

  const namespace = taskPlanNamespace(graphId);
  const bound = new Set<string>();
  /** The text with each reference replaced by a stand-in object id, after checking each is bound. */
  const standIn = (index: number, step: unknown, text: string): string => {
    let names: string[];
    try {
      names = planReferences(text);
    } catch (err) {
      throw problem(index, step, (err as Error).message);
    }
    for (const name of names) if (!bound.has(name)) throw problem(index, step, `\${${name}} is used before a resolve step binds it`);
    return text.replace(REFERENCE, OID_STAND_IN);
  };
  const inNamespace = (index: number, step: unknown, key: string, value: string): void => {
    const concrete = standIn(index, step, value);
    if (!concrete.startsWith(namespace) || concrete === namespace) throw problem(index, step, `${key} ${JSON.stringify(value)} is outside ${namespace}`);
    const bad = refFormatProblem(concrete);
    if (bad !== undefined) throw problem(index, step, `${key} ${JSON.stringify(value)} ${bad}`);
  };
  /** A ref under the namespace, or exactly one `${name}`. */
  const refOrName = (index: number, step: unknown, key: string, value: string): void => {
    if (/^\$\{[^}]*\}$/.test(value)) {
      standIn(index, step, value);
      return;
    }
    inNamespace(index, step, key, value);
  };

  let writes = 0;
  steps.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw problem(index, raw, "step must be an object");
    const step = raw as Record<string, unknown>;
    switch (step["kind"]) {
      case "fetch": {
        exactKeys(index, step, ["kind", "remote", "refspec", "intoRef"]);
        const remote = str(index, step, "remote");
        const bad = remoteProblem(remote);
        if (bad !== undefined) throw problem(index, step, `remote ${JSON.stringify(remote)} ${bad}`);
        const refspec = str(index, step, "refspec");
        if (!refspec.startsWith("refs/") || /[:+*^~]|@\{|\.\./.test(refspec) || refFormatProblem(refspec) !== undefined) {
          throw problem(index, step, `refspec ${JSON.stringify(refspec)} must be one source ref starting with refs/, with no : + * ^ ~ @{ or ..`);
        }
        if (refspec.includes("${")) throw problem(index, step, "refspec takes no reference");
        inNamespace(index, step, "intoRef", str(index, step, "intoRef"));
        return;
      }
      case "resolve": {
        const rev = step["revParse"] !== undefined;
        const base = step["mergeBase"] !== undefined;
        if (rev === base) throw problem(index, step, "a resolve step has exactly one of revParse and mergeBase");
        exactKeys(index, step, rev ? ["kind", "name", "revParse"] : ["kind", "name", "mergeBase"]);
        const name = str(index, step, "name");
        if (!NAME.test(name)) throw problem(index, step, `name ${JSON.stringify(name)} must match ${NAME.source}`);
        if (bound.has(name)) throw problem(index, step, `name ${name} is already bound`);
        if (bound.size >= MAX_TASK_PLAN_NAMES) throw problem(index, step, `more than ${MAX_TASK_PLAN_NAMES} names`);
        if (rev) {
          refOrName(index, step, "revParse", str(index, step, "revParse"));
        } else {
          const operands = step["mergeBase"];
          if (!Array.isArray(operands) || operands.length !== 2 || operands.some((o) => typeof o !== "string" || o === "" || o.includes("\u0000"))) {
            throw problem(index, step, "mergeBase must be two non-empty strings");
          }
          for (const operand of operands as string[]) refOrName(index, step, "mergeBase operand", operand);
        }
        bound.add(name);
        return;
      }
      case "updateRef": {
        exactKeys(index, step, ["kind", "from", "to"]);
        refOrName(index, step, "from", str(index, step, "from"));
        inNamespace(index, step, "to", str(index, step, "to"));
        return;
      }
      case "writeTask": {
        exactKeys(index, step, ["kind", "path", "fields"]);
        writes += 1;
        if (index !== steps.length - 1) throw problem(index, step, "writeTask must be the last step");
        const p = str(index, step, "path");
        const segments = p.split("/");
        if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || segments.some((s) => s === ".." || s === "" || s === ".")) {
          throw problem(index, step, `path ${JSON.stringify(p)} must be relative, with no .. , . or empty segment`);
        }
        if (segments.at(-1) !== "task.yaml") throw problem(index, step, `path ${JSON.stringify(p)} must end in task.yaml`);
        const fields = step["fields"];
        if (fields === null || typeof fields !== "object" || Array.isArray(fields)) throw problem(index, step, "fields must be an object");
        for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
          if (key === "graph" || key === "repo" || key === "config") throw problem(index, step, `field ${key} is written by the CLI itself`);
          if (!TASK_PLAN_FIELDS.includes(key)) throw problem(index, step, `field ${JSON.stringify(key)} is not a task field a plan may set (${TASK_PLAN_FIELDS.join(", ")})`);
          if (typeof value !== "string" || value.includes("\u0000") || Buffer.byteLength(value, "utf8") > MAX_TASK_FIELD_BYTES) {
            throw problem(index, step, `field ${key} must be a string of at most ${MAX_TASK_FIELD_BYTES} bytes with no NUL`);
          }
          standIn(index, step, value);
        }
        return;
      }
      default:
        throw problem(index, step, `unknown step kind ${JSON.stringify(step["kind"])}; a plan has no step that runs a command`);
    }
  });
  if (writes !== 1) throw new TaskPlanError("task plan needs exactly one writeTask, as its last step");
  return plan as TaskPlan;
}
