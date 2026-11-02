// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EvidenceUnavailableError,
  evidenceBlobPath,
  evidenceStoreReader,
  externalizePayload,
  hydrateRecord,
  installLazyPayload,
  isEvidenceUnavailable,
  stableHash,
  writeEvidenceBlobs,
  type EvidenceRecord,
} from "./index.js";

const big = (n: number, c = "x"): string => c.repeat(n);

function commandPayload(): Record<string, unknown> {
  return {
    command: { id: "write-report", exitCode: 0, argv: ["node", "-e", big(20_000, "a")], stdout: big(30_000, "b"), stderr: "" },
    files: [big(9_000, "c"), "small", big(100, "d")],
    producer: { jobId: "job-1", note: big(12_000, "p") },
  };
}

function record(payload: unknown): EvidenceRecord {
  return { ref: "ev-1", kind: "command", generation: 1, payload };
}

function dirWith(blobs: Array<{ sha256: string; text: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "evidence-store-"));
  writeEvidenceBlobs(dir, blobs);
  return dir;
}

describe("externalizePayload", () => {
  it("moves parts over the threshold, keeps identifying fields, root and producer inline", () => {
    const out = externalizePayload(commandPayload());
    const p = out.payload as { command: Record<string, unknown>; files: unknown[]; producer: { note: string } };
    expect(p.command["id"]).toBe("write-report");
    expect(p.command["exitCode"]).toBe(0);
    expect(p.command["stdout"]).toBeNull();
    expect((p.command["argv"] as unknown[])[2]).toBeNull();
    expect(p.files[0]).toBeNull();
    expect(p.files[1]).toBe("small");
    expect(p.producer.note).toHaveLength(12_000);
    expect(out.externalized.map((e) => e.path)).toEqual(expect.arrayContaining([["command", "stdout"], ["command", "argv", 2], ["files", 0]]));
  });

  it("is deterministic and round trips byte-identical", () => {
    const a = externalizePayload(commandPayload());
    const b = externalizePayload(commandPayload());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const original = record(commandPayload());
    const dir = dirWith(a.blobs);
    const externalized: EvidenceRecord = { ...original, payload: a.payload, externalized: a.externalized };
    const hydrated = hydrateRecord(externalized, evidenceStoreReader(dir));
    expect(stableHash(hydrated)).toBe(stableHash(original));
    expect(hydrated.externalized).toBeUndefined();
  });

  it("never externalizes a root string, and splits many mid-size members largest first", () => {
    expect(externalizePayload(big(50_000)).externalized).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, big(3_000 + i, "m")]));
    // Members of the root under the threshold stay inline: only a part over it is externalized.
    expect(externalizePayload(many).externalized).toEqual([]);
    // A nested part over the threshold sheds its members largest first until it fits.
    const out = externalizePayload({ id: "x", nested: many });
    expect(out.externalized[0]!.path).toEqual(["nested", "k5"]);
    expect(JSON.stringify((out.payload as { nested: unknown }).nested).length).toBeLessThanOrEqual(8 * 1024);
  });

  it("stores a container of many tiny members whole instead of one blob per member", () => {
    const series = Array.from({ length: 900 }, (_, k) => [k, k * 3.14159, "m"]);
    const out = externalizePayload({ metrics: { series, unit: "ms" }, producer: { a: 1 } });
    expect(out.externalized.map((e) => e.path)).toEqual([["metrics", "series"]]);
    expect(out.blobs).toHaveLength(1);
    expect((out.payload as { metrics: { unit: string } }).metrics.unit).toBe("ms");
  });

  it("round trips arbitrary nesting, keeps every blob referenced, and never leaves nested parts under a stored one", () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const make = (depth: number): unknown => {
      const pick = rand(depth > 3 ? 3 : 6);
      if (pick === 0) return rand(1000);
      if (pick === 1) return "s".repeat(rand(14_000));
      if (pick === 2) return null;
      if (pick === 3) return Array.from({ length: rand(40) }, () => make(depth + 1));
      return Object.fromEntries(Array.from({ length: rand(30) }, (_, i) => [`k${i}`, make(depth + 1)]));
    };
    for (let n = 0; n < 60; n += 1) {
      const original = { id: `r${n}`, body: make(0), producer: { x: make(2) } };
      const out = externalizePayload(original);
      const paths = out.externalized.map((e) => e.path);
      for (const a of paths) for (const b of paths) if (a !== b) expect(b.length > a.length && a.every((k, i) => b[i] === k)).toBe(false);
      expect(new Set(out.blobs.map((b) => b.sha256))).toEqual(new Set(out.externalized.map((e) => e.sha256)));
      const dir = dirWith(out.blobs);
      const hydrated = hydrateRecord({ ref: "e", kind: "other", payload: out.payload, externalized: out.externalized }, evidenceStoreReader(dir));
      expect(stableHash(hydrated.payload)).toBe(stableHash(original));
    }
  }, 120_000);

  it("stores identical parts once", () => {
    const out = externalizePayload({ a: big(9_000), b: big(9_000) });
    expect(out.externalized).toHaveLength(2);
    expect(out.blobs).toHaveLength(1);
  });
});

describe("installLazyPayload", () => {
  it("reads parts on first access and fails with evidence_unavailable on a missing or corrupt blob", () => {
    const out = externalizePayload(commandPayload());
    const dir = dirWith(out.blobs);
    const wire = (): EvidenceRecord => JSON.parse(JSON.stringify({ ...record(out.payload), externalized: out.externalized })) as EvidenceRecord;
    const rec = wire();
    installLazyPayload(rec, evidenceStoreReader(dir));
    const payload = rec.payload as { command: { stdout: string; argv: string[] } };
    expect(Object.keys(payload.command)).toContain("stdout");
    expect(payload.command.stdout).toHaveLength(30_000);
    expect(payload.command.argv[2]).toHaveLength(20_000);
    expect(stableHash(rec.payload)).toBe(stableHash(commandPayload()));

    const corrupt = wire();
    const victim = out.externalized.find((e) => e.path.join(".") === "command.stdout")!;
    writeFileSync(evidenceBlobPath(dir, victim.sha256), '"tampered"');
    installLazyPayload(corrupt, evidenceStoreReader(dir));
    let caught: unknown;
    try {
      void (corrupt.payload as { command: { stdout: string } }).command.stdout;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvidenceUnavailableError);
    expect(isEvidenceUnavailable(caught)).toBe(true);

    const missing = mkdtempSync(path.join(tmpdir(), "evidence-empty-"));
    expect(() => hydrateRecord({ ...record(out.payload), externalized: out.externalized }, evidenceStoreReader(missing))).toThrow(/blob file is missing/);
    expect(readdirSync(dir)).toContain("sha256");
  });
});

describe("writeEvidenceBlobs durability", () => {
  it("fsyncs the blob's directory after the rename, and the parent of every directory it created, before returning", () => {
    const base = mkdtempSync(path.join(tmpdir(), "evidence-durable-"));
    const store = path.join(base, "run", "evidence");
    const calls: string[] = [];
    const fds = new Map<number, string>();
    const fs = {
      existsSync,
      statSync,
      mkdirSync: (dir: string, o: { recursive: true }) => (calls.push(`mkdir ${path.relative(base, dir)}`), mkdirSync(dir, o)),
      openSync: (file: string, flags: string) => {
        const real = openSync(file, flags);
        fds.set(real, path.relative(base, file));
        return real;
      },
      writeSync: (fd: number, text: string, position: null, enc: "utf8") => writeSync(fd, text, position, enc),
      fsyncSync: (fd: number) => (calls.push(`fsync ${fds.get(fd)!.replace(/\.[0-9a-f-]+\.tmp$/, ".tmp")}`), fsyncSync(fd)),
      closeSync,
      renameSync: (a: string, b: string) => (calls.push(`rename ${path.relative(base, b)}`), renameSync(a, b)),
    };
    const blob = { sha256: "a".repeat(64), text: '"x"' };
    // sha256 digests are checked by name only on read; writing does not verify them.
    writeEvidenceBlobs(store, [blob], fs);
    const rename = calls.findIndex((c) => c.startsWith("rename "));
    expect(rename).toBeGreaterThan(calls.findIndex((c) => c.startsWith("fsync ") && c.endsWith(".tmp")));
    const after = calls.slice(rename + 1);
    // The blob's own directory, then the parent of each directory created: base (holds run), run (holds evidence), evidence (holds sha256).
    expect(after).toEqual([
      path.join("run", "evidence", "sha256"),
      "",
      "run",
      path.join("run", "evidence"),
    ].map((d) => `fsync ${d}`));
    // A second write into the now existing store syncs only the directory of the new blob.
    calls.length = 0;
    writeEvidenceBlobs(store, [{ sha256: "b".repeat(64), text: '"y"' }], fs);
    expect(calls.slice(calls.findIndex((c) => c.startsWith("rename ")) + 1)).toEqual([`fsync ${path.join("run", "evidence", "sha256")}`]);
  });
});
