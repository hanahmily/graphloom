import { describe, expect, it } from "vitest";
import { returnToNormal } from "@graphloom/sdk";
import { createPiSupervisor, type PiSupervisorSessionPort } from "./pi-supervisor.js";
import { createScriptedSupervisor } from "./types.js";

interface PromptCall {
  text: string;
  timeoutMs: number | undefined;
}

function codingSession(args: {
  replies: string[];
  turnsPerPrompt: number[];
  calls: PromptCall[];
  grants: string[];
}): PiSupervisorSessionPort {
  let reply = 0;
  let pendingTurns = 0;
  return {
    runId: "run-1",
    provider: "minimax-cn",
    modelId: "MiniMax-M3",
    sessionId: "sess-patch",
    sessionFile: "/tmp/sess-patch.jsonl",
    credentialSource: "options",
    async prompt(text, options) {
      args.calls.push({ text, timeoutMs: options?.timeoutMs });
      pendingTurns += args.turnsPerPrompt[reply] ?? 1;
      const next = args.replies[reply++];
      if (next === undefined) throw new Error("fake session exhausted");
      return next;
    },
    drainTurnCount() {
      const n = pendingTurns;
      pendingTurns = 0;
      return n;
    },
    async grantCandidateCoding(root) {
      args.grants.push(root);
    },
    async revokeCandidateCoding() {
      /* no-op */
    },
    async setModel() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  };
}

const request = {
  candidateRoot: "/state/repairs/repair-1/candidate",
  target: "validator" as const,
  reason: "exact-greeting gate rejects correct bytes",
};

describe("supervisor candidate patch", () => {
  it("patches through the same Pi session and settles every tool turn", async () => {
    const calls: PromptCall[] = [];
    const grants: string[] = [];
    const supervisor = createPiSupervisor({
      session: codingSession({
        replies: ["  Fixed the newline comparison in validators.ts.  "],
        turnsPerPrompt: [4],
        calls,
        grants,
      }),
      patchTimeoutMs: 1234,
    });

    await supervisor.grantCandidateCoding!(request.candidateRoot);
    const result = await supervisor.patchCandidate!(request);

    expect(result.summary).toBe("Fixed the newline comparison in validators.ts.");
    expect(grants).toEqual([request.candidateRoot]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(1234);
    expect(calls[0]?.text).toContain(`Candidate root: ${request.candidateRoot}`);
    expect(calls[0]?.text).toContain("Reason: exact-greeting gate rejects correct bytes");
    expect(calls[0]?.text).toMatch(/Do not edit graphloom\.stages\.json/);
    expect(calls[0]?.text).toMatch(/No shell is available/);
    expect(supervisor.drainProviderCalls()).toBe(4);
    expect(supervisor.sessionId).toBe("sess-patch");
  });

  it("refuses to patch without a grant or outside the granted root", async () => {
    const supervisor = createPiSupervisor({
      session: codingSession({ replies: [], turnsPerPrompt: [], calls: [], grants: [] }),
    });
    await expect(supervisor.patchCandidate!(request)).rejects.toThrow(/active candidate coding grant/);

    await supervisor.grantCandidateCoding!(request.candidateRoot);
    await expect(
      supervisor.patchCandidate!({ ...request, candidateRoot: "/elsewhere" }),
    ).rejects.toThrow(/!= granted/);

    await supervisor.revokeCandidateCoding!();
    await expect(supervisor.patchCandidate!(request)).rejects.toThrow(/active candidate coding grant/);
    expect(supervisor.drainProviderCalls()).toBe(0);
  });

  it("charges at least one call per prompt and bounds the summary", async () => {
    const calls: PromptCall[] = [];
    const supervisor = createPiSupervisor({
      session: codingSession({
        replies: [JSON.stringify(returnToNormal({ summary: "ok" }, "r")), "x".repeat(5000)],
        turnsPerPrompt: [0, 0],
        calls,
        grants: [],
      }),
    });
    await supervisor.decide({
      runId: "run-1",
      episodeId: "ep-1",
      trigger: { code: "supervise", message: "m" },
      view: {
        runId: "run-1",
        task: { request: "hi", repo: "." },
        current: { stageId: "write", attempt: 1 },
        receipts: [],
        evidence: [],
        outstanding: [],
        budgets: { agentInvocations: 5, jobs: 5, decisions: 5, corrections: 2 },
        validatorBindings: [],
        generation: 1,
        stateRevision: 1,
        activeVersion: "hello@0.1.0",
      },
    });
    await supervisor.grantCandidateCoding!(request.candidateRoot);
    const { summary } = await supervisor.patchCandidate!(request);
    expect(summary).toHaveLength(2000);
    expect(supervisor.drainProviderCalls()).toBe(2);
  });

  it("scripted supervisor patches only the granted root", async () => {
    const seen: string[] = [];
    const supervisor = createScriptedSupervisor({
      decisions: [],
      patch: async ({ candidateRoot }) => {
        seen.push(candidateRoot);
        return { summary: "scripted fix" };
      },
    });
    await expect(supervisor.patchCandidate!(request)).rejects.toThrow(/grant/);
    await supervisor.grantCandidateCoding!(request.candidateRoot);
    await expect(supervisor.patchCandidate!(request)).resolves.toEqual({ summary: "scripted fix" });
    expect(seen).toEqual([request.candidateRoot]);
  });
});
