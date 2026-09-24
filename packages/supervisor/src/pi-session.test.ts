import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSupervisorSession, isMiniMaxProvider } from "./pi-session.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("isMiniMaxProvider", () => {
  it("recognizes minimax providers only", () => {
    expect(isMiniMaxProvider("minimax-cn")).toBe(true);
    expect(isMiniMaxProvider("minimax")).toBe(true);
    expect(isMiniMaxProvider("openai")).toBe(false);
    expect(isMiniMaxProvider("anthropic")).toBe(false);
  });
});

describe("createPiSupervisorSession credential isolation", () => {
  it("rejects injecting a MiniMax apiKey into a non-MiniMax provider", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "gl-sup-"));
    temps.push(sessionDir);
    await expect(
      createPiSupervisorSession({
        runId: "cred-1",
        sessionDir,
        provider: "openai",
        modelId: "gpt-4o",
        apiKey: "sk-minimax-should-not-cross",
      }),
    ).rejects.toThrow(/MiniMax-only|cannot inject MiniMax/i);
  });
});
