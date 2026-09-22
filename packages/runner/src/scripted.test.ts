import { describe, expect, it } from "vitest";
import { createScriptedRunner } from "./scripted.js";
import type { JobSpec } from "@graphloom/sdk";

const job = (id: string): JobSpec => ({
  stageId: "write",
  kind: "agent",
  purpose: "work",
  instruction: id,
});

const ctx = {
  runId: "r1",
  generation: 1,
  worktreePath: "/tmp/wt",
  artifactDir: "/tmp/art",
};

describe("createScriptedRunner", () => {
  it("returns scripted results in order", async () => {
    const runner = createScriptedRunner({
      jobs: [
        () => ({ status: "ok", summary: "first" }),
        () => ({ status: "ok", summary: "second" }),
      ],
    });
    expect((await runner.runJob(job("a"), ctx)).summary).toBe("first");
    expect((await runner.runJob(job("b"), ctx)).summary).toBe("second");
  });

  it("throws when exhausted", async () => {
    const runner = createScriptedRunner({
      jobs: [() => ({ status: "ok", summary: "only" })],
    });
    await runner.runJob(job("a"), ctx);
    await expect(runner.runJob(job("b"), ctx)).rejects.toThrow(/exhausted/);
  });
});
