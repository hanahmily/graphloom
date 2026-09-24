import { describe, expect, it } from "vitest";
import { createPiSupervisorSession } from "./pi-session.js";

const live = process.env.GRAPHLOOM_LIVE_MINIMAX === "1";

describe("createPiSupervisorSession (live MiniMax)", () => {
  it.skipIf(!live)("prompts MiniMax-M3 and returns model text", async () => {
    const supervisor = await createPiSupervisorSession({
      runId: "live-minimax-1",
      systemPrompt: "Reply with exactly PI_MINIMAX_OK and nothing else.",
      promptTimeoutMs: 60_000,
    });
    try {
      const reply = await supervisor.prompt("Reply with exactly PI_MINIMAX_OK");
      expect(reply).toContain("PI_MINIMAX_OK");
      expect(supervisor.provider).toBe("minimax-cn");
      expect(supervisor.modelId).toBe("MiniMax-M3");
      expect(supervisor.sessionId.length).toBeGreaterThan(0);
      // Never assert on raw key material — only the resolution class.
      expect(["options", "env:MINIMAX_CN_API_KEY", "env:MINIMAX_API_KEY", "pi-stored"]).toContain(
        supervisor.credentialSource,
      );
    } finally {
      await supervisor.close();
    }
  }, 90_000);
});
