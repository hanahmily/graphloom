// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { LoopDefinitionError, parseLoopDefinition } from "./index.js";

const good = { name: "nightly", every: "15m", graph: "g", profile: "p", sink: "hub", limits: { maxLiveRuns: 2, maxStartsPerDay: 5 } };

describe("parseLoopDefinition", () => {
  it("applies defaults and converts every", () => {
    const d = parseLoopDefinition(good);
    expect(d.limits).toEqual({ maxStartsPerTick: 1, maxLiveRuns: 2, maxStartsPerDay: 5 });
    expect(d.everyMs).toBe(900_000);
    expect(d.version).toBeUndefined();
  });
  it.each([["60s", 60_000], ["2h", 7_200_000], ["1d", 86_400_000]])("every %s", (every, ms) => {
    expect(parseLoopDefinition({ ...good, every }).everyMs).toBe(ms);
  });
  it("accepts the bounds, below setTimeout's limit", () => {
    expect(parseLoopDefinition({ ...good, every: "1m" }).everyMs).toBe(60_000);
    const max = parseLoopDefinition({ ...good, every: "24d" }).everyMs;
    expect(max).toBeLessThan(2 ** 31 - 1);
  });
  it("keeps optional fields", () => {
    const d = parseLoopDefinition({ ...good, version: ">=0.17 <0.18", repo: "/r", limits: { maxStartsPerTick: 3, maxLiveRuns: 2, maxStartsPerDay: 5 } });
    expect(d).toMatchObject({ version: ">=0.17 <0.18", repo: "/r" });
    expect(d.limits.maxStartsPerTick).toBe(3);
  });
  const refusals: Array<[string, unknown, RegExp]> = [
    ["non-object", "x", /must be an object/],
    ["unknown property", { ...good, extra: 1 }, /unknown property "extra"/],
    ["missing name", { ...good, name: undefined }, /name must be/],
    ["name with colon", { ...good, name: "a:b" }, /name must be/],
    ["every without unit", { ...good, every: "15" }, /every must be/],
    ["every zero", { ...good, every: "0m" }, /every must be/],
    ["every 30s below the minimum", { ...good, every: "30s" }, /between 1m and 24d/],
    ["every 59s", { ...good, every: "59s" }, /between 1m and 24d/],
    ["every 25d above the timer limit", { ...good, every: "25d" }, /between 1m and 24d/],
    ["every 9999999d", { ...good, every: "9999999d" }, /between 1m and 24d/],
    ["every bad unit", { ...good, every: "5w" }, /every must be/],
    ["bad graph", { ...good, graph: "a b" }, /graph must be/],
    ["missing profile", { ...good, profile: "" }, /profile must be/],
    ["sink other", { ...good, sink: "cron" }, /sink must be "hub"/],
    ["limits missing", { ...good, limits: undefined }, /limits must be an object/],
    ["unknown limit", { ...good, limits: { ...good.limits, maxFoo: 1 } }, /unknown limits property/],
    ["limit zero", { ...good, limits: { ...good.limits, maxLiveRuns: 0 } }, /maxLiveRuns must be a positive integer/],
    ["limit fraction", { ...good, limits: { ...good.limits, maxStartsPerDay: 1.5 } }, /maxStartsPerDay must be/],
    ["missing maxLiveRuns", { ...good, limits: { maxStartsPerDay: 1 } }, /maxLiveRuns must be/],
    ["empty version", { ...good, version: "" }, /version must be/],
    ["empty repo", { ...good, repo: " " }, /repo must be/],
  ];
  it.each(refusals)("refuses %s", (_n, value, rule) => {
    expect(() => parseLoopDefinition(value)).toThrow(LoopDefinitionError);
    expect(() => parseLoopDefinition(value)).toThrow(rule);
  });
});
