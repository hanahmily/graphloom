import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineExecutor, MAX_EXECUTOR_INPUT_BYTES, assertBoundedJson } from "@graphloom/sdk";
import {
  assertSandboxSupported,
  createBuiltinExecutorRunner,
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

  const credentialFixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../test/fixtures/credential-executor.mjs",
  );
  const workerModule = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist/executor-worker.js",
  );
  const ctx = {
    runId: "r1",
    operationId: "op1",
    generation: 1,
    worktreePath: "/tmp",
    artifactDir: "/tmp/a",
  };
  const job = (id: string, input: unknown, version = "2") => ({
    stageId: "select",
    kind: "command" as const,
    purpose: "diagnostic" as const,
    instruction: "unused",
    readOnly: true,
    executor: { id, version },
    input,
  });

  it("delivers bound credentials over stdin and redacts them from results", async () => {
    const runner = createChildExecutorRunner({
      entryModule: credentialFixture,
      executorIds: ["acme.cred/echo"],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
      env: {},
      credentials: { api: "tok-secret-123" },
    });
    const result = await runner.runJob(job("acme.cred/echo", { msg: "hi" }), ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("echo hi with [REDACTED]");
    expect(JSON.stringify(result)).not.toContain("tok-secret-123");
    expect(result.evidence?.[0]?.payload).toEqual({ seen: "[REDACTED]", env: null });
  });

  it("redacts short credentials without corrupting the result, and rejects empty ones", async () => {
    const runner = createChildExecutorRunner({
      entryModule: credentialFixture,
      executorIds: ["acme.cred/echo"],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
      credentials: { api: "q7z" },
    });
    const result = await runner.runJob(job("acme.cred/echo", { msg: "hi" }), ctx);
    expect(result.summary).toBe("echo hi with [REDACTED]");
    expect(result.evidence?.[0]?.payload).toEqual({ seen: "[REDACTED]", env: null });
    expect(result.runId).toBe("r1");

    expect(() =>
      createChildExecutorRunner({
        entryModule: credentialFixture,
        executorIds: ["acme.cred/echo"],
        fallback: createScriptedRunner({ jobs: [] }),
        credentials: { api: "" },
      }),
    ).toThrow('credential "api" is empty');
  });

  it("refuses ungranted effects, pin mismatches, and schema violations in the child", async () => {
    const runner = createChildExecutorRunner({
      entryModule: credentialFixture,
      executorIds: ["acme.cred/echo", "acme.cred/post"],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
      allowedEffects: ["read"],
    });
    const write = await runner.runJob(job("acme.cred/post", {}), ctx);
    expect(write.status).toBe("failed");
    expect(write.summary).toBe("executor acme.cred/post effect write is not granted");

    const stale = await runner.runJob(job("acme.cred/echo", { msg: "hi" }, "1"), ctx);
    expect(stale.status).toBe("failed");
    expect(stale.summary).toBe("executor acme.cred/echo pinned version 1 but installed 2");

    const bad = await runner.runJob(job("acme.cred/echo", { msg: 7 }), ctx);
    expect(bad.status).toBe("failed");
    expect(bad.summary).toMatch(/input failed schema validation/);
  });

  it("rejects custom registrations that would shadow a built-in id", () => {
    expect(() =>
      createChildExecutorRunner({
        entryModule: credentialFixture,
        executorIds: ["graphloom.github/list-issues"],
        fallback: createScriptedRunner({ jobs: [] }),
      }),
    ).toThrow(/cannot claim built-in id graphloom\.github\/list-issues/);
    expect(() =>
      createTrustedInProcessRunner({
        executors: [
          defineExecutor({ id: "graphloom.github/list-issues", effect: "read", execute: () => ({}) }),
        ],
        fallback: createScriptedRunner({ jobs: [] }),
      }),
    ).toThrow(/cannot claim built-in id/);
    expect(() =>
      createChildExecutorRunner({
        entryModule: credentialFixture,
        executorIds: ["graphloom.github/list-issues"],
        fallback: createScriptedRunner({ jobs: [] }),
        builtin: true,
      }),
    ).not.toThrow();
  });
});

describe("createBuiltinExecutorRunner", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerModule = path.join(here, "../dist/executor-worker.js");
  const manifest = {
    name: "@graphloom/executor-fixture",
    entryModule: path.join(here, "../test/fixtures/builtin-executor.mjs"),
    executorIds: ["graphloom.fixture/echo", "graphloom.fixture/probe", "graphloom.fixture/post"],
    credentials: ["fixture"],
    configEnv: ["GL_FIXTURE_URL"],
  };
  const ctx = { runId: "r1", operationId: "op1", generation: 1, worktreePath: "/tmp", artifactDir: "/tmp/a" };
  const job = (id: string, input: unknown = {}) => ({
    stageId: "select",
    kind: "command" as const,
    purpose: "check" as const,
    instruction: "unused",
    readOnly: true,
    executor: { id, version: "1" },
    input,
  });

  it("confines each package to reading its own code: no outside reads, writes, processes, or workers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-sandbox-"));
    const outside = path.join(dir, "host-secret.txt");
    await writeFile(outside, "host secret", "utf8");
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest }],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
    });
    const result = await runner.runJob(job("graphloom.fixture/probe", { outside }), ctx);
    expect(result.status, result.summary).toBe("ok");
    expect(result.evidence?.[0]?.payload).toEqual({
      control: "allowed",
      readOwnPackage: "allowed",
      readOutside: "ERR_ACCESS_DENIED",
      write: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
      worker: "ERR_ACCESS_DENIED",
    });
  });

  it("refuses to run built-in packages on Node without the permission model", () => {
    expect(() => assertSandboxSupported("22.12.0")).toThrow(/cannot enforce executor filesystem and process scopes/);
    expect(() => assertSandboxSupported("20.18.1")).toThrow(/require Node >= 22\.13/);
    expect(() => assertSandboxSupported("22.13.0")).not.toThrow();
    expect(() => assertSandboxSupported("24.6.0")).not.toThrow();
  });

  it("gives each package only its bound credential and declared configuration", async () => {
    process.env.GL_HOST_SECRET = "host-only";
    try {
      const runner = createBuiltinExecutorRunner({
        packages: [{ manifest, credentials: { fixture: "tok-fixture-9" }, env: { GL_FIXTURE_URL: "http://x" } }],
        fallback: createScriptedRunner({ jobs: [] }),
        workerModule,
      });
      const result = await runner.runJob(job("graphloom.fixture/echo"), ctx);
      expect(result.status).toBe("ok");
      expect(result.summary).toBe("token [REDACTED]");
      expect(result.evidence?.[0]?.payload).toEqual({ config: "http://x", leaked: null });
    } finally {
      delete process.env.GL_HOST_SECRET;
    }
  });

  it("grants reads only unless the operator grants writes, and falls back for other ids", async () => {
    const fallback = createScriptedRunner({ jobs: [async () => ({ status: "ok", summary: "fallback" })] });
    const readOnly = createBuiltinExecutorRunner({ packages: [{ manifest }], fallback, workerModule });
    const refused = await readOnly.runJob(job("graphloom.fixture/post"), ctx);
    expect(refused.summary).toBe("executor graphloom.fixture/post effect write is not granted");
    expect((await readOnly.runJob(job("acme.other/thing"), ctx)).summary).toBe("fallback");

    const writable = createBuiltinExecutorRunner({
      packages: [{ manifest, allowedEffects: ["read", "write"] }],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
    });
    expect((await writable.runJob(job("graphloom.fixture/post"), ctx)).summary).toBe("posted");
  });

  it("rejects bindings or manifests the package did not declare", () => {
    const fallback = createScriptedRunner({ jobs: [] });
    expect(() =>
      createBuiltinExecutorRunner({ packages: [{ manifest, credentials: { other: "x" } }], fallback }),
    ).toThrow('built-in package @graphloom/executor-fixture does not accept credential "other"');
    expect(() =>
      createBuiltinExecutorRunner({ packages: [{ manifest, env: { PATH: "/bin" } }], fallback }),
    ).toThrow('built-in package @graphloom/executor-fixture does not accept configuration "PATH"');
    expect(() =>
      createBuiltinExecutorRunner({
        packages: [{ manifest: { ...manifest, executorIds: ["acme.fixture/echo"] } }],
        fallback,
      }),
    ).toThrow(/serves acme\.fixture\/echo outside graphloom\.\*/);
    expect(() =>
      createBuiltinExecutorRunner({ packages: [{ manifest }, { manifest: { ...manifest, name: "dup" } }], fallback }),
    ).toThrow("executor graphloom.fixture/echo is served by both @graphloom/executor-fixture and dup");
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
