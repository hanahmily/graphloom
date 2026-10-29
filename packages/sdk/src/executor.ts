// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { assertConfinement } from "./confinement.js";
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
  /** The executor failed and asked not to be called again for this many milliseconds. */
  retryAfterMs?: number;
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
  /** Present for agent jobs: where a resumable session may be kept. */
  session?: ExecutorSession;
  /**
   * With `session`, when the host can take it: report a `sessionRef` as soon
   * as the session is saved in `session.dir` and restorable, before the job
   * returns. A job the host stops before it returns (its wall clock ran out
   * and the stop grace passed) still names the newest session reported here;
   * a `sessionRef` in the result takes precedence.
   */
  keepSession?(sessionRef: string): void;
  /**
   * The wall clock (ms) the host gives this job: the job's own `timeoutMs`
   * clamped to the operator's ceiling, or the operator's default. An
   * executor with its own watchdogs keeps them shorter than this.
   */
  timeoutMs?: number;
  /**
   * The job's declared result contract, resolved by the controller from the
   * run's GraphDefinition.resultContracts: the schema to constrain and
   * validate structured output against, and any per-dispatch reference id
   * sets. Present only for an agent job naming a contract its plugin declared.
   */
  resultContract?: {
    name: string;
    schema: Record<string, unknown>;
    references?: string[];
    knownReferences?: Record<string, import("./result-contract.js").ReferenceSet>;
  };
}

/**
 * A controller-owned directory for an agent job's resumable session. An
 * executor returns `sessionRef` in its result to make the session continuable;
 * a later job that continues it receives the same directory and `resume`.
 */
export interface ExecutorSession {
  dir: string;
  /** Session to continue. An executor that cannot restore it must fail, not start fresh. */
  resume?: string;
  /**
   * With `resume`: why the controller continues the session (its last turn
   * ran out of time, say), for the executor to tell the agent before the
   * assignment. Controller-authored text, never the plugin's.
   */
  note?: string;
}

export const MAX_SESSION_REF_CHARS = 256;

export type JsonSchemaValidator<T> = (value: unknown) => value is T;

/**
 * An executor's input shape declared as data, for whoever composes a job's
 * input. `schema` is a plain JSON Schema object; `example` is a compact valid
 * input. Documentation only: the executor's `inputSchema` predicate stays
 * authoritative, and a shape that is looser than it can still be refused.
 */
export interface ExecutorInputShape {
  schema: Record<string, unknown>;
  example?: unknown;
}

/** Most UTF-8 bytes of a declared input shape the host will carry and show. */
export const MAX_INPUT_SHAPE_BYTES = 8_192;

export interface ExecutorDefinition<TInput = unknown, TOutput = unknown> {
  readonly id: ExecutorId;
  readonly version?: string;
  readonly effect: ExecutorEffect;
  readonly capabilities?: readonly string[];
  readonly inputSchema?: JsonSchemaValidator<TInput>;
  /** Why `input` fails `inputSchema` (first failing path and rule), or undefined when it does not. Only explains a refusal. */
  readonly inputProblem?: (input: unknown) => string | undefined;
  /** The input shape as data, shown to whoever proposes a job for this executor. */
  readonly inputShape?: ExecutorInputShape;
  readonly outputSchema?: JsonSchemaValidator<TOutput>;
  /**
   * What `input` would change outside `scope.writablePaths`, if the executor can
   * tell from the input alone (a command that rewrites a user-level config
   * file, say), or undefined. Asked before a supervisor-originated job is
   * admitted; the runner separately enforces the scope when the job runs.
   */
  readonly hostEffect?: (input: unknown, scope: ExecutorScope) => string | undefined;
  execute(input: TInput, ctx: ExecutorContext): Promise<TOutput> | TOutput;
}

/** The only places a confined job may write. */
export interface ExecutorScope {
  writablePaths: readonly string[];
  /** The launch mounts a private writable /tmp, so writes under /tmp stay inside the job. */
  privateTmp?: boolean;
}

export interface DefineExecutorOptions<TInput, TOutput> {
  id: ExecutorId;
  version?: string;
  effect: ExecutorEffect;
  capabilities?: readonly string[];
  inputSchema?: JsonSchemaValidator<TInput>;
  inputProblem?: (input: unknown) => string | undefined;
  inputShape?: ExecutorInputShape;
  outputSchema?: JsonSchemaValidator<TOutput>;
  hostEffect?: (input: unknown, scope: ExecutorScope) => string | undefined;
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
  /**
   * State the executor itself must keep writing when its job is confined to the
   * run's scope, such as an agent's login and history: the directory each
   * listed env name holds, else the home-relative default. Without it, a
   * confined job's user-level state (XDG_*) is redirected into the run too.
   */
  ownState?: { env: readonly string[]; homeRelative: readonly string[] };
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
  /** Wall-clock limit (ms) for one job in the package's executor process. Default: the runner's. */
  timeoutMs?: number;
  /**
   * Most wall clock (ms) a job may ask for with its own `JobSpec.timeoutMs`;
   * a longer request is clamped to it. Default: `timeoutMs`, so a job may ask
   * for less than the default but not more.
   */
  maxTimeoutMs?: number;
}

/** Longest wall clock a job may ask for (one day); also keeps it a valid timer delay. */
export const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * Most times the controller continues the timed-out agent sessions of one
 * attempt (a work dispatch and the continuations chained from it), whatever
 * a job asks.
 */
export const MAX_TIMEOUT_CONTINUATIONS = 3;

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
    ...(options.inputProblem !== undefined ? { inputProblem: options.inputProblem } : {}),
    ...(options.inputShape !== undefined ? { inputShape: options.inputShape } : {}),
    ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
    ...(options.hostEffect !== undefined ? { hostEffect: options.hostEffect } : {}),
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
  if (
    job.continueFrom !== undefined &&
    (typeof job.continueFrom !== "string" || job.continueFrom.length === 0 || job.continueFrom.length > 128)
  ) {
    throw new Error("job continueFrom must be an operation id of at most 128 characters");
  }
  if (
    job.timeoutMs !== undefined &&
    (typeof job.timeoutMs !== "number" || !Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > MAX_JOB_TIMEOUT_MS)
  ) {
    throw new Error(`job timeoutMs must be a whole number of milliseconds from 1 to ${MAX_JOB_TIMEOUT_MS}`);
  }
  if (job.timeoutContinuations !== undefined) {
    const n = job.timeoutContinuations;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_TIMEOUT_CONTINUATIONS) {
      throw new Error(`job timeoutContinuations must be a whole number from 0 to ${MAX_TIMEOUT_CONTINUATIONS}`);
    }
    if (n > 0 && job.kind !== "agent") throw new Error(`only agent jobs carry sessions; a ${job.kind} job cannot set timeoutContinuations`);
  }

  const withConfinement = job.confinement !== undefined ? { ...withTools, confinement: assertConfinement(job.confinement) } : withTools;
  if (withConfinement.confinement?.kind === "docker" && job.kind !== "command") {
    throw new Error("only command jobs run in a docker confinement");
  }

  if (job.executor) {
    const pin = assertExecutorPin(job.executor);
    return { ...withConfinement, executor: pin };
  }
  return { ...withConfinement, executor: builtinPinForKind(job.kind) };
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

/**
 * The refusal for an input the executor's schema rejects, with the reason when
 * the executor can give one; undefined when the input is accepted.
 */
export function checkExecutorInput(def: ExecutorDefinition, input: unknown): string | undefined {
  if (!def.inputSchema || def.inputSchema(input)) return undefined;
  let problem: string | undefined;
  try {
    problem = def.inputProblem?.(input);
  } catch {
    problem = undefined;
  }
  return `executor ${def.id}: input failed schema validation${problem ? `: ${problem}` : ""}`;
}

/** Validate executor input against a definition's schema when present. */
export function validateExecutorInput(
  def: ExecutorDefinition,
  input: unknown,
): void {
  const refusal = checkExecutorInput(def, input);
  if (refusal !== undefined) throw new Error(refusal);
}

/** An input shape that is plain JSON within the size bound, or undefined. */
export function boundedInputShape(value: unknown): ExecutorInputShape | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = (value as { schema?: unknown }).schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined || Buffer.byteLength(raw, "utf8") > MAX_INPUT_SHAPE_BYTES) return undefined;
    return JSON.parse(raw) as ExecutorInputShape;
  } catch {
    return undefined;
  }
}
