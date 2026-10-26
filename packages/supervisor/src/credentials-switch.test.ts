// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensureProviderCredentials } from "./pi-session.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("ensureProviderCredentials", () => {
  it("rejects a target provider with no configured auth before setModel would run", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "gl-cred-"));
    temps.push(agentDir);
    await writeFile(path.join(agentDir, "auth.json"), "{}", "utf8");
    await writeFile(path.join(agentDir, "models.json"), "{}", "utf8");

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });

    await expect(
      ensureProviderCredentials({
        modelRuntime,
        provider: "openai",
        agentDir,
      }),
    ).rejects.toThrow(/credential unavailable for provider openai/i);
  });
});
