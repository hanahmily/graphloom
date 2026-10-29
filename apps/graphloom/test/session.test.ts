// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { makeCliEnv, type CliEnv } from "./cli-env.js";
import { splitWords } from "../src/session-launcher.js";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/main.js");
const stub = path.join(here, "fixtures", "fake-session-agent.mjs");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const EXECUTOR = "graphloom.coding-agent/run";
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

interface World {
  env: CliEnv;
  stateDir: string;
  runId: string;
  worktree: string;
  claudeId: string;
  codexThread: string;
  claudeDir: string;
  codexDir: string;
  logFile: string;
  /** Saved copy of the Claude job session. */
  jobSessionDir: string;
}

const claudeTranscript = (id: string): string =>
  [
    { type: "user", sessionId: id, message: { role: "user", content: "Answer the questions about the pull request." } },
    { type: "assistant", sessionId: id, message: { role: "assistant", content: [{ type: "text", text: "Q1: reuse the base helper." }], usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 } } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

const codexRollout = (thread: string): string =>
  [
    { timestamp: "2026-10-29T10:00:00.000Z", type: "session_meta", payload: { id: thread, cwd: "/w", cli_version: "0.130.0" } },
    { timestamp: "2026-10-29T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Check the answers." } },
    { timestamp: "2026-10-29T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "All supported." } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

async function digestTree(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(p.slice(dir.length));
      if (e.isDirectory()) await walk(p);
      else h.update(await readFile(p));
    }
  };
  await walk(dir);
  return h.digest("hex");
}

/** A stopped run of the hello graph (a fake Claude that fails to start), given recorded agent sessions the way a real run would leave them. */
async function world(): Promise<World> {
  const env = await makeCliEnv(cleanups);
  await env.fakeClaude({ start: [{ error: "the model is unavailable" }] });
  const run = await env.graphloom("run", "task.yaml");
  const report = JSON.parse(run.stdout) as { runId: string; status: string; stateDir: string; worktreePath: string };
  expect(report.status).toBe("stopped");
  const claudeId = randomUUID();
  const codexThread = randomUUID();
  const sessions = path.join(report.stateDir, "agent-sessions");
  const jobSessionDir = path.join(sessions, "op-answerer");
  const codexDir = path.join(sessions, "op-checker");
  // The answerer's saved Claude session, with a side file, and the checker's saved Codex rollout.
  await mkdir(path.join(jobSessionDir, `claude-${claudeId}`, "subagents"), { recursive: true });
  await writeFile(path.join(jobSessionDir, `claude-${claudeId}.json`), JSON.stringify({ project: "-fake-project", model: null, systemPromptSha256: "abc" }));
  await writeFile(path.join(jobSessionDir, `claude-${claudeId}.jsonl`), claudeTranscript(claudeId));
  await writeFile(path.join(jobSessionDir, `claude-${claudeId}`, "subagents", "agent-1.jsonl"), '{"type":"user"}\n');
  await mkdir(codexDir, { recursive: true });
  const rolloutRel = `sessions/2026/10/29/rollout-2026-10-29T10-00-00-${codexThread}.jsonl`;
  await writeFile(path.join(codexDir, `codex-${codexThread}.json`), JSON.stringify({ rollout: rolloutRel, model: null }));
  await writeFile(path.join(codexDir, `codex-${codexThread}.jsonl`), codexRollout(codexThread));
  const confinement = { kind: "bwrap", network: true, mask: [path.join(report.worktreePath, "CLAUDE.md")], binds: [] };
  const record = (over: Record<string, unknown>) => ({
    operationId: "op-answerer",
    stageId: "write",
    attempt: 1,
    generation: 1,
    dispatchKey: "answerer",
    executorId: EXECUTOR,
    status: "ok",
    sessionRef: `claude-${claudeId}`,
    sessionDir: jobSessionDir,
    settledAt: "2026-10-29T10:00:00.000Z",
    harness: "claude-code",
    confinement,
    summary: "answered 34 questions",
    ...over,
  });
  const statePath = path.join(report.stateDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  state.agentSessions = [
    record({}),
    record({ operationId: "op-checker", dispatchKey: "answer-checker", sessionRef: `codex-${codexThread}`, sessionDir: codexDir, harness: "codex", settledAt: "2026-10-29T10:05:00.000Z", summary: "32 supported, 2 partial" }),
  ];
  await writeFile(statePath, JSON.stringify(state, null, 2));
  // A masked file in the checkout, a probe target outside it, and the stand-in agent's wrappers.
  await writeFile(path.join(report.worktreePath, "CLAUDE.md"), "PR-CONTROLLED-INSTRUCTIONS\n");
  const logFile = path.join(env.dir, "agent-log.jsonl");
  await mkdir(path.join(env.dir, "bin"), { recursive: true });
  for (const kind of ["claude", "codex"]) {
    await writeFile(path.join(env.dir, "bin", `session-${kind}`), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${kind} "$@"\n`, { mode: 0o755 });
  }
  await writeFile(path.join(env.dir, "home-file.txt"), "visible only outside the sandbox\n");
  const w: World = { env, stateDir: report.stateDir, runId: report.runId, worktree: report.worktreePath, claudeId, codexThread, claudeDir: path.join(env.dir, "claude-config"), codexDir: path.join(env.dir, "codex-home"), logFile, jobSessionDir };
  await mkdir(w.claudeDir, { recursive: true });
  await mkdir(w.codexDir, { recursive: true });
  await runnerConfig(w, {});
  return w;
}

async function runnerConfig(w: World, extra: { claude?: Record<string, unknown>; codex?: Record<string, unknown>; top?: Record<string, unknown> }): Promise<void> {
  const pass = ["FAKE_AGENT_SCRIPT", "FAKE_AGENT_LOG_DIR", "FAKE_AGENT_MASKED", "FAKE_AGENT_HOME_FILE", "FAKE_AGENT_STATE_DIR", "GH_TOKEN"];
  const config = {
    harness: "claude-code",
    harnesses: ["claude-code", "codex"],
    allowUnrestricted: true,
    github: { tokenEnv: "GH_TOKEN" },
    ...extra.top,
    claude: { command: path.join(w.env.dir, "bin", "session-claude"), configDir: w.claudeDir, passEnv: pass, ...extra.claude },
    codex: { command: path.join(w.env.dir, "bin", "session-codex"), codexHome: w.codexDir, passEnv: pass, ...extra.codex },
  };
  await writeFile(path.join(w.env.dir, "runner.json"), JSON.stringify(config));
  w.env.env.GRAPHLOOM_RUNNER_CONFIG = path.join(w.env.dir, "runner.json");
}

interface Out {
  stdout: string;
  stderr: string;
  code: number;
}

/** `graphloom session …` with a terminal on stdin (through script(1)), or without one. */
async function session(w: World, args: string[], options: { tty?: boolean; script?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<Out> {
  const env: NodeJS.ProcessEnv = {
    ...w.env.env,
    SHELL: "/bin/sh",
    FAKE_AGENT_LOG_DIR: w.claudeDir,
    FAKE_AGENT_SCRIPT: JSON.stringify(options.script ?? {}),
    FAKE_AGENT_MASKED: path.join(w.worktree, "CLAUDE.md"),
    FAKE_AGENT_HOME_FILE: path.join(w.env.dir, "home-file.txt"),
    GH_TOKEN: "ghp_secret_token",
    ...options.env,
  };
  const plain = (r: { stdout?: string; stderr?: string }, code: number): Out => ({ stdout: (r.stdout ?? "").replaceAll("\r", ""), stderr: (r.stderr ?? "").replaceAll("\r", ""), code });
  // On a terminal the agent's stderr and stdout are one stream.
  const merged = (r: { stdout?: string; stderr?: string }, code: number): Out => {
    const all = `${r.stdout ?? ""}${r.stderr ?? ""}`.replaceAll("\r", "");
    return { stdout: all, stderr: all, code };
  };
  const argv = args.map((a) => (a === w.runId ? w.stateDir : a));
  if (options.tty === false) {
    return execFileP(process.execPath, [cli, "session", ...argv], { cwd: w.env.dir, env }).then((r) => plain(r, 0), (e: { stdout?: string; stderr?: string; code?: number }) => plain(e, typeof e.code === "number" ? e.code : 1));
  }
  const command = [process.execPath, cli, "session", ...argv].map(shq).join(" ");
  return execFileP("script", ["-qefc", command, "/dev/null"], { cwd: w.env.dir, env }).then((r) => merged(r, 0), (e: { stdout?: string; stderr?: string; code?: number }) => merged(e, typeof e.code === "number" ? e.code : 1));
}

async function agentLog(w: World): Promise<Array<{ kind: string; argv: string[]; cwd: string; tty: boolean; env: Record<string, string | null>; probes: Record<string, unknown> }>> {
  const read = async (dir: string) => (await readFile(path.join(dir, "agent-log.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as never);
  return [...(await read(w.claudeDir)), ...(await read(w.codexDir))];
}

async function state(w: World): Promise<{ agentSessions: Array<Record<string, unknown>>; evidence: Array<{ ref: string; payload?: Record<string, unknown> }>; status: string }> {
  return JSON.parse(await readFile(path.join(w.stateDir, "state.json"), "utf8")) as never;
}

async function patchState(w: World, patch: (s: Record<string, unknown>) => void): Promise<void> {
  const p = path.join(w.stateDir, "state.json");
  const s = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
  patch(s);
  await writeFile(p, JSON.stringify(s, null, 2));
}

const conversations = async (w: World) => (await state(w)).agentSessions.filter((r) => r.origin === "operator");
const claudeParentBytes = (w: World) => digestTree(w.jobSessionDir);

describe("graphloom session list", () => {
  it("shows one row per recorded session, with whether it can be opened, as text and as JSON", async () => {
    const w = await world();
    await patchState(w, (s) => {
      (s.agentSessions as unknown[]).push({ operationId: "op-pi", stageId: "write", attempt: 1, generation: 1, dispatchKey: "verifier", executorId: EXECUTOR, status: "ok", sessionRef: "pi-abc", sessionDir: "/x", settledAt: "2026-10-29T10:06:00.000Z" });
    });
    const text = await session(w, ["list", w.runId, "--state-root", "test-repo/graphloom-state"], { tty: false });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(`op-answerer  stage write#1  answerer  ${EXECUTOR} (claude-code)  claude-${w.claudeId}  ok`);
    expect(text.stdout).toMatch(/op-checker .*answer-checker .*codex-.*\[ok\]/);
    expect(text.stdout).toMatch(/op-pi .*\[pi: no interactive restore\]/);
    const json = JSON.parse((await session(w, ["list", w.stateDir, "--json"], { tty: false })).stdout) as Array<{ id: string; openable: string; harness: string }>;
    expect(json.map((r) => [r.id, r.harness, r.openable])).toEqual([["op-answerer", "claude-code", "ok"], ["op-checker", "codex", "ok"], ["op-pi", "pi", "pi: no interactive restore"]]);
  }, 120_000);
});

describe("graphloom session open: a Claude Code session", () => {
  it("forks the answerer under its confinement, records the conversation, and leaves the saved session byte-identical", async () => {
    const w = await world();
    const before = await claudeParentBytes(w);
    const r = await session(w, ["open", w.runId, "--stage", "write", "--state-root", "test-repo/graphloom-state"], { script: { exit: 3 } });
    // The agent's own exit code is GraphLoom's.
    expect(r.code, r.stderr + r.stdout).toBe(3);
    const [call] = await agentLog(w);
    expect(call).toBeDefined();
    const a = call!.argv;
    const ref = (flag: string) => a[a.indexOf(flag) + 1]!;
    expect(a).toEqual(expect.arrayContaining(["--resume", w.claudeId, "--fork-session", "--session-id"]));
    expect(ref("--resume")).toBe(w.claudeId);
    expect(ref("--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(ref("--session-id")).not.toBe(w.claudeId);
    // One line of status, as the system prompt addition; it names the session, the later job and the run.
    const note = ref("--append-system-prompt");
    expect(note).not.toContain("\n");
    expect(note).toContain("fork of the write session");
    expect(note).toContain("a job of answer-checker settled ok (32 supported, 2 partial)");
    expect(note).toContain("run status stopped");
    expect(call!.tty).toBe(true);
    expect(call!.cwd).toBe(w.worktree);
    // The confinement: the checkout is read-only, the masked file reads empty, no token, the home is hidden but the agent's store is writable.
    expect(call!.probes.writeCheckout).toBe("EROFS");
    // The masked file is an empty, unreadable stand-in: the pull request's instructions never reach the agent.
    expect(call!.probes.maskedRead).not.toContain("PR-CONTROLLED-INSTRUCTIONS");
    expect(call!.probes.homeFile).toBe(false);
    expect(call!.probes.storeWrite).toBe("ok");
    // The home is an empty tmpfs: a write there never reaches the real one.
    expect(await stat(path.join(w.env.dir, ".fake-agent-home-write")).catch(() => undefined)).toBeUndefined();
    expect(call!.env.GH_TOKEN).toBeNull();
    expect(call!.env.CLAUDE_CONFIG_DIR).toBe(w.claudeDir);
    // The conversation is recorded: a record under the stage, its parent, the evidence with the operator's turn verbatim.
    const [conv] = await conversations(w);
    expect(conv).toMatchObject({ stageId: "write", parent: "op-answerer", origin: "operator", harness: "claude-code", dispatchKey: "operator", sessionRef: `claude-${ref("--session-id")}`, confinement: { kind: "bwrap" } });
    expect((conv!.transcript as { omitted?: boolean }).omitted).toBeUndefined();
    expect(conv!.contextTokens).toBe(3 + 400 + 50);
    const s = await state(w);
    const evidence = s.evidence.map((e) => e.payload).find((p) => p?.type === "operator-conversation") as Record<string, unknown>;
    expect(evidence).toMatchObject({ type: "operator-conversation", stageId: "write", baseSession: `claude-${w.claudeId}`, rootSession: `claude-${w.claudeId}`, forkSession: `claude-${ref("--session-id")}`, harness: "claude-code" });
    expect(evidence.turns).toEqual([{ operator: "why did you settle the first question that way?", answer: "Because the base commit already had the helper." }]);
    // The stored copy is self-contained: it holds the parent's turns and the new ones, and a later fork needs only it.
    const stored = await readFile(path.join(w.stateDir, "agent-sessions", "operator", `claude-${ref("--session-id")}.jsonl`), "utf8");
    expect(stored).toContain("Q1: reuse the base helper.");
    expect(stored).toContain("why did you settle the first question that way?");
    expect(await readFile(path.join(w.stateDir, "agent-sessions", "operator", `claude-${ref("--session-id")}`, "fork-side.txt"), "utf8")).toBe("side\n");
    // The recorded session, its transcript, its side files and its metadata are exactly as they were.
    expect(await claudeParentBytes(w)).toBe(before);
    // The checkout is untouched.
    expect(await stat(path.join(w.worktree, ".fake-agent-write")).catch(() => undefined)).toBeUndefined();
  }, 120_000);

  it("chains: a second open of the stage forks the first conversation, --from-original forks the job session, and list shows the parents", async () => {
    const w = await world();
    const first = await session(w, ["open", w.runId, "--stage", "write"], { script: { ask: "first question" } });
    expect(first.code, first.stderr).toBe(0);
    const second = await session(w, ["open", w.runId, "--stage", "write"], { script: { ask: "second question" } });
    expect(second.code, second.stderr).toBe(0);
    const third = await session(w, ["open", w.runId, "--stage", "write", "--from-original"], { script: { ask: "third question" } });
    expect(third.code, third.stderr).toBe(0);
    const calls = await agentLog(w);
    const resumed = calls.map((c) => c.argv[c.argv.indexOf("--resume") + 1]);
    const forks = calls.map((c) => c.argv[c.argv.indexOf("--session-id") + 1]);
    expect(resumed[0]).toBe(w.claudeId);
    expect(resumed[1]).toBe(forks[0]);
    expect(resumed[2]).toBe(w.claudeId);
    expect(calls[1]!.argv.join(" ")).toContain("an earlier conversation on the write session");
    const convs = await conversations(w);
    expect(convs).toHaveLength(3);
    expect(convs.map((c) => c.parent)).toEqual(["op-answerer", convs[0]!.operationId, "op-answerer"]);
    // The second conversation's saved copy holds the first conversation's turns; the third starts beside it.
    const secondText = await readFile(path.join(w.stateDir, "agent-sessions", "operator", `${convs[1]!.sessionRef}.jsonl`), "utf8");
    expect(secondText).toContain("first question");
    expect(secondText).toContain("second question");
    const thirdText = await readFile(path.join(w.stateDir, "agent-sessions", "operator", `${convs[2]!.sessionRef}.jsonl`), "utf8");
    expect(thirdText).not.toContain("first question");
    // The evidence of the second conversation carries only its own turn.
    const evidence = (await state(w)).evidence.map((e) => e.payload).filter((p) => p?.type === "operator-conversation");
    expect((evidence[1] as { turns: unknown }).turns).toEqual([{ operator: "second question", answer: "Because the base commit already had the helper." }]);
    expect(evidence[1]).toMatchObject({ baseSession: convs[0]!.sessionRef, rootSession: `claude-${w.claudeId}` });
    const list = await session(w, ["list", w.runId], { tty: false });
    expect(list.stdout).toContain(`parent ${convs[0]!.sessionRef} (${convs[0]!.operationId})`);
    expect(list.stdout).toContain(`parent claude-${w.claudeId} (op-answerer)`);
    // By ref: any recorded session, a conversation included.
    const byRef = await session(w, ["open", w.runId, convs[1]!.sessionRef as string], { script: { ask: "fourth question" } });
    expect(byRef.code, byRef.stderr).toBe(0);
    expect((await agentLog(w))[3]!.argv[(await agentLog(w))[3]!.argv.indexOf("--resume") + 1]).toBe(forks[1]);
  }, 240_000);

  it("records nothing for a fork with no operator turn, or one whose agent dropped --session-id, and says why", async () => {
    const w = await world();
    const quiet = await session(w, ["open", w.runId, "--stage", "write"], { script: { noTurn: true } });
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stdout).toContain("the fork has no operator turn: nothing was recorded");
    expect(await conversations(w)).toEqual([]);
    const dropped = await session(w, ["open", w.runId, "--stage", "write"], { script: { dropSessionId: true } });
    expect(dropped.stderr).toMatch(/no transcript exists under the fork id [0-9a-f-]{36}.*nothing was recorded.*does not guess at another session/);
    expect(await conversations(w)).toEqual([]);
    expect((await state(w)).evidence.filter((e) => e.payload?.type === "operator-conversation")).toEqual([]);
  }, 120_000);

  it("records an over-bound conversation as transcript omitted (digest and extract kept), and refuses it as a fork source", async () => {
    const w = await world();
    await runnerConfig(w, { top: { maxConversationBytes: 2048 } });
    const r = await session(w, ["open", w.runId, "--stage", "write"], { script: { pad: 5000 } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("transcript omitted");
    const [conv] = await conversations(w);
    expect(conv!.transcript).toMatchObject({ omitted: true });
    const evidence = (await state(w)).evidence.map((e) => e.payload).find((p) => p?.type === "operator-conversation") as Record<string, unknown>;
    expect(evidence.transcript).toMatch(/^omitted \(\d+ bytes\)$/);
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.turns).toHaveLength(1);
    expect(await stat(path.join(w.stateDir, "agent-sessions", "operator", `${conv!.sessionRef}.jsonl`)).catch(() => undefined)).toBeUndefined();
    // The stage's latest conversation is the omitted one: it cannot be forked, and the message names --from-original.
    const again = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/over the bound and not stored.*--from-original/);
    expect((await session(w, ["open", w.runId, "--stage", "write", "--from-original"])).code).toBe(0);
  }, 120_000);

  it("records nothing when the run finished while the agent ran", async () => {
    const w = await world();
    // The stand-in is told nothing; the run is finished before the capture by a stand-in controller: flip the status as the agent runs.
    const flip = `${process.execPath} -e ${shq(`const fs=require("fs");const p=${JSON.stringify(path.join(w.stateDir, "state.json"))};const s=JSON.parse(fs.readFileSync(p,"utf8"));s.status="succeeded";fs.writeFileSync(p,JSON.stringify(s))`)}`;
    await writeFile(path.join(w.env.dir, "bin", "session-claude"), `#!/bin/sh\n${flip}\nexec "${process.execPath}" "${stub}" claude "$@"\n`, { mode: 0o755 });
    // The open reads the state, probes the wrapper (which finishes the run), then launches: the capture finds the run finished.
    const r = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/nothing was recorded: run .* finished while the agent ran, and its saved sessions were removed; the fork stays in the agent's own store \(claude --resume [0-9a-f-]{36}\)/);
    expect(await conversations(w)).toEqual([]);
  }, 120_000);
});

describe("graphloom session open: a Codex session", () => {
  it("copies the rollout under a new thread id, resumes that thread with the status line as its first turn, and records the conversation", async () => {
    const w = await world();
    const before = await digestTree(path.join(w.stateDir, "agent-sessions", "op-checker"));
    const r = await session(w, ["open", w.runId, "op-checker"], { script: { ask: "why partial?", answer: "Two citations were weaker." } });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const [call] = await agentLog(w);
    expect(call!.kind).toBe("codex");
    expect(call!.argv[0]).toBe("resume");
    // The thread the agent resumed is a new one; the prompt is the status line.
    const thread = call!.argv.find((a) => /^[0-9a-f-]{36}$/.test(a))!;
    expect(thread).not.toBe(w.codexThread);
    expect(call!.argv.at(-1)).toMatch(/^\[GraphLoom opening note\] This is a fork of the write session/);
    expect(call!.argv).toEqual(expect.arrayContaining(["--sandbox", "danger-full-access"]));
    expect(call!.probes.writeCheckout).toBe("EROFS");
    expect(call!.env.CODEX_HOME).toBe(w.codexDir);
    expect(call!.env.GH_TOKEN).toBeNull();
    // The copy: its session_meta names the new thread; the recorded thread's own rollout was never written.
    const day = path.join(w.codexDir, "sessions");
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else files.push(path.join(d, e.name));
      }
    };
    await walk(day);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(`-${thread}.jsonl`)).toBe(true);
    expect((JSON.parse((await readFile(files[0]!, "utf8")).split("\n")[0]!) as { payload: { id: string } }).payload.id).toBe(thread);
    expect(await digestTree(path.join(w.stateDir, "agent-sessions", "op-checker"))).toBe(before);
    const [conv] = await conversations(w);
    expect(conv).toMatchObject({ parent: "op-checker", harness: "codex", sessionRef: `codex-${thread}`, contextTokens: 777 });
    const evidence = (await state(w)).evidence.map((e) => e.payload).find((p) => p?.type === "operator-conversation") as { turns: unknown };
    expect(evidence.turns).toEqual([{ operator: "why partial?", answer: "Two citations were weaker." }]);
    // Chained: the saved fork copy is restorable by a later open.
    const again = await session(w, ["open", w.runId, `codex-${thread}`], { script: { ask: "and the third?" } });
    expect(again.code, again.stderr).toBe(0);
    expect((await agentLog(w))[1]!.argv.find((a) => /^[0-9a-f-]{36}$/.test(a))).not.toBe(thread);
  }, 120_000);
});

describe("graphloom session open: refusals", () => {
  it("refuses a Pi session, a ref whose harness disagrees with its record or saved copy, another executor, and a docker confinement", async () => {
    const w = await world();
    await patchState(w, (s) => {
      const base = { stageId: "write", attempt: 1, generation: 1, status: "ok", settledAt: "2026-10-29T11:00:00.000Z", sessionDir: "/nowhere" };
      (s.agentSessions as unknown[]).push(
        { ...base, operationId: "op-pi", dispatchKey: "verifier", executorId: EXECUTOR, sessionRef: "pi-abc" },
        { ...base, operationId: "op-mismatch", dispatchKey: "m", executorId: EXECUTOR, sessionRef: `claude-${w.claudeId}`, harness: "codex", sessionDir: w.jobSessionDir },
        { ...base, operationId: "op-shape", dispatchKey: "s", executorId: EXECUTOR, sessionRef: `codex-${w.codexThread}`, harness: "codex", sessionDir: w.jobSessionDir },
        { ...base, operationId: "op-other", dispatchKey: "o", executorId: "acme.agent/code", sessionRef: `claude-${w.claudeId}`, sessionDir: w.jobSessionDir },
        { ...base, operationId: "op-docker", dispatchKey: "d", executorId: EXECUTOR, sessionRef: `claude-${w.claudeId}`, sessionDir: w.jobSessionDir, confinement: { kind: "docker", image: "x@sha256:0", cpus: 1, memory: "1g", pids: 1, tmp: "1g", wallClockMs: 1, writable: [], readOnly: [], env: {} } },
      );
    });
    const open = (ref: string) => session(w, ["open", w.runId, ref]);
    const pi = await open("op-pi");
    expect(pi.code).toBe(2);
    expect(pi.stderr).toMatch(/Pi session: Pi has no interactive restore/);
    expect((await open("op-mismatch")).stderr).toMatch(/record says codex but its ref names claude-code/);
    expect((await open("op-shape")).stderr).toMatch(/no saved copy of session codex-/);
    expect((await open("op-other")).stderr).toMatch(/recorded by executor acme\.agent\/code, not the coding agent/);
    expect((await open("op-docker")).stderr).toMatch(/docker confinement/);
    expect(await agentLog(w)).toEqual([]);
  }, 120_000);

  it("refuses without a terminal, while the owning job runs, after the run finished, and with both a stage and a session", async () => {
    const w = await world();
    const noTty = await session(w, ["open", w.runId, "--stage", "write"], { tty: false });
    expect(noTty.code).toBe(2);
    expect(noTty.stderr).toMatch(/needs one on stdin/);
    await patchState(w, (s) => {
      s.pendingDispatch = { operationId: "op-next", generation: 1, stageId: "write", status: "pending", job: { stageId: "write", kind: "agent", purpose: "work", instruction: "x", continueFrom: "op-answerer" } };
    });
    const running = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(running.code).toBe(2);
    expect(running.stderr).toMatch(/still running/);
    // Another stage's session is unaffected.
    expect((await session(w, ["open", w.runId, "op-checker"])).code).toBe(0);
    await patchState(w, (s) => {
      delete s.pendingDispatch;
      s.status = "succeeded";
    });
    const finished = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(finished.code).toBe(2);
    expect(finished.stderr).toMatch(/has succeeded: its saved sessions were removed/);
    expect((await session(w, ["list", w.runId], { tty: false })).stdout).toMatch(/\[wiped\]/);
    const both = await session(w, ["open", w.runId, "op-checker", "--stage", "write"]);
    expect(both.stderr).toMatch(/a session or --stage, not both/);
    expect((await session(w, ["open", w.runId, "--from-original"])).stderr).toMatch(/goes with --stage/);
    expect((await session(w, ["open", w.runId, "nope"])).stderr).toMatch(/has no session "nope"/);
  }, 120_000);

  it("--stage picks the stage's first-dispatched key (the answerer), not a later checker, and the latest attempt", async () => {
    const w = await world();
    await patchState(w, (s) => {
      const sessions = s.agentSessions as Array<Record<string, unknown>>;
      // A checker of the same stage and attempt, settled after the answerer, and an older attempt's session.
      sessions.push({ ...sessions[0]!, operationId: "op-stage-checker", dispatchKey: "stage-checker", settledAt: "2026-10-29T10:10:00.000Z" });
      sessions.push({ ...sessions[0]!, operationId: "op-old", attempt: 0, settledAt: "2026-10-29T09:00:00.000Z" });
    });
    const r = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(r.code, r.stderr).toBe(0);
    expect((await conversations(w))[0]!.parent).toBe("op-answerer");
  }, 120_000);
});

describe("graphloom session open: the session launcher", () => {
  async function launcher(w: World, name: string, extra = ""): Promise<string> {
    const file = path.join(w.env.dir, "bin", name);
    // Records that it was used, then starts the real stand-in with the arguments after its own.
    await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "$FAKE_AGENT_LOG_DIR/launcher.log"\n${extra}\nexec "${process.execPath}" "${stub}" claude "$@"\n`, { mode: 0o755 });
    await chmod(file, 0o755);
    return file;
  }
  const launcherLog = async (w: World) => (await readFile(path.join(w.claudeDir, "launcher.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);

  it("prefixes session open only: a headless job keeps claude.command; capture through the wrapper finds the fork by the id GraphLoom chose", async () => {
    const w = await world();
    const wrapper = await launcher(w, "hapi-claude");
    await runnerConfig(w, { claude: { sessionLauncher: [wrapper] } });
    // A headless job with the same config runs claude.command (the stand-in, which a launcher would not be).
    const headless = await w.env.graphloom("run", "task.yaml");
    void headless;
    expect(await launcherLog(w)).toEqual([]);
    const r = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const log = await launcherLog(w);
    expect(log.some((l) => l.includes("--resume") && l.includes("--fork-session") && l.includes("--session-id") && l.includes("--append-system-prompt"))).toBe(true);
    expect(log.some((l) => l.endsWith("--help"))).toBe(true);
    expect(await conversations(w)).toHaveLength(1);
  }, 180_000);

  it("the environment override replaces the configured launcher; the launcher's state directories are writable inside the confinement and the rest of the home is not", async () => {
    const w = await world();
    const configured = await launcher(w, "configured-launcher");
    const override = await launcher(w, "override launcher");
    const stateDir = path.join(w.env.dir, "launcher-state");
    await runnerConfig(w, { claude: { sessionLauncher: [configured], sessionLauncherStateDirs: [stateDir] } });
    const r = await session(w, ["open", w.runId, "--stage", "write"], { env: { GRAPHLOOM_CLAUDE_SESSION_LAUNCHER: `"${override}" --extra 'two words'`, FAKE_AGENT_STATE_DIR: stateDir } });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const log = await launcherLog(w);
    expect(log.every((l) => l.startsWith("override launcher"))).toBe(true);
    expect(log.some((l) => l.includes("--extra two words --resume"))).toBe(true);
    const [call] = await agentLog(w);
    expect(call!.probes.launcherStateWrite).toBe("ok");
    expect(await stat(path.join(w.env.dir, ".fake-agent-home-write")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(stateDir, "marker"), "utf8")).toBe("x");
  }, 120_000);

  it("a launcher that drops --session-id records nothing; one that cannot resume is refused by the probe before anything launches, with no fresh session", async () => {
    const w = await world();
    const dropper = path.join(w.env.dir, "bin", "dropper");
    await writeFile(
      path.join(w.env.dir, "bin", "dropper.mjs"),
      `import { execFileSync } from "node:child_process";\nconst a = process.argv.slice(2);\nconst i = a.indexOf("--session-id");\nif (i >= 0) a.splice(i, 2);\ntry { execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(stub)}, "claude", ...a], { stdio: "inherit" }); } catch (e) { process.exit(e.status ?? 1); }\n`,
    );
    await writeFile(dropper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(w.env.dir, "bin", "dropper.mjs")}" "$@"\n`, { mode: 0o755 });
    await runnerConfig(w, { claude: { sessionLauncher: [dropper] } });
    const dropped = await session(w, ["open", w.runId, "--stage", "write"]);
    expect(dropped.stderr).toMatch(/no transcript exists under the fork id/);
    expect(await conversations(w)).toEqual([]);

    // A hapi-codex-like launcher: its --help fails, so it may not accept the resume arguments either.
    const rejecting = await launcher(w, "hapi-codex-like");
    await runnerConfig(w, { claude: { sessionLauncher: [rejecting] } });
    const before = (await agentLog(w)).length;
    const refused = await session(w, ["open", w.runId, "--stage", "write"], { script: { helpFails: true } });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/session launcher .*hapi-codex-like.* failed its probe `.*--help`: exit 1: Unsupported shared launch flag: --help/);
    expect(refused.stderr).toMatch(/Remove claude\.sessionLauncher to start plain/);
    expect(refused.stderr).toMatch(/never starts a fresh session/);
    expect((await agentLog(w)).length).toBe(before);
    expect(await conversations(w)).toEqual([]);
  }, 180_000);

  it("refuses a Codex launcher whose resume --help fails, and doctor warns with the same message", async () => {
    const w = await world();
    const rejecting = path.join(w.env.dir, "bin", "codex-like");
    await writeFile(rejecting, `#!/bin/sh\necho "Unsupported shared Codex launch flag: --help" >&2\nexit 1\n`, { mode: 0o755 });
    await runnerConfig(w, { codex: { sessionLauncher: [rejecting] } });
    const refused = await session(w, ["open", w.runId, "op-checker"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/failed its probe `.*codex-like resume --help`.*Unsupported shared Codex launch flag/);
    expect(refused.stderr).toMatch(/Remove codex\.sessionLauncher/);
    const { probeConfiguredLaunchers, probeRefusal } = await import("../src/session-launcher.js");
    const { loadRunnerConfig } = await import("../src/runner-config.js");
    const probes = await probeConfiguredLaunchers(await loadRunnerConfig(w.env.env), w.env.env);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.probe.ok).toBe(false);
    expect(probeRefusal(probes[0]!.setup, probes[0]!.probe)).toBe(refused.stderr.trim().replace(/^graphloom session: /, ""));
  }, 120_000);
});

describe("runner config launcher keys, and shell-style words", () => {
  it("parses the launcher and its state directories and refuses a malformed one", async () => {
    const { parseRunnerConfig } = await import("../src/runner-config.js");
    const base = { harness: "claude-code", allowUnrestricted: true };
    const ok = parseRunnerConfig({ ...base, claude: { sessionLauncher: ["hapi", "claude"], sessionLauncherStateDirs: ["~/.hapi", "/var/hapi"] }, codex: { sessionLauncher: ["hapi", "codex"] }, maxConversationBytes: 1000 });
    expect(ok.claude?.sessionLauncher).toEqual(["hapi", "claude"]);
    expect(ok.claude?.sessionLauncherStateDirs?.[1]).toBe("/var/hapi");
    expect(path.isAbsolute(ok.claude!.sessionLauncherStateDirs![0]!)).toBe(true);
    expect(ok.maxConversationBytes).toBe(1000);
    for (const bad of [{ sessionLauncher: [] }, { sessionLauncher: ["hapi", ""] }, { sessionLauncher: "hapi claude" }, { sessionLauncherStateDirs: ["relative/dir"] }, { sessionLauncherStateDirs: "x" }]) {
      expect(() => parseRunnerConfig({ ...base, claude: bad }), JSON.stringify(bad)).toThrow(/sessionLauncher/);
    }
    expect(() => parseRunnerConfig({ ...base, claude: { launcher: ["x"] } })).toThrow(/unsupported setting/);
  });

  it("splits words as a shell would, honoring quotes and expanding nothing", () => {
    expect(splitWords(`hapi claude`)).toEqual(["hapi", "claude"]);
    expect(splitWords(`"a b" 'c d' e\\ f ""`)).toEqual(["a b", "c d", "e f", ""]);
    expect(splitWords(`x $HOME ~ * $(id)`)).toEqual(["x", "$HOME", "~", "*", "$(id)"]);
    expect(splitWords(`"say \\"hi\\""`)).toEqual([`say "hi"`]);
    expect(() => splitWords(`"open`)).toThrow(/unterminated/);
  });
});
