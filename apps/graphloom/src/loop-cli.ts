// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { IntakeError } from "@graphloom/controller";
import { evaluate, replay, validInstant, DEFAULT_EVALUATE_LIMITS, type EvaluateDeps, type EvaluateOutcome, type Transcript } from "@graphloom/loop";
import { createChildPluginHost, type PluginHost } from "@graphloom/plugin-host";
import { LoopReplyError, validateLoopManifest, type LoopCandidatesInput, type LoopManifest } from "@graphloom/sdk";
import { confinedHookLauncher, defaultConfinementProbe, type ConfinementProbe } from "./loop-confine.js";
import { createLoopReadHost, type LoopReadHost } from "./loop-read-host.js";
import { loadRunnerConfig, RUNNER_CONFIG_ENV, type RunnerConfig } from "./runner-config.js";
import { loadBundle, readProfile, Refused, resolveProfile, type Loaded } from "./task-new.js";

export const LOOP_USAGE = [
  "graphloom loop evaluate <graph> [--out <dir>] [--profile <name|path>] [--runner-config <path>] [--now <iso>] [--replay <transcript.json>] [--json]",
];

/** Exit codes of `graphloom loop evaluate` (docs/design-loop.md section 14). */
export const LOOP_EXIT = {
  /** Candidates (possibly none), or a replay that reproduced. */
  ok: 0,
  /** The evaluator could not run: a usage error, a bundle that is not loopable, a missing runner config, or a replay that differs. */
  failed: 1,
  /** The hook refused the profile or usage. */
  refused: 2,
  /** A hook error, a malformed reply or an exceeded limit: no candidates this tick. */
  blocked: 3,
  /** A read asked to wait (rate limit): try again at `until`. */
  deferred: 4,
} as const;

/** The largest transcript `--replay` reads. */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

export interface LoopEvaluateOptions {
  graph: string;
  out?: string;
  profile?: string;
  runnerConfig?: string;
  now?: string;
  replay?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** One hook call's wall clock (ms); the evaluator's own limit. Default 10 s. */
  hookTimeoutMs?: number;
  /**
   * Why this machine cannot confine the hook child, or undefined when it can. Tests inject a failing probe; whatever it
   * says, a hook is never run unconfined: the answer can only refuse.
   */
  confinementProbe?: ConfinementProbe;
  /** Where signals are heard and how the process leaves on one; the process's own by default (tests inject). */
  signals?: SignalSource;
}

/** The part of `process` the evaluator listens to a stop signal on. */
export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  exit(code: number): void;
}

/**
 * Close what is running when the CLI is told to stop (SIGTERM, SIGINT), then exit with the conventional 128 + signal.
 * Returns the function that removes the handlers. The hook's sandbox also ends with its parent, but the read host's
 * scratch directory is the CLI's own to remove.
 */
export function closeOnSignal(close: () => Promise<void>, source: SignalSource = process): () => void {
  let stopping = false;
  const handlers = new Map<"SIGTERM" | "SIGINT", () => void>();
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    const handler = () => {
      if (stopping) return;
      stopping = true;
      void close().catch(() => undefined).finally(() => source.exit(code));
    };
    handlers.set(signal, handler);
    source.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) source.off(signal, handler);
  };
}

export function parseLoopEvaluateArgs(argv: string[]): { options: LoopEvaluateOptions; error?: string } {
  const [graph, ...rest] = argv;
  const options: LoopEvaluateOptions = { graph: graph ?? "" };
  if (graph === undefined || graph.startsWith("-")) return { options, error: "loop evaluate needs a graph id" };
  const valued = new Set(["--out", "--profile", "--runner-config", "--now", "--replay"]);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (valued.has(name)) {
      const value = eq > 0 ? token.slice(eq + 1) : rest[(i += 1)];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) return { options, error: `${name} needs a value` };
      if (name === "--out") options.out = value;
      else if (name === "--profile") options.profile = value;
      else if (name === "--runner-config") options.runnerConfig = value;
      else if (name === "--now") options.now = value;
      else options.replay = value;
    } else if (token === "--json") {
      options.json = true;
    } else {
      return { options, error: `unknown argument ${JSON.stringify(token)}` };
    }
  }
  if (options.now !== undefined && !validInstant(options.now)) return { options, error: nowError(options.now) };
  return { options };
}

function nowError(value: string): string {
  return `--now must be a UTC instant ending in Z, such as 2026-03-04T05:06:07Z, got ${JSON.stringify(value)}`;
}

const LOOP_HELP = [
  "graphloom loop: discover work with a graph's loopCandidates hook.",
  "",
  `usage: ${LOOP_USAGE.join("\n       ")}`,
  "",
  "evaluate runs the hook (the manifest's loop key names the reads it may ask for, run with the runner config's read token) in a",
  "sandbox with no network, no home and no credentials, and prints the candidates it found. It refuses to run where the sandbox",
  "(bubblewrap) is not available. Exits 0 candidates (or a replay that reproduced), 1 the evaluator could not run (usage, a bundle",
  "that cannot be looped, no sandbox, a replay that differs), 2 the hook refused the profile, 3 blocked (hook error or limit),",
  "4 deferred (a read asked to wait). --json prints { outcome, transcript }, for --replay { replay: { ok, ... } }, and for a",
  "failure { error }. --replay <file> re-runs the hook on a recorded transcript with no reads.",
];

/** `graphloom loop <subcommand>`; only `evaluate` exists. */
export async function loopCommand(argv: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  const json = argv.includes("--json");
  const help = (rest: string[]) => rest.some((a) => a === "--help" || a === "-h");
  if (argv.length === 0 || (argv[0] !== "evaluate" && help(argv)) || (argv[0] === "evaluate" && help(argv.slice(1)))) {
    if (argv.length === 0) {
      err(`usage: ${LOOP_USAGE.join("\n       ")}`);
      return LOOP_EXIT.failed;
    }
    for (const line of LOOP_HELP) out(line);
    return LOOP_EXIT.ok;
  }
  const failure = (message: string): number => {
    err(message);
    if (json) out(JSON.stringify({ error: message.split("\n")[0]!.replace(/^graphloom loop evaluate: /, "") }));
    return LOOP_EXIT.failed;
  };
  if (argv[0] !== "evaluate") return failure(`unknown loop subcommand ${JSON.stringify(argv[0])}\nusage: ${LOOP_USAGE.join("\n       ")}`);
  const parsed = parseLoopEvaluateArgs(argv.slice(1));
  if (parsed.error !== undefined) return failure(`graphloom loop evaluate: ${parsed.error}\nusage: ${LOOP_USAGE[0]}`);
  return loopEvaluate(parsed.options, out, err);
}

/** The manifest's `loop` key, checked: this bundle can be looped at protocol 1, with these reads. */
function loopManifest(loaded: Loaded, graph: string): LoopManifest {
  if (loaded.loop === undefined) throw new Refused(`graph ${graph} does not discover work: its manifest has no loop key`);
  let manifest: LoopManifest;
  try {
    manifest = validateLoopManifest(loaded.loop);
  } catch (e) {
    if (e instanceof LoopReplyError) throw new Refused(`graph ${graph}: ${e.message}`);
    throw e;
  }
  if (manifest.protocol !== 1) throw new Refused(`graph ${graph} declares loop protocol ${manifest.protocol}; this GraphLoom supports 1`);
  return manifest;
}

/** The plugin child gets no credentials: a hook is pure data in, data out, and a read token is the evaluator's alone. */
function hookEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.PATH !== undefined ? { PATH: env.PATH } : {};
}

export async function loopEvaluate(options: LoopEvaluateOptions, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  let plugin: PluginHost | undefined;
  let reads: LoopReadHost | undefined;
  let stopListening: (() => void) | undefined;
  try {
    // A usage error comes before anything is read: the runner config, the token, the bundle.
    if (options.now !== undefined && !validInstant(options.now)) throw new Refused(nowError(options.now));
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const outDir = path.resolve(cwd, options.out ?? ".");
    const graph = options.graph;
    const loaded = await loadBundle(outDir, graph);
    const manifest = loopManifest(loaded, graph);

    let profile: unknown;
    if (options.profile !== undefined) profile = await readProfile(await resolveProfile(options.profile, cwd, outDir, loaded.bundle));
    else if (loaded.requiresConfig) throw new Refused(`graph ${graph} needs a task config: name one with --profile <name|path>`);

    const transcript = options.replay !== undefined ? await readTranscript(path.resolve(cwd, options.replay)) : undefined;
    const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_EVALUATE_LIMITS.hookTimeoutMs;

    // The hook never runs unconfined: where bubblewrap is not usable the evaluator refuses, and no flag changes that.
    const unsupported = await (options.confinementProbe ?? defaultConfinementProbe)();
    if (unsupported !== undefined) throw new Refused(`the graph's hook cannot be run, since it must run confined (no network, no home, no credentials): ${unsupported}`);
    const childEnv = hookEnv(env);
    stopListening = closeOnSignal(async () => {
      await reads?.close().catch(() => undefined);
      await plugin?.close().catch(() => undefined);
    }, options.signals);
    plugin = await createChildPluginHost({
      entryModule: loaded.entry,
      activeVersion: `${graph}@${loaded.version}`,
      generation: 1,
      cwd: loaded.bundle,
      // A little above the evaluator's own limit, so its message ("hook timed out ... at round R") is the one shown.
      callbackTimeoutMs: hookTimeoutMs + 2_000,
      env: childEnv,
      launcher: confinedHookLauncher({ bundle: loaded.bundle, env: childEnv }),
    }).catch((e: unknown) => {
      throw new Refused(`the graph's plugin did not start: ${e instanceof Error ? e.message : String(e)}`);
    });
    const host = plugin;
    const operationId = () => `op-${randomUUID().slice(0, 8)}`;
    const hook: EvaluateDeps["hook"] = async (input: LoopCandidatesInput) => {
      const result = await host.loopCandidates!({ runId: "loop-evaluate", operationId: operationId(), expectedStateRevision: 0 }, input);
      if (!result.ok) throw new Error(`the graph's loopCandidates failed (${result.observation.code}): ${result.observation.message}`);
      // Undefined means the plugin has no such hook; a hook that returned nothing is a malformed reply, and says so the same way.
      if (result.value === undefined) throw new Error(`graph ${graph} does not discover work: the plugin has no loopCandidates hook`);
      return result.value;
    };

    if (transcript !== undefined) {
      const verdict = await replay(transcript, hook, { profile, timeoutMs: hookTimeoutMs });
      if (verdict.ok) {
        out(options.json === true
          ? JSON.stringify({ replay: { ok: true, rounds: transcript.rounds.length } })
          : `replay ok: ${transcript.rounds.length} round${transcript.rounds.length === 1 ? "" : "s"} reproduced`);
        return LOOP_EXIT.ok;
      }
      err(`replay differs at round ${verdict.round}: ${verdict.reason}`);
      if (options.json === true) out(JSON.stringify({ replay: { ok: false, round: verdict.round, reason: verdict.reason } }));
      return LOOP_EXIT.failed;
    }

    const tickId = randomUUID().slice(0, 8);
    let read: EvaluateDeps["read"];
    if (manifest.reads.length > 0) {
      let config: RunnerConfig | undefined;
      try {
        config = await loadRunnerConfig(options.runnerConfig !== undefined ? { ...env, [RUNNER_CONFIG_ENV]: path.resolve(cwd, options.runnerConfig) } : env);
      } catch (e) {
        throw new Refused(e instanceof Error ? e.message : String(e));
      }
      if (config === undefined) throw new Refused(`graph ${graph} declares reads, which need a runner config with a github section: run graphloom setup, or pass --runner-config <path>`);
      try {
        reads = await createLoopReadHost({ config, env, loopName: graph, tickId });
      } catch (e) {
        throw new Refused(e instanceof Error ? e.message : String(e));
      }
      read = (r, signal) => reads!.read(r, signal);
    } else {
      // No declared read: the evaluator refuses any the hook asks for (allowedReads is empty), so none reaches a host.
      read = async () => ({ status: "failed", summary: "this bundle declares no loop reads" });
    }

    const outcome = await evaluate(
      { hook, read },
      { protocol: 1, profile, now: options.now ?? new Date().toISOString(), allowedReads: manifest.reads, limits: { hookTimeoutMs } },
    );
    report(outcome, options.json === true, out);
    return LOOP_EXIT[outcome.kind === "candidates" ? "ok" : outcome.kind];
  } catch (e) {
    if (e instanceof Refused || e instanceof IntakeError) {
      err(`graphloom loop evaluate: ${e.message}`);
      if (options.json === true) out(JSON.stringify({ error: e.message }));
      return LOOP_EXIT.failed;
    }
    throw e;
  } finally {
    stopListening?.();
    await reads?.close().catch(() => undefined);
    await plugin?.close().catch(() => undefined);
  }
}

async function readTranscript(file: string): Promise<Transcript> {
  let value: unknown;
  const text = await readBounded(file, MAX_TRANSCRIPT_BYTES, "transcript");
  try {
    value = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Refused(`transcript ${file} cannot be read as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  // `--json` prints `{ outcome, transcript }`; either that file or the bare transcript is accepted.
  const bare = typeof value === "object" && value !== null && "transcript" in value ? (value as { transcript: unknown }).transcript : value;
  const t = bare as Partial<Transcript> | null;
  if (typeof bare !== "object" || t === null || t.protocol !== 1 || typeof t.now !== "string" || !Array.isArray(t.rounds)) {
    throw new Refused(`transcript ${file} is not a loop transcript (protocol 1, now, rounds)`);
  }
  return t as Transcript;
}

/** A regular file's text, refused when it is larger than `max` bytes: the size is checked on the opened file, before it is read, and the read itself stops one byte past `max`. */
async function readBounded(file: string, max: number, what: string): Promise<string> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (e) {
    throw new Refused(`${what} ${file} cannot be read as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Refused(`${what} ${file} is not a regular file`);
    if (stat.size > max) throw new Refused(`${what} ${file} is ${stat.size} bytes, more than ${max}`);
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, stat.size + 1, 0);
    if (bytesRead > max) throw new Refused(`${what} ${file} is more than ${max} bytes`);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function report(outcome: EvaluateOutcome, json: boolean, out: (line: string) => void): void {
  if (json) {
    const { transcript, ...rest } = outcome;
    out(JSON.stringify({ outcome: rest, transcript }, null, 2));
    return;
  }
  switch (outcome.kind) {
    case "candidates":
      out(`candidates: ${outcome.candidates.length}`);
      for (const c of outcome.candidates) out(`  ${c.key}  ${JSON.stringify(c.taskArgs)}`);
      break;
    case "refused":
      out(`refused: ${outcome.reason}`);
      break;
    case "blocked":
      out(`blocked: ${outcome.reason}`);
      break;
    case "deferred":
      out(`deferred until ${outcome.until}: ${outcome.reason}`);
      break;
  }
}
