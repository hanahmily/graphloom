import { describe, expect, it } from "vitest";
import {
  assertBoundedJson,
  assertExecutorId,
  assertExecutorPin,
  builtinPinForKind,
  defineExecutor,
  pinJobExecutor,
  validateExecutorInput,
  checkExecutorInput,
  boundedInputShape,
  MAX_INPUT_SHAPE_BYTES,
  BUILTIN_AGENT_EXECUTOR_ID,
  BUILTIN_COMMAND_EXECUTOR_ID,
  MAX_EXECUTOR_INPUT_BYTES,
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

describe("assertBoundedJson / pinJobExecutor input bounds", () => {
  it("rejects non-serializable and oversized inputs at pin time", () => {
    expect(() => assertBoundedJson(BigInt(1))).toThrow(/JSON-serializable/);
    expect(() => assertBoundedJson("x".repeat(MAX_EXECUTOR_INPUT_BYTES + 1))).toThrow(/exceeds/);
    expect(() =>
      pinJobExecutor({
        stageId: "write",
        kind: "agent",
        purpose: "work",
        instruction: "x",
        writeScope: ["a"],
        input: { nest: { ok: true } },
      }),
    ).not.toThrow();
  });
});

describe("executor input reasons and declared shape", () => {
  const msgOnly = defineExecutor({
    id: "acme.echo/ping",
    effect: "read",
    inputSchema: (v): v is { msg: string } => typeof v === "object" && v !== null && typeof (v as { msg?: unknown }).msg === "string",
    inputProblem: (v) => (typeof (v as { msg?: unknown } | null)?.msg === "string" ? undefined : "msg: required string"),
    inputShape: { schema: { type: "object", required: ["msg"] }, example: { msg: "hi" } },
    async execute(input) {
      return input;
    },
  });

  it("carries the executor's reason in the refusal, and none when the input is accepted", () => {
    expect(checkExecutorInput(msgOnly, { msg: 1 })).toBe("executor acme.echo/ping: input failed schema validation: msg: required string");
    expect(() => validateExecutorInput(msgOnly, {})).toThrow(/msg: required string/);
    expect(checkExecutorInput(msgOnly, { msg: "ok" })).toBeUndefined();
    expect(msgOnly.inputShape?.example).toEqual({ msg: "hi" });
  });

  it("lets the predicate decide when the reason check disagrees or throws", () => {
    const lax = defineExecutor({
      id: "acme.echo/lax",
      effect: "read",
      inputSchema: (v): v is unknown => v === "ok",
      inputProblem: () => {
        throw new Error("boom");
      },
      async execute() {
        return null;
      },
    });
    expect(checkExecutorInput(lax, "ok")).toBeUndefined();
    expect(checkExecutorInput(lax, "no")).toBe("executor acme.echo/lax: input failed schema validation");
  });

  it("carries only a plain, bounded input shape", () => {
    expect(boundedInputShape({ schema: { type: "object" }, example: 1 })).toEqual({ schema: { type: "object" }, example: 1 });
    expect(boundedInputShape({ schema: [] })).toBeUndefined();
    expect(boundedInputShape("x")).toBeUndefined();
    expect(boundedInputShape({ schema: { big: "x".repeat(MAX_INPUT_SHAPE_BYTES) } })).toBeUndefined();
  });
});
