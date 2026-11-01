// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { MAX_EXECUTOR_INPUT_BYTES } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { partitionAreas } from "../src/areas.js";
import { buildDigest, INTERFACE_PATCH_BYTES, interfaceGlobs, newExportedSymbols } from "../src/digest.js";
import { largeReporterInstruction } from "../src/largeprompts.js";
import { pullFile, type PullFile } from "../src/snapshot.js";
import { reporterSections } from "../src/template.js";
import { profileOf } from "./support.js";

const profile = profileOf();
const sections = reporterSections(profile);

const file = (path: string, patch: string | null, over: Record<string, unknown> = {}): PullFile => pullFile({ path, status: "added", previousPath: null, additions: 1, deletions: 0, sha: null, patch, patchOmitted: patch === null, ...over })!;
const added = (lines: string[]): string => `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
const big = (n: number): string => added(Array.from({ length: n }, (_, i) => `line ${i} of a document that is long enough to count`));
const partition = (files: PullFile[]) => partitionAreas(files, { ...profile.limits, areaMaxBytes: 100_000, areaMinBytes: 1 }, []);

describe("the interface files of the digest", () => {
  it("are the files the schema, config and interfaces routing globs match, protobuf definitions, CHANGES.md and docs", () => {
    const globs = interfaceGlobs(sections);
    const routing = sections.filter((s) => ["schema", "config", "interfaces"].includes(s.id)).flatMap((s) => s.routing);
    expect(routing).toContain("api/proto/**");
    for (const g of routing) expect(globs).toContain(g);
    for (const g of ["**/*.proto", "CHANGES.md", "docs/**"]) expect(globs).toContain(g);
    // The routing of other sections is not an interface.
    const background = sections.find((s) => s.id === "background")!.routing;
    for (const g of background) if (!routing.includes(g)) expect(globs).not.toContain(g);
  });

  it("gives their patches and no others", () => {
    const files = [file("api/proto/x/v1/rpc.proto", added(["message A {}"])), file("docs/a.md", added(["# doc"])), file("CHANGES.md", added(["- change"])), file("a/b/model.proto", added(["message B {}"])), file("pkg/x/x.go", added(["package x"])), file("banyand/liaison/grpc/server.go", added(["package grpc"]))];
    const d = buildDigest(files, partition(files), sections);
    expect(d.patches.map((p) => p.path)).toEqual(["CHANGES.md", "a/b/model.proto", "api/proto/x/v1/rpc.proto", "docs/a.md"]);
    expect(d.leftOut).toEqual([]);
  });

  it("are capped in total: the largest patch is left out first, and the files left out are listed", () => {
    const files = [file("docs/small.md", big(10)), file("docs/medium.md", big(400)), file("docs/huge.md", big(5000))];
    const total = files.reduce((n, f) => n + Buffer.byteLength(f.patch!), 0);
    expect(total).toBeGreaterThan(INTERFACE_PATCH_BYTES);
    const d = buildDigest(files, partition(files), sections);
    expect(d.patches.map((p) => p.path)).toEqual(["docs/medium.md", "docs/small.md"]);
    expect(d.leftOut).toEqual([{ path: "docs/huge.md", bytes: Buffer.byteLength(files[2]!.patch!) }]);
    expect(d.patches.reduce((n, p) => n + p.bytes, 0)).toBeLessThanOrEqual(INTERFACE_PATCH_BYTES);
    const d2 = buildDigest(files, partition(files), sections, 10_000);
    expect(d2.patches.map((p) => p.path)).toEqual(["docs/small.md"]);
    expect(d2.leftOut.map((l) => l.path)).toEqual(["docs/huge.md", "docs/medium.md"]);
  });

  it("say so in the reporter's input, with the note listing what was left out, and the input fits an executor's bound", () => {
    const files = [file("docs/small.md", big(10)), file("docs/medium.md", big(400)), file("docs/huge.md", big(5000)), file("pkg/x/x.go", added(["package x", "func Exported() {}"]))];
    const text = largeReporterInstruction({ pr: { mode: "report", owner: "o", repo: "r", number: 1, head: "h".repeat(40) }, snapshot: { pull: { title: "t", body: "b" } as never, files, commits: [{ sha: "a".repeat(40), message: "m" }] }, partition: partition(files), sections, facts: [], kind: "first", feedback: [] });
    expect(text).toContain("Interface patches left out because the total was over the cap, largest first");
    expect(text).toContain("docs/huge.md (");
    expect(text).toContain('<untrusted source="patch of docs/medium.md">');
    expect(text).not.toContain('<untrusted source="patch of docs/huge.md">');
    expect(text).not.toContain('patch of pkg/x/x.go');
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThan(MAX_EXECUTOR_INPUT_BYTES);
  });

  it("shrink below the cap when the rest of the input leaves less room, so the job's input still fits", () => {
    // Many files: a long file list and the patches (with their JSON escaping) compete for the executor's bound.
    const files = Array.from({ length: 30 }, (_, i) => file(`docs/part${i}.md`, added(Array.from({ length: 300 }, (_x, n) => `"quoted" line ${n} of part ${i}\t`))));
    const text = largeReporterInstruction({ pr: { mode: "report", owner: "o", repo: "r", number: 1, head: "h".repeat(40) }, snapshot: { pull: { title: "t", body: "b".repeat(30_000) } as never, files, commits: [] }, partition: partition(files), sections, facts: [], kind: "first", feedback: [] });
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThan(MAX_EXECUTOR_INPUT_BYTES);
    expect(text).toContain("Interface patches left out because the total was over the cap");
  });
});

describe("the names of the new exported symbols", () => {
  it("lists Go funcs, methods and types that start with an upper-case letter, names only", () => {
    const f = file("pkg/x/x.go", added(["package x", "func Exported(a int) int {", "func unexported() {}", "func (r *Repo) Load() {}", "type Config struct {", "type hidden struct{}", "func Generic[T any](x T) T {"]));
    expect(newExportedSymbols(f)).toEqual(["Exported", "Load", "Config", "Generic"]);
  });

  it("lists TypeScript exports, and skips a name that was already declared on a removed line", () => {
    const f = file("src/a.ts", "@@ -1,2 +1,4 @@\n-export function kept() {}\n+export function kept(x: number) {}\n+export class Fresh {}\n+export const LIMIT = 3;\n+function local() {}");
    expect(newExportedSymbols(f)).toEqual(["Fresh", "LIMIT"]);
  });

  it("lists none for a test file or a deleted file", () => {
    expect(newExportedSymbols(file("pkg/x/x_test.go", added(["func TestX(t *testing.T) {}"])))).toEqual([]);
    expect(newExportedSymbols(file("src/a.test.ts", added(["export const x = 1;"])))).toEqual([]);
    expect(newExportedSymbols(file("pkg/x/gone.go", "@@ -1 +0,0 @@\n-func Gone() {}", { status: "removed" }))).toEqual([]);
  });

  it("are listed per area in the digest, and counted past the limit", () => {
    const funcs = Array.from({ length: 45 }, (_, i) => `func Name${i}() {}`);
    const files = [file("pkg/many/many.go", added(["package many", ...funcs]))];
    const d = buildDigest(files, partition(files), sections);
    expect(d.areas[0]!.symbols).toHaveLength(40);
    expect(d.areas[0]!.moreSymbols).toBe(5);
    expect(d.areas[0]).toMatchObject({ files: 1, additions: 1, deletions: 0 });
  });
});
