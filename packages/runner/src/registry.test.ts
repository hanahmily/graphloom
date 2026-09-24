import { describe, expect, it } from "vitest";
import { defineExecutor } from "@graphloom/sdk";
import { createRegistryRunner, createScriptedRunner } from "./index.js";

describe("createRegistryRunner", () => {
  it("executes a registered custom executor by pin id", async () => {
    const echo = defineExecutor({
      id: "acme.echo/ping",
      effect: "read",
      inputSchema: (v): v is { msg: string } =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as { msg?: unknown }).msg === "string",
      async execute(input) {
        return { status: "ok" as const, summary: `echo:${input.msg}` };
      },
    });
    const runner = createRegistryRunner({
      executors: [echo],
      fallback: createScriptedRunner({ jobs: [] }),
    });
    const result = await runner.runJob(
      {
        stageId: "write",
        kind: "agent",
        purpose: "diagnostic",
        instruction: "unused",
        executor: { id: "acme.echo/ping" },
        input: { msg: "hi" },
      },
      {
        runId: "r1",
        operationId: "op1",
        generation: 1,
        worktreePath: "/tmp",
        artifactDir: "/tmp/a",
      },
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("echo:hi");
    expect(result.runId).toBe("r1");
  });

  it("falls back for built-in agent pins", async () => {
    const runner = createRegistryRunner({
      executors: [],
      fallback: createScriptedRunner({
        jobs: [async () => ({ status: "ok", summary: "scripted" })],
      }),
    });
    const result = await runner.runJob(
      {
        stageId: "write",
        kind: "agent",
        purpose: "work",
        instruction: "write",
      },
      {
        runId: "r1",
        operationId: "op1",
        generation: 1,
        worktreePath: "/tmp",
        artifactDir: "/tmp/a",
      },
    );
    expect(result.summary).toBe("scripted");
  });

  it("fails closed on schema rejection", async () => {
    const echo = defineExecutor({
      id: "acme.echo/ping",
      effect: "read",
      inputSchema: (v): v is { msg: string } =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as { msg?: unknown }).msg === "string",
      async execute(input) {
        return input;
      },
    });
    const runner = createRegistryRunner({
      executors: [echo],
      fallback: createScriptedRunner({ jobs: [] }),
    });
    const result = await runner.runJob(
      {
        stageId: "write",
        kind: "agent",
        purpose: "diagnostic",
        instruction: "x",
        executor: { id: "acme.echo/ping" },
        input: { msg: 9 },
      },
      {
        runId: "r1",
        operationId: "op1",
        generation: 1,
        worktreePath: "/tmp",
        artifactDir: "/tmp/a",
      },
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/schema/);
  });

  it("rejects duplicate executor registrations", () => {
    const a = defineExecutor({
      id: "acme.echo/ping",
      effect: "read",
      execute: async () => ({}),
    });
    expect(() =>
      createRegistryRunner({
        executors: [a, a],
        fallback: createScriptedRunner({ jobs: [] }),
      }),
    ).toThrow(/duplicate/);
  });
});
