// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecutorContext, ToolCallRequest } from "@graphloom/sdk";
import { createClaudeCodeHarness } from "./claude.js";
import { createCodingAgentExecutor } from "./index.js";

/**
 * Runs the user's real Claude Code (its own login, or ANTHROPIC_API_KEY).
 * Opt in with GRAPHLOOM_CLAUDE_LIVE=1; GRAPHLOOM_CLAUDE_MODEL picks the model (default haiku).
 */
const live = process.env.GRAPHLOOM_CLAUDE_LIVE === "1";
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!live)("Claude Code harness against the real CLI", () => {
  it("calls a graph tool, writes with its own tools, returns structured output, and resumes", { timeout: 240_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-claude-live-"));
    dirs.push(dir);
    const executor = createCodingAgentExecutor(createClaudeCodeHarness({ model: process.env.GRAPHLOOM_CLAUDE_MODEL || "haiku" }));
    const calls: ToolCallRequest[] = [];
    let modelCalls = 0;
    const ctx = (resume?: string): ExecutorContext => ({
      runId: "live",
      operationId: "op",
      generation: 1,
      worktreePath: dir,
      artifactDir: dir,
      writeScope: ["GREETING.txt"],
      usage: { reserveModelCall: async () => (modelCalls += 1) <= 20 },
      session: { dir: path.join(dir, ".sessions"), ...(resume !== undefined ? { resume } : {}) },
      tools: {
        bindings: [{ name: "get_greeting", effect: "read", description: "Returns the greeting text to write" }],
        async call(req) {
          calls.push(req);
          return { status: "ok", summary: "greeting", evidence: [{ kind: "other", payload: { greeting: "Hello, GraphLoom!" } }] };
        },
      },
    });
    const schema = JSON.stringify({ type: "object", properties: { wrote: { type: "string" } }, required: ["wrote"] });
    const first = await executor.execute(
      {
        assignment:
          "Call the get_greeting tool once, then use Bash to write its greeting followed by a newline to GREETING.txt. Report the file you wrote.",
        resultSchema: schema,
      },
      ctx(),
    );
    expect(first, JSON.stringify(first)).toMatchObject({ status: "ok" });
    const usage = (first as { evidence: [{ payload: { codingAgent: { usage: { outputTokens: number } } } }] }).evidence[0].payload.codingAgent.usage;
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(await readFile(path.join(dir, "GREETING.txt"), "utf8")).toBe("Hello, GraphLoom!\n");
    const ref = (first as { sessionRef?: string }).sessionRef!;
    expect(ref).toMatch(/^claude-/);

    const second = await executor.execute(
      { assignment: "Without using tools, which file did you write in your earlier turn?", resultSchema: schema },
      ctx(ref),
    );
    expect(second, JSON.stringify(second)).toMatchObject({ status: "ok", sessionRef: ref });
    const output = (second as { evidence: [{ payload: { codingAgent: { output: { wrote: string } } } }] }).evidence[0].payload.codingAgent.output;
    expect(output.wrote).toContain("GREETING.txt");
  });
});
