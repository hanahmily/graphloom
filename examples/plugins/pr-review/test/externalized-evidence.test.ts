// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evidenceStoreReader, externalizePayload, installLazyPayload, writeEvidenceBlobs, type EvidenceRecord } from "@graphloom/sdk";
import { hugeRehearsal } from "../src/rehearsal.js";
import { HUGE_LIMITS } from "../src/rehearsal-huge.js";
import { BANYANDB, simulateYielding, type Simulation } from "./support.js";

/**
 * The plugin worker hands the plugin evidence in its externalized form with lazy getters
 * (packages/plugin-host/src/worker.ts); the plugin's decisions must not depend on which form it reads. This runs
 * the real graph and validators over a pull request at the scale of #1445 twice, once on inline records and once
 * on records externalized into a store and read back lazily, and compares every decision and receipt.
 */
const dir = mkdtempSync(path.join(tmpdir(), "pr-review-evidence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Stats {
  records: number;
  externalizedRecords: number;
  parts: number;
  inlineBytes: number;
  externalizedBytes: number;
}

/** Records as the worker presents them: externalized, sent over the wire (JSON), lazy getters installed. Once per record. */
function lazyForm(stats: Stats): (records: EvidenceRecord[]) => EvidenceRecord[] {
  const cache = new WeakMap<EvidenceRecord, EvidenceRecord>();
  const reader = evidenceStoreReader(dir);
  const parsed = new Map<string, unknown>();
  return (records) =>
    records.map((record) => {
      let wire = cache.get(record);
      if (wire === undefined) {
        const moved = record.payload === undefined ? undefined : externalizePayload(record.payload);
        if (moved !== undefined) writeEvidenceBlobs(dir, moved.blobs);
        const stored: EvidenceRecord = moved === undefined || moved.externalized.length === 0 ? record : { ...record, payload: moved.payload, externalized: moved.externalized };
        wire = JSON.parse(JSON.stringify(stored)) as EvidenceRecord;
        stats.records += 1;
        stats.inlineBytes += JSON.stringify(record).length;
        stats.externalizedBytes += JSON.stringify(stored).length;
        if (wire.externalized !== undefined) {
          stats.externalizedRecords += 1;
          stats.parts += wire.externalized.length;
        }
        installLazyPayload(wire, reader, parsed);
        cache.set(record, wire);
      }
      return wire;
    });
}

describe("pr-review reads externalized evidence exactly as it reads inline evidence", () => {
  it("answers the same on the same run at the scale of #1445, in advance and in every validator", async () => {
    const CONFIG = { limits: HUGE_LIMITS };
    const { scenario, headFiles } = hugeRehearsal({ ...BANYANDB, ...CONFIG });
    const stats: Stats = { records: 0, externalizedRecords: 0, parts: 0, inlineBytes: 0, externalizedBytes: 0 };
    const compared: Array<{ step: number; what: string; recorded: string; shadow: string }> = [];
    const sim: Simulation = await simulateYielding({
      scenario,
      config: CONFIG,
      files: headFiles,
      maxSteps: 2_500,
      budgets: { agentInvocations: 400, jobs: 2_000, decisions: 4_000, corrections: 40 },
      shadow: { records: lazyForm(stats), every: 6, compared },
    });
    expect(sim.final.action.type).toBe("stop");

    // Every sampled advance and every validation gave the same answer on both forms.
    const advances = compared.filter((c) => c.what === "advance");
    const validations = compared.filter((c) => c.what.startsWith("validate"));
    expect(advances.length).toBeGreaterThan(30);
    expect(validations.length).toBeGreaterThan(3);
    for (const c of compared) expect(c.shadow, `${c.what} at step ${c.step}`).toBe(c.recorded);
    // Presenting the evidence lazily leaves the recorded evidence untouched.
    expect(sim.evidence.every((e) => e.externalized === undefined)).toBe(true);

    // The comparison is meaningful: much of the evidence really was externalized.
    console.log(`pr-review #1445-scale: ${JSON.stringify(stats)} steps=${sim.decisions.length} advances compared=${advances.length} validations compared=${validations.length}`);
    expect(stats.externalizedRecords).toBeGreaterThan(50);
    expect(stats.externalizedBytes).toBeLessThan(stats.inlineBytes / 2);
  }, 900_000);
});
