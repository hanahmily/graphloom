// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkoutWriteDigest,
  checkoutWritePathProblem,
  checkoutWriteProblem,
  MAX_CHECKOUT_WRITE_BYTES,
  MAX_CHECKOUT_WRITE_FILES,
  type CheckoutSpec,
} from "./index.js";

describe("CheckoutSpec.write", () => {
  it("accepts relative files on either checkout, and an empty list", () => {
    const candidate: CheckoutSpec = { from: "candidate", write: [{ path: "pkg/calc/calc_proof_test.go", content: "package calc\n" }] };
    const base: CheckoutSpec = { from: "base", paths: [], write: [{ path: "x_test.go", content: "" }] };
    expect(checkoutWriteProblem(candidate.write)).toBeUndefined();
    expect(checkoutWriteProblem(base.write)).toBeUndefined();
    expect(checkoutWriteProblem([])).toBeUndefined();
    expect(checkoutWriteProblem([{ path: "Makefile.extra", content: "x" }, { path: "a b/c+d@1.txt", content: "y" }])).toBeUndefined();
  });

  it("refuses a path that is absolute, has an empty, . or .. segment, or enters .git", () => {
    expect(checkoutWritePathProblem("/etc/passwd")).toMatch(/relative/);
    expect(checkoutWritePathProblem("")).toMatch(/empty/);
    expect(checkoutWritePathProblem("a//b.go")).toMatch(/empty segment/);
    expect(checkoutWritePathProblem("a/b/")).toMatch(/empty segment/);
    expect(checkoutWritePathProblem("./a.go")).toMatch(/\. or \.\. segment/);
    expect(checkoutWritePathProblem("a/../../b.go")).toMatch(/\. or \.\. segment/);
    expect(checkoutWritePathProblem(".git/hooks/pre-commit")).toMatch(/outside \.git/);
    expect(checkoutWritePathProblem("sub/.GIT/config")).toMatch(/outside \.git/);
    expect(checkoutWritePathProblem("a\\b.go")).toMatch(/backslash/);
    expect(checkoutWritePathProblem("a\nb.go")).toMatch(/control character/);
    expect(checkoutWritePathProblem(".gitignore")).toBeUndefined();
    expect(checkoutWritePathProblem("pkg/.github/x.yml")).toBeUndefined();
  });

  it("names the entry and the rule it breaks", () => {
    expect(checkoutWriteProblem([{ path: "ok.go", content: "" }, { path: "../x.go", content: "" }])).toBe(
      'checkout.write[1] "../x.go": the path must not have a . or .. segment',
    );
  });

  it("refuses a malformed list or entry", () => {
    expect(checkoutWriteProblem({ path: "a", content: "" })).toMatch(/must be an array/);
    expect(checkoutWriteProblem(["a.go"])).toMatch(/\[0\] must be an object/);
    expect(checkoutWriteProblem([{ path: 1, content: "" }])).toMatch(/\.path must be a string/);
    expect(checkoutWriteProblem([{ path: "a.go", bytes: "x" }])).toMatch(/unknown fields: bytes/);
    expect(checkoutWriteProblem([{ path: "a.go" }])).toMatch(/\.content must be a string/);
  });

  it("refuses too many files, a file too large in UTF-8 bytes, a path listed twice and a path that is another's directory", () => {
    const many = Array.from({ length: MAX_CHECKOUT_WRITE_FILES + 1 }, (_, i) => ({ path: `t${i}.go`, content: "" }));
    expect(checkoutWriteProblem(many)).toMatch(`adds ${MAX_CHECKOUT_WRITE_FILES + 1} files, more than ${MAX_CHECKOUT_WRITE_FILES}`);
    expect(checkoutWriteProblem(many.slice(1))).toBeUndefined();
    expect(checkoutWriteProblem([{ path: "big.txt", content: "x".repeat(MAX_CHECKOUT_WRITE_BYTES) }])).toBeUndefined();
    // Two bytes each in UTF-8: the bound is on bytes, not characters.
    expect(checkoutWriteProblem([{ path: "big.txt", content: "é".repeat(MAX_CHECKOUT_WRITE_BYTES / 2 + 1) }])).toMatch(/more than 65536/);
    expect(checkoutWriteProblem([{ path: "a.go", content: "1" }, { path: "a.go", content: "2" }])).toMatch(/listed twice/);
    expect(checkoutWriteProblem([{ path: "a/b.go", content: "" }, { path: "a", content: "" }])).toMatch(/"a": the path is a directory of "a\/b.go"/);
  });

  it("digests the content's UTF-8 bytes as sha256:<hex>", () => {
    const content = "package calc\n// é\n";
    expect(checkoutWriteDigest(content)).toBe(`sha256:${createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")}`);
    expect(checkoutWriteDigest("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
