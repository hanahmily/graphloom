// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { createScriptedRunner } from "./scripted.js";

const job = (id: string): JobSpec => ({
  stageId: "write",
  kind: "agent",
  purpose: "work",
  instruction: id,
});

const ctx = {
  runId: "r1",
  operationId: "op-1",
  generation: 1,
  worktreePath: "/tmp/wt",
  artifactDir: "/tmp/art",
};

describe("createScriptedRunner", () => {
  it("returns scripted results in order and echoes identity", async () => {
    const runner = createScriptedRunner({
      jobs: [
        () => ({ status: "ok", summary: "first" }),
        () => ({ status: "ok", summary: "second" }),
      ],
    });
    const first = await runner.runJob(job("a"), ctx);
    expect(first.summary).toBe("first");
    expect(first.runId).toBe("r1");
    expect(first.operationId).toBe("op-1");
    expect(first.generation).toBe(1);
    expect((await runner.runJob(job("b"), { ...ctx, operationId: "op-2" })).summary).toBe(
      "second",
    );
  });

  it("throws when exhausted", async () => {
    const runner = createScriptedRunner({
      jobs: [() => ({ status: "ok", summary: "only" })],
    });
    await runner.runJob(job("a"), ctx);
    await expect(runner.runJob(job("b"), ctx)).rejects.toThrow(/exhausted/);
  });
});
