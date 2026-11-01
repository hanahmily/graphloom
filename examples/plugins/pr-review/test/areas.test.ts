// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { isExcluded, partitionAreas } from "../src/areas.js";
import { describeReasons, hardCapProblem, questionsMode, reportMode } from "../src/mode.js";
import { DEFAULT_LIMITS } from "../src/profile.js";
import { pullFile, type PullFile } from "../src/snapshot.js";

/** A file whose patch is `bytes` bytes long. */
function file(path: string, bytes: number, over: Record<string, unknown> = {}): PullFile {
  const header = "@@ -0,0 +1 @@\n+";
  const patch = header + "x".repeat(Math.max(0, bytes - header.length));
  return pullFile({ path, status: "added", previousPath: null, additions: 1, deletions: 0, sha: null, patch, patchOmitted: false, ...over })!;
}

const limits = (areaMaxBytes: number, areaMinBytes: number) => ({ areaMaxBytes, areaMinBytes });
const names = (files: PullFile[], max: number, min: number, exclude: string[] = []): Array<[string, string[]]> => partitionAreas(files, limits(max, min), exclude).areas.map((a) => [a.name, a.paths]);

describe("the areas of a large pull request (design §6.9)", () => {
  it("groups the files by their first path segment, in path order, numbered A1...", () => {
    const p = partitionAreas([file("pkg/a.go", 100), file("docs/x.md", 100), file("cmd/main.go", 100)], limits(1000, 1), []);
    expect(p.areas.map((a) => [a.id, a.name, a.paths])).toEqual([
      ["A1", "cmd", ["cmd/main.go"]],
      ["A2", "docs", ["docs/x.md"]],
      ["A3", "pkg", ["pkg/a.go"]],
    ]);
    expect(p.areas.every((a) => a.kind === "read")).toBe(true);
    expect(p.omitted).toEqual([]);
  });

  it("splits a group over areaMaxBytes by its next segment, recursively", () => {
    const files = [file("pkg/a/x.go", 200), file("pkg/a/y.go", 200), file("pkg/b/deep/z.go", 300), file("pkg/b/other/w.go", 300)];
    expect(names(files, 500, 1)).toEqual([
      ["pkg/a", ["pkg/a/x.go", "pkg/a/y.go"]],
      ["pkg/b/deep", ["pkg/b/deep/z.go"]],
      ["pkg/b/other", ["pkg/b/other/w.go"]],
    ]);
  });

  it("splits a single directory over the size into runs of files sorted by path, each under the size", () => {
    const files = ["e", "a", "c", "b", "d"].map((n) => file(`pkg/${n}.go`, 300));
    const areas = partitionAreas(files, limits(700, 1), []).areas;
    expect(areas.map((a) => a.paths)).toEqual([["pkg/a.go", "pkg/b.go"], ["pkg/c.go", "pkg/d.go"], ["pkg/e.go"]]);
    expect(areas.map((a) => a.name)).toEqual(["pkg (files 1/3)", "pkg (files 2/3)", "pkg (files 3/3)"]);
    // A file over the size on its own is a run of its own.
    expect(partitionAreas([file("pkg/big.go", 900), file("pkg/s.go", 100)], limits(700, 1), []).areas.map((a) => a.paths)).toEqual([["pkg/big.go"], ["pkg/s.go"]]);
  });

  it("merges sibling groups under areaMinBytes into <parent>/(rest), and leaves one small group alone", () => {
    const files = [file("pkg/a/x.go", 400), file("pkg/b/y.go", 20), file("pkg/c/z.go", 30), file("pkg/d/w.go", 400)];
    expect(names(files, 500, 100)).toEqual([
      ["pkg/a", ["pkg/a/x.go"]],
      ["pkg/(rest)", ["pkg/b/y.go", "pkg/c/z.go"]],
      ["pkg/d", ["pkg/d/w.go"]],
    ]);
    // Top-level groups under the minimum merge into "(rest)".
    expect(names([file("a/x.go", 10), file("b/y.go", 10), file("c/z.go", 600)], 1000, 100)).toEqual([
      ["(rest)", ["a/x.go", "b/y.go"]],
      ["c", ["c/z.go"]],
    ]);
    // One small sibling has nothing to merge with.
    expect(names([file("pkg/a/x.go", 400), file("pkg/b/y.go", 20)], 410, 100)).toEqual([
      ["pkg/a", ["pkg/a/x.go"]],
      ["pkg/b", ["pkg/b/y.go"]],
    ]);
  });

  it("never packs a merged area past areaMaxBytes", () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`pkg/d${i}/f.go`, 40));
    const areas = partitionAreas(files, limits(100, 50), []).areas;
    expect(areas.every((a) => a.bytes <= 100)).toBe(true);
    expect(areas.flatMap((a) => a.paths).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("puts the files under excludeRoots in one generated area that no agent reads, and lists a file with no patch apart", () => {
    const files = [file("api/gen/a.pb.go", 100), file("api/gen/b.pb.go", 100), file("pkg/a.go", 100), file("assets/logo.png", 0, { patch: null, patchOmitted: true })];
    const p = partitionAreas(files, limits(1000, 1), ["**/*.pb.go"]);
    expect(p.areas.map((a) => [a.id, a.kind, a.paths])).toEqual([
      ["A1", "read", ["pkg/a.go"]],
      ["generated", "generated", ["api/gen/a.pb.go", "api/gen/b.pb.go"]],
    ]);
    expect(p.omitted).toEqual(["assets/logo.png"]);
  });

  it("keeps a test file with its directory's group, so a package and its tests are read together", () => {
    const files = [file("pkg/a/a.go", 300), file("pkg/a/a_test.go", 300), file("pkg/b/b.go", 300), file("pkg/b/b_test.go", 300)];
    const a = names(files, 700, 1);
    expect(a).toEqual([
      ["pkg/a", ["pkg/a/a.go", "pkg/a/a_test.go"]],
      ["pkg/b", ["pkg/b/b.go", "pkg/b/b_test.go"]],
    ]);
  });

  it("is deterministic: the same files in any order give the same areas, ids and names", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`m${i % 4}/p${i % 7}/f${i}.go`, 50 + (i * 37) % 200));
    const first = JSON.stringify(partitionAreas(files, limits(400, 120), ["m3/**"]));
    for (const seed of [1, 2, 3]) {
      const shuffled = [...files].sort((a, b) => ((a.path.length * seed) % 7) - ((b.path.length * seed) % 7) || (a.path < b.path ? seed : -seed));
      expect(JSON.stringify(partitionAreas(shuffled, limits(400, 120), ["m3/**"]))).toBe(first);
    }
  });

  it("covers every file exactly once", () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`a${i % 5}/b${i % 3}/f${i}.go`, 30 + i * 11));
    const p = partitionAreas(files, limits(300, 100), []);
    const all = [...p.areas.flatMap((a) => a.paths), ...p.omitted].sort();
    expect(all).toEqual(files.map((f) => f.path).sort());
    expect(new Set(all).size).toBe(files.length);
  });

  it("reads excludeRoots as a glob or a path prefix", () => {
    expect(isExcluded("a/b.pb.go", ["**/*.pb.go"])).toBe(true);
    expect(isExcluded("vendor/x/y.go", ["vendor"])).toBe(true);
    expect(isExcluded("vendorish/y.go", ["vendor"])).toBe(false);
    expect(isExcluded("pkg/y.go", ["vendor/"])).toBe(false);
  });
});

describe("the mode a limit decides (design §6.9, §7.6)", () => {
  const bytes = (n: number): PullFile => file("f.go", n);
  it("is standard at or under the limits and large over either, with the reason", () => {
    expect(reportMode([bytes(10)], { maxFiles: 1, maxPatchBytes: 100 })).toEqual({ mode: "standard", reasons: [] });
    expect(reportMode([bytes(10), bytes(10)], { maxFiles: 1, maxPatchBytes: 100 })).toEqual({ mode: "large", reasons: [{ limit: "maxFiles", value: 2, max: 1 }] });
    const m = reportMode([bytes(200)], { maxFiles: 5, maxPatchBytes: 100 });
    expect(m).toEqual({ mode: "large", reasons: [{ limit: "maxPatchBytes", value: 200, max: 100 }] });
    expect(describeReasons(m.reasons)).toBe("200 patch bytes, over the limit of 100");
  });

  it("makes the questions large over maxNewSymbols alone, and keeps the report's reasons", () => {
    const standard = reportMode([bytes(10)], { maxFiles: 5, maxPatchBytes: 100 });
    expect(questionsMode(standard, 3, { maxNewSymbols: 3 }).mode).toBe("standard");
    expect(questionsMode(standard, 4, { maxNewSymbols: 3 })).toEqual({ mode: "large", reasons: [{ limit: "maxNewSymbols", value: 4, max: 3 }] });
    const large = reportMode([bytes(200)], { maxFiles: 5, maxPatchBytes: 100 });
    expect(questionsMode(large, 0, { maxNewSymbols: 3 }).reasons).toEqual(large.reasons);
  });

  it("refuses only past a hard cap", () => {
    const caps = { hardMaxFiles: 2, hardMaxPatchBytes: 100 };
    expect(hardCapProblem([bytes(10), bytes(10)], caps)).toBeUndefined();
    expect(hardCapProblem([bytes(10), bytes(10), bytes(10)], caps)).toMatch(/3 files, past the profile's limits.hardMaxFiles of 2/);
    expect(hardCapProblem([bytes(101)], caps)).toMatch(/101 bytes, past the profile's limits.hardMaxPatchBytes of 100/);
    expect(DEFAULT_LIMITS).toMatchObject({ maxFiles: 150, hardMaxFiles: 1000, hardMaxPatchBytes: 8 * 1024 * 1024, hardMaxNewSymbols: 2000, areaMaxBytes: 256 * 1024, areaMinBytes: 16 * 1024 });
  });
});
