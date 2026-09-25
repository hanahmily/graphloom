import type { JobKind, JobSpec } from "./types.js";

/** Qualified executor identity, e.g. `graphloom.agent/run` or `acme.echo/ping`. */
export type ExecutorId = string;

export type ExecutorEffect = "read" | "write" | "ambiguous";

/** Default max UTF-8 bytes for durable executor `input` (admission). */
export const MAX_EXECUTOR_INPUT_BYTES = 256_000;

/** Serializable pin recorded at admission — never a function or closure. */
export interface ExecutorPin {
  id: ExecutorId;
  version?: string;
  digest?: string;
}

export interface ExecutorCredentials {
  get(name: string): Promise<string | undefined>;
}

/**
 * A harness tool the graph exposes to an agent job. The agent calls it by
 * name; the controller admits each call as a child operation of the pinned
 * executor. The agent cannot name an executor or widen its grants.
 */
export interface ToolBinding {
  name: string;
  executor: ExecutorPin;
  /** Declared effect; the runner refuses an executor whose effect differs. */
  effect: ExecutorEffect;
  description?: string;
}

export interface ToolCallRequest {
  /** Harness tool-call identity; a repeated id replays the recorded result. */
  toolCallId: string;
  tool: string;
  input: unknown;
}

export interface ToolCallEvidence {
  kind: "file" | "command" | "workspace" | "review" | "other";
  payload?: unknown;
  fingerprint?: string;
}

export interface ToolCallResult {
  status: "ok" | "failed" | "conflict";
  summary: string;
  evidence?: ToolCallEvidence[];
  /** Controller operation that executed the call, when one was admitted. */
  childOperationId?: string;
  /** True when the result was recorded earlier and not executed again. */
  replayed?: boolean;
}

/** Tools admitted for this job, serviced by the controller one call at a time. */
export interface ExecutorTools {
  readonly bindings: ReadonlyArray<Pick<ToolBinding, "name" | "effect" | "description">>;
  call(request: ToolCallRequest): Promise<ToolCallResult>;
}

/** Shared run budget for model requests made inside an executor. */
export interface ExecutorUsage {
  /** Reserve one provider request; false when the run budget is exhausted or the job is fenced. */
  reserveModelCall(): Promise<boolean>;
}

export interface ExecutorContext {
  runId: string;
  operationId: string;
  generation: number;
  worktreePath: string;
  artifactDir: string;
  /** Admitted write paths when the job may mutate the worktree. */
  writeScope?: string[];
  readOnly?: boolean;
  signal?: AbortSignal;
  credentials?: ExecutorCredentials;
  /** Present when the job declared tools. */
  tools?: ExecutorTools;
  /** Present when the host accounts for model requests made by this job. */
  usage?: ExecutorUsage;
}

export type JsonSchemaValidator<T> = (value: unknown) => value is T;

export interface ExecutorDefinition<TInput = unknown, TOutput = unknown> {
  readonly id: ExecutorId;
  readonly version?: string;
  readonly effect: ExecutorEffect;
  readonly capabilities?: readonly string[];
  readonly inputSchema?: JsonSchemaValidator<TInput>;
  readonly outputSchema?: JsonSchemaValidator<TOutput>;
  execute(input: TInput, ctx: ExecutorContext): Promise<TOutput> | TOutput;
}

export interface DefineExecutorOptions<TInput, TOutput> {
  id: ExecutorId;
  version?: string;
  effect: ExecutorEffect;
  capabilities?: readonly string[];
  inputSchema?: JsonSchemaValidator<TInput>;
  outputSchema?: JsonSchemaValidator<TOutput>;
  execute: (input: TInput, ctx: ExecutorContext) => Promise<TOutput> | TOutput;
}

/**
 * What an executor package declares to the host that runs it. Plain data: the
 * host loads `entryModule` in a separate executor process and never imports it.
 */
export interface ExecutorPackageManifest {
  /** Package name, used in errors and evidence. */
  name: string;
  /** Absolute path to a module exporting `executors: ExecutorDefinition[]`. */
  entryModule: string;
  /** Qualified ids the module serves. */
  executorIds: readonly ExecutorId[];
  /** Credential binding names executors may request through `ctx.credentials`. */
  credentials?: readonly string[];
  /** Non-secret environment variables the operator may set for the executor process. */
  configEnv?: readonly string[];
  /**
   * `sandbox` (default): read-only package closure, no writes or processes.
   * `unrestricted`: full user permissions, e.g. a coding agent that edits the
   * worktree and runs commands. The host requires explicit operator consent.
   */
  isolation?: "sandbox" | "unrestricted";
}

/** Operator-supplied grants for one executor package. */
export interface ExecutorBinding {
  /** Secrets by binding name; delivered over stdin and redacted from results. */
  credentials?: Record<string, string>;
  /** Effects granted to the package. Default: `["read"]`. */
  allowedEffects?: readonly ExecutorEffect[];
  /** Values for names the manifest lists in `configEnv`. */
  env?: Record<string, string>;
  /** Operator consent to run a manifest that declares `isolation: "unrestricted"`. */
  allowUnrestricted?: boolean;
}

/** Built-in agent executor id — legacy `kind: "agent"` jobs pin to this. */
export const BUILTIN_AGENT_EXECUTOR_ID = "graphloom.agent/run";

/** Built-in command executor id — legacy `kind: "command"` jobs pin to this. */
export const BUILTIN_COMMAND_EXECUTOR_ID = "graphloom.command/run";

const QUALIFIED_ID = /^[a-z][a-z0-9._-]*\/[a-z][a-z0-9._-]*$/i;

export function assertExecutorId(id: unknown): asserts id is ExecutorId {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("executor id must be a non-empty string");
  }
  if (!QUALIFIED_ID.test(id)) {
    throw new Error(
      `executor id must be qualified as namespace/name (got ${JSON.stringify(id)})`,
    );
  }
}

export function assertExecutorPin(value: unknown): ExecutorPin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("executor pin must be an object");
  }
  const obj = value as Record<string, unknown>;
  assertExecutorId(obj["id"]);
  const pin: ExecutorPin = { id: obj["id"] };
  if (obj["version"] !== undefined) {
    if (typeof obj["version"] !== "string" || obj["version"].length === 0) {
      throw new Error("executor pin version must be a non-empty string");
    }
    pin.version = obj["version"];
  }
  if (obj["digest"] !== undefined) {
    if (typeof obj["digest"] !== "string" || obj["digest"].length === 0) {
      throw new Error("executor pin digest must be a non-empty string");
    }
    pin.digest = obj["digest"];
  }
  return pin;
}

/**
 * Ensure a value is JSON-serializable and within the durable input size bound.
 * Returns the canonical JSON string (for byte accounting / IPC).
 */
export function assertBoundedJson(
  value: unknown,
  maxBytes = MAX_EXECUTOR_INPUT_BYTES,
): string {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (err) {
    throw new Error(
      `executor input is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === undefined) {
    throw new Error("executor input must not be undefined");
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Error(`executor input exceeds ${maxBytes} bytes`);
  }
  return raw;
}

/**
 * Freeze an executor definition for export from a plugin or built-in package.
 * The controller never imports `execute`; only the runner/child host does.
 */
export function defineExecutor<TInput, TOutput>(
  options: DefineExecutorOptions<TInput, TOutput>,
): ExecutorDefinition<TInput, TOutput> {
  assertExecutorId(options.id);
  return Object.freeze({
    id: options.id,
    effect: options.effect,
    execute: options.execute,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.capabilities !== undefined
      ? { capabilities: Object.freeze([...options.capabilities]) }
      : {}),
    ...(options.inputSchema !== undefined ? { inputSchema: options.inputSchema } : {}),
    ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
  });
}

/** Map legacy kind to a built-in executor pin when dispatch omits `executor`. */
export function builtinPinForKind(kind: JobKind): ExecutorPin {
  switch (kind) {
    case "agent":
      return { id: BUILTIN_AGENT_EXECUTOR_ID, version: "1" };
    case "command":
      return { id: BUILTIN_COMMAND_EXECUTOR_ID, version: "1" };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new Error(`unsupported job kind: ${String(kind)}`);
    }
  }
}

/**
 * Ensure a JobSpec carries a serializable executor pin for durable admission.
 * Legacy agent/command jobs receive the matching built-in pin.
 * When `input` is present it is JSON-canonicalized and size-bounded.
 */
export function pinJobExecutor(job: JobSpec): JobSpec {
  let input = job.input;
  if (input !== undefined) {
    const raw = assertBoundedJson(input);
    input = JSON.parse(raw) as unknown;
  }

  const withInput =
    input !== undefined ? { ...job, input } : (() => {
      const { input: _drop, ...rest } = job;
      void _drop;
      return rest;
    })();

  const withTools =
    job.tools !== undefined ? { ...withInput, tools: assertToolBindings(job.tools) } : withInput;
  if (job.effect !== undefined && !EFFECTS.includes(job.effect)) {
    throw new Error(`job effect must be one of ${EFFECTS.join(", ")}`);
  }

  if (job.executor) {
    const pin = assertExecutorPin(job.executor);
    return { ...withTools, executor: pin };
  }
  return { ...withTools, executor: builtinPinForKind(job.kind) };
}

const EFFECTS: readonly ExecutorEffect[] = ["read", "write", "ambiguous"];
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_TOOL_BINDINGS = 32;

/** Validate and canonicalize a job's tool bindings. */
export function assertToolBindings(value: unknown): ToolBinding[] {
  if (!Array.isArray(value)) throw new Error("job tools must be an array");
  if (value.length > MAX_TOOL_BINDINGS) throw new Error(`job declares more than ${MAX_TOOL_BINDINGS} tools`);
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (raw === null || typeof raw !== "object") throw new Error("tool binding must be an object");
    const b = raw as Record<string, unknown>;
    const name = b["name"];
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      throw new Error(`tool name must match ${TOOL_NAME.source} (got ${JSON.stringify(name)})`);
    }
    if (seen.has(name)) throw new Error(`duplicate tool ${name}`);
    seen.add(name);
    const effect = b["effect"];
    if (!EFFECTS.includes(effect as ExecutorEffect)) {
      throw new Error(`tool ${name} effect must be one of ${EFFECTS.join(", ")}`);
    }
    const binding: ToolBinding = {
      name,
      executor: assertExecutorPin(b["executor"]),
      effect: effect as ExecutorEffect,
    };
    if (b["description"] !== undefined) {
      if (typeof b["description"] !== "string") throw new Error(`tool ${name} description must be a string`);
      binding.description = b["description"];
    }
    return binding;
  });
}

/** Validate executor input against a definition's schema when present. */
export function validateExecutorInput(
  def: ExecutorDefinition,
  input: unknown,
): void {
  if (!def.inputSchema) {
    return;
  }
  if (!def.inputSchema(input)) {
    throw new Error(`executor ${def.id}: input failed schema validation`);
  }
}
