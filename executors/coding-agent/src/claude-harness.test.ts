// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext, ToolCallRequest, ToolCallResult } from "@graphloom/sdk";
import { createClaudeCodeHarness, type ClaudeCodeHarnessOptions } from "./claude.js";
import { CONTINUATION_NOTICE, createCodingAgentExecutor } from "./index.js";
import { startToolBridge } from "./mcp-bridge.js";

const fakeClaude = fileURLToPath(new URL("../test/fake-claude.mjs", import.meta.url));

type Step = Record<string, unknown>;
interface Invocation {
  argv: string[];
  prompt: string;
  cwd: string;
  apiKey: string | null;
  env: Record<string, string>;
  history: string[];
  side: Record<string, string>;
  mcp: { type: string; url: string } | null;
}

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function setup(harnessOverrides: ClaudeCodeHarnessOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-claude-harness-"));
  temps.push(dir);
  const worktree = path.join(dir, "worktree");
  const sessions = path.join(dir, "sessions");
  const configDir = path.join(dir, "claude-config");
  const scriptFile = path.join(dir, "script.json");
  const logFile = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "claude");
  await mkdir(worktree);
  // Claude Code gets a minimal environment, so the fake's settings travel in its wrapper.
  await writeFile(
    bin,
    `#!/bin/sh\nexport FAKE_CLAUDE_SCRIPT="${scriptFile}" FAKE_CLAUDE_LOG="${logFile}"\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  const makeExecutor = (overrides: ClaudeCodeHarnessOptions = {}) =>
    createCodingAgentExecutor(createClaudeCodeHarness({ command: bin, killGraceMs: 500, ...harnessOverrides, ...overrides }));
  const executor = makeExecutor();
  const toolCalls: ToolCallRequest[] = [];
  let reservations = 0;
  const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
    runId: "r1",
    operationId: "op1",
    generation: 1,
    worktreePath: worktree,
    artifactDir: dir,
    writeScope: ["notes.md"],
    usage: {
      reserveModelCall: async () => {
        reservations += 1;
        return true;
      },
    },
    tools: {
      bindings: [{ name: "read_comments", effect: "read", description: "Read an issue's comments" }],
      async call(req): Promise<ToolCallResult> {
        toolCalls.push(req);
        return { status: "ok", summary: "2 comments", childOperationId: `child-${toolCalls.length}` };
      },
    },
    ...over,
  });
  const script = (start: Step[], resume: Step[] = [], extra: Record<string, unknown> = {}) =>
    writeFile(scriptFile, JSON.stringify({ start, resume, ...extra }), "utf8");
  const controls = async (): Promise<Array<{
    signal?: string;
    request?: { subtype?: string };
    tool?: string;
    reply?: { subtype: string; response?: { behavior: string }; error?: string };
  }>> => (await readFile(`${logFile}.controls`, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const invocations = async (): Promise<Invocation[]> =>
    existsSync(logFile)
      ? (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Invocation)
      : [];
  return {
    dir,
    worktree,
    sessions,
    configDir,
    executor,
    makeExecutor,
    ctx,
    toolCalls,
    script,
    invocations,
    controls,
    reservations: () => reservations,
  };
}

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, unknown> } }] }).evidence[0].payload.codingAgent;
}

const flagValue = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Claude Code harness", () => {
  it("runs Claude Code headless with its full toolset, graph tools served over MCP", async () => {
    const h = await setup();
    await h.script([
      { tool: "read_comments", args: { issue: 7 } },
      { bash: "mkdir -p src && printf 'export const x = 1;\\n' > src/x.ts" },
      { text: "Summarized 2 comments and wrote src/x.ts" },
    ]);
    const result = await h.executor.execute({ assignment: "Summarize issue 7" }, h.ctx());

    expect(result).toMatchObject({ status: "ok", summary: "Summarized 2 comments and wrote src/x.ts" });
    expect(await readFile(path.join(h.worktree, "src/x.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(h.toolCalls).toEqual([{ toolCallId: expect.stringMatching(/^claude-[0-9a-f]{8}-1$/), tool: "read_comments", input: { issue: 7 } }]);
    expect(payload(result)).toMatchObject({ harness: "claude-code", modelCalls: 3, toolCalls: [{ childOperationId: "child-1" }] });
    expect(payload(result).usage).toEqual({ inputTokens: 30, outputTokens: 15, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.0125 });

    const [call] = await h.invocations();
    expect(call!.cwd).toBe(h.worktree);
    expect(call!.argv).toEqual(expect.arrayContaining(["-p", "--verbose", "--strict-mcp-config"]));
    expect(flagValue(call!.argv, "--output-format")).toBe("stream-json");
    expect(flagValue(call!.argv, "--tools")).toBe("default");
    expect(flagValue(call!.argv, "--input-format")).toBe("stream-json");
    expect(flagValue(call!.argv, "--permission-mode")).toBe("default");
    expect(flagValue(call!.argv, "--permission-prompt-tool")).toBe("stdio");
    expect(call!.mcp).toMatchObject({ type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) });
    expect(call!.prompt).toBe("Summarize issue 7\n\nChange only these paths: notes.md.");
  });

  it("gives Claude Code a minimal environment, never the controller's secrets", async () => {
    vi.stubEnv("GRAPHLOOM_GITHUB_LIVE_TOKEN", "ghp-controller-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-ambient");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("CUSTOM_TOOL_HOME", "/opt/custom");
    vi.stubEnv("OTHER_TOOL_HOME", "/opt/other");
    const h = await setup({ passEnv: ["CUSTOM_TOOL_HOME"] });
    await h.script([{ text: "done" }]);
    await h.executor.execute({ assignment: "work" }, h.ctx());
    vi.stubEnv("GRAPHLOOM_CLAUDE_PASS_ENV", "CUSTOM_TOOL_HOME, OTHER_TOOL_HOME");
    await h.makeExecutor({ passEnv: undefined as never }).execute({ assignment: "work" }, h.ctx());

    const [chosen, configured] = await h.invocations();
    expect(chosen!.env).toMatchObject({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LC_ALL: "C.UTF-8",
      CUSTOM_TOOL_HOME: "/opt/custom",
      CLAUDE_CONFIG_DIR: h.configDir,
    });
    for (const name of ["GRAPHLOOM_GITHUB_LIVE_TOKEN", "ANTHROPIC_API_KEY", "OTHER_TOOL_HOME"]) {
      expect(chosen!.env).not.toHaveProperty(name);
    }
    expect(configured!.env).toMatchObject({ CUSTOM_TOOL_HOME: "/opt/custom", OTHER_TOOL_HOME: "/opt/other" });
    expect(configured!.env).not.toHaveProperty("GRAPHLOOM_CLAUDE_PASS_ENV");
    expect(configured!.env).not.toHaveProperty("GRAPHLOOM_GITHUB_LIVE_TOKEN");

    const refused = "passEnv cannot include ANTHROPIC_API_KEY; bind the anthropic-api-key credential instead";
    await expect(h.makeExecutor({ passEnv: ["ANTHROPIC_API_KEY"] }).execute({ assignment: "work" }, h.ctx())).rejects.toThrow(refused);
    vi.stubEnv("GRAPHLOOM_CLAUDE_PASS_ENV", "CUSTOM_TOOL_HOME,ANTHROPIC_API_KEY");
    await expect(h.makeExecutor({ passEnv: undefined as never }).execute({ assignment: "work" }, h.ctx())).rejects.toThrow(refused);
    expect(await h.invocations()).toHaveLength(2);
  });

  it("stops a Claude Code run that shows no model output after starting", async () => {
    const h = await setup({ startupTimeoutMs: 300 });
    await h.script([{ hang: true }]);
    const started = Date.now();
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "failed", summary: "Claude Code stalled: no model output within 0.3s of starting" });
    expect(Date.now() - started).toBeLessThan(5_000);

    vi.stubEnv("GRAPHLOOM_CLAUDE_STARTUP_TIMEOUT_MS", "200");
    const configured = await h.makeExecutor({ startupTimeoutMs: undefined as never }).execute({ assignment: "work" }, h.ctx());
    expect(configured).toMatchObject({ summary: "Claude Code stalled: no model output within 0.2s of starting" });
    vi.stubEnv("GRAPHLOOM_CLAUDE_STARTUP_TIMEOUT_MS", "soon");
    await expect(h.makeExecutor({ startupTimeoutMs: undefined as never }).execute({ assignment: "work" }, h.ctx())).rejects.toThrow(
      "GRAPHLOOM_CLAUDE_STARTUP_TIMEOUT_MS must be a non-negative number of milliseconds",
    );
  });

  it("stops a Claude Code run whose model goes quiet, keeping the session to continue", async () => {
    const h = await setup({ responseTimeoutMs: 300 });
    await h.script([{ text: "working on it" }, { hang: true }]);
    const started = Date.now();
    const result = await h.executor.execute({ assignment: "work" }, h.ctx({ session: { dir: h.sessions } }));
    expect(result).toMatchObject({
      status: "failed",
      summary: "Claude Code stalled: no model output for 0.3s",
      sessionRef: expect.stringMatching(/^claude-/),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not count thinking or a running tool as a stall", async () => {
    const h = await setup({ startupTimeoutMs: 300, responseTimeoutMs: 300 });
    await h.script([{ think: 700 }, { bash: "sleep 0.8" }, { text: "done after a slow build" }]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "ok", summary: "done after a slow build" });
  });

  it("tells a read-only job not to change files and passes the chosen model", async () => {
    const h = await setup({ model: "sonnet" });
    await h.script([{ text: "looked" }]);
    await h.executor.execute({ assignment: "look" }, h.ctx({ readOnly: true, writeScope: undefined as never }));
    await h.executor.execute({ assignment: "look", harnessOptions: { model: "opus" } }, h.ctx({ tools: undefined as never }));

    const [readOnly, chosen] = await h.invocations();
    expect(readOnly!.prompt).toBe("look\n\nThis job is read-only: do not change files in the worktree.");
    expect(flagValue(readOnly!.argv, "--model")).toBe("sonnet");
    expect(flagValue(chosen!.argv, "--model")).toBe("opus");
    expect(chosen!.mcp).toBeNull();
  });

  it("reserves budget before launching and ends the session when a later request is refused", async () => {
    const h = await setup();
    await h.script([{ tool: "read_comments", args: {} }, { hang: true }]);
    let grants = 1;
    const started = Date.now();
    const result = await h.executor.execute(
      { assignment: "work" },
      h.ctx({ usage: { reserveModelCall: async () => grants-- > 0 } }),
    );
    expect(result).toMatchObject({ status: "failed", summary: "model request budget exhausted" });
    expect(h.toolCalls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);

    const none = await setup();
    await none.script([{ text: "never" }]);
    const refused = await none.executor.execute({ assignment: "work" }, none.ctx({ usage: undefined as never }));
    expect(refused).toMatchObject({ status: "failed", summary: "model request budget exhausted" });
    expect(await none.invocations()).toEqual([]);
  });

  it("charges one request per model response, even when it makes several tool calls", async () => {
    const h = await setup();
    await h.script([
      { parallel: [{ tool: "read_comments", args: { issue: 1 } }, { tool: "read_comments", args: { issue: 2 } }] },
      { text: "done" },
    ]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "ok" });
    expect(h.toolCalls.map((c) => c.toolCallId)).toEqual([
      expect.stringMatching(/-1$/),
      expect.stringMatching(/-2$/),
    ]);
    expect(h.reservations()).toBe(2);
  });

  it("answers file permissions from the admitted scope and denies unknown requests", async () => {
    const h = await setup();
    await h.script([
      { permission: { tool: "Write", input: { file_path: "notes.md", content: "allowed" } }, write: "allowed" },
      { permission: { tool: "Write", input: { file_path: "elsewhere.md", content: "denied" } }, write: "denied" },
      { permission: { tool: "NewMutationTool", input: {} } },
      { permission: { tool: "Write", input: null } },
      { permission: { tool: "Write", input: {}, subtype: "unknown_control" } },
      { text: "done" },
    ]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "ok" });
    expect(await readFile(path.join(h.worktree, "notes.md"), "utf8")).toBe("allowed");
    expect(existsSync(path.join(h.worktree, "elsewhere.md"))).toBe(false);
    const replies = (await h.controls()).filter((entry) => entry.reply !== undefined).map((entry) => entry.reply!);
    expect(replies.map((reply) => reply.response?.behavior ?? reply.subtype)).toEqual(["allow", "deny", "deny", "deny", "error"]);
  });

  it("denies file writes and shell commands for read-only jobs", async () => {
    const h = await setup();
    await h.script([
      { permission: { tool: "Write", input: { file_path: "notes.md" } }, write: "no" },
      { bash: "printf 'no' > shell.txt" },
      { text: "reviewed" },
    ]);
    const result = await h.executor.execute({ assignment: "review" }, h.ctx({ readOnly: true }));
    expect(result).toMatchObject({ status: "ok" });
    expect(existsSync(path.join(h.worktree, "notes.md"))).toBe(false);
    expect(existsSync(path.join(h.worktree, "shell.txt"))).toBe(false);
    expect((await h.controls()).filter((entry) => entry.reply).map((entry) => entry.reply?.response?.behavior)).toEqual(["deny", "deny"]);
  });

  it("interrupts a cancelled turn, saves its session, and resumes it", async () => {
    const h = await setup();
    const controller = new AbortController();
    await h.script([{ tool: "read_comments", args: {} }, { hang: true }], [{ text: "resumed interrupted session" }]);
    const first = await h.executor.execute({ assignment: "first assignment" }, h.ctx({
      signal: controller.signal,
      session: { dir: h.sessions },
      tools: {
        bindings: [{ name: "read_comments", effect: "read" }],
        async call() {
          controller.abort();
          return { status: "ok", summary: "read" };
        },
      },
    }));
    expect(first).toMatchObject({ status: "failed", summary: "agent session aborted", sessionRef: expect.stringMatching(/^claude-/) });
    const controls = await h.controls();
    expect(controls.some((entry) => entry.request?.subtype === "interrupt")).toBe(true);
    expect(controls.some((entry) => entry.signal !== undefined)).toBe(false);
    const ref = (first as { sessionRef: string }).sessionRef;
    expect(await readFile(path.join(h.sessions, `${ref}.jsonl`), "utf8")).toContain("interrupted turn saved");
    const second = await h.executor.execute({ assignment: "continue" }, h.ctx({ session: { dir: h.sessions, resume: ref } }));
    expect(second).toMatchObject({ status: "ok", summary: "resumed interrupted session", sessionRef: ref });
  });

  it("saves and reports the session while the turn still runs, so a job killed before it returns leaves a resumable one", async () => {
    const h = await setup();
    const controller = new AbortController();
    await h.script([{ tool: "read_comments", args: {} }, { hang: true }], [{ text: "resumed after the kill" }]);
    const kept: string[] = [];
    const running = h.executor.execute(
      { assignment: "first assignment" },
      h.ctx({ signal: controller.signal, session: { dir: h.sessions }, keepSession: (ref) => kept.push(ref) }),
    );
    // Reported while Claude Code is still mid-turn, not when it returns.
    await expect.poll(() => kept.length, { timeout: 5_000 }).toBe(1);
    const ref = kept[0]!;
    expect(ref).toMatch(/^claude-/);
    // What a host that kills the job now would be left with.
    const killed = path.join(h.dir, "killed-sessions");
    await mkdir(killed);
    for (const name of await readdir(h.sessions)) await writeFile(path.join(killed, name), await readFile(path.join(h.sessions, name)));
    expect((await readdir(killed)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);
    expect(await readFile(path.join(killed, `${ref}.jsonl`), "utf8")).toContain("first assignment");
    controller.abort();
    await running;
    expect(kept).toEqual([ref]);

    const resumed = await h.executor.execute({ assignment: "continue" }, h.ctx({ session: { dir: killed, resume: ref } }));
    expect(resumed).toMatchObject({ status: "ok", summary: "resumed after the kill", sessionRef: ref });
    const last = (await h.invocations()).at(-1)!;
    expect(last.history[0]).toContain("first assignment");
    expect(last.history).not.toContain("interrupted turn saved");
  });

  it("keeps only complete transcript records in a copy taken mid-write", async () => {
    const { completeJsonl } = await import("./harness.js");
    expect(completeJsonl('{"a":1}\n{"b":2}\n')).toBe('{"a":1}\n{"b":2}\n');
    expect(completeJsonl('{"a":1}\n{"b":')).toBe('{"a":1}\n');
    expect(completeJsonl('{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}');
    expect(completeJsonl('{"b":')).toBe("");
  });

  it.each([false, true])("falls back to signals when the CLI ignores an interrupt (ignore SIGTERM: %s)", async (ignoreTerm) => {
    const h = await setup({ interruptGraceMs: 50, killGraceMs: 50 });
    const controller = new AbortController();
    await h.script([{ tool: "read_comments", args: {} }, { hang: true }], [], { ignoreInterrupt: true, ignoreTerm });
    const started = Date.now();
    const result = await h.executor.execute({ assignment: "work" }, h.ctx({
      signal: controller.signal,
      tools: {
        bindings: [{ name: "read_comments", effect: "read" }],
        async call() {
          controller.abort();
          return { status: "ok", summary: "read" };
        },
      },
    }));
    expect(result).toMatchObject({ status: "failed", summary: "agent session aborted" });
    const stops = (await h.controls()).filter((entry) => entry.request?.subtype === "interrupt" || entry.signal);
    expect(stops).toMatchObject([{ request: { subtype: "interrupt" } }, { signal: "SIGTERM" }]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reaps descendants holding output pipes after the CLI exits", async () => {
    const h = await setup({ startupTimeoutMs: 100, interruptGraceMs: 50, killGraceMs: 50 });
    await h.script([{ orphan: true }]);
    const start = Date.now();
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "failed" });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("stops a descendant left in the CLI's process group when Claude Code completes", async () => {
    const h = await setup();
    const pidFile = path.join(h.dir, "child.pid");
    await h.script([{ spawnChild: { pidFile, ignoreTerm: false } }, { text: "done" }]);
    expect(await h.executor.execute({ assignment: "work" }, h.ctx())).toMatchObject({ status: "ok", summary: "done" });
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
  });

  it("kills a descendant that ignores SIGTERM after the CLI exits on cancellation", async () => {
    const h = await setup({ startupTimeoutMs: 0, interruptGraceMs: 50, killGraceMs: 300 });
    const pidFile = path.join(h.dir, "child.pid");
    const controller = new AbortController();
    await h.script([{ spawnChild: { pidFile, ignoreTerm: true } }, { hang: true }], [], { ignoreInterrupt: true });
    setTimeout(() => controller.abort(), 300);
    expect(await h.executor.execute({ assignment: "work" }, h.ctx({ signal: controller.signal }))).toMatchObject({
      status: "failed", summary: "agent session aborted",
    });
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
  });

  it("reaps a CLI that closes stdout without ending the process", async () => {
    const h = await setup({ startupTimeoutMs: 0, interruptGraceMs: 50, killGraceMs: 50 });
    await h.script([{ closeOutput: true }]);
    const start = Date.now();
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("no result") });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("rejects malformed MCP initialization and results before control initialization", async () => {
    const h = await setup({ interruptGraceMs: 50, killGraceMs: 50 });
    await h.script([{ hang: true }], [], { malformedInit: true });
    expect(await h.executor.execute({ assignment: "work" }, h.ctx())).toMatchObject({
      status: "failed", summary: "Claude Code could not connect to the GraphLoom tool server",
    });
    await h.script([], [], { earlyResult: true });
    expect(await h.executor.execute({ assignment: "work" }, h.ctx())).toMatchObject({
      status: "failed", summary: "Claude Code returned a result before control initialization",
    });
  });

  it("charges each subagent request and reports the subagent's usage", async () => {
    const h = await setup();
    await h.script([{ agent: [{ bash: "echo found > found.txt" }, { text: "the subagent found it" }] }, { text: "done with a subagent" }]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());

    expect(result).toMatchObject({ status: "ok", summary: "done with a subagent" });
    expect(await readFile(path.join(h.worktree, "found.txt"), "utf8")).toBe("found\n");
    // Two main-thread responses and two from the subagent, which the result's `usage` leaves out.
    expect(h.reservations()).toBe(4);
    expect(payload(result)).toMatchObject({ modelCalls: 4 });
    expect(payload(result).usage).toEqual({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.0125 });
    const [call] = await h.invocations();
    expect(call!.argv).toContain("--forward-subagent-text");
  });

  it.each(["Agent", "Task"])("admits %s subagents without granting writes to a read-only job", async (agentTool) => {
    const h = await setup();
    await h.script([
      { agentTool, agent: [
        { bash: "printf 'no' > shell.txt" },
        { permission: { tool: "Write", input: { file_path: "notes.md" } }, write: "no" },
        { text: "read-only subagent finished" },
      ] },
      { text: "review finished" },
    ]);
    expect(await h.executor.execute({ assignment: "review" }, h.ctx({ readOnly: true })))
      .toMatchObject({ status: "ok", summary: "review finished" });
    expect(existsSync(path.join(h.worktree, "shell.txt"))).toBe(false);
    expect(existsSync(path.join(h.worktree, "notes.md"))).toBe(false);
    expect((await h.controls()).filter((entry) => entry.reply).map((entry) => [entry.tool, entry.reply?.response?.behavior]))
      .toEqual([[agentTool, "allow"], ["Bash", "deny"], ["Write", "deny"]]);
  });

  it("counts a background subagent's requests and every turn it adds", async () => {
    const h = await setup();
    await h.script([{ agent: [{ text: "subagent step one" }, { text: "subagent step two" }], background: true }, { text: "launched a subagent" }]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());

    expect(result).toMatchObject({ status: "ok", summary: "The background subagent finished." });
    expect(h.reservations()).toBe(5);
    expect(payload(result).usage).toEqual({ inputTokens: 50, outputTokens: 25, cacheReadTokens: 200, cacheWriteTokens: 40, costUsd: 0.025 });
  });

  it("stops Claude Code when a subagent's request is refused", async () => {
    const h = await setup();
    await h.script([{ agent: [{ text: "subagent looking" }, { hang: true }] }]);
    let grants = 1;
    const started = Date.now();
    const result = await h.executor.execute({ assignment: "work" }, h.ctx({ usage: { reserveModelCall: async () => grants-- > 0 } }));
    expect(result).toMatchObject({ status: "failed", summary: "model request budget exhausted" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("answers a background subagent's permission and late tool result after the first turn result", async () => {
    const h = await setup({ startupTimeoutMs: 500, responseTimeoutMs: 500 });
    await h.script([
      { agent: [{ tool: "read_comments", args: { issue: 9 } }, { text: "background read complete" }], background: true },
      { text: "launched a subagent" },
    ]);
    const calls: ToolCallRequest[] = [];
    const result = await h.executor.execute({ assignment: "work" }, h.ctx({
      tools: {
        bindings: [{ name: "read_comments", effect: "read" }],
        async call(request) {
          calls.push(request);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: "ok", summary: "late comments" };
        },
      },
    }));
    expect(result).toMatchObject({ status: "ok", summary: "The background subagent finished." });
    expect(calls).toMatchObject([{ tool: "read_comments", input: { issue: 9 } }]);
    expect((await h.controls()).find((entry) => entry.tool === "mcp__graphloom__read_comments")?.reply)
      .toMatchObject({ response: { behavior: "allow" } });
    expect(h.reservations()).toBe(5);
  });

  it("stops the Claude Code process when the job is cancelled", async () => {
    const h = await setup();
    const controller = new AbortController();
    await h.script([{ tool: "read_comments", args: {} }, { hang: true }]);
    const started = Date.now();
    const result = await h.executor.execute(
      { assignment: "work" },
      h.ctx({
        signal: controller.signal,
        tools: {
          bindings: [{ name: "read_comments", effect: "read" }],
          async call() {
            controller.abort();
            return { status: "ok", summary: "read" };
          },
        },
      }),
    );
    expect(result).toMatchObject({ status: "failed", summary: "agent session aborted" });
    expect(Date.now() - started).toBeLessThan(5_000);

    const pre = new AbortController();
    pre.abort();
    const skipped = await setup();
    await skipped.script([{ text: "never" }]);
    expect(await skipped.executor.execute({ assignment: "work" }, skipped.ctx({ signal: pre.signal }))).toMatchObject({
      status: "failed",
      summary: "agent session aborted",
    });
    expect(await skipped.invocations()).toEqual([]);

    const during = new AbortController();
    const late = await setup({ startupTimeoutMs: 0 });
    await late.script([{ hang: true }]);
    const aborted = await late.executor.execute(
      { assignment: "work" },
      late.ctx({
        signal: during.signal,
        usage: {
          reserveModelCall: async () => {
            during.abort();
            return true;
          },
        },
      }),
    );
    expect(aborted).toMatchObject({ status: "failed", summary: "agent session aborted" });
    expect(await late.invocations()).toEqual([]);
  });

  it("returns structured output validated by Claude Code against the result schema", async () => {
    const h = await setup();
    const schema = { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"] };
    await h.script([{ structured: { greeting: "hello", summary: "greeted" } }]);
    const inline = await h.executor.execute({ assignment: "greet", resultSchema: JSON.stringify(schema) }, h.ctx());
    await h.executor.execute({ assignment: "greet", resultSchema: "writer-result-v1" }, h.ctx());
    await h.script([{ text: "I wrote it" }]);
    const missing = await h.executor.execute({ assignment: "write", resultSchema: "writer-result-v1" }, h.ctx());

    expect(inline).toMatchObject({ status: "ok", summary: "greeted" });
    expect(payload(inline)).toMatchObject({ output: { greeting: "hello", summary: "greeted" } });
    const [first, named] = await h.invocations();
    // One object parameter: the model writes the whole result as JSON, not one raw-text parameter per field.
    const wrapped = (inner: unknown) => ({ type: "object", properties: { result: inner }, required: ["result"], additionalProperties: false });
    expect(JSON.parse(flagValue(first!.argv, "--json-schema")!)).toEqual(wrapped(schema));
    expect(JSON.parse(flagValue(named!.argv, "--json-schema")!)).toEqual(wrapped({
      type: "object",
      description: "writer-result-v1 result",
      additionalProperties: true,
    }));
    expect(first!.prompt).toContain("StructuredOutput is your final answer");
    expect(missing).toMatchObject({ status: "failed", summary: "agent finished without submitting a writer-result-v1 result" });
  });

  it("bakes a result contract's reference ids into the schema, and fails as a contract violation on an unreconcilable miss", async () => {
    const h = await setup();
    const resultContract = {
      name: "plan-review-v1",
      schema: { type: "object", properties: { finding: { type: "string" } }, required: ["finding"] },
      references: ["finding"],
      knownReferences: { finding: { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } },
    };
    await h.script([{ structured: { finding: "P1", summary: "repeats P1" } }]);
    const ok = await h.executor.execute({ assignment: "review" }, h.ctx({ resultContract }));
    expect(ok).toMatchObject({ status: "ok" });
    const [invocation] = await h.invocations();
    const wrapped = JSON.parse(flagValue(invocation!.argv, "--json-schema")!);
    expect(wrapped.properties.result.properties.finding).toMatchObject({ enum: ["", "P1"] });

    await h.script([{ structured: { finding: "a made-up finding" } }]);
    const violated = await h.executor.execute({ assignment: "review" }, h.ctx({ resultContract }));
    expect(violated).toMatchObject({ status: "failed", failureKind: "contract_violation" });
  });

  it("saves the transcript under sessionDir and restores it for a resume", async () => {
    const h = await setup();
    await h.script([{ text: "first turn done" }], [{ text: "second turn done" }]);
    const first = await h.executor.execute({ assignment: "Write the first draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef?: string }).sessionRef!;
    expect(ref).toMatch(/^claude-[0-9a-f-]{36}$/);
    expect((await readdir(h.sessions)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);

    // Claude Code's own copy is gone; the controller's copy is authoritative.
    await rm(path.join(h.configDir, "projects"), { recursive: true });
    const second = await h.executor.execute(
      { assignment: "Revise the draft" },
      h.ctx({ session: { dir: h.sessions, resume: ref } }),
    );
    expect(second).toMatchObject({ status: "ok", summary: "second turn done", sessionRef: ref });

    const [start, resumed] = await h.invocations();
    const sessionId = ref.slice("claude-".length);
    expect(flagValue(start!.argv, "--session-id")).toBe(sessionId);
    expect(flagValue(resumed!.argv, "--resume")).toBe(sessionId);
    expect(resumed!.history).toEqual([expect.stringContaining("Write the first draft"), "first turn done"]);
    expect(resumed!.prompt.startsWith(CONTINUATION_NOTICE)).toBe(true);
    expect(await readFile(path.join(h.sessions, `${ref}.jsonl`), "utf8")).toContain("second turn done");
  });

  it("answers the prompt, not a turn a resumed session ran on its own before reading it", async () => {
    const h = await setup();
    const plan = { note: "planned" };
    const done = { note: "implemented" };
    await h.script([{ structured: plan }], [{ text: "implementing" }, { structured: done }], { autoTurnOnResume: true });
    const schema = JSON.stringify({ type: "object", properties: { note: { type: "string" } }, required: ["note"] });
    const first = await h.executor.execute({ assignment: "Plan", resultSchema: schema }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef: string }).sessionRef;

    const second = await h.executor.execute(
      { assignment: "Implement", resultSchema: schema },
      h.ctx({ session: { dir: h.sessions, resume: ref } }),
    );
    expect(second).toMatchObject({ status: "ok" });
    expect(payload(second).output).toEqual(done);
    expect((await h.invocations())[1]!.argv).toContain("--replay-user-messages");
  });

  it("waits for a subagent Claude Code backgrounded without being asked", async () => {
    const h = await setup({ interruptGraceMs: 300 });
    await h.script([{ agent: [{ think: 1_000 }, { text: "subagent step one" }], background: "default" }, { text: "launched a subagent" }]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "ok", summary: "The background subagent finished." });
  });

  it("keeps the result submitted before a background subagent's report turn", async () => {
    const h = await setup({ interruptGraceMs: 300 });
    const plan = { note: "planned" };
    await h.script([{ agent: [{ think: 300 }, { text: "subagent step one" }], background: "default" }, { structured: plan }]);
    const schema = JSON.stringify({ type: "object", properties: { note: { type: "string" } }, required: ["note"] });
    const result = await h.executor.execute({ assignment: "Plan", resultSchema: schema }, h.ctx());
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result).output).toEqual(plan);
  });

  it("saves subagent transcripts with the session and restores them, so a resume can continue a subagent", async () => {
    const h = await setup();
    await h.script([{ agent: [{ text: "the number is 42" }] }, { text: "delegated" }], [{ text: "continued" }]);
    const first = await h.executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef: string }).sessionRef;
    const session = { dir: h.sessions, resume: ref };
    const subagent = { [path.join("subagents", "agent-toolu_1.jsonl")]: '{"text":"the number is 42"}\n' };
    expect((await readdir(h.sessions)).sort()).toEqual([ref, `${ref}.json`, `${ref}.jsonl`]);

    await rm(path.join(h.configDir, "projects"), { recursive: true });
    expect(await h.executor.execute({ assignment: "revise" }, h.ctx({ session }))).toMatchObject({ status: "ok", summary: "continued" });
    const [project] = await readdir(path.join(h.configDir, "projects"));
    const store = path.join(h.configDir, "projects", project!, ref.slice("claude-".length));
    await writeFile(path.join(store, "stale.txt"), "not from the saved session", "utf8");
    await h.executor.execute({ assignment: "revise" }, h.ctx({ session }));
    const [, restored, replaced] = await h.invocations();
    expect(restored!.side).toEqual(subagent);
    expect(replaced!.side).toEqual(subagent);

    await symlink("/etc/passwd", path.join(h.sessions, ref, "subagents", "agent-leak.jsonl"));
    expect(await h.executor.execute({ assignment: "revise" }, h.ctx({ session }))).toEqual({
      status: "failed",
      summary: `agent session ${ref} could not be restored: saved session ${ref} is corrupt`,
    });
    expect(await h.invocations()).toHaveLength(3);
  });

  it("does not save a transcript that is a symlink out of Claude Code's store", async () => {
    const h = await setup();
    const outside = path.join(h.configDir, "..", "outside.jsonl");
    await writeFile(outside, '{"text":"not the session"}\n', "utf8");
    await h.script([{ text: "done" }], [], { linkTranscript: outside });
    const result = await h.executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: h.sessions } }));
    expect(result).toMatchObject({ status: "ok", summary: "done" });
    expect(result).not.toHaveProperty("sessionRef");
    expect(await readdir(h.sessions).catch(() => [])).toEqual([]);
  });

  it("drops the saved subagent transcripts once the resumed session no longer has them", async () => {
    const h = await setup();
    await h.script([{ agent: [{ text: "the number is 42" }] }, { text: "delegated" }], [{ text: "continued" }], { dropSide: true });
    const first = await h.executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef: string }).sessionRef;
    expect(await readdir(h.sessions)).toContain(ref);

    const session = { dir: h.sessions, resume: ref };
    expect(await h.executor.execute({ assignment: "revise" }, h.ctx({ session }))).toMatchObject({ status: "ok", sessionRef: ref });
    expect((await readdir(h.sessions)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);
    await h.executor.execute({ assignment: "revise" }, h.ctx({ session }));
    expect((await h.invocations())[2]!.side).toEqual({});
  });

  it("reports only a resumed run's own usage, though Claude Code's totals span the session", async () => {
    const h = await setup();
    const own = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.0125 };
    await h.script([{ text: "first" }], [{ text: "again" }]);
    const first = await h.executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: h.sessions } }));
    const session = { dir: h.sessions, resume: (first as { sessionRef: string }).sessionRef };
    const second = await h.executor.execute({ assignment: "revise" }, h.ctx({ session }));
    await h.script([], [{ text: "again" }], { restoreCost: false });
    const unrestored = await h.executor.execute({ assignment: "revise" }, h.ctx({ session }));

    expect(payload(first).usage).toEqual(own);
    expect(payload(second).usage).toEqual(own);
    expect(payload(unrestored).usage).toEqual(own);

    await h.script([{ text: "first" }], [{ text: "again" }]);
    const direct = await createClaudeCodeHarness({ command: path.join(h.dir, "claude") }).createSession({
      cwd: h.worktree,
      readOnly: false,
      tools: [],
      reserveModelCall: async () => true,
      sessionDir: path.join(h.dir, "direct-sessions"),
    });
    const runs = [await direct.run({ assignment: "draft" }), await direct.run({ assignment: "revise" })];
    expect(runs.map((r) => [r.summary, r.usage])).toEqual([["first", own], ["again", own]]);
  });

  it("runs each binding on its own config dir, saving and restoring transcripts there", async () => {
    const h = await setup();
    const gateway = path.join(h.dir, "gateway-account");
    const firstParty = path.join(h.dir, "first-party-account");
    await h.script([{ text: "first" }], [{ text: "again" }]);
    const byOption = h.makeExecutor({ configDir: gateway });
    vi.stubEnv("GRAPHLOOM_CLAUDE_CONFIG_DIR", firstParty);
    const byConfig = h.makeExecutor();

    const refs: string[] = [];
    for (const [executor, dir] of [[byOption, gateway], [byConfig, firstParty]] as const) {
      const sessions = path.join(h.dir, `sessions-${path.basename(dir)}`);
      const first = await executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: sessions } }));
      const ref = (first as { sessionRef: string }).sessionRef;
      refs.push(ref);
      await rm(path.join(dir, "projects"), { recursive: true });
      const resumed = await executor.execute({ assignment: "revise" }, h.ctx({ session: { dir: sessions, resume: ref } }));
      expect(resumed).toMatchObject({ status: "ok", summary: "again", sessionRef: ref });
      const [project] = await readdir(path.join(dir, "projects"));
      expect(await readFile(path.join(dir, "projects", project!, `${ref.slice("claude-".length)}.jsonl`), "utf8")).toContain("again");
    }

    const dirs = (await h.invocations()).map((call) => call.env.CLAUDE_CONFIG_DIR);
    expect(dirs).toEqual([gateway, gateway, firstParty, firstParty]);
    expect(existsSync(h.configDir)).toBe(false);
  });

  const REF = "claude-00000000-0000-4000-8000-000000000000";
  it.each([
    ["missing", REF, undefined, undefined, `no saved session for ${REF}`],
    ["empty", REF, '{"project":"-p"}', "", `saved session ${REF} is empty`],
    ["corrupt", REF, '{"project":"-p"}', "not json\n", `saved session ${REF} is corrupt`],
    ["escaping", REF, '{"project":"..","model":null,"systemPromptSha256":"x"}', '{"text":"x"}\n', `saved session ${REF} is corrupt`],
    ["unsettled", REF, '{"project":"-p"}', '{"text":"x"}\n', `saved session ${REF} is corrupt`],
    ["malformed", "claude-../../x", undefined, undefined, "malformed session ref claude-../../x"],
  ])("fails to resume a %s session instead of starting fresh", async (_label, ref, meta, transcript, reason) => {
    const h = await setup();
    await mkdir(h.sessions, { recursive: true });
    if (meta !== undefined) await writeFile(path.join(h.sessions, `${ref}.json`), meta, "utf8");
    if (transcript !== undefined) await writeFile(path.join(h.sessions, `${ref}.jsonl`), transcript, "utf8");
    await h.script([], [{ text: "never" }]);
    const result = await h.executor.execute({ assignment: "continue" }, h.ctx({ session: { dir: h.sessions, resume: ref } }));

    expect(result).toEqual({ status: "failed", summary: `agent session ${ref} could not be restored: ${reason}` });
    expect(await h.invocations()).toEqual([]);
    expect(existsSync(path.join(h.dir, "claude-config"))).toBe(false);
  });

  it("refuses to resume a session under a different model or system prompt", async () => {
    const h = await setup();
    await h.script([{ text: "first turn done" }], [{ text: "never" }]);
    const first = await h.executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef: string }).sessionRef;
    const session = { dir: h.sessions, resume: ref };

    const otherModel = await h.executor.execute({ assignment: "revise", harnessOptions: { model: "opus" } }, h.ctx({ session }));
    const otherPrompt = await h.makeExecutor({ systemPrompt: "You are a different agent." }).execute({ assignment: "revise" }, h.ctx({ session }));
    expect(otherModel).toEqual({
      status: "failed",
      summary: `agent session ${ref} could not be restored: saved session ${ref} ran on Claude Code's default model; this job asks for model opus`,
    });
    expect(otherPrompt).toEqual({
      status: "failed",
      summary: `agent session ${ref} could not be restored: saved session ${ref} ran with a different system prompt`,
    });
    expect(await h.invocations()).toHaveLength(1);

    const pinned = await setup({ model: "sonnet" });
    await pinned.script([{ text: "first" }], [{ text: "second" }]);
    const saved = await pinned.executor.execute({ assignment: "draft" }, pinned.ctx({ session: { dir: pinned.sessions } }));
    const again = { dir: pinned.sessions, resume: (saved as { sessionRef: string }).sessionRef };
    expect(await pinned.executor.execute({ assignment: "revise" }, pinned.ctx({ session: again }))).toMatchObject({ status: "ok", summary: "second" });
    expect(await pinned.executor.execute({ assignment: "revise", harnessOptions: { model: "haiku" } }, pinned.ctx({ session: again }))).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("ran on model sonnet; this job asks for model haiku"),
    });
  });

  it("hands an Anthropic API key to Claude Code only through its environment", async () => {
    const h = await setup();
    const secret = "sk-ant-test-secret-8812";
    await h.script([{ text: `done` }]);
    const withKey = await h.executor.execute(
      { assignment: "work" },
      h.ctx({ session: { dir: h.sessions }, credentials: { get: async (name) => (name === "anthropic-api-key" ? secret : undefined) } }),
    );
    await h.executor.execute({ assignment: "work" }, h.ctx());

    const [keyed, login] = await h.invocations();
    expect(keyed!.apiKey).toBe(secret);
    expect(JSON.stringify(keyed!.argv) + keyed!.prompt).not.toContain(secret);
    expect(JSON.stringify(withKey)).not.toContain(secret);
    const ref = (withKey as { sessionRef: string }).sessionRef;
    expect(await readFile(path.join(h.sessions, `${ref}.jsonl`), "utf8")).not.toContain(secret);
    expect(login!.apiKey).toBeNull();
  });

  it("redacts the API key from Claude Code's error output", async () => {
    const h = await setup();
    const secret = "sk-ant-test-secret-3307";
    await h.script([{ crash: `invalid x-api-key ${secret}` }]);
    const result = await h.executor.execute(
      { assignment: "work" },
      h.ctx({ credentials: { get: async (name) => (name === "anthropic-api-key" ? secret : undefined) } }),
    );
    expect(result).toMatchObject({ status: "failed", summary: "Claude Code exited with code 3 and no result: invalid x-api-key [REDACTED]" });
  });

  it("reports a failed or crashed Claude Code run", async () => {
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_ATTEMPTS", "1"); // this test asserts the raw failure text, so no transient retry
    const h = await setup();
    await h.script([{ error: "API Error: overloaded" }]);
    const failed = await h.executor.execute({ assignment: "work" }, h.ctx());
    await h.script([{ crash: "segfault in the agent" }]);
    const crashed = await h.executor.execute({ assignment: "work" }, h.ctx());
    const missing = await (await setup({ command: path.join(h.dir, "no-such-claude") })).executor.execute({ assignment: "work" }, h.ctx());

    expect(failed).toMatchObject({ status: "failed", summary: expect.stringContaining("Claude Code run failed (error_during_execution): API Error: overloaded") });
    expect(payload(failed).usage).toEqual({ inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(payload(crashed).usage).toBeNull();
    expect(crashed).toMatchObject({ status: "failed", summary: "Claude Code exited with code 3 and no result: segfault in the agent" });
    expect(missing).toMatchObject({ status: "failed", summary: expect.stringMatching(/^could not start Claude Code .*ENOENT/) });
  });
});

describe("MCP tool bridge", () => {
  it("serves graph tools over authenticated JSON-RPC and returns recorded results", async () => {
    const calls: Array<[string, unknown]> = [];
    let n = 0;
    const bridge = await startToolBridge(
      [
        {
          name: "read_comments",
          effect: "read",
          async call(id, input) {
            calls.push([id, input]);
            return { status: "failed", summary: "rate limited", retryAfterMs: 1000 };
          },
        },
      ],
      () => `id-${(n += 1)}`,
    );
    type Rpc = any;
    const rpc = async (body: unknown): Promise<Rpc> => (await post(body)).json();
    const post = (body: unknown, token = bridge.token) =>
      fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
      const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(listed.result.tools).toEqual([
        { name: "read_comments", description: "GraphLoom read tool read_comments. The controller records each call.", inputSchema: { type: "object", additionalProperties: true } },
      ]);
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const called = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_comments", arguments: { issue: 3 } } });
      expect(calls).toEqual([["id-1", { issue: 3 }]]);
      expect(called.result.isError).toBe(true);
      expect(JSON.parse(called.result.content[0].text)).toEqual({ status: "failed", summary: "rate limited", retryAfterMs: 1000 });
      const unknown = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash" } });
      expect(unknown.error).toMatchObject({ code: -32602, message: "unknown tool bash" });
    } finally {
      await bridge.close();
    }
  });

  it("forwards concurrent and batched tool calls to the controller one at a time", async () => {
    let inFlight = false;
    const calls: string[] = [];
    let n = 0;
    const bridge = await startToolBridge(
      [
        {
          name: "slow_read",
          effect: "read",
          async call(id, input) {
            if ((input as { fail?: boolean }).fail) throw new Error("tool crashed");
            if (inFlight) throw new Error("another tool call is in progress");
            inFlight = true;
            await new Promise((resolve) => setTimeout(resolve, 50));
            inFlight = false;
            calls.push(id);
            return { status: "ok", summary: id };
          },
        },
      ],
      () => `id-${(n += 1)}`,
    );
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "slow_read", arguments: {} } });
    const post = async (body: unknown): Promise<any> =>
      (await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    try {
      const [batch, single] = await Promise.all([post([call(1), call(2)]), post(call(3))]);
      for (const reply of [...batch, single]) expect(reply.result.isError, JSON.stringify(reply)).toBe(false);
      expect(calls.sort()).toEqual(["id-1", "id-2", "id-3"]);
      const failFirst = { ...call(4), params: { name: "slow_read", arguments: { fail: true } } };
      const [crashed, after] = await post([failFirst, call(5)]);
      expect(crashed.error).toMatchObject({ message: "tool crashed" });
      expect(after.result.isError).toBe(false);
    } finally {
      await bridge.close();
    }
  });
});

describe("transient retry and native tools (Claude Code)", () => {
  async function attempt(steps: Step[]) {
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_ATTEMPTS", "2");
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_BASE_DELAY_MS", "1");
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_DELAY_MS", "2");
    const h = await setup();
    execFileSync("git", ["-C", h.worktree, "init", "-q"]);
    await h.script(steps);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    return { result: result as { summary: string }, runs: (await h.invocations()).length };
  }
  const overloaded = { error: "API Error: 529 overloaded_error" };

  it("retries a capacity failure when the failed try ran no tools", async () => {
    const { result, runs } = await attempt([overloaded]);
    expect(runs).toBe(2);
  });

  it("does not retry after a Bash call", async () => {
    const { result, runs } = await attempt([{ bash: "echo hi" }, overloaded]);
    expect(runs).toBe(1);
    expect(result.summary).toContain("not retried: the failed try ran a native tool (Bash)");
  });

  it("does not retry after only Read and Grep", async () => {
    const { result, runs } = await attempt([{ native: "Read" }, { native: "Grep" }, overloaded]);
    expect(runs).toBe(1);
    expect(result.summary).toContain("not retried: the failed try ran a native tool (Read)");
  });

  it("resumes the transcript the failed try wrote when the job has no controller session", async () => {
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_ATTEMPTS", "2");
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_BASE_DELAY_MS", "1");
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_DELAY_MS", "2");
    const h = await setup();
    execFileSync("git", ["-C", h.worktree, "init", "-q"]);
    await h.script([{ text: "partial" }, overloaded], [{ text: "all done" }]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    expect(result).toMatchObject({ status: "ok" });
    const [first, second] = await h.invocations();
    expect(first!.argv).toContain("--session-id");
    expect(second!.argv).toContain("--resume");
    expect(second!.argv).not.toContain("--session-id");
  });

  it("does not retry when the transcript is unparseable", async () => {
    const { result, runs } = await attempt([{ raw: "this is not json" }, overloaded]);
    expect(runs).toBe(1);
    expect(result.summary).toContain("did not report which native tools");
  });
});
