import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_EXECUTOR_ID,
  BUILTIN_COMMAND_EXECUTOR_ID,
  assertExecutorId,
  assertExecutorPin,
  builtinPinForKind,
  defineExecutor,
  pinJobExecutor,
  validateExecutorInput,
} from "./executor.js";
import type { JobSpec } from "./types.js";

describe("defineExecutor", () => {
  it("freezes a qualified executor definition", () => {
    const echo = defineExecutor({
      id: "acme.echo/ping",
      version: "1.0.0",
      effect: "read",
      capabilities: ["net:none"],
      inputSchema: (v): v is { msg: string } =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as { msg?: unknown }).msg === "string",
      async execute(input) {
        return { echo: input.msg };
      },
    });
    expect(echo.id).toBe("acme.echo/ping");
    expect(echo.version).toBe("1.0.0");
    expect(echo.effect).toBe("read");
    expect(Object.isFrozen(echo)).toBe(true);
    expect(() => {
      (echo as { id: string }).id = "hijack";
    }).toThrow();
  });

  it("rejects unqualified executor ids", () => {
    expect(() => assertExecutorId("echo")).toThrow(/qualified/);
    expect(() =>
      defineExecutor({
        id: "not-qualified",
        effect: "read",
        execute: async () => ({}),
      }),
    ).toThrow(/qualified/);
  });
});

describe("pinJobExecutor", () => {
  it("pins legacy agent jobs to the built-in agent executor", () => {
    const job: JobSpec = {
      stageId: "write",
      kind: "agent",
      purpose: "work",
      instruction: "write greeting",
      writeScope: ["GREETING.txt"],
    };
    const pinned = pinJobExecutor(job);
    expect(pinned.executor).toEqual({ id: BUILTIN_AGENT_EXECUTOR_ID, version: "1" });
    expect(builtinPinForKind("command").id).toBe(BUILTIN_COMMAND_EXECUTOR_ID);
  });

  it("preserves an explicit custom pin", () => {
    const job: JobSpec = {
      stageId: "write",
      kind: "agent",
      purpose: "work",
      instruction: "unused",
      executor: { id: "acme.echo/ping", version: "2" },
      input: { msg: "hi" },
    };
    expect(pinJobExecutor(job).executor).toEqual({
      id: "acme.echo/ping",
      version: "2",
    });
  });

  it("rejects malformed pins", () => {
    expect(() => assertExecutorPin({ id: "bad" })).toThrow(/qualified/);
    expect(() =>
      pinJobExecutor({
        stageId: "write",
        kind: "agent",
        purpose: "work",
        instruction: "x",
        executor: { id: "nope" },
      }),
    ).toThrow(/qualified/);
  });
});

describe("validateExecutorInput", () => {
  it("rejects inputs that fail the definition schema", () => {
    const echo = defineExecutor({
      id: "acme.echo/ping",
      effect: "read",
      inputSchema: (v): v is { msg: string } =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as { msg?: unknown }).msg === "string",
      execute: async (input) => input,
    });
    expect(() => validateExecutorInput(echo, { msg: 1 })).toThrow(/schema/);
    expect(() => validateExecutorInput(echo, { msg: "ok" })).not.toThrow();
  });
});
