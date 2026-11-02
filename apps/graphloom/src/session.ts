// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  captureClaudeFork,
  restoreClaudeFork,
  type ClaudeFork,
} from "@graphloom/agent-harness/claude";
import { captureCodexFork, restoreCodexFork, type CodexFork } from "@graphloom/agent-harness/codex";
import { minimalEnv } from "@graphloom/agent-harness/process";
import { OPENING_NOTE_PREFIX, contextTokens, conversationTurns, turnExtract } from "@graphloom/agent-harness/session";
import {
  DEFAULT_MAX_CONVERSATION_BYTES,
  loadRunState,
  openRefusal,
  openingNote,
  recordConversation,
  resolveStateDir,
  selectSession,
  sessionRows,
  type AgentSessionRecord,
  type SessionRow,
} from "@graphloom/controller";
import { BUILTIN_AGENT_EXECUTOR_ID } from "@graphloom/sdk";
import { CODING_AGENT_RUN_ID } from "@graphloom/executor-coding-agent";
import { agentExecutables, confineWorker, confinementUnsupported } from "@graphloom/runner";
import { loadRunnerConfig, type RunnerConfig } from "./runner-config.js";
import {
  launcherPaths,
  probeLauncher,
  probeRefusal,
  resolveExecutable,
  sessionSetup,
  type SessionHarness,
  type SessionSetup,
} from "./session-launcher.js";

export const SESSION_USAGE = [
  "graphloom session list <stateDir|runId> [--state-root <dir>] [--json]",
  "graphloom session open <stateDir|runId> [--stage <stageId> [--from-original] | <session>] [--state-root <dir>]",
];

export interface SessionIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Whether stdin is a terminal (tests stub it). */
  stdinIsTty?: () => boolean;
  /** Runner config override (tests); otherwise read from `$GRAPHLOOM_RUNNER_CONFIG` or the default path. */
  config?: RunnerConfig | undefined;
}

/** A refusal: the message, and exit code 2. */
class Refused extends Error {}

/** `graphloom session list|open`. Exit codes: 0, 2 for a usage error or a refusal, otherwise the agent's own. */
export async function sessionCommand(args: string[], io: SessionIo): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "list") return await list(rest, io);
    if (sub === "open") return await open(rest, io);
    io.err(`usage:\n  ${SESSION_USAGE.join("\n  ")}`);
    return 2;
  } catch (err) {
    if (err instanceof Refused) {
      io.err(`graphloom session: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

function parse(rest: string[], valued: string[], flags: string[], usage: string): { positional: string[]; values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (valued.includes(a)) {
      const v = rest[(i += 1)];
      if (v === undefined || v.startsWith("--")) throw new Refused(`${a} needs a value; usage: ${usage}`);
      values[a] = v;
    } else if (flags.includes(a)) {
      seen.add(a);
    } else if (a.startsWith("--")) {
      throw new Refused(`unknown option ${a}; usage: ${usage}`);
    } else {
      positional.push(a);
    }
  }
  return { positional, values, flags: seen };
}

async function loadState(runRef: string, stateRoot: string | undefined) {
  const ref = runRef.includes("/") || runRef.includes("\\") ? path.resolve(runRef) : runRef;
  const stateDir = await resolveStateDir(ref, stateRoot !== undefined ? path.resolve(stateRoot) : undefined).catch((err: unknown) => {
    throw new Refused(err instanceof Error ? err.message : String(err));
  });
  return { stateDir, state: await loadRunState(stateDir) };
}

async function list(rest: string[], io: SessionIo): Promise<number> {
  const usage = SESSION_USAGE[0]!;
  const p = parse(rest, ["--state-root"], ["--json"], usage);
  if (p.positional.length !== 1) throw new Refused(`name one run; usage: ${usage}`);
  const { state } = await loadState(p.positional[0]!, p.values["--state-root"]);
  const rows = sessionRows(state);
  if (p.flags.has("--json")) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  io.out(formatRows(rows));
  return 0;
}

/** One line per session; a conversation shows the session it forked, so a chain reads conversation, conversation, job session. */
export function formatRows(rows: readonly SessionRow[]): string {
  if (rows.length === 0) return "no agent session was recorded";
  const lines: string[] = [];
  for (const r of rows) {
    const when = r.origin === "operator" ? `${r.startedAt ?? "?"} .. ${r.endedAt ?? r.settledAt}` : `settled ${r.settledAt}`;
    const lineage =
      r.origin === "operator"
        ? ` parent ${r.parentRef ?? r.parent ?? "?"} (${r.parent ?? "?"})`
        : r.continuedFrom !== undefined
          ? ` continues ${r.continuedFrom}`
          : "";
    lines.push(
      `${r.id}  stage ${r.stageId}#${r.attempt}  ${r.origin === "operator" ? "conversation" : `${r.dispatchKey}`}  ${r.executorId}${r.harness !== undefined ? ` (${r.harness})` : ""}  ${r.sessionRef}  ${r.status}  ${when}${lineage}${r.contextTokens !== undefined ? `  context ${r.contextTokens} tokens` : ""}  [${r.openable}]`,
    );
  }
  return lines.join("\n");
}

/** The harness an `AgentSessionRecord` belongs to, from its ref. */
function recordHarness(record: AgentSessionRecord): SessionHarness {
  const byPrefix = record.sessionRef.startsWith("claude-") ? "claude-code" : record.sessionRef.startsWith("codex-") ? "codex" : undefined;
  if (byPrefix === undefined) throw new Refused(`session ${record.sessionRef} was not recorded by Claude Code or Codex`);
  return byPrefix;
}

const GITHUB_TOKEN_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN"];

/** The environment the opened agent gets: the harness's basics and `passEnv`, never a GitHub token. */
function agentEnv(setup: SessionSetup, config: RunnerConfig | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = minimalEnv(env, setup.passEnv);
  for (const name of [...GITHUB_TOKEN_NAMES, ...(config?.github?.tokenEnv !== undefined ? [config.github.tokenEnv] : []), ...(config?.github?.writeTokenEnv !== undefined ? [config.github.writeTokenEnv] : [])]) delete kept[name];
  if (setup.harness === "claude-code") kept.CLAUDE_CONFIG_DIR = setup.store;
  else kept.CODEX_HOME = setup.store;
  return kept;
}

/** The kernel setting that would let a confined process push keystrokes into the operator's shell. */
function tiocstiEnabled(): boolean {
  try {
    return readFileSync("/proc/sys/dev/tty/legacy_tiocsti", "utf8").trim() === "1";
  } catch {
    return false;
  }
}

async function open(rest: string[], io: SessionIo): Promise<number> {
  const usage = SESSION_USAGE[1]!;
  const p = parse(rest, ["--state-root", "--stage"], ["--from-original"], usage);
  if (p.positional.length < 1 || p.positional.length > 2) throw new Refused(`name one run and at most one session; usage: ${usage}`);
  const stage = p.values["--stage"];
  const ref = p.positional[1];
  if (stage !== undefined && ref !== undefined) throw new Refused(`name a session or --stage, not both; usage: ${usage}`);
  if (p.flags.has("--from-original") && stage === undefined) throw new Refused(`--from-original goes with --stage; usage: ${usage}`);
  const env = io.env ?? process.env;
  const { stateDir, state } = await loadState(p.positional[0]!, p.values["--state-root"]);

  const picked = selectSession(state, { ...(stage !== undefined ? { stage } : {}), ...(ref !== undefined ? { ref } : {}), ...(p.flags.has("--from-original") ? { fromOriginal: true } : {}) });
  if ("refusal" in picked) throw new Refused(picked.refusal);
  const record = picked;
  const refusal = openRefusal(state, record);
  if (refusal !== undefined) throw new Refused(refusal);
  if (record.executorId !== CODING_AGENT_RUN_ID && record.executorId !== BUILTIN_AGENT_EXECUTOR_ID) {
    throw new Refused(`session ${record.sessionRef} was recorded by executor ${record.executorId}, not the coding agent; only a coding-agent session can be opened`);
  }
  const harness = recordHarness(record);
  if (record.confinement?.kind === "docker") throw new Refused("the session's job ran in a docker confinement, which is for command jobs; an agent session is not opened under it");

  // The saved copy's shape must agree with the ref's harness.
  const saved = path.join(record.sessionDir, `${record.sessionRef}.json`);
  const meta = await readFile(saved, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, () => undefined);
  if (meta === undefined) throw new Refused(`no saved copy of session ${record.sessionRef} (${saved}); it cannot be restored`);
  if (harness === "claude-code" ? "rollout" in meta : "project" in meta) {
    throw new Refused(`session ${record.sessionRef} names ${harness === "claude-code" ? "Claude Code" : "Codex"}, but its saved copy has the shape of the other harness's; refusing to open it in either`);
  }

  const config = io.config !== undefined ? io.config : await loadRunnerConfig(env).catch((err: unknown) => {
    throw new Refused(err instanceof Error ? err.message : String(err));
  });
  const setup = (() => {
    try {
      return sessionSetup(harness, config, env);
    } catch (err) {
      throw new Refused((err as Error).message);
    }
  })();
  const bin = await resolveExecutable(setup.argv[0]!, env);
  if (bin === undefined) throw new Refused(`${setup.argv[0]} (${setup.source === "command" ? `the ${harness} command` : "the session launcher"}) was not found; install it or set it in the runner config`);

  // Before anything launches: a launcher that does not pass the arguments through is refused, never replaced by a fresh session.
  const probe = await probeLauncher(harness, [bin, ...setup.argv.slice(1)], env);
  if (!probe.ok) throw new Refused(probeRefusal(setup, probe));

  const isTty = io.stdinIsTty !== undefined ? io.stdinIsTty() : process.stdin.isTTY === true;
  if (!isTty) throw new Refused("session open hands the terminal to the agent and needs one on stdin; run it from a terminal");
  const unsupported = await confinementUnsupported();
  if (unsupported !== undefined) throw new Refused(`nothing runs unconfined, and this machine cannot confine the session: ${unsupported}`);
  if (tiocstiEnabled()) {
    throw new Refused("the kernel allows TIOCSTI (dev.tty.legacy_tiocsti = 1), so a confined process could push keystrokes into your shell; set it to 0 (sudo sysctl dev.tty.legacy_tiocsti=0) and retry");
  }
  const worktree = state.worktreePath;
  if (!existsSync(worktree)) throw new Refused(`the run's worktree ${worktree} does not exist`);

  const maxBytes = config?.maxConversationBytes ?? DEFAULT_MAX_CONVERSATION_BYTES;
  const note = `${openingNote(state, record)}`;
  const noteLine = `${OPENING_NOTE_PREFIX} ${note}`;
  await mkdir(setup.store, { recursive: true });

  // Restore and fork: the saved copy is only read; the fork gets a fresh id GraphLoom chose.
  let fork: ClaudeFork | CodexFork;
  try {
    fork =
      harness === "claude-code"
        ? await restoreClaudeFork({ configDir: setup.store, savedDir: record.sessionDir, parentRef: record.sessionRef })
        : await restoreCodexFork({ home: setup.store, savedDir: record.sessionDir, parentRef: record.sessionRef });
  } catch (err) {
    throw new Refused(`cannot restore session ${record.sessionRef}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const forkId = harness === "claude-code" ? (fork as ClaudeFork).forkId : (fork as CodexFork).forkThread;
  const tail =
    harness === "claude-code"
      ? ["--resume", (fork as ClaudeFork).parentId, "--fork-session", "--session-id", forkId, "--append-system-prompt", noteLine, noteLine]
      : ["resume", ...(probe.sandboxFlag === true ? ["--sandbox", "danger-full-access"] : []), forkId, noteLine];
  const argv = [bin, ...setup.argv.slice(1), ...tail];

  const scratch = await mkdtemp(path.join(os.tmpdir(), "graphloom-session-"));
  const staged = await mkdtemp(path.join(os.tmpdir(), "graphloom-conversation-"));
  const startedAt = new Date().toISOString();
  let exitCode: number;
  try {
    const stateDirs = setup.stateDirs;
    for (const dir of stateDirs) await mkdir(dir, { recursive: true });
    const sandbox =
      record.confinement?.kind === "bwrap"
        ? {
            network: true,
            mask: record.confinement.mask,
            // The chat is not a graph job: whatever the job could write, the opened session may only read.
            binds: record.confinement.binds
              .filter((b) => existsSync(b.path.startsWith("~/") ? path.join(os.homedir(), b.path.slice(2)) : b.path))
              .map((b) => ({ path: b.path, readOnly: true })),
          }
        : undefined;
    const env2 = agentEnv(setup, config, env);
    let confined;
    try {
      confined = confineWorker({
        command: argv[0]!,
        args: argv.slice(1),
        env: env2,
        cwd: worktree,
        scratchDir: scratch,
        writable: [],
        trustedWritable: [setup.store, ...stateDirs],
        readPaths: [...agentExecutables(env), ...launcherPaths(bin), process.execPath],
        keepUserState: true,
        ...(sandbox !== undefined ? { sandbox } : {}),
      });
    } catch (err) {
      throw new Refused(`the session cannot be confined: ${err instanceof Error ? err.message : String(err)}`);
    }
    io.out(`opening a fork of ${record.sessionRef} (${record.stageId}); the fork is ${harness === "claude-code" ? (fork as ClaudeFork).forkRef : (fork as CodexFork).forkRef}; the checkout is read-only and the conversation is recorded when the agent exits`);
    exitCode = await new Promise<number>((resolve, reject) => {
      // bubblewrap reports its sandbox on fd 3 (--json-status-fd): a pipe it can write, drained and ignored here.
      const child = spawn(confined.command, confined.args, { env: confined.env, stdio: ["inherit", "inherit", "inherit", "pipe"] });
      child.stdio[3]?.on("data", () => undefined);
      // The terminal's interrupt goes to the agent; this process waits for it.
      const ignore = (): void => undefined;
      process.on("SIGINT", ignore);
      const term = (): void => void child.kill("SIGTERM");
      process.on("SIGTERM", term);
      child.on("error", (err) => {
        process.off("SIGINT", ignore);
        process.off("SIGTERM", term);
        reject(err);
      });
      child.on("close", (code, signal) => {
        process.off("SIGINT", ignore);
        process.off("SIGTERM", term);
        resolve(code ?? (signal !== null ? 128 + (os.constants.signals[signal] ?? 0) : 1));
      });
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  const endedAt = new Date().toISOString();
  try {
    await capture({ io, stateDir, record, harness, fork, setup, staged, maxBytes, startedAt, endedAt });
  } catch (err) {
    io.err(`graphloom session: the conversation was not recorded: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
  }
  return exitCode;
}

/** After the agent exits: read the fork by the id GraphLoom chose, and record the conversation, or say why not. */
async function capture(args: {
  io: SessionIo;
  stateDir: string;
  record: AgentSessionRecord;
  harness: SessionHarness;
  fork: ClaudeFork | CodexFork;
  setup: SessionSetup;
  staged: string;
  maxBytes: number;
  startedAt: string;
  endedAt: string;
}): Promise<void> {
  const { io, harness, fork, setup, staged, maxBytes } = args;
  const forkId = harness === "claude-code" ? (fork as ClaudeFork).forkId : (fork as CodexFork).forkThread;
  const captured =
    harness === "claude-code"
      ? await captureClaudeFork({ configDir: setup.store, fork: fork as ClaudeFork, targetDir: staged, maxBytes })
      : await captureCodexFork({ home: setup.store, fork: fork as CodexFork, targetDir: staged, maxBytes });
  if (captured === undefined) {
    io.err(`graphloom session: no transcript exists under the fork id ${forkId} in ${setup.store}, so nothing was recorded (a launcher may have dropped --session-id or pointed the agent at another store); GraphLoom does not guess at another session`);
    return;
  }
  const turns = conversationTurns(harness, captured.transcript, fork.parentTranscript);
  if (turns.length === 0) {
    io.out("the fork has no operator turn: nothing was recorded");
    return;
  }
  const sha256 = createHash("sha256").update(captured.transcript).digest("hex");
  const outcome = await recordConversation(args.stateDir, {
    parentId: args.record.operationId,
    sessionRef: captured.ref,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    ...(captured.stored ? { stagedDir: staged } : {}),
    transcript: { sha256, bytes: captured.bytes, ...(captured.stored ? {} : { omitted: true as const }) },
    contextTokens: contextTokens(harness, captured.transcript),
    turns: turnExtract(turns),
  });
  if (!outcome.recorded) {
    io.err(`graphloom session: nothing was recorded: ${outcome.reason}; the fork stays in the agent's own store (${harness === "claude-code" ? `claude --resume ${forkId}` : `codex resume ${forkId}`})`);
    return;
  }
  io.out(
    `recorded conversation ${outcome.recordId} (${captured.ref}${captured.stored ? "" : `, transcript omitted: ${captured.bytes} bytes is over the ${maxBytes} bound`}); evidence ${outcome.evidenceRef}`,
  );
}

