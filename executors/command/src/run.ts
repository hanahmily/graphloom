import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  BUILTIN_COMMAND_EXECUTOR_ID,
  defineExecutor,
  type ExecutorContext,
  type ExecutorDefinition,
  type ExecutorScope,
} from "@graphloom/sdk";

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

/**
 * Why `v` is not a valid command input: the first failing path and its rule,
 * or undefined when it is valid. `isCommandInput` is defined in terms of it.
 */
export function commandInputProblem(v: unknown): string | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "input: must be an object";
  const o = v as Record<string, unknown>;
  if (o.commands === undefined) {
    const keys = Object.keys(o);
    return `commands: required, an array of 1-${MAX_COMMANDS} {id, argv} objects${keys.length > 0 ? ` (got only: ${keys.slice(0, 5).join(", ")})` : ""}`;
  }
  if (!Array.isArray(o.commands) || o.commands.length === 0 || o.commands.length > MAX_COMMANDS) {
    return `commands: must be an array of 1-${MAX_COMMANDS} {id, argv} objects`;
  }
  const ids = new Set<string>();
  for (const [i, raw] of (o.commands as unknown[]).entries()) {
    const at = `commands[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return `${at}: must be an object {id, argv}`;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string") return `${at}.id: required string`;
    if (!COMMAND_ID.test(c.id)) return `${at}.id: must match ${COMMAND_ID.source}`;
    if (ids.has(c.id)) return `${at}.id: duplicate id ${JSON.stringify(c.id)}; ids are unique within the job`;
    ids.add(c.id);
    if (!Array.isArray(c.argv)) return `${at}.argv: must be an array of strings, e.g. ["go","env"] (got ${describeType(c.argv)})`;
    if (c.argv.length === 0 || c.argv.length > MAX_ARGS) return `${at}.argv: must hold 1-${MAX_ARGS} strings`;
    const bad = c.argv.findIndex((a) => typeof a !== "string" || a.length > MAX_ARG_CHARS);
    if (bad >= 0) return `${at}.argv[${bad}]: must be a string of at most ${MAX_ARG_CHARS} characters`;
    if ((c.argv[0] as string).length === 0) return `${at}.argv[0]: the program must not be empty`;
    if (
      c.timeoutMs !== undefined &&
      (typeof c.timeoutMs !== "number" || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1 || c.timeoutMs > MAX_COMMAND_TIMEOUT_MS)
    ) {
      return `${at}.timeoutMs: must be an integer from 1 to ${MAX_COMMAND_TIMEOUT_MS}`;
    }
  }
  if (o.continueOnFailure !== undefined && typeof o.continueOnFailure !== "boolean") return "continueOnFailure: must be a boolean";
  if (o.env !== undefined) {
    if (o.env === null || typeof o.env !== "object" || Array.isArray(o.env)) return "env: must be an object of string values";
    for (const [name, value] of Object.entries(o.env)) {
      if (!ENV_NAME.test(name)) return `env.${name}: name must match ${ENV_NAME.source}`;
      if (name === REPORT_FILE_ENV) return `env.${name}: reserved, the executor sets it`;
      if (typeof value !== "string") return `env.${name}: must be a string`;
    }
  }
  return undefined;
}

export function isCommandInput(v: unknown): v is CommandInput {
  return commandInputProblem(v) === undefined;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

/** The input shape as data: a JSON Schema matching `isCommandInput` where a schema can say it, and a minimal example. */
export const COMMAND_INPUT_SHAPE = {
  schema: {
    type: "object",
    required: ["commands"],
    properties: {
      commands: {
        type: "array",
        minItems: 1,
        maxItems: MAX_COMMANDS,
        items: {
          type: "object",
          required: ["id", "argv"],
          properties: {
            id: { type: "string", pattern: COMMAND_ID.source, description: "Unique within the job." },
            argv: {
              type: "array",
              minItems: 1,
              maxItems: MAX_ARGS,
              items: { type: "string", maxLength: MAX_ARG_CHARS },
              description: "Program then arguments, a plain array of strings; no shell unless argv names one.",
            },
            timeoutMs: { type: "integer", minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS },
          },
        },
      },
      continueOnFailure: { type: "boolean" },
      env: {
        type: "object",
        propertyNames: { pattern: ENV_NAME.source },
        additionalProperties: { type: "string" },
        description: `Not ${REPORT_FILE_ENV}.`,
      },
    },
  },
  example: { commands: [{ id: "go-env", argv: ["go", "env", "GOCACHE"] }] },
} as const;

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
    inputSchema: isCommandInput,
    inputProblem: commandInputProblem,
    inputShape: COMMAND_INPUT_SHAPE,
    hostEffect: (input, scope) => (isCommandInput(input) ? commandHostEffect(input, scope) : undefined),
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

/** Programs whose every path operand is something they create, change or remove. */
const WRITES_ALL_OPERANDS = new Set(["rm", "rmdir", "unlink", "shred", "mv", "mkdir", "touch", "chmod", "chown", "truncate", "tee"]);
/** Programs that write only their destination: the last operand, or the one `-t` names. */
const WRITES_DESTINATION = new Set(["cp", "install", "ln", "rsync"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope"]);
const OUTSIDE_SCOPE = "outside the run's worktree and run-scoped directories";

/**
 * The first change a command visibly makes outside the confined scope: a
 * mutating program aimed at a path outside it, or a tool setting that rewrites
 * the operator's user-level configuration. Only command positions and real
 * write destinations are inspected, so reads (`cp /etc/hosts here`,
 * `git config --global --get x`) pass. A heuristic that only explains a
 * refusal early: the runner's confinement is what enforces the scope.
 */
export function commandHostEffect(input: CommandInput, scope: ExecutorScope): string | undefined {
  const roots = [...scope.writablePaths.map((p) => path.resolve(p)), "/dev", ...(scope.privateTmp === true ? ["/tmp"] : [])];
  const outside = (token: string): boolean => {
    if (token.startsWith("~")) return true;
    if (!token.startsWith("/")) return false;
    const abs = path.resolve(token);
    return !roots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
  };
  const unquote = (t: string) => t.replace(/^(["'])(.*)\1$/, "$2");
  const escapes = (target: string | undefined, program: string): string | undefined =>
    target !== undefined && outside(unquote(target)) ? `\`${program}\` changes ${unquote(target)}, ${OUTSIDE_SCOPE}` : undefined;

  /** One simple command: tokens with no separator among them. */
  const simple = (given: string[], redirects: string[], shown: string): string | undefined => {
    const tokens = [...given];
    for (const target of redirects) {
      if (outside(target)) return `output redirected to ${target}, ${OUTSIDE_SCOPE}`;
    }
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
    if (tokens.length === 0) return undefined;
    const program = path.basename(tokens[0]!);
    const args = tokens.slice(1);
    const operands = args.filter((a) => !a.startsWith("-"));
    if (program === "go" && args[0] === "env" && args.some((a) => a === "-w" || a === "-u")) {
      return `\`${shown}\` rewrites the operator's global Go configuration`;
    }
    if (program === "git" && args[0] === "config" && args.some((a) => a === "--global" || a === "--system") && !args.some((a) => CONFIG_READ_FLAGS.has(a))) {
      return `\`${shown}\` rewrites the operator's global git configuration`;
    }
    if (
      program === "npm" &&
      ["set", "config"].includes(args[0] ?? "") &&
      (args[0] === "set" || ["set", "delete", "edit"].includes(args[1] ?? "")) &&
      args.some((a) => a === "-g" || a === "--global" || a === "--location=user" || a === "--location=global")
    ) {
      return `\`${shown}\` rewrites the operator's global npm configuration`;
    }
    if (WRITES_ALL_OPERANDS.has(program)) {
      for (const operand of operands) {
        const found = escapes(operand, program);
        if (found !== undefined) return found;
      }
    }
    if (WRITES_DESTINATION.has(program)) {
      const flagged = args.findIndex((a) => a === "-t" || a === "--target-directory");
      const target =
        flagged >= 0
          ? args[flagged + 1]
          : (args.find((a) => a.startsWith("--target-directory="))?.slice("--target-directory=".length) ?? (operands.length >= 2 ? operands[operands.length - 1] : undefined));
      return escapes(target, program);
    }
    return undefined;
  };

  /**
   * The simple commands of a shell script, with quoting respected: words, and the
   * targets of `>` and `>>`, split at `;`, `&`, `|` and newlines. Not a full shell
   * parser (no expansions, heredocs or subshells), only enough to find commands and redirects.
   */
  const shellCommands = (script: string): Array<{ words: string[]; redirects: string[] }> => {
    const commands: Array<{ words: string[]; redirects: string[] }> = [];
    let words: string[] = [];
    let redirects: string[] = [];
    let word: string | undefined;
    let redirecting = false;
    const endWord = () => {
      if (word === undefined) return;
      if (redirecting) redirects.push(word);
      else words.push(word);
      redirecting = false;
      word = undefined;
    };
    const endCommand = () => {
      endWord();
      redirecting = false;
      if (words.length > 0 || redirects.length > 0) commands.push({ words, redirects });
      words = [];
      redirects = [];
    };
    for (let i = 0; i < script.length; i += 1) {
      const c = script[i]!;
      if (c === "'" || c === '"') {
        const close = script.indexOf(c, i + 1);
        const end = close < 0 ? script.length : close;
        word = (word ?? "") + script.slice(i + 1, end);
        i = end;
      } else if (c === "\\" && i + 1 < script.length) {
        word = (word ?? "") + script[i + 1]!;
        i += 1;
      } else if (/\s/.test(c) && c !== "\n") {
        endWord();
      } else if (c === ">") {
        endWord();
        if (script[i + 1] === ">") i += 1;
        redirecting = true;
      } else if (c === ";" || c === "&" || c === "|" || c === "\n") {
        endCommand();
      } else {
        word = (word ?? "") + c;
      }
    }
    endCommand();
    return commands;
  };

  for (const spec of input.commands) {
    // Redirection exists only in a shell script: in a plain argv `>` is just an argument.
    const direct = simple(spec.argv, [], spec.argv.join(" ").slice(0, 120));
    if (direct !== undefined) return direct;
    const flag = spec.argv.indexOf("-c");
    if (SHELLS.has(path.basename(spec.argv[0]!)) && flag > 0 && spec.argv[flag + 1] !== undefined) {
      const script = spec.argv[flag + 1]!;
      for (const command of shellCommands(script)) {
        const inner = simple(command.words, command.redirects, script.slice(0, 120));
        if (inner !== undefined) return inner;
      }
    }
  }
  return undefined;
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
