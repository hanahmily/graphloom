// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it, vi } from "vitest";
import { createChildExecutorRunner } from "./registry.js";

vi.mock("./confine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./confine.js")>()),
  confinementUnsupported: async () => "write confinement needs Linux bubblewrap and is not available on testos",
}));

describe("a job that must be confined, on a machine that cannot confine it (#165)", () => {
  const runner = createChildExecutorRunner({
    entryModule: "/unused/executors.js",
    executorIds: ["acme.cmd/run"],
    fallback: { runJob: async () => Promise.reject(new Error("fallback must not run")) },
  });
  const job = { stageId: "s", kind: "command", purpose: "diagnostic", instruction: "x", executor: { id: "acme.cmd/run" }, input: {} } as never;
  const confinement = { scratchDir: "/run/scratch", writablePaths: ["/run/worktree"] };

  it("is refused in-turn, saying why, instead of being run unconfined", async () => {
    expect(await runner.checkJob!(job, { confinement })).toMatch(/cannot be confined to the run: write confinement needs Linux bubblewrap/);
  });

  it("is not run at all", async () => {
    const result = await runner.runJob(job, { runId: "r", operationId: "o", generation: 1, worktreePath: "/run/worktree", artifactDir: "/run/art", confinement });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cannot be confined to the run, so the job was not run: .*testos/);
  });
});
