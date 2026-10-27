// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClaudeProcess, type ClaudeSession } from "../claude/index.js";
import { runCodexProcess, type CodexThread } from "../codex/index.js";
import type { Launch } from "./index.js";

const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";

/** Speaks just enough of `codex exec --json` for the driver: names a thread, runs one command, finishes the turn. */
const FAKE_CODEX = `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_ARGV, JSON.stringify(args));
const prompt = readFileSync(0, "utf8");
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
emit({ type: "thread.started", thread_id: "${THREAD}" });
emit({ type: "item.started", item: { id: "c1", type: "command_execution" } });
emit({ type: "item.completed", item: { id: "c1", type: "command_execution" } });
emit({ type: "item.completed", item: { id: "m1", type: "agent_message" } });
writeFileSync(args[args.indexOf("--output-last-message") + 1], "echo: " + prompt + "\\n");
emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } });
`;

/** Speaks just enough of Claude Code's stream-json control protocol: one Bash call it asks permission for, then a result. */
const FAKE_CLAUDE = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
let prompt;
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request.subtype === "initialize") {
    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
  } else if (msg.type === "user") {
    prompt = msg.message.content;
    emit({ type: "user", isReplay: true, message: { role: "user", content: prompt } });
    emit({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
    emit({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } });
  } else if (msg.type === "control_response" && msg.response.request_id === "perm-1") {
    const allowed = msg.response.response.behavior;
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: allowed }] } });
    emit({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "done" }] } });
    emit({ type: "result", subtype: "success", result: "done: " + prompt + " (" + allowed + ")",
      modelUsage: { opus: { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 0 } }, total_cost_usd: 0.5 });
  }
}
`;

async function fake(source: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-agent-harness-"));
  const script = path.join(dir, "fake.mjs");
  await writeFile(script, source);
  const argv = path.join(dir, "argv.json");
  const launched: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  // The injected launch decides what actually runs: here the fake, under this Node.
  const launch: Launch = (command, args, env, cwd) => {
    launched.push({ command, args, cwd });
    return { command: process.execPath, args: [script, ...args], env: { ...env, FAKE_ARGV: argv } };
  };
  return { dir, launch, launched, argv: async () => JSON.parse(await readFile(argv, "utf8")) as string[] };
}

describe("runCodexProcess", () => {
  it("runs the turn through the injected launch and reports the final message, tools, and usage", async () => {
    const f = await fake(FAKE_CODEX);
    const thread: CodexThread = { started: false };
    let reserved = 0;
    const run = await runCodexProcess({
      command: "codex",
      thread,
      cwd: f.dir,
      env: { PATH: process.env.PATH ?? "" },
      prompt: "hello",
      sandbox: "read-only",
      ephemeral: true,
      model: "gpt-x",
      args: ["--output-schema", "schema.json"],
      lastMessageFile: path.join(f.dir, "last.txt"),
      launch: f.launch,
      responseTimeoutMs: 10_000,
      killGraceMs: 200,
      reserveModelCall: async () => {
        reserved += 1;
        return true;
      },
    });
    expect(run).toEqual({
      outcome: { kind: "completed", message: "echo: hello" },
      nativeTools: [{ name: "command_execution" }],
      usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 },
    });
    // One more request after the command's output went back to the model.
    expect(reserved).toBe(1);
    expect(thread.threadId).toBe(THREAD);
    expect(f.launched).toEqual([{ command: "codex", args: await f.argv(), cwd: f.dir }]);
    expect(await f.argv()).toEqual([
      "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", f.dir,
      "--output-last-message", path.join(f.dir, "last.txt"), "--model", "gpt-x", "--output-schema", "schema.json", "-",
    ]);
  });

  it("resumes a started thread, and stops a turn whose provider request is refused", async () => {
    const f = await fake(FAKE_CODEX);
    const thread: CodexThread = { threadId: THREAD, started: true };
    const run = await runCodexProcess({
      command: "codex",
      thread,
      cwd: f.dir,
      env: {},
      prompt: "again",
      sandbox: "danger-full-access",
      ephemeral: false,
      lastMessageFile: path.join(f.dir, "last.txt"),
      launch: f.launch,
      responseTimeoutMs: 0,
      killGraceMs: 200,
      reserveModelCall: async () => false,
    });
    expect(run.outcome).toEqual({ kind: "failed", summary: "model request budget exhausted" });
    const argv = await f.argv();
    expect(argv.slice(0, 6)).toEqual(["exec", "--sandbox", "danger-full-access", "--cd", f.dir, "resume"]);
    expect(argv.slice(-2)).toEqual([THREAD, "-"]);
  });

  it("shows each event to onEvent, and fails on an error event only when the turn does not complete", async () => {
    const reconnecting = (tail: string) => `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
readFileSync(0, "utf8");
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
emit({ type: "thread.started", thread_id: "${THREAD}" });
emit({ type: "error", message: "Reconnecting... 1/5 (stream disconnected)" });
${tail}
`;
    const run = async (source: string) => {
      const f = await fake(source);
      const seen: string[] = [];
      const result = await runCodexProcess({
        command: "codex",
        thread: { started: false },
        cwd: f.dir,
        env: {},
        prompt: "hi",
        sandbox: "danger-full-access",
        ephemeral: true,
        lastMessageFile: path.join(f.dir, "last.txt"),
        launch: f.launch,
        responseTimeoutMs: 10_000,
        killGraceMs: 200,
        reserveModelCall: async () => true,
        onEvent: (e) => seen.push(String(e.type)),
      });
      return { result, seen };
    };
    // Codex retried the reconnect itself, and the turn completed.
    const recovered = await run(
      reconnecting(`writeFileSync(args[args.indexOf("--output-last-message") + 1], "ok");
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });`),
    );
    expect(recovered.result.outcome).toEqual({ kind: "completed", message: "ok" });
    expect(recovered.seen).toEqual(["thread.started", "error", "turn.completed"]);
    // It gave up: the last error is the failure.
    const failed = await run(reconnecting(`emit({ type: "error", message: "unexpected status 401 Unauthorized" }); process.exit(1);`));
    expect(failed.result.outcome).toEqual({ kind: "failed", summary: "Codex run failed: unexpected status 401 Unauthorized" });
  });
});

describe("runClaudeProcess", () => {
  it("drives the control protocol, answers permissions through the policy, and reports the result", async () => {
    const f = await fake(FAKE_CLAUDE);
    const session: ClaudeSession = { sessionId: "6b0e1c1e-8d2f-4a53-9f0e-2f9c3b8e7a10", ref: "claude-6b0e1c1e-8d2f-4a53-9f0e-2f9c3b8e7a10", started: false };
    const asked: unknown[] = [];
    let reserved = 0;
    const run = await runClaudeProcess({
      command: "claude",
      args: ["--tools", "default"],
      session,
      cwd: f.dir,
      env: {},
      prompt: "investigate",
      launch: f.launch,
      killGraceMs: 200,
      interruptGraceMs: 200,
      startupTimeoutMs: 10_000,
      responseTimeoutMs: 10_000,
      toolPolicy: async (tool, input) => {
        asked.push([tool, input]);
        return { behavior: "deny", message: "read-only" };
      },
      reserveModelCall: async () => {
        reserved += 1;
        return true;
      },
    });
    expect(run.outcome).toMatchObject({ kind: "result", result: { subtype: "success", result: "done: investigate (deny)" } });
    expect(run.nativeTools).toEqual([{ name: "Bash" }]);
    expect(run.usage).toEqual({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, costUsd: 0.5 });
    expect(asked).toEqual([["Bash", { command: "ls" }]]);
    // The tool result goes back in a second request.
    expect(reserved).toBe(1);
    const argv = await f.argv();
    expect(argv.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(argv.slice(-4)).toEqual(["--tools", "default", "--session-id", session.sessionId]);
  });

  it("hands each stream event, but no control message, to onEvent", async () => {
    const f = await fake(FAKE_CLAUDE);
    const seen: string[] = [];
    const run = await runClaudeProcess({
      command: "claude",
      args: [],
      session: { sessionId: "6b0e1c1e-8d2f-4a53-9f0e-2f9c3b8e7a10", ref: "claude-6b0e1c1e-8d2f-4a53-9f0e-2f9c3b8e7a10", started: false },
      cwd: f.dir,
      env: {},
      prompt: "investigate",
      launch: f.launch,
      killGraceMs: 200,
      interruptGraceMs: 200,
      startupTimeoutMs: 10_000,
      responseTimeoutMs: 10_000,
      toolPolicy: async () => ({ behavior: "allow", updatedInput: {} }),
      reserveModelCall: async () => true,
      onEvent: (event) => {
        seen.push(String(event.type));
        // An observer that throws changes nothing.
        if (event.type === "assistant") throw new Error("observer bug");
      },
    });
    expect(run.outcome).toMatchObject({ kind: "result" });
    expect(seen).toEqual(["user", "assistant", "user", "assistant", "result"]);
  });

  it("does not start the process once the signal has aborted", async () => {
    const f = await fake(FAKE_CLAUDE);
    const controller = new AbortController();
    controller.abort();
    const run = await runClaudeProcess({
      command: "claude",
      args: [],
      session: { sessionId: "6b0e1c1e-8d2f-4a53-9f0e-2f9c3b8e7a10", ref: "claude-6b0e1c1e-8d2f-4a53-9f0e-2f9c3b8e7a10", started: true },
      cwd: f.dir,
      env: {},
      prompt: "x",
      launch: f.launch,
      signal: controller.signal,
      killGraceMs: 200,
      interruptGraceMs: 200,
      startupTimeoutMs: 0,
      responseTimeoutMs: 0,
      toolPolicy: async () => ({ behavior: "deny", message: "no" }),
      reserveModelCall: async () => true,
    });
    expect(run).toEqual({ outcome: { kind: "failed", summary: "agent session aborted" } });
    expect(f.launched).toEqual([]);
  });
});
