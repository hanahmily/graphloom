// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { boundValue } from "./episode.js";

describe("boundValue", () => {
  it("keeps a wide shallow object within the limit (2,000 numeric fields against 8,000 characters)", () => {
    const wide = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`field${i}`, i]));
    const { value, truncated } = boundValue({ payload: wide }, 8_000);
    expect(truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(8_000);
  });

  it("keeps the limit even when the preview needs heavy JSON escaping", () => {
    const quotes = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`k${i}`, '"\\\n"'.repeat(4)]));
    const { value } = boundValue(quotes, 2_000);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(2_000);
  });

  it("returns a value that already fits unchanged", () => {
    expect(boundValue({ a: 1 }, 100)).toEqual({ value: { a: 1 }, truncated: false });
  });
});
