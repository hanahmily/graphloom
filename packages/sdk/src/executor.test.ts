// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

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
  MAX_JOB_TIMEOUT_MS,
  MAX_TIMEOUT_CONTINUATIONS,
} from "./executor.js";
import { jsonSchemaProblem } from "./input-problem.js";
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

  it("keeps a bounded per-job timeout and timeout continuations, and refuses malformed ones", () => {
    const job: JobSpec = { stageId: "fix", kind: "agent", purpose: "work", instruction: "x", writeScope: ["."] };
    expect(pinJobExecutor({ ...job, timeoutMs: 3 * 60 * 60_000, timeoutContinuations: 2 })).toMatchObject({
      timeoutMs: 3 * 60 * 60_000,
      timeoutContinuations: 2,
    });
    expect(pinJobExecutor({ ...job, timeoutMs: MAX_JOB_TIMEOUT_MS }).timeoutMs).toBe(MAX_JOB_TIMEOUT_MS);
    for (const timeoutMs of [0, -1, 1.5, MAX_JOB_TIMEOUT_MS + 1, Number.NaN, "60000"]) {
      expect(() => pinJobExecutor({ ...job, timeoutMs: timeoutMs as number })).toThrow(/timeoutMs must be a whole number/);
    }
    for (const n of [-1, 0.5, MAX_TIMEOUT_CONTINUATIONS + 1, "1"]) {
      expect(() => pinJobExecutor({ ...job, timeoutContinuations: n as number })).toThrow(/timeoutContinuations must be a whole number/);
    }
    expect(() => pinJobExecutor({ ...job, kind: "command", timeoutContinuations: 1 })).toThrow(/command job cannot set timeoutContinuations/);
    expect(pinJobExecutor({ ...job, kind: "command", timeoutContinuations: 0 }).timeoutContinuations).toBe(0);
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

describe("jsonSchemaProblem", () => {
  const schema = {
    type: "object",
    required: ["commands"],
    properties: {
      commands: {
        type: "array",
        minItems: 1,
        items: { type: "object", required: ["id", "argv"], properties: { id: { type: "string", pattern: "^[a-z]+$" }, argv: { type: "array", items: { type: "string" } } } },
      },
      mode: { enum: ["a", "b"] },
      n: { type: "integer", minimum: 1, maximum: 5 },
    },
  };

  it("reports the first failing path and its rule", () => {
    expect(jsonSchemaProblem(schema, { commands: [{ id: "x", argv: ["go"] }] })).toBeUndefined();
    expect(jsonSchemaProblem(schema, 1)).toBe("input: must be an object");
    expect(jsonSchemaProblem(schema, {})).toBe("commands: required");
    expect(jsonSchemaProblem(schema, { commands: [] })).toBe("commands: must hold at least 1 item(s)");
    expect(jsonSchemaProblem(schema, { commands: [{ id: "x" }] })).toBe("commands[0].argv: required");
    expect(jsonSchemaProblem(schema, { commands: [{ id: "x", argv: { item: ["go"] } }] })).toBe("commands[0].argv: must be an array");
    expect(jsonSchemaProblem(schema, { commands: [{ id: "X", argv: [] }] })).toBe("commands[0].id: must match ^[a-z]+$");
    expect(jsonSchemaProblem(schema, { commands: [{ id: "x", argv: [] }], mode: "c" })).toBe('mode: must be one of "a", "b"');
    expect(jsonSchemaProblem(schema, { commands: [{ id: "x", argv: [] }], n: 9 })).toBe("n: must be at most 5");
  });
});
