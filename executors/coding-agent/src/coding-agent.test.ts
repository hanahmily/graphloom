import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorContext, ToolCallRequest } from "@graphloom/sdk";
import { codingAgentBinding, codingAgentExecutorPackage, CODING_AGENT_RUN_ID, createCodingAgentExecutor } from "./index.js";
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

  it("rejects an empty or oversized assignment", () => {
    expect(executor.inputSchema?.({ assignment: "" })).toBe(false);
    expect(executor.inputSchema?.({ assignment: "x".repeat(64_001) })).toBe(false);
    expect(executor.inputSchema?.({ assignment: "ok", harnessOptions: [] })).toBe(false);
    expect(executor.inputSchema?.({ assignment: "ok" })).toBe(true);
  });

  it("declares an unrestricted package that the operator binding consents to", () => {
    expect(codingAgentExecutorPackage).toMatchObject({
      executorIds: [CODING_AGENT_RUN_ID],
      configEnv: ["GRAPHLOOM_CODING_HARNESS"],
      isolation: "unrestricted",
    });
    expect(codingAgentBinding({ harness: "/h.js" })).toEqual({
      allowedEffects: ["read", "write"],
      allowUnrestricted: true,
      env: { GRAPHLOOM_CODING_HARNESS: "/h.js" },
    });
  });
});
