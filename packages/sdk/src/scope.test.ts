// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { writeScopeAllows, writeScopeExcludes, writeScopeIncludes, writeScopeProblem } from "./scope.js";

describe("write scope", () => {
  it("allows listed paths and everything below them", () => {
    expect(writeScopeAllows("src/a.ts", ["src/"])).toBe(true);
    expect(writeScopeAllows("src", ["src"])).toBe(true);
    expect(writeScopeAllows("srcx/a.ts", ["src"])).toBe(false);
    expect(writeScopeAllows("README.md", [])).toBe(false);
  });

  it("lets an exclusion win over any entry that allows the path", () => {
    const scope = [".", "!api/proto", "!go.mod"];
    expect(writeScopeAllows("pkg/timestamp/scheduler.go", scope)).toBe(true);
    expect(writeScopeAllows("api/proto/banyandb/v1/x.proto", scope)).toBe(false);
    expect(writeScopeAllows("api/protocol.go", scope)).toBe(true);
    expect(writeScopeAllows("go.mod", scope)).toBe(false);
    expect(writeScopeAllows("go.sum", scope)).toBe(true);
    expect(writeScopeAllows("pkg/a.go", ["!pkg/a.go", "pkg"])).toBe(false);
  });

  it("lets a + exception re-allow a path below an excluded directory, and only below it", () => {
    const scope = [".", "!generated", "+generated/licenses"];
    expect(writeScopeAllows("generated/licenses/foo.txt", scope)).toBe(true);
    expect(writeScopeAllows("generated/licenses", scope)).toBe(true);
    expect(writeScopeAllows("generated/other.txt", scope)).toBe(false);
    expect(writeScopeAllows("generated", scope)).toBe(false);
    // An exclusion deeper than the exception still wins.
    expect(writeScopeAllows("generated/licenses/secret/x", [...scope, "!generated/licenses/secret"])).toBe(false);
    expect(writeScopeIncludes(scope)).toEqual([".", "generated/licenses"]);
    expect(writeScopeProblem(["+"])).toMatch(/names no path/);
  });

  it("matches entries written with dot segments or repeated slashes", () => {
    expect(writeScopeAllows("go.mod", [".", "!./go.mod"])).toBe(false);
    expect(writeScopeAllows("api/proto/x.proto", [".", "!api//proto/"])).toBe(false);
    expect(writeScopeAllows("pkg/a.go", ["./pkg/./"])).toBe(true);
    expect(writeScopeAllows("pkg/a.go", ["./"])).toBe(true);
    expect(writeScopeProblem(["!./"])).toBe("write scope cannot exclude the whole workspace");
    expect(writeScopeProblem(["pkg/../.."])).toMatch(/inside the workspace/);
  });

  it("splits includes and excludes", () => {
    expect(writeScopeIncludes([".", "!go.mod", "src/"])).toEqual([".", "src"]);
    expect(writeScopeExcludes([".", "!go.mod", "!api/proto/"])).toEqual(["go.mod", "api/proto"]);
  });

  it("rejects scopes that allow nothing or leave the workspace", () => {
    expect(writeScopeProblem([".", "!go.mod"])).toBeUndefined();
    expect(writeScopeProblem(["!go.mod"])).toBe("write scope allows no paths");
    expect(writeScopeProblem(["!"])).toMatch(/names no path/);
    expect(writeScopeProblem(["../x"])).toMatch(/inside the workspace/);
    expect(writeScopeProblem(["/etc"])).toMatch(/inside the workspace/);
    expect(writeScopeProblem(["src", "!."])).toBe("write scope cannot exclude the whole workspace");
  });
});
