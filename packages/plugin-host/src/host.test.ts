import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunView } from "@graphloom/sdk";
import {
  createChildPluginHost,
  createScriptedPluginHost,
  dispatch,
  type CallContext,
  type PluginHost,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...parts: string[]) => path.join(here, "../test/fixtures", ...parts);
const workerJs = path.join(here, "../dist/worker.js");

const hosts: PluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    const h = hosts.pop();
    if (h) await h.close();
  }
});

function ctx(op: string): CallContext {
  return {
    runId: "run-1",
    operationId: op,
    expectedStateRevision: 0,
  };
}

function view(): RunView {
  return {
    runId: "run-1",
    task: { request: "hi" },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 2 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 0,
    activeVersion: "minimal@1",
  };
}

async function track(host: Promise<PluginHost>): Promise<PluginHost> {
  const h = await host;
  hosts.push(h);
  return h;
}

describe("createChildPluginHost", () => {
  it("loads a minimal plugin and round-trips describe/advance", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("minimal", "graph.mjs"),
        activeVersion: "minimal@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );

    const described = await host.describe(ctx("op-describe"));
    expect(described.ok).toBe(true);
    if (!described.ok) throw new Error("expected ok");
    expect(described.value.graphId).toBe("minimal");

    const advanced = await host.advance(ctx("op-advance"), view());
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) throw new Error("expected ok");
    expect(advanced.value.action.type).toBe("dispatch");
  });

  it("loads a second external plugin with the same host code", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("secondary", "graph.mjs"),
        activeVersion: "secondary@2",
        generation: 3,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );

    const described = await host.describe(ctx("op-sec"));
    expect(described.ok).toBe(true);
    if (!described.ok) throw new Error("expected ok");
    expect(described.value.graphId).toBe("secondary");
  });

  it("observes process exit during advance as crash", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("crashing", "graph.mjs"),
        activeVersion: "crash@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );

    const result = await host.advance(ctx("op-crash"), view());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected observation");
    expect(result.observation.code).toBe("crash");
  });

  it("observes hang as timeout and keeps the caller responsive", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("hanging", "graph.mjs"),
        activeVersion: "hang@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 200,
      }),
    );

    const started = Date.now();
    const result = await host.advance(ctx("op-hang"), view());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected observation");
    expect(result.observation.code).toBe("timeout");
  });

  it("rejects stale generation replies", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: "stale-generation",
        activeVersion: "v1",
        generation: 5,
        workerModule: fixture("bad-worker.mjs"),
        callbackTimeoutMs: 3_000,
      }),
    );

    // bad-worker: argv[2] is entryModule "stale-generation" which equals mode.
    const result = await host.describe(ctx("op-stale"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected observation");
    expect(result.observation.code).toBe("stale");
  });

  it("rejects malformed wire responses", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: "malformed",
        activeVersion: "v1",
        generation: 1,
        workerModule: fixture("bad-worker.mjs"),
        callbackTimeoutMs: 3_000,
      }),
    );

    const result = await host.describe(ctx("op-bad"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected observation");
    expect(["malformed", "unknown"]).toContain(result.observation.code);
  });

  it("uses a fresh process per activation (new generation/version)", async () => {
    const first = await track(
      createChildPluginHost({
        entryModule: fixture("minimal", "graph.mjs"),
        activeVersion: "minimal@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );
    const d1 = await first.describe(ctx("g1"));
    expect(d1.ok).toBe(true);
    await first.close();

    const second = await track(
      createChildPluginHost({
        entryModule: fixture("minimal", "graph.mjs"),
        activeVersion: "minimal@2",
        generation: 2,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );
    expect(second.generation).toBe(2);
    expect(second.activeVersion).toBe("minimal@2");
    const d2 = await second.describe(ctx("g2"));
    expect(d2.ok).toBe(true);
  });
});

describe("createScriptedPluginHost", () => {
  it("keeps an in-process scripted adapter for CI paths", async () => {
    const host = createScriptedPluginHost(
      {
        definition: {
          graphId: "scripted",
          version: "0",
          stages: [{ id: "write", name: "Write", requirementIds: ["r"] }],
          requirements: [
            { id: "r", statement: "s", evidenceSchema: "e" },
          ],
          defaultValidators: [
            { requirementId: "r", validatorId: "v", version: "1" },
          ],
        },
        advances: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "go",
            },
            "scripted",
          ),
        ],
      },
      { activeVersion: "scripted@0", generation: 1 },
    );
    hosts.push(host);

    const d = await host.describe(ctx("s0"));
    expect(d.ok).toBe(true);
    const a = await host.advance(ctx("s1"), view());
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("expected ok");
    expect(a.value.action.type).toBe("dispatch");
  });
});
