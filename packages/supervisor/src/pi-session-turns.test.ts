// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { wrapPiAgentSession } from "./pi-session.js";

interface FauxModule {
  fauxProvider(options?: { provider?: string }): {
    provider: unknown;
    getModel(): unknown;
    state: { callCount: number };
    setResponses(responses: unknown[]): void;
  };
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
}

interface FauxContext {
  messages: Array<{ role: string; toolName?: string; content?: unknown }>;
}

/** First `<node_modules>/<pkg>` visible from `fromFile` (works for ESM-only packages). */
function findPackageDir(fromFile: string, pkg: string): string {
  for (const dir of createRequire(fromFile).resolve.paths(pkg) ?? []) {
    const candidate = path.join(dir, pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${pkg} not found from ${fromFile}`);
}

/** Pi's own pi-ai instance, wherever npm placed it. */
async function loadPiAi(): Promise<FauxModule> {
  const piDir = findPackageDir(import.meta.filename, "@earendil-works/pi-coding-agent");
  const aiDir = findPackageDir(path.join(piDir, "package.json"), "@earendil-works/pi-ai");
  return (await import(pathToFileURL(path.join(aiDir, "dist", "index.js")).href)) as FauxModule;
}

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("Pi supervisor session", () => {
  it("aborts the turn beyond maxTurns before its provider request", async () => {
    const ai = await loadPiAi();
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-turns-"));
    temps.push(dir);
    const repairsDir = path.join(dir, "repairs");
    const candidateRoot = path.join(repairsDir, "repair-1", "candidate");
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(path.join(repairsDir, "repair-1", "snapshot.json"), "{}\n", "utf8");

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
    });
    const faux = ai.fauxProvider({ provider: "faux-turns" });
    modelRuntime.registerNativeProvider(faux.provider as never);
    const lsTurn = () =>
      ai.fauxAssistantMessage(ai.fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" });
    faux.setResponses([lsTurn(), lsTurn(), lsTurn(), ai.fauxAssistantMessage("done")]);

    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: faux.getModel() as never,
      thinkingLevel: "off",
      modelRuntime,
      noTools: "all",
      tools: [],
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    const wrapped = wrapPiAgentSession({
      session,
      modelRuntime,
      runId: "run-turns",
      provider: "faux-turns",
      modelId: "faux",
      agentDir: dir,
      credentialSource: "pi-stored",
      promptTimeoutMs: 10_000,
      repairsDir,
    });

    try {
      await wrapped.grantCandidateCoding!(candidateRoot);
      await expect(wrapped.prompt("patch it", { maxTurns: 2 })).rejects.toThrow(
        /exceeded its 2-turn allowance/,
      );
      expect(faux.state.callCount).toBe(2);
      expect(wrapped.drainTurnCount!()).toBe(2);
    } finally {
      await wrapped.close();
    }
  });

  it("charges compaction's provider requests to the turn allowance and skips it when they do not fit", async () => {
    const ai = await loadPiAi();
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-compact-"));
    temps.push(dir);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
    });
    const faux = ai.fauxProvider({ provider: "faux-compact" });
    modelRuntime.registerNativeProvider(faux.provider as never);
    faux.setResponses(Array.from({ length: 12 }, (_, i) => ai.fauxAssistantMessage(`reply ${i}`)));

    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: faux.getModel() as never,
      thinkingLevel: "off",
      modelRuntime,
      noTools: "all",
      tools: [],
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 1 },
        retry: { enabled: false },
      }),
    });
    const wrapped = wrapPiAgentSession({
      session,
      modelRuntime,
      runId: "run-compact",
      provider: "faux-compact",
      modelId: "faux",
      agentDir: dir,
      credentialSource: "pi-stored",
      promptTimeoutMs: 10_000,
      repairsDir: path.join(dir, "repairs"),
    });

    try {
      // Build some history, then report a nearly full context so the next
      // prompt compacts first.
      for (let i = 0; i < 3; i += 1) await wrapped.prompt(`turn ${i} ${"x".repeat(200)}`);
      expect(wrapped.drainTurnCount!()).toBe(3);
      const full = { tokens: 1_000_000, contextWindow: 1_000_000, percent: 100 };
      (session as unknown as { getContextUsage: () => unknown }).getContextUsage = () => full;

      // One turn allowed: compaction (charged as 2) does not fit, so no
      // summarization request is sent and only the prompt's own turn runs.
      const before = faux.state.callCount;
      await wrapped.prompt("capped", { maxTurns: 1 });
      expect(faux.state.callCount - before).toBe(1);
      expect(wrapped.drainTurnCount!()).toBe(1);

      // Uncapped: compaction runs and is charged.
      await wrapped.prompt("uncapped");
      expect(wrapped.drainTurnCount!()).toBe(3);
    } finally {
      await wrapped.close();
    }
  });

  it("does not count a long-running local tool against the prompt's inactivity limit", async () => {
    const ai = await loadPiAi();
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-tool-idle-"));
    temps.push(dir);
    const repairsDir = path.join(dir, "repairs");
    const candidateRoot = path.join(repairsDir, "repair-1", "candidate");
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(path.join(repairsDir, "repair-1", "snapshot.json"), "{}\n", "utf8");
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
    });
    const faux = ai.fauxProvider({ provider: "faux-tool-idle" });
    modelRuntime.registerNativeProvider(faux.provider as never);
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "sleep 1 && printf built > built.txt" }), { stopReason: "toolUse" }),
      ai.fauxAssistantMessage("built"),
    ]);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: faux.getModel() as never,
      thinkingLevel: "off",
      modelRuntime,
      noTools: "all",
      tools: [],
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    const wrapped = wrapPiAgentSession({
      session,
      modelRuntime,
      runId: "run-tool-idle",
      provider: "faux-tool-idle",
      modelId: "faux",
      agentDir: dir,
      credentialSource: "pi-stored",
      // The silent one-second build is longer than this, but it is local work, not provider silence.
      promptTimeoutMs: 300,
      repairsDir,
    });
    try {
      await wrapped.grantCandidateCoding!(candidateRoot);
      expect(await wrapped.prompt("build it")).toBe("built");
      expect(await readFile(path.join(candidateRoot, "built.txt"), "utf8")).toBe("built");
    } finally {
      await wrapped.close();
    }
  });

  it("runs shell commands in the granted candidate root and drops them on revoke", async () => {
    const ai = await loadPiAi();
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-shell-"));
    temps.push(dir);
    const repairsDir = path.join(dir, "repairs");
    const candidateRoot = path.join(repairsDir, "repair-1", "candidate");
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(path.join(repairsDir, "repair-1", "snapshot.json"), "{}\n", "utf8");

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
    });
    const faux = ai.fauxProvider({ provider: "faux-shell" });
    modelRuntime.registerNativeProvider(faux.provider as never);
    const bash = (command: string) =>
      ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    let afterRevoke: FauxContext | undefined;
    faux.setResponses([
      bash("pwd > where.txt && printf fixed > validator.js"),
      ai.fauxAssistantMessage("patched"),
      bash("printf leaked > leaked.txt"),
      (context: FauxContext) => {
        afterRevoke = context;
        return ai.fauxAssistantMessage("done");
      },
    ]);

    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: faux.getModel() as never,
      thinkingLevel: "off",
      modelRuntime,
      noTools: "all",
      tools: [],
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    const wrapped = wrapPiAgentSession({
      session,
      modelRuntime,
      runId: "run-shell",
      provider: "faux-shell",
      modelId: "faux",
      agentDir: dir,
      credentialSource: "pi-stored",
      promptTimeoutMs: 10_000,
      repairsDir,
    });

    try {
      await wrapped.grantCandidateCoding!(candidateRoot);
      await wrapped.prompt("patch it");
      expect((await readFile(path.join(candidateRoot, "where.txt"), "utf8")).trim()).toBe(
        await realpath(candidateRoot),
      );
      expect(await readFile(path.join(candidateRoot, "validator.js"), "utf8")).toBe("fixed");
      expect(existsSync(path.join(dir, "where.txt"))).toBe(false);

      await wrapped.revokeCandidateCoding!();
      await wrapped.prompt("anything else?");
      expect(existsSync(path.join(candidateRoot, "leaked.txt"))).toBe(false);
      expect(existsSync(path.join(dir, "leaked.txt"))).toBe(false);
      const last = afterRevoke?.messages.at(-1);
      expect(last?.role).toBe("toolResult");
      expect(JSON.stringify(last?.content)).toMatch(/Tool bash not found/);
    } finally {
      await wrapped.close();
    }
  });
});
