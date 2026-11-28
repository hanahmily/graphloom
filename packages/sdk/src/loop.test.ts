// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { assertWireRequest, assertWireResponse, LoopReplyError, validateLoopManifest, validateLoopReply, WireValidationError } from "./index.js";

const limits = { maxReadsPerRound: 8, maxCandidates: 500 };
const cand = (key: string, extra: object = {}) => ({ key, taskArgs: [], ...extra });
const read = (id: string, extra: object = {}) => ({ id, executor: "x/list", input: {}, ...extra });

describe("validateLoopReply", () => {
  it("accepts each of the three reply shapes", () => {
    expect(validateLoopReply({ refused: "no" }, limits)).toEqual({ refused: "no" });
    expect(validateLoopReply({ reads: [read("a")] }, limits)).toEqual({ reads: [read("a")] });
    const c = { candidates: [cand("k:1#a/b@c.d_e-f", { observedState: "s", taskArgs: ["x"] }), cand("k2")] };
    expect(validateLoopReply(c, limits)).toEqual(c);
    expect(validateLoopReply({ candidates: [] }, limits)).toEqual({ candidates: [] });
  });

  const refusals: Array<[string, unknown, RegExp]> = [
    ["not an object", [], /must be an object/],
    ["null", null, /must be an object/],
    ["extra reply property", { candidates: [], more: 1 }, /unknown property "more"/],
    ["none of the three", {}, /must have one of/],
    ["refused and candidates", { refused: "a", candidates: [] }, /exactly one of/],
    ["reads and candidates", { reads: [], candidates: [] }, /exactly one of/],
    ["empty refused", { refused: "" }, /refused must be a non-empty string/],
    ["extra candidate property", { candidates: [cand("a", { extra: 1 })] }, /unknown property "extra"/],
    ["extra read property", { reads: [read("a", { extra: 1 })] }, /unknown property "extra"/],
    ["key with a space", { candidates: [cand("a b")] }, /key must be 1 to 200/],
    ["empty key", { candidates: [cand("")] }, /key must be 1 to 200/],
    ["key too long", { candidates: [cand("a".repeat(201))] }, /key must be 1 to 200/],
    ["non-string key", { candidates: [{ key: 3, taskArgs: [] }] }, /key must be 1 to 200/],
    ["duplicate keys", { candidates: [cand("a"), cand("a")] }, /duplicate candidate key/],
    ["duplicate read ids", { reads: [read("a"), read("a")] }, /duplicate read id/],
    ["17 task args", { candidates: [cand("a", { taskArgs: Array(17).fill("x") })] }, /more than 16/],
    ["long task arg", { candidates: [cand("a", { taskArgs: ["x".repeat(513)] })] }, /longer than 512/],
    ["non-string task arg", { candidates: [cand("a", { taskArgs: [1] })] }, /array of strings/],
    ["missing task args", { candidates: [{ key: "a" }] }, /array of strings/],
    ["bad observedState", { candidates: [cand("a", { observedState: 1 })] }, /observedState/],
    ["9 reads", { reads: Array.from({ length: 9 }, (_, i) => read(`r${i}`)) }, /more than 8/],
    ["501 candidates", { candidates: Array.from({ length: 501 }, (_, i) => cand(`k${i}`)) }, /more than 500/],
    ["read without executor", { reads: [{ id: "a", input: {} }] }, /executor/],
    ["read input not an object", { reads: [read("a", { input: [] })] }, /input must be an object/],
    ["reads not an array", { reads: {} }, /reads must be an array/],
    ["NUL in refused", { refused: "a\0b" }, /refused must not contain a NUL/],
    ["newline in refused", { refused: "a\nb" }, /refused must be a single line/],
    ["carriage return in refused", { refused: "a\rb" }, /single line/],
    ["NUL in read id", { reads: [read("a\0")] }, /id must not contain a NUL/],
    ["NUL in executor", { reads: [read("a", { executor: "x\0y" })] }, /executor must not contain a NUL/],
  ];
  it.each(refusals)("refuses %s", (_name, reply, rule) => {
    expect(() => validateLoopReply(reply, limits)).toThrow(LoopReplyError);
    expect(() => validateLoopReply(reply, limits)).toThrow(rule);
  });

  it("accepts a 200-character key and a 200-character read id", () => {
    const key = "k".repeat(200);
    expect(validateLoopReply({ candidates: [cand(key)] }, limits)).toEqual({ candidates: [cand(key)] });
    expect(() => validateLoopReply({ reads: [read("r".repeat(200))] }, limits)).not.toThrow();
  });

  it("allows exactly the limits", () => {
    expect(() => validateLoopReply({ reads: Array.from({ length: 8 }, (_, i) => read(`r${i}`)) }, limits)).not.toThrow();
    expect(() => validateLoopReply({ candidates: Array.from({ length: 500 }, (_, i) => cand(`k${i}`, { taskArgs: Array(16).fill("x".repeat(512)) })) }, limits)).not.toThrow();
  });
});

describe("validateLoopManifest", () => {
  it("accepts a protocol and a list of reads, none or up to 16", () => {
    expect(validateLoopManifest({ protocol: 1, reads: [] })).toEqual({ protocol: 1, reads: [] });
    expect(validateLoopManifest({ protocol: 1, reads: ["a/list", "b/get"] })).toEqual({ protocol: 1, reads: ["a/list", "b/get"] });
    expect(() => validateLoopManifest({ protocol: 1, reads: Array.from({ length: 16 }, (_, i) => `x/${i}`) })).not.toThrow();
    expect(() => validateLoopManifest({ protocol: 1, reads: ["x".repeat(200)] })).not.toThrow();
  });

  it("leaves an unsupported protocol level to the caller", () => {
    expect(validateLoopManifest({ protocol: 2, reads: [] }).protocol).toBe(2);
  });

  const refusals: Array<[string, unknown, RegExp]> = [
    ["not an object", [], /must be an object/],
    ["null", null, /must be an object/],
    ["an unknown property", { protocol: 1, reads: [], extra: 1 }, /unknown property "extra"/],
    ["no protocol", { reads: [] }, /protocol must be a positive integer/],
    ["a string protocol", { protocol: "1", reads: [] }, /protocol must be/],
    ["a fractional protocol", { protocol: 1.5, reads: [] }, /protocol must be/],
    ["no reads", { protocol: 1 }, /reads must be an array/],
    ["too many reads", { protocol: 1, reads: Array.from({ length: 17 }, (_, i) => `x/${i}`) }, /more than 16/],
    ["a duplicate", { protocol: 1, reads: ["a", "a"] }, /twice/],
    ["an empty id", { protocol: 1, reads: [""] }, /reads\[0\]/],
    ["a long id", { protocol: 1, reads: ["x".repeat(201)] }, /1 to 200/],
    ["whitespace", { protocol: 1, reads: ["a b"] }, /no whitespace/],
    ["a newline", { protocol: 1, reads: ["a\nb"] }, /no whitespace/],
    ["a non-string", { protocol: 1, reads: [3] }, /reads\[0\]/],
  ];
  it.each(refusals)("refuses %s", (_name, value, message) => {
    expect(() => validateLoopManifest(value)).toThrow(LoopReplyError);
    expect(() => validateLoopManifest(value)).toThrow(message);
  });
});

describe("the loop_candidates wire messages", () => {
  const envelope = { protocolVersion: 1, runId: "r", operationId: "o", generation: 1, expectedStateRevision: 0, activeVersion: "v" };
  const input = { protocol: 1, profile: {}, now: "2026-01-01T00:00:00.000Z", round: 0, results: [] };

  it("accepts a request and a response, with or without a reply", () => {
    expect(() => assertWireRequest({ ...envelope, kind: "loop_candidates", input })).not.toThrow();
    expect(() => assertWireResponse({ ...envelope, kind: "loop_candidates_ok" })).not.toThrow();
    expect(() => assertWireResponse({ ...envelope, kind: "loop_candidates_ok", reply: { candidates: [] } })).not.toThrow();
  });

  it("refuses a request without results", () => {
    expect(() => assertWireRequest({ ...envelope, kind: "loop_candidates", input: { protocol: 1 } })).toThrow(WireValidationError);
  });
});
