// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reenter, returnToNormal, stop, type GraphDecision } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { classifyClaudeFailure } from "./claude-failure.js";
import { CLAUDE_CODE_HARNESS, commandPaths, createClaudeSupervisorHarness, lastClaudeSessionModel } from "./claude-harness.js";
import { claudeStepRecorder } from "./claude-steps.js";
import { MAX_EPISODE_TOOL_RESULT_CHARS } from "./episode.js";
import { isSupervisorProviderError } from "./provider-failure.js";
import { reconcileSupervisorBinding } from "./restore.js";
import { fakeClaude, fakeClaudeHarness, type FakeStep } from "./testing/fake-claude.js";
import type { SupervisorInput } from "./types.js";

const OPUS = { provider: CLAUDE_CODE_HARNESS, modelId: "opus" };
const SONNET = { provider: CLAUDE_CODE_HARNESS, modelId: "sonnet" };

function decision(d: GraphDecision, extra: Record<string, unknown> = {}): string {
  return ["I read the failing job's log.", "```json", JSON.stringify({ ...d, ...extra }), "```"].join("\n");
}

function input(over: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    runId: "run-1",
    episodeId: "ep-1",
    trigger: { code: "executor_failed", message: "the fix job failed" },
    view: {
      runId: "run-1",
      task: { request: "fix it", repo: "." },
      current: { stageId: "fix", attempt: 1 },
      receipts: [],
      evidence: [],
      outstanding: [],
      budgets: { agentInvocations: 40, jobs: 10, decisions: 10, corrections: 4 },
      validatorBindings: [],
      generation: 1,
      stateRevision: 3,
      activeVersion: "hello@0.1.0",
    },
    maxWaitMs: 60_000,
    ...over,
  };
}

const REENTER = reenter({ stageId: "fix", reason: "flaky", evidenceRefs: ["ev-1"] }, "retry the stage");

describe("Claude Code supervisor harness: protocol", () => {
  it("opens with --session-id, resumes the same session for a follow-up, and passes no schema, key, or MCP servers", async () => {
    const fake = fakeClaude([{ text: "not a decision" }, { text: decision(REENTER) }]);
    const harness = fakeClaudeHarness(fake, { configuredModels: [OPUS, SONNET], env: { ...process.env, ANTHROPIC_API_KEY: "sk-secret" } });
    const host = await harness.start();
    const proposal = await host.decide(input());
    expect(proposal).toMatchObject({ action: { type: "reenter" } });
    const [first, second] = fake.invocations();
    expect(first!.resumed).toBe(false);
    expect(first!.argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--tools", "default", "--strict-mcp-config", "--model", "opus"]));
    expect(first!.argv.slice(-2)).toEqual(["--session-id", first!.sessionId]);
    expect(first!.argv).not.toContain("--json-schema");
    expect(first!.argv).not.toContain("--mcp-config");
    // The re-ask is the next user turn of the same Claude Code session.
    expect(second!.resumed).toBe(true);
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(second!.argv.slice(-2)).toEqual(["--resume", first!.sessionId]);
    expect(second!.prompt).toContain("Your reply could not be read as a decision");
    // The user's own login: the key never reaches Claude Code, the config dir does.
    expect(fake.invocations().every((i) => i.apiKey === null && i.configDir === fake.configDir)).toBe(true);
    expect(host.binding).toMatchObject({ harness: CLAUDE_CODE_HARNESS, provider: CLAUDE_CODE_HARNESS, modelId: "opus" });
    expect(host.binding.sessionFile).toBe(path.join(fake.sessionDir, `claude-${first!.sessionId}.jsonl`));
    // GraphLoom keeps its own copy of the transcript, with the session's record.
    expect(readFileSync(host.binding.sessionFile!, "utf8")).toContain("not a decision");
    const record = JSON.parse(readFileSync(host.binding.sessionFile!.replace(/\.jsonl$/, ".json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ harness: CLAUDE_CODE_HARNESS, model: "opus", role: "decide" });
    // Two prompts, no tool results: two provider calls.
    expect(host.drainProviderCalls()).toBe(2);
    await host.close();
  });

  it("refuses ANTHROPIC_API_KEY in passEnv", () => {
    expect(() => createClaudeSupervisorHarness({ runId: "r", sessionDir: "/tmp/x", passEnv: ["ANTHROPIC_API_KEY"] })).toThrow(/own Claude Code login/);
  });

  it("writes GraphLoom's copy back when Claude Code lost the transcript, so the follow-up still resumes", async () => {
    const fake = fakeClaude([{ text: "thinking out loud" }, { text: decision(REENTER) }]);
    const harness = fakeClaudeHarness(fake, { configuredModels: [OPUS] });
    const session = await harness.openSession!({ model: OPUS, role: "decide" });
    expect(await session.prompt("first")).toBe("thinking out loud");
    rmSync(path.join(fake.configDir, "projects"), { recursive: true, force: true });
    expect(await session.prompt("again")).toContain('"reenter"');
    expect(fake.invocations()[1]!.resumed).toBe(true);
    await session.close();
  });

  it("maps a failed turn to the host's provider failure classes", async () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const cases: Array<[FakeStep, string, boolean]> = [
      [{ error: `You've hit your session limit · resets ${reset}` }, "quota", true],
      [{ error: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, "transient", false],
      [{ error: "Prompt is too long" }, "overflow", false],
      [{ error: "Not logged in · Please run /login" }, "auth", false],
      [{ empty: true }, "empty", false],
    ];
    for (const [step, failureClass, hasReset] of cases) {
      const fake = fakeClaude([step]);
      const session = await fakeClaudeHarness(fake).openSession!({ model: OPUS, role: "decide" });
      expect(await session.prompt("decide")).toBe("");
      const failure = session.lastReplyFailure?.();
      expect(failure?.failureClass).toBe(failureClass);
      if (hasReset) expect(failure?.retryAt).toBe(reset);
      if (failureClass === "auth") expect(failure?.message).toMatch(/claude \/login/);
    }
  });

  it("throws a crash with no result for the host's one fresh-session retry", async () => {
    const fake = fakeClaude([{ crash: "segfault in the CLI" }]);
    const session = await fakeClaudeHarness(fake).openSession!({ model: OPUS, role: "decide" });
    const err = await session.prompt("decide").catch((e: unknown) => e);
    expect(isSupervisorProviderError(err) && err.failureClass).toBe("unknown");
    expect(String(err)).toMatch(/exited with code 3 and no result: segfault in the CLI/);

    const recovering = fakeClaude([{ crash: "segfault" }, { text: decision(REENTER) }]);
    const host = await fakeClaudeHarness(recovering, { configuredModels: [OPUS] }).start();
    expect(await host.decide(input())).toMatchObject({ action: { type: "reenter" } });
    expect(host.drainRemedies().map((r) => [r.failureClass, r.remedy])).toEqual([["unknown", "fresh_session_retry"]]);
    const [crashed, retried] = recovering.invocations();
    expect(retried!.sessionId).not.toBe(crashed!.sessionId);
    expect(retried!.prompt).toContain("You are the GraphLoom run supervisor in recovery.");
    await host.close();

    const twice = fakeClaude([{ crash: "segfault" }, { crash: "segfault" }]);
    const host2 = await fakeClaudeHarness(twice, { configuredModels: [OPUS] }).start();
    const stopped = await host2.decide(input()).catch((e: unknown) => e);
    expect(isSupervisorProviderError(stopped) && [stopped.failureClass, stopped.unremedied]).toEqual(["unknown", "already retried once"]);
    await host2.close();
  });

  it("stops a silent turn as a timeout, and a turn over its allowance as exceeded", async () => {
    const fake = fakeClaude([{ hang: true }]);
    const session = await fakeClaudeHarness(fake, { promptTimeoutMs: 800 }).openSession!({ model: OPUS, role: "decide" });
    const err = await session.prompt("decide").catch((e: unknown) => e);
    expect(isSupervisorProviderError(err) && err.failureClass).toBe("timeout");

    const busy = fakeClaude([{ observe: [{ tool: "Bash", input: { command: "ls" }, output: "a" }], text: "x" }]);
    const capped = await fakeClaudeHarness(busy).openSession!({ model: OPUS, role: "decide" });
    // One call for the prompt; the tool result going back would be a second.
    await expect(capped.prompt("decide", { maxTurns: 1 })).rejects.toThrow(/exceeded its 1-turn allowance/);
    await expect(capped.prompt("decide", { maxTurns: 0 })).rejects.toThrow(/exceeded/);
  });

  it("caps a prompt's total time", async () => {
    const fake = fakeClaude([{ observe: [{ tool: "Bash", input: { command: "sleep" }, ask: true, run: "sleep 5" }], text: "late" }]);
    const session = await fakeClaudeHarness(fake, { promptTimeoutMs: 10_000 }).openSession!({ model: OPUS, role: "decide" });
    const err = await session.prompt("decide", { timeoutMs: 700 }).catch((e: unknown) => e);
    expect(isSupervisorProviderError(err) && err.failureClass).toBe("timeout");
    expect(String(err)).toMatch(/no complete reply within/);
  });

  it("reports usage, and never switches a session's model in place", async () => {
    const fake = fakeClaude([{ text: "ok" }]);
    const session = await fakeClaudeHarness(fake).openSession!({ model: OPUS, role: "decide" });
    await session.prompt("hi");
    expect(session.lastUsage?.()).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    await expect(session.setModel(SONNET)).rejects.toThrow(/fresh session/);
  });

  it("passes a configured reasoning level as --effort and probes for it", async () => {
    const fake = fakeClaude([{ text: "ok" }]);
    const harness = fakeClaudeHarness(fake, { configuredModels: [{ ...OPUS, thinkingLevel: "high" }] });
    await (await harness.openSession!({ model: { ...OPUS, thinkingLevel: "high" }, role: "decide" })).prompt("hi");
    expect(fake.invocations()[0]!.argv).toEqual(expect.arrayContaining(["--effort", "high"]));
    expect(await harness.probe()).toEqual({ ok: true });
    const old = fakeClaudeHarness(fake, { configuredModels: [{ ...OPUS, thinkingLevel: "high" }], readHelp: async () => "-p --output-format" });
    expect(await old.probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/does not mention .*--effort/) });
  });
});

describe("Claude Code supervisor harness: probe", () => {
  it("needs confinement, a Claude Code that knows the flags, and a login", async () => {
    const fake = fakeClaude();
    expect(await fakeClaudeHarness(fake).probe()).toEqual({ ok: true });
    const bare = { runId: "r", sessionDir: fake.sessionDir, configDir: fake.configDir, loggedIn: async () => true, readHelp: async () => "" };
    expect(await createClaudeSupervisorHarness(bare).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/bwrap confinement/) });
    expect(
      await fakeClaudeHarness(fake, { confinement: { launch: fake.launch, unsupported: async () => "bubblewrap (bwrap) cannot create a mount namespace here" }, allowUnconfined: false }).probe(),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/runs confined: bubblewrap/) });
    expect(await fakeClaudeHarness(fake, { readHelp: async () => undefined }).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/is Claude Code installed/) });
    expect(await fakeClaudeHarness(fake, { readHelp: async () => "-p --output-format --tools" }).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/does not mention/) });
    expect(await fakeClaudeHarness(fake, { loggedIn: async () => false }).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/claude \/login/) });
    // The default login check reads Claude Code's own config dir, without a call.
    const harness = createClaudeSupervisorHarness({
      runId: "r",
      sessionDir: fake.sessionDir,
      configDir: fake.configDir,
      allowUnconfined: true,
      readHelp: async () => "-p --output-format --input-format --verbose --replay-user-messages --forward-subagent-text --permission-mode --permission-prompt-tool --resume --session-id --tools --strict-mcp-config --append-system-prompt --model",
    });
    if (process.platform !== "darwin") expect(await harness.probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/no login/) });
    writeFileSync(path.join(fake.configDir, ".credentials.json"), "{}");
    expect(await harness.probe()).toEqual({ ok: true });
  });
});

describe("Claude Code supervisor harness: permissions and investigation evidence", () => {
  it("allows and records native tools, refuses writes outside the scratch dir and a granted candidate", async () => {
    const fake = fakeClaude();
    const worktree = path.join(fake.dir, "worktree");
    const candidate = path.join(fake.dir, "repairs", "a1", "candidate");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    const scratch = path.join(fake.sessionDir, "scratch");
    fake.queue([
      {
        observe: [
          { tool: "Read", input: { file_path: path.join(worktree, "x.go") }, output: "package x" },
          { tool: "Bash", input: { command: "go test ./..." }, ask: true, run: "echo FAIL; exit 2" },
          { tool: "Write", input: { file_path: path.join(worktree, "x.go"), content: "patched" }, ask: true },
          { tool: "Write", input: { file_path: path.join(scratch, "notes.txt"), content: "notes" }, ask: true },
        ],
        text: decision(REENTER),
      },
      { observe: [{ tool: "Write", input: { file_path: path.join(candidate, "fix.ts"), content: "fixed" }, ask: true }], text: "Fixed the off-by-one." },
      { observe: [{ tool: "Write", input: { file_path: path.join(candidate, "late.ts"), content: "late" }, ask: true }], text: "tried" },
    ]);
    const harness = fakeClaudeHarness(fake, { cwd: worktree, configuredModels: [OPUS] });
    const session = await harness.openSession!({ model: OPUS, role: "decide" });
    await session.prompt("decide");
    const steps = session.investigation!();
    expect(steps.map((s) => [s.id, s.kind, s.tool, s.exitCode])).toEqual([
      ["inv-1", "file_read", "Read", undefined],
      ["inv-2", "command", "Bash", 2],
      ["inv-3", "file_change", "Write", undefined],
      ["inv-4", "file_change", "Write", undefined],
    ]);
    expect(steps[2]!.output).toMatch(/read-only to you/);
    expect(() => statSync(path.join(worktree, "x.go"))).toThrow();
    expect(readFileSync(path.join(scratch, "notes.txt"), "utf8")).toBe("notes");
    expect(steps.every((s) => s.harness === CLAUDE_CODE_HARNESS)).toBe(true);
    // Each tool result went back to the model: one call for the prompt and one per result.
    expect(session.drainTurnCount!()).toBe(5);

    // The patch turn runs in the candidate root, in the same session.
    await session.grantCandidateCoding!(candidate);
    expect(await session.prompt("patch")).toBe("Fixed the off-by-one.");
    expect(readFileSync(path.join(candidate, "fix.ts"), "utf8")).toBe("fixed");
    const patch = fake.invocations()[1]!;
    expect(patch.cwd).toBe(candidate);
    expect(patch.resumed).toBe(true);
    await session.revokeCandidateCoding!();
    await session.prompt("after");
    expect(() => statSync(path.join(candidate, "late.ts"))).toThrow();
    expect(fake.invocations()[2]!.cwd).toBe(worktree);
  });

  it("gives a review session no grants and nothing writable but its scratch dir", async () => {
    const fake = fakeClaude();
    const candidate = path.join(fake.dir, "candidate");
    mkdirSync(candidate, { recursive: true });
    fake.queue([{ observe: [{ tool: "Write", input: { file_path: path.join(candidate, "a.ts"), content: "x" }, ask: true }], text: "VERDICT: approved\nLooks right." }]);
    const harness = fakeClaudeHarness(fake, { configuredModels: [OPUS] });
    const review = await harness.openReviewSession({ cwd: candidate });
    expect(review.grantCandidateCoding).toBeUndefined();
    expect(await review.prompt("review")).toMatch(/^VERDICT: approved/);
    expect(fake.invocations()[0]!.cwd).toBe(candidate);
    expect(() => statSync(path.join(candidate, "a.ts"))).toThrow();
    const record = readdirSync(fake.sessionDir).find((n) => n.endsWith(".json"))!;
    expect(JSON.parse(readFileSync(path.join(fake.sessionDir, record), "utf8"))).toMatchObject({ role: "review" });
  });

  it("records subagent calls and bounds large output", () => {
    const recorder = claudeStepRecorder(CLAUDE_CODE_HARNESS);
    const big = "x".repeat(MAX_EPISODE_TOOL_RESULT_CHARS * 2);
    recorder.observe({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { prompt: "look" } }] } });
    recorder.observe({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "TODO" } }] }, parent_tool_use_id: "t1" });
    recorder.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: big }] }] }, parent_tool_use_id: "t1" });
    recorder.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } });
    recorder.observe({ type: "assistant", message: { id: "m3", content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "make" } }] } });
    recorder.flush();
    const steps = recorder.steps();
    expect(steps.map((s) => [s.id, s.kind, s.tool])).toEqual([
      ["inv-1", "tool", "Grep"],
      ["inv-2", "subagent", "Agent"],
      ["inv-3", "command", "Bash"],
    ]);
    expect(JSON.stringify(steps[0]!.output).length).toBeLessThanOrEqual(MAX_EPISODE_TOOL_RESULT_CHARS);
    expect(steps[2]!.output).toMatch(/no result/);
    expect(JSON.stringify(steps)).not.toContain("private");
  });

  it("lists the steps in follow-ups so the agent can cite them, and drains them for the episode record", async () => {
    const fake = fakeClaude([
      { observe: [{ tool: "Bash", input: { command: "go test ./pkg/x" }, output: "FAIL", exitCode: 1 }], text: decision(returnToNormal({ summary: "x" }, "x")) },
      { text: decision(REENTER, { evidence: ["inv-1"] }) },
    ]);
    const host = await fakeClaudeHarness(fake, { configuredModels: [OPUS] }).start();
    let checks = 0;
    const proposal = await host.decide(
      input({
        priorInvestigationSteps: 4,
        admission: {
          facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
          async check() {
            checks += 1;
            // The steps the turn has seen are visible to admission while it runs.
            expect(host.investigationSteps().map((s) => s.id)).toEqual(["inv-5"]);
            return checks === 1 ? { action: "return", reason: "no receipt", remaining: 2 } : undefined;
          },
          async refuse(action, reason) {
            return { action, reason, remaining: 2 };
          },
        },
      }),
    );
    expect(proposal).toMatchObject({ action: { type: "reenter" }, evidence: ["inv-1"] });
    // Numbered after the steps the episode's records already hold.
    expect(fake.invocations()[1]!.prompt).toContain('inv-5: Bash "go test ./pkg/x" exit 1');
    expect(host.drainInvestigation().map((s) => s.id)).toEqual(["inv-5"]);
    expect(host.drainInvestigation()).toEqual([]);
    await host.close();
  });
});

describe("Claude Code supervisor harness: switching and restore", () => {
  it("settles an interrupted switch from a session on its target opened after the intent", async () => {
    const fake = fakeClaude();
    const harness = fakeClaudeHarness(fake, { configuredModels: [OPUS, SONNET] });
    const first = await harness.openSession!({ model: OPUS, role: "decide" });
    // An earlier turn's model_retry opened a Sonnet session, then went back to Opus.
    await harness.openSession!({ model: SONNET, role: "decide" });
    await new Promise((r) => setTimeout(r, 5));
    const intent = { at: new Date().toISOString(), from: OPUS, to: SONNET, reason: "slips", status: "intent" as const };
    const binding = { sessionId: "logical", sessionFile: first.sessionFile, provider: CLAUDE_CODE_HARNESS, modelId: "opus", switchJournal: [intent], harness: CLAUDE_CODE_HARNESS };
    // The controller died before the switch opened its session: no evidence it took.
    expect(await reconcileSupervisorBinding(binding)).toMatchObject({ modelId: "opus", switchJournal: [{ status: "failed" }] });
    await new Promise((r) => setTimeout(r, 5));
    await harness.openSession!({ model: SONNET, role: "decide" });
    expect(await lastClaudeSessionModel(fake.sessionDir)).toEqual(SONNET);
    expect(await reconcileSupervisorBinding(binding)).toMatchObject({ modelId: "sonnet", switchJournal: [{ status: "committed" }] });
    const back = { ...intent, at: new Date(Date.now() + 1_000).toISOString(), from: SONNET, to: OPUS };
    expect(await reconcileSupervisorBinding({ ...binding, modelId: "sonnet", switchJournal: [back] })).toMatchObject({
      modelId: "sonnet",
      switchJournal: [{ status: "failed" }],
    });
  });

  it("commits a switch by opening a fresh session on the target, never resuming the old transcript", async () => {
    const fake = fakeClaude([{ text: JSON.stringify({ switch_model: { ...SONNET, reason: "bigger" } }) }, { text: decision(REENTER) }]);
    const host = await fakeClaudeHarness(fake, { configuredModels: [OPUS, SONNET] }).start();
    expect(await host.decide(input())).toMatchObject({ type: "switch_model", modelId: "sonnet" });
    await host.switchModel({ ...SONNET, reason: "bigger" });
    expect(host.binding.switchJournal.map((r) => r.status)).toEqual(["committed"]);
    await host.decide(input({ rejection: { action: "return", reason: "no", remaining: 2 } }));
    const [before, after] = fake.invocations();
    expect(after!.resumed).toBe(false);
    expect(after!.sessionId).not.toBe(before!.sessionId);
    expect(after!.argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(after!.prompt).toContain("You are the GraphLoom run supervisor in recovery.");
    await host.close();
  });

  it("restores a claude-code binding on the bound model in a fresh session, and refuses another harness's", async () => {
    const fake = fakeClaude([{ text: decision(stop({ reason: "blocked", blocker: "disk full", evidenceRefs: ["ev-1"] }, "stop")) }]);
    const harness = fakeClaudeHarness(fake, { configuredModels: [OPUS, SONNET] });
    const host = await harness.restore({
      sessionId: "logical-7",
      sessionFile: path.join(fake.sessionDir, "claude-00000000-0000-4000-8000-000000000000.jsonl"),
      provider: CLAUDE_CODE_HARNESS,
      modelId: "sonnet",
      switchJournal: [],
      harness: CLAUDE_CODE_HARNESS,
    });
    expect(host.sessionId).toBe("logical-7");
    await host.decide(input());
    expect(fake.invocations()[0]).toMatchObject({ resumed: false });
    expect(fake.invocations()[0]!.argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    await expect(harness.restore({ sessionId: "x", sessionFile: undefined, provider: "minimax-cn", modelId: "M", switchJournal: [] })).rejects.toThrow(/pinned to the pi harness/);
  });
});

describe("commandPaths", () => {
  it("keeps the executable visible in the sandbox, as given, on PATH, and through a link", () => {
    const fake = fakeClaude();
    const bin = path.join(fake.dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(fake.dir, "real-claude"), "");
    symlinkSync(path.join(fake.dir, "real-claude"), path.join(bin, "claude"));
    expect(commandPaths("claude", `/nonexistent${path.delimiter}${bin}`)).toEqual([path.join(bin, "claude"), path.join(fake.dir, "real-claude")]);
    expect(commandPaths(path.join(bin, "claude"), undefined)).toEqual([path.join(bin, "claude"), path.join(fake.dir, "real-claude")]);
    expect(commandPaths("claude", "/nonexistent")).toEqual([]);
  });
});

describe("classifyClaudeFailure", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  it("reads usage limits with and without a reset time as quota", () => {
    expect(classifyClaudeFailure("Claude Code run failed (success): Claude AI usage limit reached|1793095200", now)).toMatchObject({
      failureClass: "quota",
      retryAt: new Date(1793095200 * 1000).toISOString(),
    });
    expect(classifyClaudeFailure("Claude Code run failed (success): You've hit your session limit · resets 3pm (UTC)", now)).toMatchObject({
      failureClass: "quota",
      retryAt: "2026-10-27T15:00:00.000Z",
    });
    expect(classifyClaudeFailure("Claude Code run failed (success): You've hit your weekly limit", now)).toEqual({
      failureClass: "quota",
      message: "Claude Code run failed (success): You've hit your weekly limit",
    });
  });
  it("reads provider errors as transient with any stated wait, and the rest by what they say", () => {
    expect(classifyClaudeFailure("Claude Code run failed (error_during_execution): API Error: 500 Internal server error", now).failureClass).toBe("transient");
    expect(classifyClaudeFailure("Claude Code run failed (success): API Error: 529 overloaded; retry after 30s", now)).toMatchObject({
      failureClass: "transient",
      retryAt: "2026-10-27T10:00:30.000Z",
    });
    expect(classifyClaudeFailure("Claude Code run failed (success): Prompt is too long", now).failureClass).toBe("overflow");
    expect(classifyClaudeFailure("Claude Code run failed (success): Invalid API key · Please run /login", now).failureClass).toBe("auth");
    expect(classifyClaudeFailure("Claude Code exited with code 3 and no result: segfault", now).failureClass).toBe("unknown");
    // A start-up failure is never retried as transient.
    expect(classifyClaudeFailure("could not start Claude Code (claude): ECONNREFUSED", now).failureClass).toBe("unknown");
  });
});
