import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_COMMAND_EXECUTOR_ID, defineExecutor, type ExecutorContext, type ExecutorDefinition } from "@graphloom/sdk";

export const COMMAND_RUN_ID = BUILTIN_COMMAND_EXECUTOR_ID;

/** Names a file each command may write a machine-readable report to, such as `go test -json` output. */
export const REPORT_FILE_ENV = "GRAPHLOOM_REPORT_FILE";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;
const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_COMMANDS = 16;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;
const OUTPUT_TAIL_BYTES = 8_192;
const REPORT_TAIL_BYTES = 65_536;
const KILL_GRACE_MS = 5_000;
const COMMAND_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CommandSpec {
  /** Names the command in evidence; unique within the job. */
  id: string;
  /** Program and arguments; no shell is involved unless argv names one. */
  argv: string[];
  timeoutMs?: number;
}

export interface CommandInput {
  commands: CommandSpec[];
  /** Run later commands after one fails. Default: stop at the first failure. */
  continueOnFailure?: boolean;
  /** Non-secret variables added to the inherited environment. */
  env?: Record<string, string>;
}

/** What one command did, recorded as `command` evidence. */
export interface CommandOutcome {
  id: string;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The job was stopped while this command ran. */
  aborted: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /** The program could not be started, e.g. it is not installed. */
  spawnError?: string;
  /** Tail of the file named by `GRAPHLOOM_REPORT_FILE`, when the command wrote one. */
  report?: { text: string; truncated: boolean };
}

export function commandSucceeded(outcome: CommandOutcome): boolean {
  return outcome.exitCode === 0 && outcome.spawnError === undefined && !outcome.timedOut && !outcome.aborted;
}

function isInput(v: unknown): v is CommandInput {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.commands) || o.commands.length === 0 || o.commands.length > MAX_COMMANDS) return false;
  const ids = new Set<string>();
  for (const raw of o.commands as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || !COMMAND_ID.test(c.id) || ids.has(c.id)) return false;
    ids.add(c.id);
    if (
      !Array.isArray(c.argv) ||
      c.argv.length === 0 ||
      c.argv.length > MAX_ARGS ||
      !c.argv.every((a) => typeof a === "string" && a.length <= MAX_ARG_CHARS) ||
      (c.argv[0] as string).length === 0
    ) {
      return false;
    }
    if (
      c.timeoutMs !== undefined &&
      (typeof c.timeoutMs !== "number" || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1 || c.timeoutMs > MAX_COMMAND_TIMEOUT_MS)
    ) {
      return false;
    }
  }
  if (o.continueOnFailure !== undefined && typeof o.continueOnFailure !== "boolean") return false;
  if (o.env !== undefined) {
    if (o.env === null || typeof o.env !== "object" || Array.isArray(o.env)) return false;
    for (const [name, value] of Object.entries(o.env)) {
      if (!ENV_NAME.test(name) || name === REPORT_FILE_ENV || typeof value !== "string") return false;
    }
  }
  return true;
}

/**
 * The command executor: runs each command in the job's workspace, in order,
 * and reports what it did. A command that exits non-zero is an observation,
 * not an executor failure: the job still succeeds and its evidence carries the
 * exit code, so a check that is expected to fail can be judged.
 */
export function createCommandExecutor(): ExecutorDefinition<CommandInput> {
  return defineExecutor<CommandInput, unknown>({
    id: COMMAND_RUN_ID,
    version: "1",
    effect: "write",
    inputSchema: isInput,
    async execute(input, ctx: ExecutorContext) {
      const outcomes: CommandOutcome[] = [];
      for (const spec of input.commands) {
        if (ctx.signal?.aborted) break;
        const outcome = await runCommand(spec, input.env ?? {}, ctx);
        outcomes.push(outcome);
        if (outcome.aborted || (!commandSucceeded(outcome) && input.continueOnFailure !== true)) break;
      }
      const failed = outcomes.filter((o) => !commandSucceeded(o));
      const skipped = input.commands.length - outcomes.length;
      return {
        status: "ok",
        summary:
          failed.length === 0 && skipped === 0
            ? `${outcomes.length} command(s) succeeded`
            : `${failed.map(describeFailure).join("; ")}${skipped > 0 ? `; ${skipped} not run` : ""}`,
        evidence: outcomes.map((command) => ({ kind: "command", payload: { command } })),
      };
    },
  });
}

function describeFailure(o: CommandOutcome): string {
  if (o.spawnError !== undefined) return `${o.id} could not start: ${o.spawnError}`;
  if (o.aborted) return `${o.id} stopped`;
  if (o.timedOut) return `${o.id} timed out`;
  return o.signal !== null ? `${o.id} killed by ${o.signal}` : `${o.id} exited ${o.exitCode}`;
}

async function runCommand(spec: CommandSpec, extraEnv: Record<string, string>, ctx: ExecutorContext): Promise<CommandOutcome> {
  const reportFile = path.join(ctx.artifactDir, "reports", ctx.operationId, `${spec.id}.out`);
  await mkdir(path.dirname(reportFile), { recursive: true });
  const started = Date.now();
  const stdout = new Tail(OUTPUT_TAIL_BYTES);
  const stderr = new Tail(OUTPUT_TAIL_BYTES);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let timedOut = false;
  let aborted = false;

  const result = await new Promise<{ exitCode: number | null; signal: string | null; spawnError?: string }>((resolve) => {
    // An abort during the awaits above has already fired; nothing awaits between this check and the listener.
    if (ctx.signal?.aborted) {
      aborted = true;
      resolve({ exitCode: null, signal: null });
      return;
    }
    let child;
    try {
      child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: ctx.worktreePath,
        env: { ...process.env, ...extraEnv, [REPORT_FILE_ENV]: reportFile },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a stop reaches everything the command started.
        detached: true,
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.pid === undefined || killTimer !== undefined) return;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child.pid!, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    const settle = (value: { exitCode: number | null; signal: string | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    };
    child.once("error", (err) => settle({ exitCode: null, signal: null, spawnError: err.message }));
    // Cleanup starts when the direct child exits, not when its pipes close: a
    // descendant holding them would otherwise keep a finished command running
    // until its time limit. Nothing may outlive the command and keep changing
    // the workspace.
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        if (child.pid !== undefined && groupAlive(child.pid)) {
          terminate();
          await waitForGroupExit(child.pid, KILL_GRACE_MS * 2);
        }
        // A descendant that left the group can still hold the pipes.
        let drainTimer: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
          closed.then(() => true),
          new Promise<false>((r) => (drainTimer = setTimeout(() => r(false), KILL_GRACE_MS))),
        ]);
        clearTimeout(drainTimer);
        if (!drained) {
          child.stdout.destroy();
          child.stderr.destroy();
        }
        settle({ exitCode: code, signal });
      })();
    });
  });

  const report = await readTail(reportFile, REPORT_TAIL_BYTES);
  return {
    id: spec.id,
    argv: spec.argv,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    aborted,
    durationMs: Date.now() - started,
    stdoutTail: stdout.text(),
    stderrTail: stderr.text(),
    ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
    ...(report !== undefined ? { report } : {}),
  };
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForGroupExit(pid: number, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (groupAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already exited */
  }
}

/** Keeps the last `limit` bytes written. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > this.limit * 2) this.compact();
  }

  text(): string {
    this.compact();
    const body = Buffer.concat(this.chunks).toString("utf8");
    return this.dropped ? `…${body}` : body;
  }

  private compact(): void {
    if (this.size <= this.limit) return;
    const all = Buffer.concat(this.chunks);
    this.chunks = [all.subarray(all.length - this.limit)];
    this.size = this.limit;
    this.dropped = true;
  }
}

async function readTail(file: string, limit: number): Promise<{ text: string; truncated: boolean } | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), truncated: size > limit };
  } finally {
    await handle.close();
  }
}
