// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSupervisorSession } from "./pi-session.js";

const live = process.env.GRAPHLOOM_LIVE_MINIMAX === "1";
const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("createPiSupervisorSession (live MiniMax)", () => {
  it.skipIf(!live)("prompts MiniMax-M3 and restores a durable session file", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "gl-live-"));
    temps.push(sessionDir);

    const first = await createPiSupervisorSession({
      runId: "live-minimax-1",
      sessionDir,
      systemPrompt: "Reply with exactly PI_MINIMAX_OK and nothing else.",
      promptTimeoutMs: 60_000,
    });

    let sessionFile: string;
    try {
      const reply = await first.prompt("Reply with exactly PI_MINIMAX_OK");
      expect(reply).toContain("PI_MINIMAX_OK");
      expect(first.provider).toBe("minimax-cn");
      expect(first.modelId).toBe("MiniMax-M3");
      expect(first.sessionId.length).toBeGreaterThan(0);
      expect(first.sessionFile).toBeTruthy();
      expect(["options", "env:MINIMAX_CN_API_KEY", "env:MINIMAX_API_KEY", "pi-stored"]).toContain(
        first.credentialSource,
      );
      sessionFile = first.sessionFile!;
    } finally {
      await first.close();
    }

    const restored = await createPiSupervisorSession({
      runId: "live-minimax-1",
      sessionDir,
      sessionFile,
      systemPrompt: "You are restoring a prior supervisor session.",
      promptTimeoutMs: 60_000,
    });
    try {
      expect(restored.sessionFile).toBe(sessionFile);
      expect(restored.sessionId.length).toBeGreaterThan(0);
    } finally {
      await restored.close();
    }
  }, 120_000);
});
