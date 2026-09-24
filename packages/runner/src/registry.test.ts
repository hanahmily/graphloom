import { mkdtemp } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineExecutor, MAX_EXECUTOR_INPUT_BYTES, assertBoundedJson } from "@graphloom/sdk";
import {
  createChildExecutorRunner,
  createRegistryRunner,
  createScriptedRunner,
  createTrustedInProcessRunner,
} from "./index.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/write-greeting-executor.mjs",
);

describe("createTrustedInProcessRunner", () => {
  it("executes a registered custom executor by pin id (trusted/CI only)", async () => {
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
    const runner = createTrustedInProcessRunner({
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
  });

  it("createRegistryRunner remains an alias of trusted in-process", () => {
    expect(createRegistryRunner).toBe(createTrustedInProcessRunner);
  });

  it("falls back for built-in agent pins", async () => {
    const runner = createTrustedInProcessRunner({
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
        writeScope: ["GREETING.txt"],
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
    const runner = createTrustedInProcessRunner({
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
      createTrustedInProcessRunner({
        executors: [a, a],
        fallback: createScriptedRunner({ jobs: [] }),
      }),
    ).toThrow(/duplicate/);
  });
});

describe("createChildExecutorRunner", () => {
  it("runs a custom executor in a child process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-child-"));
    const workerModule = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist/executor-worker.js",
    );
    const runner = createChildExecutorRunner({
      entryModule: fixture,
      executorIds: ["acme.hello/write-greeting"],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
    });
    const result = await runner.runJob(
      {
        stageId: "write",
        kind: "agent",
        purpose: "work",
        instruction: "custom",
        writeScope: ["GREETING.txt"],
        executor: { id: "acme.hello/write-greeting", version: "1" },
        input: {},
      },
      {
        runId: "r1",
        operationId: "op1",
        generation: 1,
        worktreePath: dir,
        artifactDir: dir,
      },
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toMatch(/custom wrote/);
    const bytes = await readFile(path.join(dir, "GREETING.txt"), "utf8");
    expect(bytes).toBe("Hello, GraphLoom!\n");
  });
});

describe("assertBoundedJson", () => {
  it("rejects oversized and non-JSON values", () => {
    expect(() => assertBoundedJson({ ok: true })).not.toThrow();
    expect(() => assertBoundedJson(BigInt(1))).toThrow(/JSON-serializable/);
    const huge = "x".repeat(MAX_EXECUTOR_INPUT_BYTES + 1);
    expect(() => assertBoundedJson(huge)).toThrow(/exceeds/);
  });
});
