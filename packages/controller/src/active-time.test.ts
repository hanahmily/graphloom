// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { startActiveClock } from "./active-time.js";
import type { DurableRunState } from "./state.js";

afterEach(() => vi.restoreAllMocks());

describe("active clock pause", () => {
  it("stops counting down while paused and resumes afterwards", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const clock = await startActiveClock({ budgets: { activeMs: 10_000 } } as DurableRunState);
    now += 2_000;
    expect(clock.remaining()).toBe(8_000);
    const resume = clock.pause();
    now += 5_000;
    expect(clock.remaining()).toBe(8_000);
    resume();
    resume();
    now += 1_000;
    expect(clock.remaining()).toBe(7_000);
  });
});
