// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunView } from "@graphloom/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { restorePiSupervisorFromBinding } from "./restore.js";

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

const view: RunView = {
  runId: "run-1",
  task: { request: "hi", repo: "." },
  current: { stageId: "write", attempt: 1 },
  receipts: [],
  evidence: [],
  outstanding: [],
  budgets: { agentInvocations: 8, jobs: 8, decisions: 8, corrections: 2 },
  validatorBindings: [],
  generation: 1,
  stateRevision: 1,
  activeVersion: "hello@1",
};

describe("restorePiSupervisorFromBinding", () => {
  it("opens later episodes on a non-MiniMax model after a switch, without forwarding the MiniMax apiKey", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-restore-"));
    temps.push(dir);
    setEnv("MINIMAX_CN_API_KEY", undefined);
    setEnv("MINIMAX_API_KEY", undefined);
    // The other provider's own credential, as Pi would resolve it.
    setEnv("DEEPSEEK_API_KEY", "test-deepseek-key-not-used");
    const MINIMAX = { provider: "minimax-cn", modelId: "MiniMax-M3" };
    const DEEPSEEK = { provider: "deepseek", modelId: "deepseek-flash" };
    const supervisor = await restorePiSupervisorFromBinding({
      runId: "run-1",
      binding: { sessionId: "logical-1", sessionFile: undefined, ...MINIMAX, switchJournal: [] },
      sessionDir: path.join(dir, "supervisor"),
      agentDir: path.join(dir, "agent"),
      apiKey: "test-minimax-key-not-used",
      configuredModels: [MINIMAX, DEEPSEEK],
    });
    try {
      const aborted = AbortSignal.abort();
      const input = (episodeId: string) => ({
        runId: "run-1",
        episodeId,
        trigger: { code: "supervise" as const, message: "help" },
        view,
        signal: aborted,
      });
      // The run's Stop is already set, so no provider request goes out; the episode's session still opens.
      await expect(supervisor.decide(input("ep-1"))).rejects.toThrow(/aborted/);
      const firstFile = supervisor.binding.sessionFile;
      await supervisor.switchModel({ ...DEEPSEEK, reason: "operator" });
      expect(supervisor.binding).toMatchObject(DEEPSEEK);

      await expect(supervisor.decide(input("ep-2"))).rejects.toThrow(/aborted/);
      expect(supervisor.binding.sessionFile).not.toBe(firstFile);
      expect(supervisor.binding).toMatchObject({ ...DEEPSEEK, sessionId: "logical-1" });
    } finally {
      await supervisor.close?.();
    }
  });
});
