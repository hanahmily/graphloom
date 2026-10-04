import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REHEARSAL_ADVERSARIAL_ENV, REHEARSAL_SYNTHESIZED_ENV, type ExecutorContext, type RehearsalScenario } from "@graphloom/sdk";
import { createCodingAgentExecutor } from "../index.js";
import { REHEARSAL_HOME_ENV, REHEARSAL_SCENARIO_ENV, resetRehearsalScenarioCache } from "./scenario.js";
import { createPiRehearsalHarness } from "./pi.js";

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  resetRehearsalScenarioCache();
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, unknown> } }] }).evidence[0].payload.codingAgent;
}

const contract = {
  name: "review-verdict-v1",
  schema: {
    type: "object",
    properties: { verdict: { type: "string", enum: ["approved", "request_changes"] }, summary: { type: "string" } },
    required: ["verdict", "summary"],
  },
};

describe("Pi rehearsal stand-in", () => {
  async function ready(scenario: RehearsalScenario) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-rehearsal-"));
    temps.push(dir);
    const worktree = path.join(dir, "worktree");
    const home = path.join(dir, "home");
    await mkdir(worktree, { recursive: true });
    const scenarioPath = path.join(dir, "scenario.json");
    await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
    vi.stubEnv(REHEARSAL_SCENARIO_ENV, scenarioPath);
    vi.stubEnv(REHEARSAL_HOME_ENV, home);
    const executor = createCodingAgentExecutor(createPiRehearsalHarness());
    const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
      runId: "r1",
      operationId: "op1",
      generation: 1,
      worktreePath: worktree,
      artifactDir: dir,
      usage: { reserveModelCall: async () => true },
      ...over,
    });
    return { executor, ctx, worktree };
  }

  it("refuses to run without a scenario (the seam guard)", async () => {
    const executor = createCodingAgentExecutor(createPiRehearsalHarness());
    const ctx: ExecutorContext = {
      runId: "r1",
      operationId: "op1",
      generation: 1,
      worktreePath: "/tmp/does-not-matter",
      artifactDir: "/tmp",
      usage: { reserveModelCall: async () => true },
    };
    await expect(executor.execute({ assignment: "review" }, ctx)).rejects.toThrow(/refuses to impersonate/);
  });

  it("drives the real submit_result flow from a scripted reply", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "looks right" } }] },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "looks right" } });
  });

  it("refuses to emit a field the assignment never asked for", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "looks right" } }] },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute({ assignment: "Review the change and return a verdict." }, ctx({ resultContract: contract }));
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("summary") });
  });

  it("passes a field declared harnessSupplied without it being named", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "looks right" }, harnessSupplied: ["summary"] }] },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute({ assignment: "Review the change and return a verdict." }, ctx({ resultContract: contract }));
    expect(result).toMatchObject({ status: "ok" });
  });

  it("writes a reply's effects into the worktree before submitting", async () => {
    const { executor, ctx, worktree } = await ready({
      results: {
        "review-verdict-v1": [
          { output: { verdict: "approved", summary: "looks right" }, effects: [{ path: "NOTES.md", bytes: "reviewed\n" }] },
        ],
      },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract, writeScope: ["."] }),
    );
    expect(result).toMatchObject({ status: "ok" });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(worktree, "NOTES.md"), "utf8")).toBe("reviewed\n");
  });

  it("synthesizes a minimal reply when the scenario names no reply for the contract", async () => {
    const { executor, ctx } = await ready({ results: {}, expect: { status: "succeeded" } });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "summary" } });
  });

  it("--synthesized ignores a scripted reply and synthesizes instead", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "request_changes", summary: "scripted" } }] },
      expect: { status: "succeeded" },
    });
    vi.stubEnv(REHEARSAL_SYNTHESIZED_ENV, "1");
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "summary" } });
  });

  it("--adversarial drops a required property, triggering Pi's own in-turn rejection and a corrected resubmission", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "scripted" } }] },
      expect: { status: "succeeded" },
    });
    vi.stubEnv(REHEARSAL_ADVERSARIAL_ENV, "1");
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    // The mutated first submission is rejected in-turn; the model's own
    // follow-up resubmits the original, uncorrupted reply, which succeeds.
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "scripted" } });
  });

  const findingContract = {
    name: "plan-review-v1",
    schema: { type: "object", properties: { finding: { type: "string" } }, required: ["finding"] },
    references: ["finding"],
    knownReferences: { finding: { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } },
  };

  it("--adversarial writes a reference's own shown description, triggering the existing repair path", async () => {
    const { executor, ctx } = await ready({
      results: { "plan-review-v1": [{ output: { finding: "P1" } }] },
      expect: { status: "succeeded" },
    });
    vi.stubEnv(REHEARSAL_ADVERSARIAL_ENV, "1");
    const result = await executor.execute({ assignment: "review and name the finding" }, ctx({ resultContract: findingContract }));
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { finding: "P1" } });
  });

  it("--adversarial writes an effect outside the job's write scope when the reply has any effect at all", async () => {
    const { executor, ctx, worktree } = await ready({
      results: {
        "review-verdict-v1": [
          { output: { verdict: "approved", summary: "scripted" }, effects: [{ path: "NOTES.md", bytes: "noted\n" }] },
        ],
      },
      expect: { status: "succeeded" },
    });
    vi.stubEnv(REHEARSAL_ADVERSARIAL_ENV, "1");
    await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(await readFile(path.join(worktree, "NOTES.md"), "utf8")).toBe("noted\n");
    const strayPath = path.join(worktree, ".graphloom-adversarial-stray-write");
    expect(await readFile(strayPath, "utf8")).toBe("adversarial: write outside scope\n");
  });

  it("repeats the last scripted reply once a contract's list is exhausted", async () => {
    const { executor, ctx } = await ready({
      results: {
        "review-verdict-v1": [
          { output: { verdict: "request_changes", summary: "first pass" } },
          { output: { verdict: "approved", summary: "second pass" } },
        ],
      },
      expect: { status: "succeeded" },
    });
    const input = { assignment: "Review the change and return a verdict and a summary." };
    const first = await executor.execute(input, ctx({ resultContract: contract, operationId: "op-1" }));
    const second = await executor.execute(input, ctx({ resultContract: contract, operationId: "op-2" }));
    const third = await executor.execute(input, ctx({ resultContract: contract, operationId: "op-3" }));
    expect(payload(first)).toMatchObject({ output: { verdict: "request_changes" } });
    expect(payload(second)).toMatchObject({ output: { verdict: "approved" } });
    expect(payload(third)).toMatchObject({ output: { verdict: "approved" } });
  });

  it("fails the job without submitting when the reply scripts no-result", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ fail: { kind: "no-result" } }] },
      expect: { status: "stopped" },
    });
    const result = await executor.execute({ assignment: "Review the change." }, ctx({ resultContract: contract }));
    expect(result).toMatchObject({ status: "failed" });
  });

  it("fails the job with the scripted summary when the reply scripts exit", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ fail: { kind: "exit", summary: "simulated provider outage" } }] },
      expect: { status: "stopped" },
    });
    const result = await executor.execute({ assignment: "Review the change." }, ctx({ resultContract: contract }));
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("simulated provider outage") });
  });

  it("aborts a hang reply when the job's own signal aborts first", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ fail: { kind: "hang", ms: 60_000 } }] },
      expect: { status: "stopped" },
    });
    const controller = new AbortController();
    const resultPromise = executor.execute({ assignment: "Review the change." }, ctx({ resultContract: contract, signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const result = await resultPromise;
    expect(result).toMatchObject({ status: "failed", summary: "agent session aborted" });
  }, 10_000);

  it("resumes a continued session, forwarding the continuation notice", async () => {
    const { executor, ctx, worktree } = await ready({
      results: {
        "review-verdict-v1": [
          { output: { verdict: "request_changes", summary: "first look" } },
          { output: { verdict: "approved", summary: "second look" } },
        ],
      },
      expect: { status: "succeeded" },
    });
    const sessionDir = path.join(worktree, "..", "sessions");
    const first = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract, session: { dir: sessionDir } }),
    );
    const sessionRef = (first as { sessionRef?: string }).sessionRef;
    expect(sessionRef).toBeDefined();
    const second = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract, operationId: "op-2", session: { dir: sessionDir, resume: sessionRef! } }),
    );
    expect(payload(second)).toMatchObject({ continued: true });
    expect((payload(second) as { output: { summary: string } }).output.summary).toBe("second look");
  });
});
