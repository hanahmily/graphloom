import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunView } from "@graphloom/sdk";
import {
  createChildPluginHost,
  createInProcessPluginHost,
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
  it.each(["null", "[]", "true", "42", '"text"'])("observes non-object JSON %s as malformed", async (json) => {
    const host = await track(createChildPluginHost({
      entryModule: `json-${json}`,
      activeVersion: "v1",
      generation: 1,
      workerModule: fixture("bad-worker.mjs"),
      callbackTimeoutMs: 200,
    }));
    expect(await host.describe(ctx("op-non-object"))).toMatchObject({
      ok: false,
      observation: { code: "malformed" },
    });
  });

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

  it("reports why the plugin entry failed to load, not the error envelope's missing run id", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("empty", "graph.mjs"),
        activeVersion: "empty@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );
    const described = await host.describe(ctx("op-describe"));
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("expected a failure");
    expect(described.observation.message).toMatch(/failed to load plugin: plugin entry must export createGraph\(\) or default GraphPlugin/);
    expect(described.observation.message).not.toMatch(/runId must be a non-empty string/);
  });

  it("reports a load failure the child wrote and exited on before any call was made", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("empty", "graph.mjs"),
        activeVersion: "empty@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );
    // Let the worker fail to load, write its error and exit before the first
    // call registers: the order CI hit, where the line used to be dropped.
    await new Promise((r) => setTimeout(r, 1_500));
    const described = await host.describe(ctx("op-describe-late"));
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("expected a failure");
    expect(described.observation.message).toMatch(/failed to load plugin: plugin entry must export createGraph\(\) or default GraphPlugin/);
  });

  it("attributes an oversized advance request to its real run, not a malformed-response failure", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("minimal", "graph.mjs"),
        activeVersion: "minimal@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );
    // Large enough to exceed the wire byte cap once serialized as part of the request.
    const huge: RunView = { ...view(), task: { request: "x".repeat(17_000_000) } };
    const result = await host.advance(ctx("op-huge"), huge);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.observation.code).toBe("oversized");
  });

  it("attributes an oversized recovery-scoped advance request too, not a stale-episode failure", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("minimal", "graph.mjs"),
        activeVersion: "minimal@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );
    const huge: RunView = { ...view(), task: { request: "x".repeat(17_000_000) } };
    const result = await host.advance({ ...ctx("op-huge-recovery"), recoveryEpisodeId: "recovery-1" }, huge);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.observation.code).toBe("oversized");
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

  it("keeps NDJSON intact when the plugin writes to stdout/console", async () => {
    const host = await track(
      createChildPluginHost({
        entryModule: fixture("chatty", "graph.mjs"),
        activeVersion: "chatty@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
      }),
    );

    const described = await host.describe(ctx("op-chatty"));
    expect(described.ok).toBe(true);
    if (!described.ok) throw new Error(`expected ok, got ${JSON.stringify(described)}`);
    expect(described.value.graphId).toBe("chatty");
  });

  it("surfaces spawn failures without an unhandled child error", async () => {
    await expect(
      createChildPluginHost({
        entryModule: fixture("minimal", "graph.mjs"),
        activeVersion: "spawn-fail@1",
        generation: 1,
        workerModule: workerJs,
        cwd: path.join(here, "definitely-missing-cwd"),
        callbackTimeoutMs: 3_000,
      }),
    ).rejects.toThrow(/spawn failed|ENOENT|failed during startup|exited during startup/);
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

describe("task config", () => {
  const configured = (config?: unknown) =>
    track(
      createChildPluginHost({
        entryModule: fixture("configured", "graph.mjs"),
        activeVersion: "configured@1",
        generation: 1,
        workerModule: workerJs,
        callbackTimeoutMs: 3_000,
        ...(config !== undefined ? { config } : {}),
      }),
    );

  it("attaches the run's config to describe, advance, evaluate and rehearsal, unread", async () => {
    const config = { profile: { nested: [1, "two", null] }, graph: "not-the-task-graph" };
    const host = await configured(config);
    const described = await host.describe(ctx("op-describe"));
    expect(described.ok && described.value.requirements[0]!.statement).toBe(`describe saw ${JSON.stringify(config)}`);
    const advanced = await host.advance(ctx("op-advance"), view());
    expect(advanced.ok && advanced.value.action).toEqual({ type: "stop", stop: { reason: "echo", blocker: JSON.stringify(config) } });
    const evaluated = await host.evaluate!(ctx("op-evaluate"), "echo", { requirementId: "r", statement: "s", evidence: [] });
    expect(evaluated.ok && evaluated.value.reason).toBe(JSON.stringify(config));
    const rehearsal = await host.rehearsal!(ctx("op-rehearsal"), fixture("configured", "graph.mjs"));
    expect(rehearsal.ok && rehearsal.value?.scenarios.happy!.expect.stopReason).toBe(JSON.stringify(config));
  });

  it("sends no config when the run has none", async () => {
    const host = await configured();
    const described = await host.describe(ctx("op-describe"));
    expect(described.ok && described.value.requirements[0]!.statement).toBe("describe saw null");
    const advanced = await host.advance(ctx("op-advance"), view());
    expect(advanced.ok && advanced.value.action).toEqual({ type: "stop", stop: { reason: "echo", blocker: "null" } });
  });

  it("passes the config to an in-process plugin's describe and advance", async () => {
    const seen: unknown[] = [];
    const host = createInProcessPluginHost(
      {
        describe: (config?: unknown) => {
          seen.push(config);
          return { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] };
        },
        advance: (v) => {
          seen.push(v.config);
          return { action: { type: "stop", stop: { reason: "r", blocker: "b" } }, reason: "r" };
        },
      },
      { activeVersion: "g@1", config: [42] },
    );
    hosts.push(host);
    await host.describe(ctx("d"));
    await host.advance(ctx("a"), view());
    expect(seen).toEqual([[42], [42]]);
  });
});
