import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobResult, Runner } from "@graphloom/runner";
import type { JobSpec } from "@graphloom/sdk";
import { loadAgentConfig, parseAgentConfig, servePlainAgentJobs } from "../src/agent-config.js";

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-agent-config-"));
  temps.push(dir);
  return dir;
}

describe("operator coding agent config", () => {
  it("reads a Claude Code or Pi harness, with Pi's model from the environment when the file omits it", () => {
    expect(parseAgentConfig({ harness: "claude-code", model: "sonnet", configDir: "/srv/claude", timeoutMs: 600_000 })).toEqual({
      harness: "claude-code",
      model: "sonnet",
      configDir: "/srv/claude",
      timeoutMs: 600_000,
    });
    expect(parseAgentConfig({ harness: "pi" }, "cfg", { GRAPHLOOM_PI_PROVIDER: "minimax-cn", GRAPHLOOM_PI_MODEL: "MiniMax-M3" })).toEqual({
      harness: "pi",
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
    });
    expect(parseAgentConfig({ harness: "pi", provider: "deepseek", modelId: "deepseek-chat" }, "cfg", {})).toMatchObject({
      provider: "deepseek",
      modelId: "deepseek-chat",
    });
  });

  it("refuses credentials, unknown settings, and an unknown harness", () => {
    expect(() => parseAgentConfig({ harness: "claude-code", apiKey: "sk-ant-x" }, "cfg")).toThrow(
      "cfg: apiKey is not a claude-code setting; credentials never go in this file",
    );
    expect(() => parseAgentConfig({ harness: "pi", provider: "p", modelId: "m", token: "t" }, "cfg")).toThrow(/credentials never go in this file/);
    expect(() => parseAgentConfig({ harness: "pi", provider: "p", modelId: "m", model: "x" }, "cfg")).toThrow("cfg: model is not a pi setting");
    expect(() => parseAgentConfig({ harness: "codex" }, "cfg")).toThrow("cfg: harness must be one of claude-code, pi");
    expect(() => parseAgentConfig({ harness: "pi" }, "cfg", {})).toThrow(
      "cfg: the pi harness needs provider and modelId (or GRAPHLOOM_PI_PROVIDER and GRAPHLOOM_PI_MODEL)",
    );
  });

  it("loads the file named by GRAPHLOOM_AGENT_CONFIG, falls back to GRAPHLOOM_AGENT_HARNESS, and otherwise says how to configure one", async () => {
    const dir = await tempDir();
    const bin = path.join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    const file = path.join(dir, "agent.json");
    await writeFile(file, JSON.stringify({ harness: "claude-code", command: bin }));
    expect(await loadAgentConfig({ GRAPHLOOM_AGENT_CONFIG: file })).toEqual({ harness: "claude-code", command: bin });
    expect(await loadAgentConfig({ HOME: dir, GRAPHLOOM_AGENT_HARNESS: "claude-code", PATH: dir })).toEqual({ harness: "claude-code" });
    await expect(loadAgentConfig({ GRAPHLOOM_AGENT_CONFIG: path.join(dir, "absent.json") })).rejects.toThrow(/cannot read agent config/);
    await expect(loadAgentConfig({ GRAPHLOOM_AGENT_HARNESS: "claude-code", PATH: path.join(dir, "empty") })).rejects.toThrow(
      "Claude Code command claude was not found",
    );
    const home = await tempDir();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(loadAgentConfig({})).rejects.toThrow(/^no coding agent configured: create ~\/\.config\/graphloom\/agent\.json/);
    } finally {
      process.env.HOME = saved;
    }
  });
});

describe("plain agent jobs on the coding agent", () => {
  const ctx = { runId: "r", operationId: "op", generation: 1, worktreePath: "/w", artifactDir: "/a" };
  const job = (over: Partial<JobSpec>): JobSpec => ({
    stageId: "review",
    kind: "agent",
    purpose: "review",
    instruction: "Review GREETING.txt.",
    readOnly: true,
    resultSchema: "review-verdict-v1",
    executor: { id: "graphloom.agent/run", version: "1", digest: "d1" },
    ...over,
  });
  const inner = (output: unknown) => {
    const seen: JobSpec[] = [];
    const runner: Runner = {
      async runJob(j, c): Promise<JobResult> {
        seen.push(j);
        return { status: "ok", summary: "done", runId: c.runId, operationId: c.operationId, generation: c.generation, evidence: [{ kind: "other", payload: { codingAgent: { output } } }] };
      },
      async describeExecutors() {
        return [{ id: "graphloom.coding-agent/run", digest: "d1", source: "/pkg", entryModule: "/pkg/executors.js", isolation: "unrestricted", builtin: true }];
      },
    };
    return { runner, seen };
  };

  it("serves the agent-run pin with the coding agent's code, the instruction as the assignment", async () => {
    const { runner, seen } = inner({ verdict: "approved" });
    const served = servePlainAgentJobs(runner);
    expect((await served.describeExecutors!()).map((d) => [d.id, d.digest, d.source])).toEqual([
      ["graphloom.coding-agent/run", "d1", "/pkg"],
      ["graphloom.agent/run", "d1", "/pkg"],
    ]);
    await served.runJob(job({}), ctx);
    expect(seen[0]).toMatchObject({
      executor: { id: "graphloom.coding-agent/run", version: "1", digest: "d1" },
      input: { assignment: "Review GREETING.txt.", resultSchema: "review-verdict-v1" },
    });
  });

  it("reports a read-only review job's structured result as its verdict, and nothing else as one", async () => {
    const review = await servePlainAgentJobs(inner({ verdict: "approved", summary: "ok" }).runner).runJob(job({}), ctx);
    expect(review.evidence?.filter((e) => e.kind === "review").map((e) => e.payload)).toEqual([{ verdict: "approved", summary: "ok" }]);

    for (const other of [job({ purpose: "work", readOnly: false, writeScope: ["GREETING.txt"] }), job({ readOnly: false })]) {
      const result = await servePlainAgentJobs(inner({ verdict: "approved" }).runner).runJob(other, ctx);
      expect(result.evidence?.some((e) => e.kind === "review")).toBe(false);
    }
    const noOutput = await servePlainAgentJobs(inner(null).runner).runJob(job({}), ctx);
    expect(noOutput.evidence?.some((e) => e.kind === "review")).toBe(false);
  });

  it("passes jobs that name an executor through unchanged", async () => {
    const { runner, seen } = inner(null);
    const named = job({ executor: { id: "graphloom.coding-agent/run", version: "1" }, input: { assignment: "x" } });
    await servePlainAgentJobs(runner).runJob(named, ctx);
    expect(seen[0]).toBe(named);
  });
});
