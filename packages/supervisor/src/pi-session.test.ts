// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSupervisorSession } from "./pi-session.js";

const temps: string[] = [];
const saved: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("createPiSupervisorSession credentials", () => {
  it("applies an explicit apiKey to the session's own provider, whichever it is", async () => {
    setEnv("OPENAI_API_KEY", undefined);
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "gl-sup-"));
    temps.push(sessionDir);
    const session = await createPiSupervisorSession({
      runId: "cred-1",
      sessionDir,
      agentDir: path.join(sessionDir, "agent"),
      provider: "openai",
      modelId: "gpt-4o",
      apiKey: "sk-fake-explicit",
    });
    try {
      expect(session).toMatchObject({ provider: "openai", modelId: "gpt-4o", credentialSource: "options" });
    } finally {
      await session.close();
    }
  });

  it("switches to another provider on that provider's own key, never the explicit one", async () => {
    setEnv("DEEPSEEK_API_KEY", undefined);
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "gl-sup-"));
    temps.push(sessionDir);
    const session = await createPiSupervisorSession({
      runId: "cred-2",
      sessionDir,
      agentDir: path.join(sessionDir, "agent"),
      provider: "openai",
      modelId: "gpt-4o",
      apiKey: "sk-fake-openai",
    });
    try {
      await expect(session.setModel({ provider: "deepseek", modelId: "deepseek-v4-pro" })).rejects.toThrow(/credential unavailable for provider deepseek: set DEEPSEEK_API_KEY/);
      expect(session.provider).toBe("openai");
      setEnv("DEEPSEEK_API_KEY", "sk-fake-deepseek");
      await session.setModel({ provider: "deepseek", modelId: "deepseek-v4-pro" });
      expect(session).toMatchObject({ provider: "deepseek", modelId: "deepseek-v4-pro" });
      setEnv("DEEPSEEK_API_KEY", undefined);
      // Back to the first provider: its explicit key is still its own.
      await session.setModel({ provider: "openai", modelId: "gpt-4o" });
      expect(session.provider).toBe("openai");
    } finally {
      await session.close();
    }
  });
});
