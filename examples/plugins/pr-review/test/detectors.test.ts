// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { detectFacts } from "../src/detectors.js";
import { addedRanges, lineText, parsePatch, sideLines } from "../src/patch.js";
import { pullFile, type PullFile } from "../src/snapshot.js";

const file = (path: string, status: string, patch: string | null, extra: Record<string, unknown> = {}): PullFile =>
  pullFile({ path, status, patch, previousPath: null, additions: 0, deletions: 0, patchOmitted: patch === null, ...extra })!;

const noProfile = { sections: [] };
const facts = (files: PullFile[], profile: Parameters<typeof detectFacts>[1] = noProfile) => detectFacts(files, profile).map(({ id: _id, ...f }) => f);

describe("parsePatch", () => {
  const patch = "@@ -10,4 +10,5 @@ func x() {\n a\n-b\n+c\n+d\n e\n@@ -40,2 +41,2 @@\n \n-x\n+y\n\\ No newline at end of file";

  it("numbers added lines on the head side, removed lines on the base side, context on both", () => {
    const p = parsePatch(patch);
    expect(p.lines.map((l) => [l.kind, l.line, l.baseLine ?? null, l.text])).toEqual([
      ["ctx", 10, 10, "a"],
      ["del", 11, null, "b"],
      ["add", 11, null, "c"],
      ["add", 12, null, "d"],
      ["ctx", 13, 12, "e"],
      ["ctx", 41, 40, ""],
      ["del", 41, null, "x"],
      ["add", 42, null, "y"],
    ]);
    expect([p.added, p.removed]).toEqual([3, 2]);
  });

  it("knows which lines each side's hunks show, and reads one back", () => {
    const p = parsePatch(patch);
    expect([...sideLines(p, "head")].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 41, 42]);
    expect([...sideLines(p, "base")].sort((a, b) => a - b)).toEqual([10, 11, 12, 40, 41]);
    expect(lineText(p, "head", 12)).toBe("d");
    expect(lineText(p, "base", 11)).toBe("b");
    expect(lineText(p, "head", 99)).toBeUndefined();
  });

  it("merges consecutive added lines into ranges, and handles no patch", () => {
    expect(addedRanges(parsePatch(patch))).toEqual([{ start: 11, end: 12 }, { start: 42, end: 42 }]);
    expect(parsePatch(null).lines).toEqual([]);
    expect(parsePatch("").lines).toEqual([]);
  });
});

describe("detectors", () => {
  it("manifest: dependencies added, removed and re-versioned in go.mod", () => {
    const patch = "@@ -3,5 +3,5 @@\n require (\n-\tgithub.com/a/b v1.0.0\n+\tgithub.com/a/b v1.1.0\n-\tgithub.com/gone/x v0.2.0\n+\tgithub.com/new/y v0.1.0\n )";
    expect(facts([file("go.mod", "modified", patch)]).map((f) => [f.section, f.side, f.line, f.symbol, f.text])).toEqual([
      ["external", "head", 4, "github.com/a/b", "Dependency github.com/a/b changed from v1.0.0 to v1.1.0 in go.mod"],
      ["external", "head", 5, "github.com/new/y", "Dependency github.com/new/y v0.1.0 added in go.mod"],
      ["external", "base", 5, "github.com/gone/x", "Dependency github.com/gone/x v0.2.0 removed from go.mod"],
    ]);
  });

  it("manifest: a go.mod line that only moves is no change; module, go and replace lines are no dependency", () => {
    const patch = "@@ -1,4 +1,4 @@\n-go 1.24\n+go 1.25\n-replace github.com/a/b => ../b\n+replace github.com/a/b => ../c\n-\tgithub.com/a/b v1.0.0\n+\tgithub.com/a/b v1.0.0";
    expect(facts([file("go.mod", "modified", patch)])).toEqual([]);
  });

  it("manifest: package.json dependency maps, but not the package's own fields", () => {
    const patch = '@@ -1,6 +1,7 @@\n {\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n   "dependencies": {\n+    "left-pad": "^1.3.0",\n+    "@scope/pkg": "workspace:*"\n   }';
    expect(facts([file("ui/package.json", "modified", patch)]).map((f) => f.symbol)).toEqual(["left-pad", "@scope/pkg"]);
  });

  it("manifest: pom.xml, requirements.txt and Cargo.toml", () => {
    expect(facts([file("pom.xml", "modified", "@@ -1,1 +1,2 @@\n a\n+<artifactId>junit</artifactId>")]).map((f) => f.text)).toEqual(["Dependency junit added in pom.xml"]);
    expect(facts([file("py/requirements-dev.txt", "modified", "@@ -1,1 +1,3 @@\n a\n+requests==2.31.0\n+# comment")]).map((f) => f.symbol)).toEqual(["requests"]);
    expect(facts([file("Cargo.toml", "modified", '@@ -1,1 +1,3 @@\n a\n+serde = "1.0"\n+name = "x"')]).map((f) => f.symbol)).toEqual(["serde"]);
  });

  it("paths: schema and migration globs, for an added, changed and deleted file", () => {
    const fs = [file("api/x.proto", "added", "@@ -0,0 +1,2 @@\n+a\n+b"), file("db/migrations/001.go", "modified", "@@ -1 +1 @@\n-a\n+b"), file("q/old.sql", "removed", "@@ -1,2 +0,0 @@\n-a\n-b"), file("docs/a.md", "added", "@@ -0,0 +1 @@\n+x")];
    expect(facts(fs).filter((f) => f.section === "schema").map((f) => [f.path, f.side, f.line, f.text])).toEqual([
      ["api/x.proto", "head", 1, "schema or migration file api/x.proto added"],
      ["db/migrations/001.go", "head", 1, "schema or migration file db/migrations/001.go changed"],
      ["q/old.sql", "base", 1, "schema or migration file q/old.sql deleted"],
    ]);
  });

  it("added-line: environment variables, flags, cron expressions and routes, each with its symbol", () => {
    const patch = [
      "@@ -1,1 +1,8 @@",
      " keep",
      '+\tv := os.Getenv("BYDB_X")',
      '+\tflag.Int("port", 1, "")',
      '+\tcmd.Flags().String("name", "", "")',
      '+\tsched.Add("*/5 * * * *", job)',
      '+\tmux.HandleFunc("/v1/groups", h)',
      "+\tconst e = process.env.TOKEN_X",
      '+\tapp.get("/health", h)',
    ].join("\n");
    const got = facts([file("a.go", "modified", patch)]).map((f) => [f.section, f.symbol]);
    expect(got).toEqual(expect.arrayContaining([["config", "BYDB_X"], ["config", "port"], ["config", "name"], ["background", "*/5 * * * *"], ["interfaces", "/v1/groups"], ["config", "TOKEN_X"], ["interfaces", "/health"]]));
  });

  it("added-line: an unchanged (context or removed) line matches nothing", () => {
    expect(facts([file("a.go", "modified", '@@ -1,2 +1,1 @@\n-\tv := os.Getenv("OLD")\n \tx := os.Getenv("KEPT")')])).toEqual([]);
  });

  it("removed: a deleted file, and a removed exported declaration unless it comes back", () => {
    const deleted = facts([file("pkg/old.go", "removed", "@@ -1,2 +0,0 @@\n-package old\n-func Old() {}")]);
    expect(deleted).toEqual([{ section: "removed", path: "pkg/old.go", side: "base", line: 1, text: "File pkg/old.go deleted" }]);
    const patch = "@@ -1,6 +1,4 @@\n-func Gone() {}\n-func (r *T) Moved(a int) {}\n-type Widget struct{}\n-func private() {}\n+func Moved2() {}\n+func (r *T) Moved(a int, b int) {}";
    expect(facts([file("pkg/a.go", "modified", patch)]).map((f) => f.symbol)).toEqual(["Gone", "Widget"]);
    const ts = facts([file("src/a.ts", "modified", "@@ -1,2 +1,0 @@\n-export function gone() {}\n-export const KEPT = 1\n+export const KEPT = 2")]);
    expect(ts.map((f) => f.symbol)).toEqual(["gone"]);
  });

  it("deprecated: markers added, not removed", () => {
    const patch = "@@ -1,1 +1,4 @@\n a\n+// Deprecated: use B.\n+/** @deprecated */\n+deprecated = true";
    expect(facts([file("a.go", "modified", patch)]).filter((f) => f.text.startsWith("Deprecation")).map((f) => f.line)).toEqual([2, 3, 4]);
    expect(facts([file("a.go", "modified", "@@ -1,2 +1,1 @@\n-// Deprecated: gone\n a")])).toEqual([]);
  });

  it("a file with no patch text still counts as a schema path, at line 0", () => {
    expect(facts([file("api/big.proto", "modified", null)])).toEqual([{ section: "schema", path: "api/big.proto", side: "head", line: 0, text: "schema or migration file api/big.proto changed" }]);
  });

  it("profile detectors and routing add facts to their sections; ids are stable", () => {
    const profile = {
      sections: [
        { id: "interfaces", routing: ["api/**"], detectors: [{ kind: "added-line" as const, pattern: String.raw`RegisterService\((\w+)`, label: "gRPC service" }] },
        { id: "other", detectors: [{ kind: "paths" as const, globs: ["*.md"], label: "doc" }] },
      ],
    };
    const fs = [file("api/rpc.go", "modified", "@@ -1,1 +1,2 @@\n a\n+\tRegisterService(Foo{})"), file("README.md", "modified", "@@ -1 +1 @@\n-a\n+b")];
    const a = detectFacts(fs, profile);
    expect(a.map((f) => [f.id, f.section, f.text])).toEqual([
      ["D1", "interfaces", "gRPC service Foo at api/rpc.go:2"],
      ["D2", "interfaces", "File routed to this section: api/rpc.go changed"],
      ["D3", "other", "doc README.md changed"],
    ]);
    expect(detectFacts(fs, profile)).toEqual(a);
  });
});
