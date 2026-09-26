import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorContext, ToolCallRequest } from "@graphloom/sdk";
import {
  codingAgentBinding,
  codingAgentExecutorPackage,
  CODING_AGENT_RUN_ID,
  CONTINUATION_NOTICE,
  createCodingAgentExecutor,
  piHarnessModule,
  type CodingHarness,
} from "./index.js";
import { createScriptedHarness } from "./testing/scripted-harness.js";

const executor = createCodingAgentExecutor(createScriptedHarness());

async function ctx(over: Partial<ExecutorContext> = {}): Promise<ExecutorContext> {
  return {
    runId: "r1",
    operationId: "op1",
    generation: 1,
    worktreePath: await mkdtemp(path.join(os.tmpdir(), "gl-agent-")),
    artifactDir: os.tmpdir(),
    writeScope: ["notes.md"],
    ...over,
  };
}

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, unknown> } }] }).evidence[0].payload.codingAgent;
}

describe("graphloom.coding-agent/run", () => {
  it("runs the harness in the worktree with the job's tools and model budget", async () => {
    const calls: ToolCallRequest[] = [];
    let budget = 1;
    const c = await ctx({
      tools: {
        bindings: [{ name: "read_comments", effect: "read" }],
        async call(req) {
          calls.push(req);
          return { status: "ok", summary: "2 comments", childOperationId: "child-1" };
        },
      },
      usage: { reserveModelCall: async () => budget-- > 0 },
    });
    const result = await executor.execute(
      {
        assignment: "Summarize the discussion into notes.md",
        harnessOptions: {
          steps: [
            { model: true },
            { tool: "read_comments", id: "call-1", input: { issue: 7 } },
            { write: { path: "notes.md", content: "summary\n" } },
          ],
        },
      },
      c,
    );
    expect(result).toMatchObject({ status: "ok", summary: "scripted agent ran 3 steps" });
    expect(calls).toEqual([{ toolCallId: "call-1", tool: "read_comments", input: { issue: 7 } }]);
    expect(await readFile(path.join(c.worktreePath, "notes.md"), "utf8")).toBe("summary\n");
    expect(payload(result)).toMatchObject({
      harness: "scripted",
      modelCalls: 1,
      toolCalls: [{ toolCallId: "call-1", tool: "read_comments", status: "ok", childOperationId: "child-1", replayed: false }],
    });
  });

  it("stops the agent when the run's model budget is exhausted", async () => {
    const result = await executor.execute(
      { assignment: "work", harnessOptions: { steps: [{ model: true }, { model: true }] } },
      await ctx({ usage: { reserveModelCall: async () => false } }),
    );
    expect(result).toMatchObject({ status: "failed", summary: "model request budget exhausted" });
  });

  it("grants no model requests when the host does not account for them", async () => {
    const result = await executor.execute({ assignment: "work", harnessOptions: { steps: [{ model: true }] } }, await ctx());
    expect(result).toMatchObject({ status: "failed" });
  });

  it("offers the agent only the tools the job declared", async () => {
    const result = await executor.execute(
      { assignment: "work", harnessOptions: { steps: [{ tool: "delete_repo", id: "x" }] } },
      await ctx(),
    );
    expect(result).toMatchObject({ status: "failed", summary: "tool delete_repo is not available" });
  });

  it("saves a session the controller gave a directory for, and continues it with a notice", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-session-"));
    const first = await executor.execute(
      { assignment: "Write notes.md", harnessOptions: { steps: [{ write: { path: "notes.md", content: "draft\n" } }] } },
      await ctx({ session: { dir } }),
    );
    const sessionRef = (first as { sessionRef?: string }).sessionRef;
    expect(sessionRef).toMatch(/^scripted-[a-z0-9]{8}$/);
    expect(payload(first)).toMatchObject({ sessionRef, continued: false });
    expect(JSON.parse(await readFile(path.join(dir, `${sessionRef}.json`), "utf8")).turns).toHaveLength(1);

    const second = await executor.execute(
      { assignment: "Fix notes.md", harnessOptions: { steps: [] } },
      await ctx({ operationId: "op2", session: { dir, resume: sessionRef! } }),
    );
    expect(second).toMatchObject({ status: "ok", sessionRef });
    const agent = payload(second);
    expect(agent).toMatchObject({ continued: true, sessionRef });
    const output = agent.output as { assignment: string; priorAssignments: string[] };
    expect(output.priorAssignments).toEqual(["Write notes.md"]);
    expect(output.assignment).toBe(`${CONTINUATION_NOTICE}\n\nFix notes.md`);
    // Each turn replaces the transcript whole; no partial or temporary file is left behind.
    expect(await readdir(dir)).toEqual([`${sessionRef}.json`]);
    expect(JSON.parse(await readFile(path.join(dir, `${sessionRef}.json`), "utf8")).turns).toHaveLength(2);
  });

  it("fails instead of starting fresh when the session cannot be restored", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-session-"));
    const missing = await executor.execute(
      { assignment: "Fix it", harnessOptions: { steps: [{ write: { path: "notes.md", content: "x" } }] } },
      await ctx({ session: { dir, resume: "scripted-deadbeef" } }),
    );
    expect(missing).toEqual({
      status: "failed",
      summary: "agent session scripted-deadbeef could not be restored: no transcript for scripted-deadbeef",
    });

    const oneShot: CodingHarness = { name: "one-shot", createSession: createScriptedHarness().createSession };
    const refused = await createCodingAgentExecutor(oneShot).execute(
      { assignment: "Fix it" },
      await ctx({ session: { dir, resume: "scripted-deadbeef" } }),
    );
    expect(refused).toEqual({ status: "failed", summary: "harness one-shot cannot continue agent session scripted-deadbeef" });
  });

  it("names no session when the controller gave the job no session directory", async () => {
    const result = await executor.execute({ assignment: "work" }, await ctx());
    expect(result).not.toHaveProperty("sessionRef");
    expect(payload(result)).toMatchObject({ sessionRef: null, continued: false });
  });

  it("rejects an empty or oversized assignment", () => {
    expect(executor.inputSchema?.({ assignment: "" })).toBe(false);
    expect(executor.inputSchema?.({ assignment: "x".repeat(64_001) })).toBe(false);
    expect(executor.inputSchema?.({ assignment: "ok", harnessOptions: [] })).toBe(false);
    expect(executor.inputSchema?.({ assignment: "ok" })).toBe(true);
  });

  it("declares an unrestricted package that the operator binding consents to", () => {
    expect(codingAgentExecutorPackage).toMatchObject({
      executorIds: [CODING_AGENT_RUN_ID],
      credentials: ["pi-api-key"],
      configEnv: ["GRAPHLOOM_CODING_HARNESS", "GRAPHLOOM_PI_PROVIDER", "GRAPHLOOM_PI_MODEL", "GRAPHLOOM_PI_AGENT_DIR"],
      isolation: "unrestricted",
    });
    expect(codingAgentBinding({ harness: "/h.js" })).toEqual({
      allowedEffects: ["read", "write"],
      allowUnrestricted: true,
      env: { GRAPHLOOM_CODING_HARNESS: "/h.js" },
    });
  });

  it("binds Pi settings as config and the API key only as a credential", () => {
    const binding = codingAgentBinding({
      harness: piHarnessModule,
      pi: { provider: "anthropic", modelId: "claude-x", agentDir: "/pi", apiKey: "sk-secret" },
    });
    expect(binding).toEqual({
      allowedEffects: ["read", "write"],
      allowUnrestricted: true,
      env: {
        GRAPHLOOM_CODING_HARNESS: piHarnessModule,
        GRAPHLOOM_PI_PROVIDER: "anthropic",
        GRAPHLOOM_PI_MODEL: "claude-x",
        GRAPHLOOM_PI_AGENT_DIR: "/pi",
      },
      credentials: { "pi-api-key": "sk-secret" },
    });
    expect(JSON.stringify(binding.env)).not.toContain("sk-secret");
    expect(piHarnessModule).toMatch(/[\\/]pi\.js$/);
  });
});
