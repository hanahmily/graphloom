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
