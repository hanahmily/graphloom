// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { ExecutorView } from "@graphloom/sdk";
import { createPiSupervisor, type PiSupervisorSessionPort } from "./pi-supervisor.js";
import { normalizeJobInput } from "./item-arrays.js";
import { createAdmissionTools } from "./tools.js";
import type { SupervisorInput } from "./types.js";

/** graphloom.command/run's declared input shape, as the R01 run's catalog (c77f003f-ad0) recorded it. */
const COMMAND_SHAPE: ExecutorView = {
  id: "graphloom.command/run",
  inputShape: {
    schema: {
      type: "object",
      required: ["commands"],
      properties: {
        commands: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "argv"],
            properties: {
              id: { type: "string" },
              argv: { type: "array", minItems: 1, items: { type: "string" } },
              timeoutMs: { type: "integer" },
            },
          },
        },
        continueOnFailure: { type: "boolean" },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    example: { commands: [{ id: "go-env", argv: ["go", "env", "GOCACHE"] }] },
  },
};

const SCRIPT = "base=111193ca\ngit archive \"$base\" | tar -x -C \"$tmp\"\nexit 0";

/** The R01 proposal that stopped the run (episode transcript, first refused dispatch). */
const r01Job = {
  stageId: "fix",
  kind: "command",
  purpose: "check",
  readOnly: true,
  executor: { id: "graphloom.command/run" },
  instruction: "Supply the missing RED check for the fix stage.",
  input: { commands: { item: [{ id: "red", argv: { item: ["sh", "-c", SCRIPT] } }] } },
};

type Execute = (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; terminate?: boolean }>;

function dispatchTool(executors: ExecutorView[] | undefined, noted: string[][] = []) {
  const toolbox = createAdmissionTools(
    [{ provider: "p", modelId: "m" }],
    [],
    1,
    undefined,
    {},
    {
      facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
      check: async () => undefined,
      refuse: async (action, reason) => ({ action, reason, remaining: 2 }),
      normalized: (paths) => noted.push(paths),
    },
    undefined,
    undefined,
    executors,
  );
  const tool = toolbox.tools.find((t) => t.name === "dispatch")!;
  return { toolbox, execute: (tool as unknown as { execute: Execute }).execute };
}

const jobOf = (toolbox: ReturnType<typeof dispatchTool>["toolbox"]) => {
  const p = toolbox.proposal();
  if (p === undefined || !("action" in p) || p.action.type !== "dispatch") throw new Error("expected a dispatch proposal");
  return p.action.job;
};

describe("item-array normalization", () => {
  it("admits the exact R01 proposal as plain arrays and records the paths", async () => {
    const noted: string[][] = [];
    const { toolbox, execute } = dispatchTool([COMMAND_SHAPE], noted);
    const result = await execute("1", { reason: "supply RED", job: r01Job });
    expect(result.terminate).toBe(true);
    expect(jobOf(toolbox).input).toEqual({ commands: [{ id: "red", argv: ["sh", "-c", SCRIPT] }] });
    expect(noted).toEqual([["job.input.commands", "job.input.commands[0].argv"]]);
    expect(result.content[0]!.text).toContain("job.input.commands, job.input.commands[0].argv");
  });

  it("wraps a single-element {item: x} form into a one-element array", async () => {
    const { toolbox, execute } = dispatchTool([COMMAND_SHAPE]);
    const job = { ...r01Job, input: { commands: { item: { id: "one", argv: { item: "ls" } } } } };
    await execute("1", { reason: "one", job });
    expect(jobOf(toolbox).input).toEqual({ commands: [{ id: "one", argv: ["ls"] }] });
  });

  it("resolves the kind's default executor when the job pins none", async () => {
    const { toolbox, execute } = dispatchTool([COMMAND_SHAPE]);
    const { executor: _executor, ...unpinned } = r01Job;
    await execute("1", { reason: "default", job: unpinned });
    expect(jobOf(toolbox).input).toEqual({ commands: [{ id: "red", argv: ["sh", "-c", SCRIPT] }] });
  });

  it("leaves an object-typed property with an item key untouched", () => {
    const shape: ExecutorView = {
      id: "x/run",
      inputShape: {
        schema: {
          type: "object",
          properties: { meta: { type: "object" }, list: { type: "array", items: { type: "object" } } },
        },
      },
    };
    const input = { meta: { item: [1, 2] }, list: [{ item: "kept" }] };
    const { job, paths } = normalizeJobInput({ kind: "command", executor: { id: "x/run" }, input }, [shape]);
    expect(paths).toEqual([]);
    expect(job.input).toBe(input);
  });

  it("does not unwrap an object with other keys beside item", () => {
    const input = { commands: { item: [{ id: "a", argv: ["ls"] }], extra: 1 } };
    const { paths } = normalizeJobInput({ kind: "command", executor: { id: "graphloom.command/run" }, input }, [COMMAND_SHAPE]);
    expect(paths).toEqual([]);
  });

  it("leaves input untouched for an executor that declares no shape", async () => {
    const noted: string[][] = [];
    const { toolbox, execute } = dispatchTool([{ ...COMMAND_SHAPE, id: "other/run" }], noted);
    await execute("1", { reason: "no shape", job: r01Job });
    expect(jobOf(toolbox).input).toEqual(r01Job.input);
    expect(noted).toEqual([]);

    const bare = dispatchTool(undefined);
    await bare.execute("1", { reason: "no catalog", job: r01Job });
    expect(jobOf(bare.toolbox).input).toEqual(r01Job.input);
  });

  it("normalizes a proposal given as a text-only JSON reply the same way", async () => {
    const reply = JSON.stringify({ reason: "supply RED", action: { type: "dispatch", job: r01Job } });
    const session: PiSupervisorSessionPort = {
      runId: "run-1",
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      sessionId: "s",
      sessionFile: "/tmp/s.jsonl",
      credentialSource: "options",
      async prompt() {
        return reply;
      },
      async setModel() {},
      async close() {},
    } as unknown as PiSupervisorSessionPort;
    const noted: string[][] = [];
    const input: SupervisorInput = {
      runId: "run-1",
      episodeId: "ep-1",
      trigger: { code: "supervise", message: "x" },
      view: {
        runId: "run-1",
        task: { request: "hi", repo: "." },
        current: { stageId: "fix", attempt: 1 },
        receipts: [],
        evidence: [],
        outstanding: [],
        budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 4 },
        validatorBindings: [],
        generation: 1,
        stateRevision: 2,
        activeVersion: "hello@0.1.0",
        recoveryEpisodeId: "ep-1",
        executors: [COMMAND_SHAPE],
      },
      admission: {
        facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
        check: async () => undefined,
        refuse: async (action, reason) => ({ action, reason, remaining: 2 }),
        normalized: (paths) => noted.push(paths),
      },
    };
    const decision = await createPiSupervisor({ session }).decide(input);
    if (!("action" in decision) || decision.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(decision.action.job.input).toEqual({ commands: [{ id: "red", argv: ["sh", "-c", SCRIPT] }] });
    expect(noted).toEqual([["job.input.commands", "job.input.commands[0].argv"]]);
  });
});

/** The live proposals of run c68993c4-021 (ep-939eb08d): numbers as strings, `id` and `continueOnFailure` left on the job. */
describe("stringified scalars and stray job fields", () => {
  const live = {
    stageId: "report",
    kind: "command",
    purpose: "diagnostic",
    readOnly: true,
    executor: { id: "graphloom.command/run" },
    instruction: "Diagnose why the pinned TypeScript metric job cannot resolve typescript.",
    input: { commands: { item: { argv: { item: ["sh", "-c", SCRIPT] } } } },
    id: "diag-ts-resolve",
    continueOnFailure: "true",
  };

  it("admits the live proposal without an id inside the command: the stray id and flag move into the input", async () => {
    const noted: string[][] = [];
    const { toolbox, execute } = dispatchTool([COMMAND_SHAPE], noted);
    const result = await execute("1", { reason: "diagnose", job: live });
    expect(result.terminate).toBe(true);
    const job = jobOf(toolbox) as unknown as Record<string, unknown>;
    expect(job.input).toEqual({ commands: [{ id: "diag-ts-resolve", argv: ["sh", "-c", SCRIPT] }], continueOnFailure: true });
    expect(job).not.toHaveProperty("id");
    expect(job).not.toHaveProperty("continueOnFailure");
    expect(noted[0]).toEqual(expect.arrayContaining(["job.input.commands[0].id (moved from job.id)", "job.input.continueOnFailure (moved from job.continueOnFailure)"]));
    expect(result.content[0]!.text).toContain("Normalized the job input");
  });

  it("reads a stringified integer and boolean against the schema, and leaves strings where a string is allowed", () => {
    const input = { commands: [{ id: "120", argv: ["echo", "true"], timeoutMs: "120000" }], continueOnFailure: "false" };
    const { job, paths } = normalizeJobInput({ kind: "command", executor: { id: "graphloom.command/run" }, input }, [COMMAND_SHAPE]);
    expect(job.input).toEqual({ commands: [{ id: "120", argv: ["echo", "true"], timeoutMs: 120000 }], continueOnFailure: false });
    expect(paths).toHaveLength(2);
  });

  it("does not move a key into an element that already has it, or into an ambiguous list", () => {
    const two = { commands: [{ argv: ["a"] }, { argv: ["b"] }] };
    expect(normalizeJobInput({ kind: "command", executor: { id: "graphloom.command/run" }, input: two, id: "x" }, [COMMAND_SHAPE]).paths).toEqual([]);
    const has = { commands: [{ id: "mine", argv: ["a"] }] };
    expect(normalizeJobInput({ kind: "command", executor: { id: "graphloom.command/run" }, input: has, id: "x" }, [COMMAND_SHAPE]).paths).toEqual([]);
  });
});
