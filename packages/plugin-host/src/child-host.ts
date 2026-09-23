import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  WireValidationError,
  assertWireResponse,
  parseJsonBounded,
  type GraphDecision,
  type GraphDefinition,
  type RunView,
  type ValidationInput,
  type ValidationResult,
  type WireRequest,
  type WireResponse,
} from "@graphloom/sdk";
import type {
  CallContext,
  ChildObservation,
  ChildPluginHostOptions,
  HostResult,
  PluginHost,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export async function createChildPluginHost(
  options: ChildPluginHostOptions,
): Promise<PluginHost> {
  const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerModule =
    options.workerModule ?? fileURLToPath(new URL("./worker.js", import.meta.url));
  const entryModule = resolveEntryPath(options.entryModule);

  const child = spawn(
    process.execPath,
    [workerModule, entryModule],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    },
  );

  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const session = new ChildSession({
    child,
    stdout,
    activeVersion: options.activeVersion,
    generation: options.generation,
    timeoutMs,
    stderrChunks,
  });

  // Fail fast if the worker dies or fails to spawn before any call.
  await session.waitUntilReady();
  return session;
}

class ChildSession implements PluginHost {
  readonly activeVersion: string;
  readonly generation: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout: Interface;
  private readonly timeoutMs: number;
  private readonly stderrChunks: string[];
  private readonly pending = new Map<
    string,
    {
      resolve: (line: string) => void;
      reject: (err: Error) => void;
      generation: number;
    }
  >();
  private closed = false;
  private exitCode: number | null = null;
  private spawnError: Error | null = null;
  private readonly exitPromise: Promise<number | null>;
  private readonly spawnErrorPromise: Promise<Error>;

  constructor(args: {
    child: ChildProcessWithoutNullStreams;
    stdout: Interface;
    activeVersion: string;
    generation: number;
    timeoutMs: number;
    stderrChunks: string[];
  }) {
    this.child = args.child;
    this.stdout = args.stdout;
    this.activeVersion = args.activeVersion;
    this.generation = args.generation;
    this.timeoutMs = args.timeoutMs;
    this.stderrChunks = args.stderrChunks;

    this.child.stdin.on("error", () => {
      /* Ignore EPIPE after the child exits; callers observe via exit/timeout. */
    });

    this.spawnErrorPromise = new Promise((resolve) => {
      this.child.on("error", (err) => {
        this.spawnError = err;
        this.stderrChunks.push(err.message);
        this.rejectAllPending(err);
        resolve(err);
      });
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => {
        this.exitCode = code;
        resolve(code);
        this.rejectAllPending(new Error(`plugin child exited during pending call`));
      });
    });

    this.stdout.on("line", (line) => {
      this.onLine(line);
    });
  }

  async waitUntilReady(): Promise<void> {
    // Brief settle window; spawn `error` can win early without waiting on exit.
    await Promise.race([sleep(25), this.spawnErrorPromise.then(() => undefined)]);
    if (this.spawnError !== null && !this.closed) {
      throw new Error(`plugin child spawn failed: ${this.spawnError.message}`, {
        cause: this.spawnError,
      });
    }
    if (this.exitCode !== null && !this.closed) {
      throw new Error(
        `plugin child exited during startup (code=${String(this.exitCode)}): ${this.stderrChunks.join("")}`,
      );
    }
  }

  describe(ctx: CallContext): Promise<HostResult<GraphDefinition>> {
    return this.call(ctx, { kind: "describe" }, (res) => {
      if (res.kind !== "describe_ok") {
        throw new WireValidationError("malformed", `expected describe_ok, got ${res.kind}`);
      }
      return res.definition;
    });
  }

  advance(ctx: CallContext, view: RunView): Promise<HostResult<GraphDecision>> {
    return this.call(ctx, { kind: "advance", view }, (res) => {
      if (res.kind !== "advance_ok") {
        throw new WireValidationError("malformed", `expected advance_ok, got ${res.kind}`);
      }
      return res.decision;
    });
  }

  evaluate(
    ctx: CallContext,
    validatorId: string,
    input: ValidationInput,
  ): Promise<HostResult<ValidationResult>> {
    return this.call(ctx, { kind: "evaluate", validatorId, input }, (res) => {
      if (res.kind !== "evaluate_ok") {
        throw new WireValidationError("malformed", `expected evaluate_ok, got ${res.kind}`);
      }
      return res.result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdout.close();
    if (!this.child.killed) {
      this.child.kill("SIGKILL");
    }
    await this.exitPromise.catch(() => null);
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = parseJsonBounded(line);
    } catch {
      this.deliverToSolePending(line);
      return;
    }

    const obj = parsed as { operationId?: unknown };
    const opId = typeof obj.operationId === "string" ? obj.operationId : undefined;
    if (opId) {
      const waiter = this.pending.get(opId);
      if (!waiter) {
        // Late/unknown operation — ignore (cannot apply).
        return;
      }
      this.pending.delete(opId);
      waiter.resolve(line);
      return;
    }

    // Malformed but parseable objects may omit operationId — still observe them.
    this.deliverToSolePending(line);
  }

  private deliverToSolePending(line: string): void {
    if (this.pending.size !== 1) {
      return;
    }
    const [opId, waiter] = this.pending.entries().next().value as [
      string,
      { resolve: (line: string) => void; reject: (err: Error) => void; generation: number },
    ];
    this.pending.delete(opId);
    waiter.resolve(line);
  }

  private rejectAllPending(err: Error): void {
    for (const [opId, waiter] of this.pending) {
      this.pending.delete(opId);
      waiter.reject(err);
    }
  }

  private async call<T>(
    ctx: CallContext,
    body:
      | { kind: "describe" }
      | { kind: "advance"; view: RunView }
      | { kind: "evaluate"; validatorId: string; input: ValidationInput },
    extract: (res: WireResponse) => T,
  ): Promise<HostResult<T>> {
    if (this.closed || this.exitCode !== null || this.spawnError !== null) {
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: "crash",
          message:
            this.spawnError !== null
              ? `plugin child spawn failed: ${this.spawnError.message}`
              : `plugin child is not running (exit=${String(this.exitCode)})`,
          exitCode: this.exitCode,
        },
      };
    }

    const request: WireRequest = {
      protocolVersion: PROTOCOL_VERSION,
      runId: ctx.runId,
      operationId: ctx.operationId,
      generation: this.generation,
      expectedStateRevision: ctx.expectedStateRevision,
      activeVersion: this.activeVersion,
      ...(ctx.recoveryEpisodeId !== undefined
        ? { recoveryEpisodeId: ctx.recoveryEpisodeId }
        : {}),
      ...body,
    };

    const linePromise = new Promise<string>((resolve, reject) => {
      this.pending.set(ctx.operationId, {
        resolve,
        reject,
        generation: this.generation,
      });
    });

    try {
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (err) {
      this.pending.delete(ctx.operationId);
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: "crash",
          message: err instanceof Error ? err.message : String(err),
          exitCode: this.exitCode,
        },
      };
    }

    let line: string;
    try {
      line = await Promise.race([
        linePromise,
        sleep(this.timeoutMs).then(() => {
          throw new TimeoutError(`plugin callback timed out after ${this.timeoutMs}ms`);
        }),
        this.exitPromise.then((code) => {
          throw new CrashError(
            `plugin child exited (code=${String(code)})`,
            code,
          );
        }),
        this.spawnErrorPromise.then((err) => {
          throw new CrashError(`plugin child spawn failed: ${err.message}`, null);
        }),
      ]);
    } catch (err) {
      this.pending.delete(ctx.operationId);
      if (err instanceof TimeoutError) {
        await this.killForObservation();
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "timeout",
            message: err.message,
            exitCode: this.exitCode,
          },
        };
      }
      if (err instanceof CrashError) {
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "crash",
            message: err.message,
            exitCode: err.exitCode,
          },
        };
      }
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: "crash",
          message: err instanceof Error ? err.message : String(err),
          exitCode: this.exitCode,
        },
      };
    }

    return this.decodeResult(line, ctx, extract);
  }

  private decodeResult<T>(
    line: string,
    ctx: CallContext,
    extract: (res: WireResponse) => T,
  ): HostResult<T> {
    let response: WireResponse;
    try {
      const raw = parseJsonBounded(line);
      response = assertWireResponse(raw);
    } catch (err) {
      const obs = wireErrorToObservation(err);
      return { ok: false, observation: obs };
    }

    if (response.operationId !== ctx.operationId) {
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: "stale",
          message: `operationId mismatch: expected ${ctx.operationId}, got ${response.operationId}`,
        },
      };
    }
    if (response.generation !== this.generation) {
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: "stale",
          message: `generation mismatch: expected ${this.generation}, got ${response.generation}`,
        },
      };
    }
    if (response.activeVersion !== this.activeVersion) {
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: "stale",
          message: `activeVersion mismatch: expected ${this.activeVersion}, got ${response.activeVersion}`,
        },
      };
    }

    if (response.kind === "error") {
      return {
        ok: false,
        observation: {
          kind: "child_observation",
          code: mapWireErrorCode(response.code),
          message: response.message,
        },
      };
    }

    try {
      return { ok: true, value: extract(response) };
    } catch (err) {
      return { ok: false, observation: wireErrorToObservation(err) };
    }
  }

  private async killForObservation(): Promise<void> {
    if (!this.child.killed) {
      this.child.kill("SIGKILL");
    }
    await this.exitPromise.catch(() => null);
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

class CrashError extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = "CrashError";
    this.exitCode = exitCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve filesystem paths; keep bare tokens (test worker modes) intact. */
function resolveEntryPath(entry: string): string {
  if (path.isAbsolute(entry) || entry.includes("/") || entry.includes("\\")) {
    return path.resolve(entry);
  }
  return entry;
}

function wireErrorToObservation(err: unknown): ChildObservation {
  if (isWireValidationError(err)) {
    return {
      kind: "child_observation",
      code: mapWireErrorCode(err.code),
      message: err.message,
    };
  }
  return {
    kind: "child_observation",
    code: "internal",
    message: errorMessage(err),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isWireValidationError(err: unknown): err is WireValidationError {
  return err instanceof WireValidationError;
}

function mapWireErrorCode(
  code: string,
): ChildObservation["code"] {
  switch (code) {
    case "malformed":
    case "stale":
    case "oversized":
    case "unknown":
    case "internal":
      return code;
    default:
      return "unknown";
  }
}
