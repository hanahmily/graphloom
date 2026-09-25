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
}

/** Operator-supplied grants for one executor package. */
export interface ExecutorBinding {
  /** Secrets by binding name; delivered over stdin and redacted from results. */
  credentials?: Record<string, string>;
  /** Effects granted to the package. Default: `["read"]`. */
  allowedEffects?: readonly ExecutorEffect[];
  /** Values for names the manifest lists in `configEnv`. */
  env?: Record<string, string>;
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

  if (job.executor) {
    const pin = assertExecutorPin(job.executor);
    return { ...withInput, executor: pin };
  }
  return { ...withInput, executor: builtinPinForKind(job.kind) };
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
