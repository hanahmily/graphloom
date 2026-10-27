// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reenter, returnToNormal, stop, type GraphDecision } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { classifyCodexFailure } from "./codex-failure.js";
import { CODEX_HARNESS, createCodexSupervisorHarness, lastCodexSessionModel } from "./codex-harness.js";
import { codexStepRecorder } from "./codex-steps.js";
import { MAX_EPISODE_TOOL_RESULT_CHARS } from "./episode.js";
import { isSupervisorProviderError } from "./provider-failure.js";
import { reconcileSupervisorBinding } from "./restore.js";
import { FAKE_CODEX, fakeCodex, fakeCodexHarness, type FakeCodexStep } from "./testing/fake-codex.js";
import type { SupervisorInput } from "./types.js";

const GPT = { provider: CODEX_HARNESS, modelId: "gpt-5-codex" };
const MINI = { provider: CODEX_HARNESS, modelId: "gpt-5-codex-mini" };

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

describe("Codex supervisor harness: protocol", () => {
  it("starts a thread with exec --json, resumes it for a follow-up, and passes no schema or API key", async () => {
    const fake = fakeCodex([{ text: "not a decision" }, { text: decision(REENTER) }]);
    const harness = fakeCodexHarness(fake, {
      configuredModels: [{ ...GPT, thinkingLevel: "high" }, MINI],
      env: { ...process.env, OPENAI_API_KEY: "sk-secret", CODEX_API_KEY: "sk-other" },
    });
    const host = await harness.start();
    const proposal = await host.decide(input());
    expect(proposal).toMatchObject({ action: { type: "reenter" } });
    const [first, second] = fake.invocations();
    expect(first!.resumed).toBe(false);
    expect(first!.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(first!.argv).toEqual(
      expect.arrayContaining(["--sandbox", "danger-full-access", "--model", "gpt-5-codex", "--config", 'model_reasoning_effort="high"', "--ignore-user-config"]),
    );
    expect(first!.argv).not.toContain("--ephemeral");
    expect(first!.argv).not.toContain("--output-schema");
    expect(first!.argv.at(-1)).toBe("-");
    // The instructions open the thread; Codex has no appended system prompt.
    expect(first!.prompt).toMatch(/^You are the GraphLoom run supervisor, running as Codex\./);
    // The re-ask is the next user turn of the same Codex thread.
    expect(second!.resumed).toBe(true);
    expect(second!.threadId).toBe(first!.threadId);
    expect(second!.argv.slice(0, 6)).toEqual(["exec", "--sandbox", "danger-full-access", "--cd", second!.cwd, "resume"]);
    expect(second!.argv.slice(-2)).toEqual([first!.threadId, "-"]);
    expect(second!.prompt).toMatch(/^Your reply could not be read as a decision/);
    // The user's own login: no key reaches Codex, its home does.
    expect(fake.invocations().every((i) => i.apiKey === null && i.codexHome === fake.codexHome)).toBe(true);
    expect(host.binding).toMatchObject({ harness: CODEX_HARNESS, provider: CODEX_HARNESS, modelId: "gpt-5-codex" });
    // The binding names GraphLoom's record of the session, which names the thread's rollout copy.
    const record = JSON.parse(readFileSync(host.binding.sessionFile!, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ harness: CODEX_HARNESS, model: "gpt-5-codex", role: "decide", threadId: first!.threadId, transcript: `codex-${first!.threadId}.jsonl` });
    expect(readFileSync(path.join(fake.sessionDir, String(record.transcript)), "utf8")).toContain("not a decision");
    // No last-message file is left in the scratch dir.
    expect(readdirSync(path.join(fake.sessionDir, "scratch")).filter((n) => n.startsWith("last-message"))).toEqual([]);
    // Two prompts, no command results: two provider calls.
    expect(host.drainProviderCalls()).toBe(2);
    await host.close();
  });

  it("refuses an API key in passEnv", () => {
    expect(() => createCodexSupervisorHarness({ runId: "r", sessionDir: "/tmp/x", passEnv: ["OPENAI_API_KEY"] })).toThrow(/own Codex login.*OPENAI_API_KEY/);
    expect(() => createCodexSupervisorHarness({ runId: "r", sessionDir: "/tmp/x", passEnv: ["CODEX_API_KEY"] })).toThrow(/CODEX_API_KEY/);
  });

  it("writes GraphLoom's copy back when Codex lost the rollout, so the follow-up still resumes", async () => {
    const fake = fakeCodex([{ text: "thinking out loud" }, { text: decision(REENTER) }]);
    const session = await fakeCodexHarness(fake, { configuredModels: [GPT] }).openSession!({ model: GPT, role: "decide" });
    expect(await session.prompt("first")).toBe("thinking out loud");
    rmSync(path.join(fake.codexHome, "sessions"), { recursive: true, force: true });
    expect(await session.prompt("again")).toContain('"reenter"');
    const [, again] = fake.invocations();
    expect(again!.resumed).toBe(true);
    expect(again!.threadId).toBe(fake.invocations()[0]!.threadId);
    await session.close();
  });

  it("maps a failed turn to the host's provider failure classes", async () => {
    const cases: Array<[FakeCodexStep, string, boolean]> = [
      [{ error: "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes." }, "quota", true],
      [{ error: "stream disconnected before completion: 503 Service Unavailable" }, "transient", false],
      [{ error: "Your input exceeds the context window of this model." }, "overflow", false],
      [{ error: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" }, "auth", false],
      [{ empty: true }, "empty", false],
    ];
    for (const [step, failureClass, hasReset] of cases) {
      const fake = fakeCodex([step]);
      const session = await fakeCodexHarness(fake).openSession!({ model: GPT, role: "decide" });
      expect(await session.prompt("decide")).toBe("");
      const failure = session.lastReplyFailure?.();
      expect(failure?.failureClass).toBe(failureClass);
      if (hasReset) expect(Date.parse(failure!.retryAt!)).toBeGreaterThan(Date.now() + 2 * 3_600_000);
      if (failureClass === "auth") expect(failure?.message).toMatch(/codex login/);
    }
  });

  it("throws an exit with no reported failure for the host's one fresh-session retry", async () => {
    const fake = fakeCodex([{ crash: "panicked at core/src/codex.rs" }]);
    const session = await fakeCodexHarness(fake).openSession!({ model: GPT, role: "decide" });
    const err = await session.prompt("decide").catch((e: unknown) => e);
    expect(isSupervisorProviderError(err) && err.failureClass).toBe("unknown");
    expect(String(err)).toMatch(/Codex run failed: panicked/);

    const recovering = fakeCodex([{ crash: "panicked" }, { text: decision(REENTER) }]);
    const host = await fakeCodexHarness(recovering, { configuredModels: [GPT] }).start();
    expect(await host.decide(input())).toMatchObject({ action: { type: "reenter" } });
    expect(host.drainRemedies().map((r) => [r.failureClass, r.remedy])).toEqual([["unknown", "fresh_session_retry"]]);
    const [crashed, retried] = recovering.invocations();
    expect(retried!.resumed).toBe(false);
    expect(retried!.threadId).not.toBe(crashed!.threadId);
    expect(retried!.prompt).toContain("You are the GraphLoom run supervisor in recovery.");
    await host.close();
  });

  it("stops a silent turn as a timeout, a turn over its allowance as exceeded, and caps a prompt's total time", async () => {
    const fake = fakeCodex([{ hang: true }]);
    const session = await fakeCodexHarness(fake, { promptTimeoutMs: 800 }).openSession!({ model: GPT, role: "decide" });
    const err = await session.prompt("decide").catch((e: unknown) => e);
    expect(isSupervisorProviderError(err) && err.failureClass).toBe("timeout");

    const busy = fakeCodex([{ observe: [{ type: "command_execution", command: "ls", output: "a" }], text: "x" }]);
    const capped = await fakeCodexHarness(busy).openSession!({ model: GPT, role: "decide" });
    // One call for the prompt; the command's output going back would be a second.
    await expect(capped.prompt("decide", { maxTurns: 1 })).rejects.toThrow(/exceeded its 1-turn allowance/);
    await expect(capped.prompt("decide", { maxTurns: 0 })).rejects.toThrow(/exceeded/);

    const slow = fakeCodex([{ observe: [{ type: "command_execution", command: "sleep 5", run: "sleep 5" }], text: "late" }]);
    const long = await fakeCodexHarness(slow, { promptTimeoutMs: 10_000 }).openSession!({ model: GPT, role: "decide" });
    const capErr = await long.prompt("decide", { timeoutMs: 700 }).catch((e: unknown) => e);
    expect(isSupervisorProviderError(capErr) && capErr.failureClass).toBe("timeout");
    expect(String(capErr)).toMatch(/no complete reply within/);
  });

  it("reports usage, and never switches a session's model in place", async () => {
    const fake = fakeCodex([{ text: "ok" }]);
    const session = await fakeCodexHarness(fake).openSession!({ model: GPT, role: "decide" });
    await session.prompt("hi");
    expect(session.lastUsage?.()).toEqual({ inputTokens: 16, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 0 });
    await expect(session.setModel(MINI)).rejects.toThrow(/fresh session/);
  });

  it("passes no --model for Codex's default model, and maps max to xhigh and off to nothing", async () => {
    const fake = fakeCodex([{ text: "a" }, { text: "b" }]);
    const harness = fakeCodexHarness(fake);
    await (await harness.openSession!({ model: { provider: CODEX_HARNESS, modelId: "default", thinkingLevel: "off" }, role: "decide" })).prompt("hi");
    await (await harness.openSession!({ model: { ...GPT, thinkingLevel: "max" }, role: "decide" })).prompt("hi");
    const [plain, max] = fake.invocations();
    expect(plain!.argv).not.toContain("--model");
    expect(plain!.argv).not.toContain("--config");
    expect(max!.argv).toEqual(expect.arrayContaining(["--config", 'model_reasoning_effort="xhigh"']));
  });
});

describe("Codex supervisor harness: probe", () => {
  it("needs confinement, a Codex that knows the flags, and a login", async () => {
    const fake = fakeCodex();
    expect(await fakeCodexHarness(fake).probe()).toEqual({ ok: true });
    const bare = { runId: "r", sessionDir: fake.sessionDir, codexHome: fake.codexHome, loggedIn: async () => true, readHelp: async () => "" };
    expect(await createCodexSupervisorHarness(bare).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/bwrap confinement/) });
    expect(
      await fakeCodexHarness(fake, { confinement: { launch: fake.launch, unsupported: async () => "bubblewrap (bwrap) cannot create a mount namespace here" }, allowUnconfined: false }).probe(),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/runs confined: bubblewrap/) });
    expect(await fakeCodexHarness(fake, { readHelp: async () => undefined }).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/is Codex installed/) });
    expect(await fakeCodexHarness(fake, { readHelp: async () => "resume --json --sandbox danger-full-access" }).probe()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not mention .*--ignore-user-config/),
    });
    expect(await fakeCodexHarness(fake, { loggedIn: async () => false }).probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/codex login/) });
    // The default checks ask Codex itself (`exec --help`, `login status`), with no provider call.
    const bin = path.join(fake.dir, "codex");
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX}' "$@"\n`, { mode: 0o755 });
    const harness = createCodexSupervisorHarness({ runId: "r", sessionDir: fake.sessionDir, codexHome: fake.codexHome, command: bin, allowUnconfined: true });
    expect(await harness.probe()).toMatchObject({ ok: false, reason: expect.stringMatching(/no login in .*codex login/) });
    writeFileSync(path.join(fake.codexHome, "auth.json"), "{}");
    expect(await harness.probe()).toEqual({ ok: true });
  });
});

describe("Codex supervisor harness: investigation evidence and grants", () => {
  it("records commands and file changes, and writes only where a turn is granted", async () => {
    const fake = fakeCodex();
    const worktree = path.join(fake.dir, "worktree");
    const candidate = path.join(fake.dir, "repairs", "a1", "candidate");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(worktree, "x.go"), "package x\n");
    fake.queue([
      {
        observe: [
          { type: "command_execution", command: "/bin/sh -lc 'cat x.go'", run: "cat x.go" },
          { type: "command_execution", command: "go test ./...", run: "echo FAIL; exit 2" },
          { type: "web_search", query: "go test flags" },
        ],
        text: decision(REENTER),
      },
      { observe: [{ type: "file_change", path: "fix.ts", content: "fixed" }], text: "Fixed the off-by-one." },
      { text: decision(REENTER) },
    ]);
    const harness = fakeCodexHarness(fake, { cwd: worktree, configuredModels: [GPT] });
    const session = await harness.openSession!({ model: GPT, role: "decide" });
    await session.prompt("decide");
    const steps = session.investigation!();
    expect(steps.map((s) => [s.id, s.kind, s.tool, s.exitCode])).toEqual([
      ["inv-1", "command", "command_execution", 0],
      ["inv-2", "command", "command_execution", 2],
      ["inv-3", "tool", "web_search", undefined],
    ]);
    // A file read is a shell command, with the file's content as its output.
    expect(steps[0]!.output).toBe("package x\n");
    expect(steps[1]!.output).toBe("FAIL\n");
    expect(steps.every((s) => s.harness === CODEX_HARNESS)).toBe(true);
    // One call for the prompt and one per command result.
    expect(session.drainTurnCount!()).toBe(3);

    // The patch turn resumes the same thread with --cd at the candidate root.
    await session.grantCandidateCoding!(candidate);
    expect(await session.prompt("patch")).toBe("Fixed the off-by-one.");
    expect(readFileSync(path.join(candidate, "fix.ts"), "utf8")).toBe("fixed");
    const patch = fake.invocations()[1]!;
    expect(patch.cwd).toBe(candidate);
    expect(patch.argv.slice(3, 5)).toEqual(["--cd", candidate]);
    expect(patch.resumed).toBe(true);
    expect(session.investigation!().at(-1)).toMatchObject({ id: "inv-4", kind: "file_change", tool: "file_change", input: { path: "fix.ts" }, output: { status: "completed" } });
    await session.revokeCandidateCoding!();
    await session.prompt("after");
    expect(fake.invocations()[2]!.cwd).toBe(worktree);
  });

  it("gives a review session no grants, in the candidate root", async () => {
    const fake = fakeCodex([{ text: "VERDICT: approved\nLooks right." }]);
    const candidate = path.join(fake.dir, "candidate");
    mkdirSync(candidate, { recursive: true });
    const review = await fakeCodexHarness(fake, { configuredModels: [GPT] }).openReviewSession({ cwd: candidate });
    expect(review.grantCandidateCoding).toBeUndefined();
    expect(await review.prompt("review")).toMatch(/^VERDICT: approved/);
    expect(fake.invocations()[0]!.cwd).toBe(candidate);
    expect(fake.invocations()[0]!.prompt).toMatch(/^You are an independent GraphLoom reviewer, running as Codex/);
    const record = readdirSync(fake.sessionDir).find((n) => n.startsWith("codex-session-"))!;
    expect(JSON.parse(readFileSync(path.join(fake.sessionDir, record), "utf8"))).toMatchObject({ role: "review" });
  });

  it("pairs items within a prompt, notes unfinished ones, skips messages and reasoning, and bounds output", () => {
    const recorder = codexStepRecorder(CODEX_HARNESS);
    const big = "x".repeat(MAX_EPISODE_TOOL_RESULT_CHARS * 2);
    recorder.observe({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "private" } });
    recorder.observe({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "looking" } });
    recorder.observe({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "cat big", exit_code: null, status: "in_progress" } });
    recorder.observe({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "cat big", aggregated_output: big, exit_code: 0, status: "completed" } });
    recorder.observe({ type: "item.completed", item: { id: "item_3", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { q: "x" }, result: { hits: 1 }, status: "completed" } });
    recorder.observe({ type: "item.completed", item: { id: "item_4", type: "todo_list", items: [] } });
    recorder.observe({ type: "item.started", item: { id: "item_5", type: "command_execution", command: "make", exit_code: null, status: "in_progress" } });
    recorder.flush();
    // The next process numbers its items from item_0 again.
    recorder.observe({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "ls", aggregated_output: "", exit_code: null, status: "declined" } });
    const steps = recorder.steps();
    expect(steps.map((s) => [s.id, s.kind, s.tool, s.exitCode])).toEqual([
      ["inv-1", "command", "command_execution", 0],
      ["inv-2", "tool", "mcp:docs/search", undefined],
      ["inv-3", "command", "command_execution", undefined],
      ["inv-4", "command", "command_execution", undefined],
    ]);
    expect(JSON.stringify(steps[0]!.output).length).toBeLessThanOrEqual(MAX_EPISODE_TOOL_RESULT_CHARS);
    expect(steps[2]!.output).toMatch(/no result/);
    expect(steps[3]!.output).toEqual({ status: "declined", output: "" });
    expect(JSON.stringify(steps)).not.toContain("private");
  });

  it("lists the steps in follow-ups so the agent can cite them, and drains them for the episode record", async () => {
    const fake = fakeCodex([
      { observe: [{ type: "command_execution", command: "go test ./pkg/x", output: "FAIL", exitCode: 1 }], text: decision(returnToNormal({ summary: "x" }, "x")) },
      { text: decision(REENTER, { evidence: ["inv-1"] }) },
    ]);
    const host = await fakeCodexHarness(fake, { configuredModels: [GPT] }).start();
    let checks = 0;
    const proposal = await host.decide(
      input({
        priorInvestigationSteps: 2,
        admission: {
          facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
          async check() {
            checks += 1;
            expect(host.investigationSteps().map((s) => s.id)).toEqual(["inv-3"]);
            return checks === 1 ? { action: "return", reason: "no receipt", remaining: 2 } : undefined;
          },
          async refuse(action, reason) {
            return { action, reason, remaining: 2 };
          },
        },
      }),
    );
    expect(proposal).toMatchObject({ action: { type: "reenter" }, evidence: ["inv-1"] });
    expect(fake.invocations()[1]!.prompt).toContain('inv-3: command_execution "go test ./pkg/x" exit 1');
    expect(host.drainInvestigation().map((s) => s.id)).toEqual(["inv-3"]);
    await host.close();
  });
});

describe("Codex supervisor harness: switching and restore", () => {
  it("settles an interrupted switch from a session on its target opened after the intent", async () => {
    const fake = fakeCodex();
    const harness = fakeCodexHarness(fake, { configuredModels: [GPT, MINI] });
    const first = await harness.openSession!({ model: GPT, role: "decide" });
    await harness.openSession!({ model: MINI, role: "decide" });
    await new Promise((r) => setTimeout(r, 5));
    const intent = { at: new Date().toISOString(), from: GPT, to: MINI, reason: "slips", status: "intent" as const };
    const binding = { sessionId: "logical", sessionFile: first.sessionFile, provider: CODEX_HARNESS, modelId: GPT.modelId, switchJournal: [intent], harness: CODEX_HARNESS };
    expect(await reconcileSupervisorBinding(binding)).toMatchObject({ modelId: GPT.modelId, switchJournal: [{ status: "failed" }] });
    await new Promise((r) => setTimeout(r, 5));
    await harness.openSession!({ model: MINI, role: "decide" });
    expect(await lastCodexSessionModel(fake.sessionDir)).toEqual(MINI);
    expect(await reconcileSupervisorBinding(binding)).toMatchObject({ modelId: MINI.modelId, switchJournal: [{ status: "committed" }] });
  });

  it("commits a switch by opening a fresh thread on the target, never resuming the old one", async () => {
    const fake = fakeCodex([{ text: JSON.stringify({ switch_model: { ...MINI, reason: "faster" } }) }, { text: decision(REENTER) }]);
    const host = await fakeCodexHarness(fake, { configuredModels: [GPT, MINI] }).start();
    expect(await host.decide(input())).toMatchObject({ type: "switch_model", modelId: MINI.modelId });
    await host.switchModel({ ...MINI, reason: "faster" });
    expect(host.binding.switchJournal.map((r) => r.status)).toEqual(["committed"]);
    await host.decide(input({ rejection: { action: "return", reason: "no", remaining: 2 } }));
    const [before, after] = fake.invocations();
    expect(after!.resumed).toBe(false);
    expect(after!.threadId).not.toBe(before!.threadId);
    expect(after!.argv).toEqual(expect.arrayContaining(["--model", MINI.modelId]));
    expect(after!.prompt).toContain("You are the GraphLoom run supervisor in recovery.");
    await host.close();
  });

  it("restores a codex binding on the bound model in a fresh thread, and refuses another harness's", async () => {
    const fake = fakeCodex([{ text: decision(stop({ reason: "blocked", blocker: "disk full", evidenceRefs: ["ev-1"] }, "stop")) }]);
    const harness = fakeCodexHarness(fake, { configuredModels: [GPT, MINI] });
    const host = await harness.restore({
      sessionId: "logical-7",
      sessionFile: path.join(fake.sessionDir, "codex-session-00000000-0000-4000-8000-000000000000.json"),
      provider: CODEX_HARNESS,
      modelId: MINI.modelId,
      switchJournal: [],
      harness: CODEX_HARNESS,
    });
    expect(host.sessionId).toBe("logical-7");
    await host.decide(input());
    expect(fake.invocations()[0]).toMatchObject({ resumed: false });
    expect(fake.invocations()[0]!.argv).toEqual(expect.arrayContaining(["--model", MINI.modelId]));
    await expect(harness.restore({ sessionId: "x", sessionFile: undefined, provider: "claude-code", modelId: "opus", switchJournal: [], harness: "claude-code" })).rejects.toThrow(
      /pinned to the claude-code harness/,
    );
    expect(() => statSync(path.join(fake.sessionDir, "scratch"))).not.toThrow();
  });
});

describe("classifyCodexFailure", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  it("reads usage limits with and without a reset time as quota", () => {
    expect(classifyCodexFailure("Codex run failed: You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.", now)).toMatchObject({
      failureClass: "quota",
      retryAt: "2026-10-27T12:13:00.000Z",
    });
    expect(classifyCodexFailure("Codex run failed: You've hit your usage limit. Try again later.", now)).toEqual({
      failureClass: "quota",
      message: "Codex run failed: You've hit your usage limit. Try again later.",
    });
  });
  it("reads a missing login as auth, provider errors as transient, and the rest by what they say", () => {
    expect(classifyCodexFailure("Codex run failed: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", now)).toMatchObject({
      failureClass: "auth",
      message: expect.stringMatching(/codex login/),
    });
    expect(classifyCodexFailure("Codex run failed: Selected model is at capacity. Please try a different model.", now).failureClass).toBe("transient");
    expect(classifyCodexFailure("Codex run failed: stream disconnected before completion: ECONNRESET", now).failureClass).toBe("transient");
    expect(classifyCodexFailure("Codex run failed: context_length_exceeded", now).failureClass).toBe("overflow");
    expect(classifyCodexFailure("could not start Codex (codex): spawn ENOENT", now).failureClass).toBe("unknown");
  });
});
