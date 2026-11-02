// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVIDENCE_STORE_ENV,
  evidenceBlobPath,
  evidenceStoreReader,
  externalizePayload,
  writeEvidenceBlobs,
  type EvidenceRecord,
  type RunView,
} from "@graphloom/sdk";
import { createChildPluginHost, createInProcessPluginHost, type CallContext, type PluginHost } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "../test/fixtures/evidence/graph.mjs");
const workerJs = path.join(here, "../dist/worker.js");

const dirs: string[] = [];
const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ctx = (op: string): CallContext => ({ runId: "run-1", operationId: op, expectedStateRevision: 0 });

function payload() {
  return {
    command: { id: "write-report", exitCode: 0, argv: ["node", "-e", "a".repeat(20_000)], stdout: "b".repeat(30_000) },
    producer: { stageId: "write" },
  };
}

async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-evidence-host-"));
  dirs.push(dir);
  const moved = externalizePayload(payload());
  writeEvidenceBlobs(dir, moved.blobs);
  const record: EvidenceRecord = { ref: "ev-1", kind: "command", generation: 1, payload: moved.payload, externalized: moved.externalized };
  return { dir, moved, record };
}

function view(evidence: EvidenceRecord[]): RunView {
  return {
    runId: "run-1",
    task: { request: "hi" },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence,
    outstanding: [],
    budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 2 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 0,
    activeVersion: "evidence-reader@1.0.0",
  };
}

async function child(storeDir: string | undefined): Promise<PluginHost> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[EVIDENCE_STORE_ENV];
  if (storeDir !== undefined) env[EVIDENCE_STORE_ENV] = storeDir;
  const host = await createChildPluginHost({ entryModule: entry, workerModule: workerJs, activeVersion: "evidence-reader@1.0.0", generation: 1, env });
  hosts.push(host);
  return host;
}

type Seen = Array<{ ref: string; id: string; stdout: number; argv2: number; keys: string[]; json: number }>;
const seen = (decision: unknown): Seen => JSON.parse((decision as { action: { stop: { blocker: string } } }).action.stop.blocker) as Seen;

describe("plugin worker evidence hydration", () => {
  it("lets plugin code read externalized parts as if they were inline, in advance and in evaluate", async () => {
    const { dir, record } = await store();
    const host = await child(dir);
    const advanced = await host.advance(ctx("adv"), view([record]));
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const [one] = seen(advanced.value);
    expect(one).toMatchObject({ ref: "ev-1", id: "write-report", stdout: 30_000, argv2: 20_000, keys: ["id", "exitCode", "argv", "stdout"] });
    // The plugin sees exactly the bytes of the original payload.
    expect(one!.json).toBe(JSON.stringify(payload()).length);

    const evaluated = await host.evaluate!(ctx("ev"), "reads", {
      requirementId: "r1",
      statement: "s",
      evidence: [record],
      history: [{ ...record, ref: "ev-0" }],
    });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    const result = JSON.parse(evaluated.value.reason) as { evidence: Seen; history: Seen };
    expect(result.evidence[0]!.stdout).toBe(30_000);
    expect(result.history[0]).toMatchObject({ ref: "ev-0", stdout: 30_000 });
  });

  it("answers a missing or corrupt blob with the host observation evidence_unavailable, not internal", async () => {
    const { dir, moved, record } = await store();
    const stdout = moved.externalized.find((p) => p.path.join(".") === "command.stdout")!;
    await writeFile(evidenceBlobPath(dir, stdout.sha256), '"tampered"', "utf8");
    const host = await child(dir);
    const corrupt = await host.advance(ctx("adv-corrupt"), view([record]));
    expect(corrupt).toMatchObject({ ok: false, observation: { code: "evidence_unavailable" } });
    await rm(evidenceBlobPath(dir, stdout.sha256));
    const missing = await host.advance(ctx("adv-missing"), view([record]));
    expect(missing).toMatchObject({ ok: false, observation: { code: "evidence_unavailable", message: expect.stringContaining("missing") } });
    const evaluated = await host.evaluate!(ctx("ev-missing"), "reads", { requirementId: "r1", statement: "s", evidence: [record] });
    expect(evaluated).toMatchObject({ ok: false, observation: { code: "evidence_unavailable" } });
    const unset = await (await child(undefined)).advance(ctx("adv-unset"), view([record]));
    expect(unset).toMatchObject({ ok: false, observation: { code: "evidence_unavailable" } });
  });

  it("gives the in-process host's plugin the same view through the reader it was given", async () => {
    const { dir, record } = await store();
    const mod = (await import(entry)) as { createGraph: () => Parameters<typeof createInProcessPluginHost>[0] };
    const inline = createInProcessPluginHost(mod.createGraph(), { activeVersion: "v1", evidenceReader: evidenceStoreReader(dir) });
    expect(inline.hydratesEvidence).toBe(true);
    const out = await inline.advance(ctx("adv"), view([record]));
    expect(out.ok).toBe(true);
    if (out.ok) expect(seen(out.value)[0]).toMatchObject({ stdout: 30_000, argv2: 20_000 });
    const without = createInProcessPluginHost(mod.createGraph(), { activeVersion: "v1" });
    expect(without.hydratesEvidence).toBeUndefined();
  });
});
