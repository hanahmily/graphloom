// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { compactBeforePrompt } from "./pi-session.js";

function fake(tokens: number | null | undefined, contextWindow = 1000): { session: AgentSession; compacted: () => number } {
  let n = 0;
  const session = {
    getContextUsage: () => (tokens === undefined ? undefined : { tokens, contextWindow, percent: null }),
    compact: async () => {
      n += 1;
    },
  } as unknown as AgentSession;
  return { session, compacted: () => n };
}

describe("compactBeforePrompt", () => {
  it("compacts when the known context plus the prompt crosses the fraction of the window", async () => {
    const f = fake(600);
    await compactBeforePrompt(f.session, "x".repeat(300)); // 600 + 100 = 700 -> not over 0.7*1000
    expect(f.compacted()).toBe(0);
    await compactBeforePrompt(f.session, "x".repeat(330)); // 600 + 110 > 700
    expect(f.compacted()).toBe(1);
  });

  it("leaves a session alone when usage is unknown", async () => {
    for (const tokens of [undefined, null]) {
      const f = fake(tokens);
      await compactBeforePrompt(f.session, "x".repeat(100_000));
      expect(f.compacted()).toBe(0);
    }
  });
});
