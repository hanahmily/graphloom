// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { compareGoVersions, parseGoVersion, toolchainMismatch, toolchainSentence } from "../src/toolchain.js";

const ERROR = "go: go.mod requires go >= 1.26.11 (running go 1.26.10; GOTOOLCHAIN=local)";

describe("the sandbox's Go against go.mod's", () => {
  it("compares versions as Go does", () => {
    expect(compareGoVersions("1.26.10", "1.26.11")).toBeLessThan(0);
    expect(compareGoVersions("1.26.9", "1.26.10")).toBeLessThan(0);
    expect(compareGoVersions("1.27", "1.26.11")).toBeGreaterThan(0);
    expect(compareGoVersions("1.26", "1.26.0")).toBe(0);
    expect(compareGoVersions("go1.26.11", "1.26.11")).toBe(0);
    expect(compareGoVersions("1.26rc1", "1.26")).toBeLessThan(0);
    expect(compareGoVersions("1.26rc1", "1.25.9")).toBeGreaterThan(0);
    expect(compareGoVersions("1.27beta2", "1.27rc1")).toBeLessThan(0);
    expect(compareGoVersions("1.27rc2", "1.27rc1")).toBeGreaterThan(0);
    expect(compareGoVersions("1.27beta1", "1.27beta2")).toBeLessThan(0);
    expect(compareGoVersions("1.27rc1", "1.27")).toBeLessThan(0);
    expect(toolchainMismatch("go: go.mod requires go >= 1.27rc1 (running go 1.27beta2; GOTOOLCHAIN=local)")).toEqual({ required: "1.27rc1", running: "1.27beta2" });
    expect(compareGoVersions("latest", "1.26")).toBeUndefined();
    expect(parseGoVersion("go1.26.11")?.parts).toEqual([1, 26, 11]);
  });

  it("reads the mismatch from Go's own error text, with or without the go: prefix and a dependency's name", () => {
    expect(toolchainMismatch(ERROR)).toEqual({ required: "1.26.11", running: "1.26.10" });
    expect(toolchainMismatch("go.mod requires go >= 1.26.11 (running go 1.26.10; GOTOOLCHAIN=local)")).toMatchObject({ required: "1.26.11" });
    expect(toolchainMismatch("go: golang.org/x/sys@v0.40.0 requires go >= 1.25 (running go 1.24.2; GOTOOLCHAIN=local)")).toEqual({ required: "1.25", running: "1.24.2" });
    expect(toolchainMismatch("go: go.mod requires go >= go1.26.11 (running go go1.26.10; GOTOOLCHAIN=local)")).toEqual({ required: "1.26.11", running: "1.26.10" });
  });

  it("is not a mismatch for other errors, or when the running Go is not older", () => {
    expect(toolchainMismatch("pkg/a/a.go:12:5: undefined: foo")).toBeUndefined();
    expect(toolchainMismatch("go: go.mod requires go >= 1.26.10 (running go 1.26.10; GOTOOLCHAIN=local)")).toBeUndefined();
    expect(toolchainMismatch("go: go.mod requires go >= 1.25 (running go 1.26.10; GOTOOLCHAIN=local)")).toBeUndefined();
  });

  it("says plainly which profile field to change", () => {
    expect(toolchainSentence({ required: "1.26.11", running: "1.26.10" })).toBe("the sandbox's Go 1.26.10 is older than go.mod's 1.26.11; update metrics.sandbox.go.image");
  });
});
