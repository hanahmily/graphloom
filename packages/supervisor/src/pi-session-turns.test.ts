import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("Pi session turn cap", () => {
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
});
