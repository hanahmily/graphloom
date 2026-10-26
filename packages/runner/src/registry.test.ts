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
  describeExecutorModule,
  digestExecutorSource,
} from "./index.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/write-greeting-executor.mjs",
);

describe("createTrustedInProcessRunner", () => {
  it("refuses a pinned version mismatch before executing trusted code", async () => {
    let executions = 0;
    const executor = defineExecutor({
      id: "acme.version/read",
      version: "2",
      effect: "read",
      execute: async () => {
        executions += 1;
        return { status: "ok", summary: "executed" };
      },
    });
    const runner = createTrustedInProcessRunner({ executors: [executor], fallback: createScriptedRunner({ jobs: [] }) });
    const job = { stageId: "write", kind: "agent" as const, purpose: "work" as const, instruction: "x", input: {} };
    const context = { runId: "r", operationId: "op", generation: 1, worktreePath: "/tmp", artifactDir: "/tmp" };
    expect(await runner.runJob({ ...job, executor: { id: executor.id, version: "1" } }, context))
      .toMatchObject({ status: "failed", summary: "executor acme.version/read pinned version 1 but installed 2" });
    expect(executions).toBe(0);
    expect((await runner.runJob({ ...job, executor: { id: executor.id, version: "2" } }, context)).status).toBe("ok");
    expect(executions).toBe(1);
  });

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

  it("hands an agent job its session and returns the ref only for a job that had one", async () => {
    const seen: unknown[] = [];
    const agent = defineExecutor<{ ref: string }, unknown>({
      id: "acme.agent/code",
      effect: "read",
      async execute(input, ctx) {
        seen.push(ctx.session);
        return { status: "ok", summary: "done", sessionRef: input.ref };
      },
    });
    const runner = createTrustedInProcessRunner({ executors: [agent], fallback: createScriptedRunner({ jobs: [] }) });
    const run = (ref: string, session?: { dir: string; resume?: string }) =>
      runner.runJob(
        { stageId: "write", kind: "agent", purpose: "work", instruction: "x", executor: { id: "acme.agent/code" }, input: { ref } },
        { runId: "r1", operationId: "op1", generation: 1, worktreePath: "/tmp", artifactDir: "/tmp/a", ...(session ? { session } : {}) },
      );
    expect((await run("s1", { dir: "/state/s", resume: "s0" })).sessionRef).toBe("s1");
    expect(seen[0]).toEqual({ dir: "/state/s", resume: "s0" });
    expect(await run("s1")).not.toHaveProperty("sessionRef");
    expect(await run("x".repeat(257), { dir: "/state/s" })).not.toHaveProperty("sessionRef");
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
  it.each(["null", "[]", "true", "42", '"text"', "not-json"])(
    "rejects malformed module description %s without an uncaught exception",
    async (reply) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "gl-bad-description-"));
      const workerModule = path.join(dir, "worker.mjs");
      await writeFile(workerModule, `process.stdin.once("data", () => process.stdout.write(${JSON.stringify(`${reply}\n`)}));`);
      await expect(describeExecutorModule({ entryModule: fixture, workerModule, timeoutMs: 500 }))
        .rejects.toThrow(/malformed|JSON|object/);
    },
  );

  it.each(["null", "[]", "true", "42", '"text"', "not-json", '{}', '{"kind":"error","message":{}}'])(
    "rejects malformed executor reply %s without crashing the host",
    async (reply) => {
      const runner = createChildExecutorRunner({
        entryModule: fixture,
        executorIds: ["acme.hello/write-greeting"],
        fallback: createScriptedRunner({ jobs: [] }),
        workerModule: path.join(path.dirname(fixture), "bad-worker.mjs"),
        timeoutMs: 500,
        stopGraceMs: 100,
      });
      const result = await runner.runJob(
        { stageId: "write", kind: "agent", purpose: "work", instruction: "x", executor: { id: "acme.hello/write-greeting" }, input: { reply } },
        { runId: "r", operationId: "op", generation: 1, worktreePath: "/tmp", artifactDir: "/tmp" },
      );
      expect(result).toMatchObject({ status: "failed", summary: expect.stringMatching(/malformed|JSON|object|kind|message/) });
      expect(result.summary).not.toMatch(/timed out/);
    },
  );

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

  it("checks a job against the executor's own schema, pin and grant without running it", async () => {
    const runner = createChildExecutorRunner({
      entryModule: credentialFixture,
      executorIds: ["acme.cred/echo", "acme.cred/post"],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
      env: {},
      allowedEffects: ["read"],
    });
    expect(await runner.checkJob!(job("acme.cred/echo", { msg: "hi" }))).toBeUndefined();
    expect(await runner.checkJob!(job("acme.cred/echo", { other: 1 }))).toBe("executor acme.cred/echo: input failed schema validation");
    expect(await runner.checkJob!(job("acme.cred/echo", { msg: "hi" }, "1"))).toBe("executor acme.cred/echo pinned version 1 but installed 2");
    expect(await runner.checkJob!(job("acme.cred/post", {}))).toBe("executor acme.cred/post effect write is not granted");
    // An executor this runner does not serve, with no fallback check: it cannot tell.
    expect(await runner.checkJob!(job("acme.other/read", {}))).toBeUndefined();
  });

  it("checks a trusted in-process executor's schema without executing it", async () => {
    let executions = 0;
    const echo = defineExecutor({
      id: "acme.echo/ping",
      effect: "read",
      inputSchema: (v): v is { msg: string } => typeof v === "object" && v !== null && typeof (v as { msg?: unknown }).msg === "string",
      async execute() {
        executions += 1;
        return { status: "ok" as const, summary: "ran" };
      },
    });
    const child = createChildExecutorRunner({ entryModule: credentialFixture, executorIds: ["acme.cred/echo"], fallback: createScriptedRunner({ jobs: [] }), workerModule, env: {} });
    const runner = createTrustedInProcessRunner({ executors: [echo], fallback: child });
    const unversioned = (input: unknown) => ({ ...job("acme.echo/ping", input), executor: { id: "acme.echo/ping" } });
    expect(await runner.checkJob!(unversioned({ msg: 9 }))).toBe("executor acme.echo/ping: input failed schema validation");
    expect(await runner.checkJob!(unversioned({ msg: "x" }))).toBeUndefined();
    // Jobs it does not serve go to the fallback's check.
    expect(await runner.checkJob!(job("acme.cred/echo", {}))).toBe("executor acme.cred/echo: input failed schema validation");
    expect(executions).toBe(0);
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

  describe("stopping an executor that started its own process group", () => {
    const groupFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/process-group-executor.mjs");
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pidIn = async (file: string) => Number(await readFile(file, "utf8"));
    const groupRunner = (extra: { timeoutMs?: number; maxTimeoutMs?: number; stopGraceMs?: number }) =>
      createChildExecutorRunner({
        entryModule: groupFixture,
        executorIds: ["acme.group/stop-on-abort", "acme.group/await-tool", "acme.group/ignore-abort", "acme.group/session-on-abort", "acme.group/report-timeout"],
        fallback: createScriptedRunner({ jobs: [] }),
        workerModule,
        ...extra,
      });

    it("aborts the executor's signal on timeout and settles once it has stopped its processes", async () => {
      const pidFile = path.join(await mkdtemp(path.join(os.tmpdir(), "gl-group-")), "pid");
      const result = await groupRunner({ timeoutMs: 500 }).runJob(job("acme.group/stop-on-abort", { pidFile }, "1"), ctx);
      expect(result).toMatchObject({
        status: "failed",
        failureKind: "timeout",
        summary: "executor child timed out after 500ms; while stopping, the executor reported: stopped",
      });
      expect(alive(await pidIn(pidFile))).toBe(false);
    });

    it("keeps the session and evidence a timed-out executor reports while stopping, as a timeout", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "gl-session-"));
      const result = await groupRunner({ timeoutMs: 300 }).runJob(job("acme.group/session-on-abort", {}, "1"), { ...ctx, session: { dir } });
      expect(result).toMatchObject({
        status: "failed",
        failureKind: "timeout",
        sessionRef: "saved-1",
        evidence: [{ kind: "other", payload: { progress: "half" } }],
        summary: "executor child timed out after 300ms; while stopping, the executor reported: agent session aborted",
      });
      // Without a controller-owned session directory, no session is kept.
      expect((await groupRunner({ timeoutMs: 300 }).runJob(job("acme.group/session-on-abort", {}, "1"), ctx)).sessionRef).toBeUndefined();
    });

    it("gives a job the wall clock it asks for, clamped to the operator's ceiling, and tells the executor", async () => {
      const report = (timeoutMs: number | undefined, extra: { timeoutMs?: number; maxTimeoutMs?: number }) =>
        groupRunner(extra).runJob({ ...job("acme.group/report-timeout", {}, "1"), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, ctx);
      expect((await report(undefined, { timeoutMs: 1_000, maxTimeoutMs: 5_000 })).summary).toBe("1000");
      expect((await report(3_000, { timeoutMs: 1_000, maxTimeoutMs: 5_000 })).summary).toBe("3000");
      expect((await report(9_000, { timeoutMs: 1_000, maxTimeoutMs: 5_000 })).summary).toBe("5000");
      expect((await report(500, { timeoutMs: 1_000, maxTimeoutMs: 5_000 })).summary).toBe("500");
      // Without a ceiling a job may ask for less than the default, never more.
      expect((await report(3_000, { timeoutMs: 1_000 })).summary).toBe("1000");
      const pidFile = path.join(await mkdtemp(path.join(os.tmpdir(), "gl-group-")), "pid");
      const clamped = await groupRunner({ timeoutMs: 200, maxTimeoutMs: 300 }).runJob({ ...job("acme.group/stop-on-abort", { pidFile }, "1"), timeoutMs: 10_000 }, ctx);
      expect(clamped).toMatchObject({
        failureKind: "timeout",
        summary: expect.stringMatching(/^executor child timed out after 300ms \(the job asked for 10000ms; the operator allows at most 300ms\)/),
      });
      expect(() => groupRunner({ timeoutMs: 1_000, maxTimeoutMs: 500 })).toThrow("maxTimeoutMs (500 ms) must be at least the default timeout (1000 ms)");
    });

    it("aborts the executor's signal when the run stops", async () => {
      const pidFile = path.join(await mkdtemp(path.join(os.tmpdir(), "gl-group-")), "pid");
      const stop = new AbortController();
      const running = groupRunner({}).runJob(job("acme.group/stop-on-abort", { pidFile }, "1"), { ...ctx, signal: stop.signal });
      await expect.poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 5_000 }).not.toBe("");
      stop.abort();
      expect(await running).toMatchObject({ status: "failed", summary: "executor cancelled: run stopped" });
      expect(alive(await pidIn(pidFile))).toBe(false);
    });

    it("refuses a tool call left unanswered, so a stopped executor can return", async () => {
      const children = {
        callTool: () => new Promise<never>(() => undefined),
        reserveModelCall: async () => true,
      };
      const started = Date.now();
      const result = await groupRunner({ timeoutMs: 300, stopGraceMs: 5_000 }).runJob(
        {
          ...job("acme.group/await-tool", {}, "1"),
          tools: [{ name: "probe", effect: "read" as const, executor: { id: "acme.other/probe", version: "1" } }],
        },
        { ...ctx, children } as never,
      );
      expect(result.summary).toBe("executor child timed out after 300ms; while stopping, the executor reported: executor stopped before the tool call was answered");
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("kills an executor that ignores its signal after the stop grace", async () => {
      const pidFile = path.join(await mkdtemp(path.join(os.tmpdir(), "gl-group-")), "pid");
      const started = Date.now();
      const result = await groupRunner({ timeoutMs: 300, stopGraceMs: 400 }).runJob(job("acme.group/ignore-abort", { pidFile }, "1"), ctx);
      expect(result).toMatchObject({ summary: "executor child timed out after 300ms", failureKind: "timeout" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(700);
      const pid = await pidIn(pidFile);
      process.kill(-pid, "SIGKILL");
    });
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
      expect(result.evidence?.[0]?.payload).toEqual({ config: "http://x", leaked: null, session: null });
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

  it("keeps agent sessions from sandboxed packages, which cannot write them", async () => {
    const run = (packages: Parameters<typeof createBuiltinExecutorRunner>[0]["packages"], session: { dir: string; resume?: string }) =>
      createBuiltinExecutorRunner({ packages, fallback: createScriptedRunner({ jobs: [] }), workerModule }).runJob(
        job("graphloom.fixture/echo"),
        { ...ctx, session },
      );
    const fresh = await run([{ manifest }], { dir: "/state/agent-sessions/op1" });
    expect(fresh.status).toBe("ok");
    expect(fresh).not.toHaveProperty("sessionRef");
    expect((fresh.evidence?.[0]?.payload as { session: unknown }).session).toBeNull();

    const resumed = await run([{ manifest }], { dir: "/state/agent-sessions/op1", resume: "s1" });
    expect(resumed).toMatchObject({
      status: "failed",
      summary: "executor graphloom.fixture/echo runs sandboxed and cannot continue agent session s1",
    });

    const unrestricted = await run(
      [{ manifest: { ...manifest, isolation: "unrestricted" as const }, allowUnrestricted: true }],
      { dir: "/state/agent-sessions/op1", resume: "s1" },
    );
    expect(unrestricted.sessionRef).toBe("fixture-session");
    expect((unrestricted.evidence?.[0]?.payload as { session: unknown }).session).toEqual({
      dir: "/state/agent-sessions/op1",
      resume: "s1",
    });
  });

  it("runs an unrestricted package only with operator consent, and then without the sandbox", async () => {
    const unrestricted = { ...manifest, isolation: "unrestricted" as const };
    const fallback = createScriptedRunner({ jobs: [] });
    expect(() => createBuiltinExecutorRunner({ packages: [{ manifest: unrestricted }], fallback })).toThrow(
      "built-in package @graphloom/executor-fixture runs unrestricted; the operator must set allowUnrestricted",
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-unrestricted-"));
    const outside = path.join(dir, "readable.txt");
    await writeFile(outside, "x", "utf8");
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: unrestricted, allowUnrestricted: true }],
      fallback,
      workerModule,
    });
    const result = await runner.runJob(job("graphloom.fixture/probe", { outside }), ctx);
    expect(result.evidence?.[0]?.payload).toMatchObject({ readOutside: "allowed", spawn: "allowed" });
  });
});

describe("child operation protocol", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerModule = path.join(here, "../dist/executor-worker.js");
  const entryModule = path.join(here, "../test/fixtures/tool-agent-executor.mjs");
  const tools = [
    { name: "read_comments", effect: "read" as const, executor: { id: "acme.github/list-comments", version: "1" } },
  ];
  const agentJob = (input: unknown) => ({
    stageId: "implement",
    kind: "agent" as const,
    purpose: "work" as const,
    instruction: "implement",
    writeScope: ["src"],
    executor: { id: "acme.agent/tooling", version: "1" },
    tools,
    input,
  });
  const ctx = { runId: "r1", operationId: "op1", generation: 1, worktreePath: "/tmp", artifactDir: "/tmp/a" };
  const runner = (credentials?: Record<string, string>) =>
    createChildExecutorRunner({
      entryModule,
      executorIds: ["acme.agent/tooling"],
      fallback: createScriptedRunner({ jobs: [] }),
      workerModule,
      ...(credentials !== undefined ? { credentials } : {}),
    });
  function port(budget = 1) {
    const calls: unknown[] = [];
    const reservations = { count: 0 };
    let remaining = budget;
    return {
      calls,
      reservations,
      port: {
        async callTool(req: { toolCallId: string; tool: string; input: unknown }) {
          calls.push(req);
          return { status: "ok" as const, summary: `ran ${req.tool}`, childOperationId: `child-${calls.length}` };
        },
        async reserveModelCall() {
          reservations.count += 1;
          remaining -= 1;
          return remaining >= 0;
        },
      },
    };
  }

  it("services tool calls and model reservations while the executor waits", async () => {
    const p = port(1);
    const result = await runner().runJob(
      agentJob({
        steps: [
          { model: true },
          { id: "t1", tool: "read_comments", input: { issue: 7 } },
          { model: true },
        ],
      }),
      { ...ctx, children: p.port },
    );
    expect(result.status, result.summary).toBe("ok");
    expect(p.calls).toEqual([{ toolCallId: "t1", tool: "read_comments", input: { issue: 7 } }]);
    expect(result.evidence?.[0]?.payload).toEqual({
      calls: [
        { model: true },
        { tool: "read_comments", result: { status: "ok", summary: "ran read_comments", childOperationId: "child-1" } },
        { model: false },
      ],
      tools: [{ name: "read_comments", effect: "read" }],
    });
  });

  it("refuses a tool the job did not declare without reaching the controller", async () => {
    const p = port();
    const result = await runner().runJob(agentJob({ steps: [{ id: "t1", tool: "delete_repo" }] }), {
      ...ctx,
      children: p.port,
    });
    expect(p.calls).toEqual([]);
    expect(result.evidence?.[0]?.payload).toMatchObject({
      calls: [{ result: { status: "failed", summary: "tool delete_repo is not admitted for this job" } }],
    });
  });

  it("redacts bound credentials from tool input before it reaches the controller", async () => {
    const p = port();
    await runner({ agent: "sekrit-9" }).runJob(
      agentJob({ steps: [{ id: "t1", tool: "read_comments", input: { q: "token sekrit-9" } }] }),
      { ...ctx, children: p.port },
    );
    expect(p.calls).toEqual([{ toolCallId: "t1", tool: "read_comments", input: { q: "token [REDACTED]" } }]);
  });

  it("kills the executor process when the run stops", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const pending = runner().runJob(agentJob({ hang: true }), { ...ctx, signal: abort.signal, children: port().port });
    setTimeout(() => abort.abort(), 200);
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", summary: "executor cancelled: run stopped" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("fails the job on a tool or model call without a usable seq, before reaching the controller", async () => {
    for (const [raw, kind] of [
      ['{"kind":"tool_call","toolCallId":"t1","tool":"read_comments","input":{}}\n', "tool_call"],
      ['{"kind":"model_call","seq":"1"}\n', "model_call"],
    ] as const) {
      const p = port();
      const result = await runner().runJob(agentJob({ steps: [{ raw }], hang: true }), { ...ctx, children: p.port });
      expect(result).toMatchObject({ status: "failed", summary: `executor sent ${kind} without a positive integer seq` });
      expect(p.calls).toEqual([]);
      expect(p.reservations.count).toBe(0);
    }
  });

  it("ignores tool and model calls that arrive after the job settled", async () => {
    const p = port();
    const raw =
      '{"kind":"ok","output":{"status":"ok","summary":"done early"}}\n' +
      '{"kind":"tool_call","seq":1,"toolCallId":"t1","tool":"read_comments","input":{}}\n' +
      '{"kind":"model_call","seq":2}\n';
    const result = await runner().runJob(agentJob({ steps: [{ raw }], hang: true }), { ...ctx, children: p.port });
    expect(result).toMatchObject({ status: "ok", summary: "done early" });
    await new Promise((r) => setTimeout(r, 50));
    expect(p.calls).toEqual([]);
    expect(p.reservations.count).toBe(0);
  });

  it("refuses an executor whose effect differs from the declared one", async () => {
    const result = await runner().runJob({ ...agentJob({ steps: [] }), effect: "read" }, ctx);
    expect(result.summary).toBe("executor acme.agent/tooling effect write does not match declared read");
  });
});

describe("executor pins and run-local copies", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerModule = path.join(here, "../dist/executor-worker.js");
  const credentialFixture = path.join(here, "../test/fixtures/credential-executor.mjs");
  const ctx = { runId: "r1", operationId: "op1", generation: 1, worktreePath: "/tmp", artifactDir: "/tmp/a" };
  const echoJob = (digest?: string) => ({
    stageId: "select",
    kind: "command" as const,
    purpose: "diagnostic" as const,
    instruction: "unused",
    readOnly: true,
    executor: { id: "acme.cred/echo", version: "2", ...(digest !== undefined ? { digest } : {}) },
    input: { msg: "hi" },
  });
  const child = () =>
    createChildExecutorRunner({
      entryModule: credentialFixture,
      executorIds: ["acme.cred/echo"],
      fallback: createTrustedInProcessRunner({
        executors: [defineExecutor({ id: "acme.inproc/noop", effect: "read", execute: async () => ({}) })],
        fallback: createScriptedRunner({ jobs: [] }),
      }),
      workerModule,
    });

  it("describes every served executor with a digest of the code it runs", async () => {
    const described = await child().describeExecutors!();
    expect(described).toEqual([
      {
        id: "acme.cred/echo",
        digest: await digestExecutorSource(credentialFixture),
        source: credentialFixture,
        isolation: "unrestricted",
        builtin: false,
      },
      expect.objectContaining({ id: "acme.inproc/noop", source: "in-process", isolation: "in-process" }),
    ]);
  });

  it("runs only the pinned bytes and serves a run-local copy under its own digest", async () => {
    const runner = child();
    const installed = await digestExecutorSource(credentialFixture);
    expect((await runner.runJob(echoJob(installed), ctx)).status).toBe("ok");

    const stale = await runner.runJob(echoJob("0".repeat(64)), ctx);
    expect(stale.status).toBe("failed");
    expect(stale.summary).toBe(`executor acme.cred/echo digest ${installed.slice(0, 12)} does not match pinned 000000000000`);

    const copy = await mkdtemp(path.join(os.tmpdir(), "gl-copy-"));
    const entryModule = path.join(copy, "credential-executor.mjs");
    await writeFile(entryModule, (await readFile(credentialFixture, "utf8")).replace("`echo ${input.msg}", "`copy ${input.msg}"));
    const executorSource = { root: copy, entryModule };
    const copyDigest = await digestExecutorSource(copy);

    const unpinned = await runner.runJob(echoJob(), { ...ctx, executorSource });
    expect(unpinned.summary).toBe("executor acme.cred/echo: a run-local copy runs only under a pinned digest");
    const wrongCopy = await runner.runJob(echoJob(installed), { ...ctx, executorSource });
    expect(wrongCopy.status).toBe("failed");
    const served = await runner.runJob(echoJob(copyDigest), { ...ctx, executorSource });
    expect(served.summary).toBe("copy hi with no token");

    const escaped = await runner.runJob(echoJob(copyDigest), {
      ...ctx,
      executorSource: { root: copy, entryModule: credentialFixture },
    });
    expect(escaped.summary).toBe(
      `executor acme.cred/echo: run-local entry module ${credentialFixture} is outside its root ${copy}`,
    );
  });

  it("checks only pinned bytes: a package changed after pinning is refused without importing its module", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-check-pin-"));
    const marker = path.join(dir, "imported.txt");
    const entryModule = path.join(dir, "executor.mjs");
    // Importing the module leaves a mark: the test can see whether it was loaded.
    const source = (summary: string) =>
      [
        `import { appendFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(marker)}, "imported\\n");`,
        `export const executors = [{ id: "acme.pin/echo", version: "2", effect: "read",`,
        `  inputSchema: (v) => typeof v === "object" && v !== null && typeof v.msg === "string",`,
        `  async execute() { return { status: "ok", summary: ${JSON.stringify(summary)} }; } }];`,
      ].join("\n");
    await writeFile(entryModule, source("pinned"));
    const runner = createChildExecutorRunner({ entryModule, executorIds: ["acme.pin/echo"], fallback: createScriptedRunner({ jobs: [] }), workerModule, env: {} });
    const pinned = await digestExecutorSource(entryModule);
    const job = (input: unknown, digest = pinned) => ({ ...echoJob(digest), executor: { id: "acme.pin/echo", version: "2", digest }, input });
    const imports = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

    // Matching bytes: the check loads the module and runs only its schema.
    expect(await runner.checkJob!(job({ other: 1 }))).toBe("executor acme.pin/echo: input failed schema validation");
    expect(await imports()).toBe(1);

    // The package changes after pinning: the check gives runJob's refusal and loads nothing.
    await writeFile(entryModule, source("changed"));
    const changed = await digestExecutorSource(entryModule);
    const refusal = `executor acme.pin/echo digest ${changed.slice(0, 12)} does not match pinned ${pinned.slice(0, 12)}`;
    expect(await runner.checkJob!(job({ msg: "hi" }))).toBe(refusal);
    expect(await runner.checkJob!(job({ other: 1 }))).toBe(refusal);
    expect((await runner.runJob(job({ msg: "hi" }), ctx)).summary).toBe(refusal);
    expect(await imports()).toBe(1);

    // A run-local copy without a pin, or outside its root, is refused the same way, before any import.
    expect(await runner.checkJob!({ ...job({ msg: "hi" }), executor: { id: "acme.pin/echo", version: "2" } }, { executorSource: { root: dir, entryModule } }))
      .toBe("executor acme.pin/echo: a run-local copy runs only under a pinned digest");
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "gl-check-root-"));
    expect(await runner.checkJob!(job({ msg: "hi" }, changed), { executorSource: { root: elsewhere, entryModule } }))
      .toBe(`executor acme.pin/echo: run-local entry module ${entryModule} is outside its root ${elsewhere}`);
    expect(await imports()).toBe(1);
  });

  it("refuses digest mismatches and run-local copies for in-process executors", async () => {
    const noop = defineExecutor({ id: "acme.inproc/noop", effect: "read", execute: async () => ({ status: "ok" as const, summary: "noop" }) });
    const runner = createTrustedInProcessRunner({ executors: [noop], fallback: createScriptedRunner({ jobs: [] }) });
    const [described] = await runner.describeExecutors!();
    const job = (digest: string) => ({ ...echoJob(digest), executor: { id: "acme.inproc/noop", digest } });
    expect((await runner.runJob(job(described!.digest), ctx)).summary).toBe("noop");
    expect((await runner.runJob(job("f".repeat(64)), ctx)).summary).toMatch(/does not match pinned ffffffffffff$/);
    const copied = await runner.runJob(job(described!.digest), { ...ctx, executorSource: { root: "/tmp", entryModule: "/tmp/x.mjs" } });
    expect(copied.summary).toBe("executor acme.inproc/noop runs in-process and cannot be served from a run-local copy");
    // checkJob gives the same refusals.
    expect(await runner.checkJob!(job(described!.digest))).toBeUndefined();
    expect(await runner.checkJob!(job("f".repeat(64)))).toMatch(/does not match pinned ffffffffffff$/);
    expect(await runner.checkJob!(job(described!.digest), { executorSource: { root: "/tmp", entryModule: "/tmp/x.mjs" } }))
      .toBe("executor acme.inproc/noop runs in-process and cannot be served from a run-local copy");
  });

  it("passes a failed executor's retryAfterMs through, and drops it from successes", async () => {
    const runner = createTrustedInProcessRunner({
      executors: [
        defineExecutor({ id: "acme.rl/fail", effect: "read", execute: async () => ({ status: "failed" as const, summary: "limited", retryAfterMs: 1500.2 }) }),
        defineExecutor({ id: "acme.rl/ok", effect: "read", execute: async () => ({ status: "ok" as const, summary: "fine", retryAfterMs: 99 }) }),
      ],
      fallback: createScriptedRunner({ jobs: [] }),
    });
    const run = (id: string) => runner.runJob({ ...echoJob(), executor: { id } }, ctx);
    expect((await run("acme.rl/fail")).retryAfterMs).toBe(1501);
    expect((await run("acme.rl/ok")).retryAfterMs).toBeUndefined();
  });

  it("describes a module's executors in a child process without running them", async () => {
    expect(await describeExecutorModule({ entryModule: credentialFixture, workerModule })).toEqual([
      { id: "acme.cred/echo", version: "2", effect: "read" },
      { id: "acme.cred/post", version: "2", effect: "write" },
    ]);
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

describe("declared input shapes are read with the runner's scoped environment", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = path.join(here, "../test/fixtures/env-shape-executor.mjs");
  const workerModule = path.join(here, "../dist/executor-worker.js");

  it("does not leak the caller's ambient variables into describe, and passes the bound ones", async () => {
    process.env.GL_AMBIENT = "secret-token";
    try {
      const runner = createChildExecutorRunner({
        entryModule: fixture,
        executorIds: ["acme.env/shape"],
        fallback: createScriptedRunner({ jobs: [] }),
        workerModule,
        env: { GL_BOUND: "configured" },
      });
      const [described] = await runner.describeExecutors!();
      expect(described?.inputShape?.schema.description).toBe("leak=none bound=configured");
    } finally {
      delete process.env.GL_AMBIENT;
    }
  });
});

describe("a shape that cannot be serialized", () => {
  it("is left out of describe without losing the other executors", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const described = await describeExecutorModule({
      entryModule: path.join(here, "../test/fixtures/bad-shape-executor.mjs"),
      workerModule: path.join(here, "../dist/executor-worker.js"),
    });
    expect(described.map((d) => [d.id, d.inputShape])).toEqual([
      ["acme.shape/circular", undefined],
      ["acme.shape/fine", { schema: { type: "object" }, example: {} }],
    ]);
  });
});
