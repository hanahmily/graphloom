// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindingHarness, type SupervisorBinding } from "./harness.js";
import { createPiHarness } from "./pi-harness.js";
import { reconcileSupervisorBinding, restorePiSupervisorFromBinding } from "./restore.js";

const temps: string[] = [];
const saved: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-harness-"));
  temps.push(dir);
  return dir;
}

const MINIMAX = { provider: "minimax-cn", modelId: "MiniMax-M3" };

describe("the Pi harness", () => {
  it("probes for a credential reference and a registered model without a provider call", async () => {
    const dir = await tempDir();
    setEnv("MINIMAX_CN_API_KEY", undefined);
    setEnv("MINIMAX_API_KEY", undefined);
    const harness = createPiHarness({ runId: "run-1", sessionDir: path.join(dir, "supervisor"), agentDir: path.join(dir, "agent"), configuredModels: [MINIMAX] });
    expect(harness.name).toBe("pi");
    expect(harness.capabilities.toolCalling).toBe(true);
    const missing = await harness.probe();
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toMatch(/credential unavailable for provider minimax-cn: set MINIMAX_CN_API_KEY or MINIMAX_API_KEY/);
    setEnv("MINIMAX_CN_API_KEY", "test-key-not-used");
    expect(await harness.probe()).toEqual({ ok: true });
    const unknown = createPiHarness({
      runId: "run-1",
      sessionDir: path.join(dir, "supervisor"),
      agentDir: path.join(dir, "agent"),
      configuredModels: [{ provider: "minimax-cn", modelId: "no-such-model" }],
    });
    expect(await unknown.probe()).toEqual({ ok: false, reason: "Pi model not found: minimax-cn/no-such-model" });
  });

  it("starts and restores real Pi sessions whose binding names the pi harness", async () => {
    const dir = await tempDir();
    setEnv("MINIMAX_CN_API_KEY", "test-key-not-used");
    const harness = createPiHarness({ runId: "run-1", sessionDir: path.join(dir, "supervisor"), agentDir: path.join(dir, "agent"), configuredModels: [MINIMAX] });
    const fresh = await harness.start();
    try {
      expect(fresh.binding).toMatchObject({ ...MINIMAX, harness: "pi" });
    } finally {
      await fresh.close();
    }
    // A binding recorded before harnesses (no `harness`) restores as Pi.
    const legacy: SupervisorBinding = { sessionId: "logical-1", sessionFile: path.join(dir, "supervisor", "old.jsonl"), ...MINIMAX, switchJournal: [] };
    expect(bindingHarness(legacy)).toBe("pi");
    const restored = await restorePiSupervisorFromBinding({ runId: "run-1", binding: legacy, agentDir: path.join(dir, "agent") });
    try {
      expect(restored.sessionId).toBe("logical-1");
      expect(restored.binding).toMatchObject({ sessionId: "logical-1", harness: "pi", ...MINIMAX });
    } finally {
      await restored.close();
    }
  });

  it("refuses to restore a binding pinned to another harness", async () => {
    await expect(
      restorePiSupervisorFromBinding({
        runId: "run-1",
        binding: { sessionId: "s", sessionFile: "/x/y.jsonl", provider: "claude-code", modelId: "opus", switchJournal: [], harness: "claude-code" },
      }),
    ).rejects.toThrow(/pinned to the claude-code harness, not pi/);
    let opened = 0;
    const harness = createPiHarness({
      runId: "run-1",
      sessionDir: "/nonexistent",
      sessionOpener: async () => {
        opened += 1;
        throw new Error("no session should open");
      },
    });
    await expect(
      harness.restore({ sessionId: "s", sessionFile: "/x/y.jsonl", provider: "codex", modelId: "gpt-5-codex", switchJournal: [], harness: "codex" }),
    ).rejects.toThrow(/pinned to the codex harness, not pi/);
    expect(opened).toBe(0);
  });

  it("settles an interrupted switch of a non-Pi binding as failed, without reading a Pi session file", async () => {
    const binding: SupervisorBinding = {
      sessionId: "s",
      sessionFile: "/nonexistent/copy.jsonl",
      provider: "fake-cli",
      modelId: "a",
      harness: "fake-cli",
      switchJournal: [{ at: "t", from: { provider: "fake-cli", modelId: "a" }, to: { provider: "fake-cli", modelId: "b" }, reason: "r", status: "intent" }],
    };
    const settled = await reconcileSupervisorBinding(binding);
    expect(settled.modelId).toBe("a");
    expect(settled.switchJournal[0]!.status).toBe("failed");
  });
});
