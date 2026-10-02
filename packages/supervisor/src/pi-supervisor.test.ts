import { describe, expect, it } from "vitest";
import { dispatch, returnToNormal, stop, WireValidationError, type AgentSessionView, type EvidenceRecord } from "@graphloom/sdk";
import {
  buildRecoveryPrompt,
  createPiSupervisor,
  type PiSupervisorSessionPort,
  type SupervisorModelRef,
} from "./pi-supervisor.js";
import type { SupervisorInput } from "./types.js";

function sampleInput(episodeId = "ep-1"): SupervisorInput {
  return {
    runId: "run-1",
    episodeId,
    trigger: { code: "supervise", message: "unfamiliar failure" },
    view: {
      runId: "run-1",
      task: { request: "hi", repo: "." },
      current: { stageId: "write", attempt: 1 },
      receipts: [],
      evidence: [],
      outstanding: [],
      budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 4 },
      validatorBindings: [],
      generation: 1,
      stateRevision: 2,
      activeVersion: "hello@0.1.0",
      recoveryEpisodeId: episodeId,
    },
  };
}

function fakeSession(args: {
  replies: string[];
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  onPrompt?: (text: string) => void;
  switchImpl?: (ref: SupervisorModelRef) => Promise<void>;
}): PiSupervisorSessionPort {
  let replyIndex = 0;
  let provider = args.provider ?? "minimax-cn";
  let modelId = args.modelId ?? "MiniMax-M3";
  return {
    runId: "run-1",
    get provider() {
      return provider;
    },
    get modelId() {
      return modelId;
    },
    sessionId: args.sessionId ?? "sess-abc",
    sessionFile: args.sessionFile ?? "/tmp/sess.jsonl",
    credentialSource: "options",
    async prompt(text) {
      args.onPrompt?.(text);
      const reply = args.replies[replyIndex];
      replyIndex += 1;
      if (reply === undefined) {
        throw new Error("fake session exhausted");
      }
      return reply;
    },
    async close() {
      /* no-op */
    },
    async setModel(ref) {
      if (args.switchImpl) {
        await args.switchImpl(ref);
      }
      provider = ref.provider;
      modelId = ref.modelId;
    },
  };
}

describe("createPiSupervisor", () => {
  it("parses a live decision from the session prompt and reuses one session", async () => {
    const prompted: string[] = [];
    const session = fakeSession({
      replies: [
        JSON.stringify(returnToNormal({ summary: "fixed" }, "return after repair")),
        JSON.stringify(
          stop({ reason: "still blocked", blocker: "external" }, "cannot proceed"),
        ),
      ],
      onPrompt: (t) => prompted.push(t),
    });
    const supervisor = createPiSupervisor({ session });

    const first = await supervisor.decide(sampleInput("ep-1"));
    expect(first).toMatchObject({ action: { type: "return" } });
    const second = await supervisor.decide(sampleInput("ep-2"));
    expect(second).toMatchObject({ action: { type: "stop" } });

    expect(prompted).toHaveLength(2);
    expect(prompted[0]).toContain("ep-1");
    expect(prompted[1]).toContain("ep-2");
    expect(supervisor.binding.sessionId).toBe("sess-abc");
    expect(supervisor.binding.sessionFile).toBe("/tmp/sess.jsonl");
    expect(supervisor.drainProviderCalls()).toBe(2);
    expect(supervisor.drainProviderCalls()).toBe(0);
  });

  it("rejects Accept proposals from the model", async () => {
    const supervisor = createPiSupervisor({
      session: fakeSession({
        replies: [JSON.stringify({ action: { type: "accept" }, reason: "ship it" })],
      }),
    });
    await expect(supervisor.decide(sampleInput())).rejects.toThrow(WireValidationError);
  });

  it("journals an explicit model switch and rejects silent fallback", async () => {
    const configured: SupervisorModelRef[] = [
      { provider: "minimax-cn", modelId: "MiniMax-M3" },
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "deepseek", modelId: "deepseek-chat" },
    ];
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: [], provider: "minimax-cn", modelId: "MiniMax-M3" }),
      configuredModels: configured,
    });

    await supervisor.switchModel({
      provider: "openai",
      modelId: "gpt-4o",
      reason: "provider outage",
    });
    expect(supervisor.binding.provider).toBe("openai");
    expect(supervisor.binding.modelId).toBe("gpt-4o");
    expect(supervisor.binding.switchJournal).toEqual([
      expect.objectContaining({
        from: { provider: "minimax-cn", modelId: "MiniMax-M3" },
        to: { provider: "openai", modelId: "gpt-4o" },
        reason: "provider outage",
        status: "committed",
      }),
    ]);

    await expect(
      supervisor.switchModel({
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        reason: "try another",
      }),
    ).rejects.toThrow(/not configured/i);
    expect(supervisor.binding.provider).toBe("openai");
  });

  it("records a failed switch intent when setModel throws mid-flight", async () => {
    const supervisor = createPiSupervisor({
      session: fakeSession({
        replies: [],
        switchImpl: async () => {
          throw new Error("auth missing");
        },
      }),
      configuredModels: [
        { provider: "minimax-cn", modelId: "MiniMax-M3" },
        { provider: "openai", modelId: "gpt-4o" },
      ],
    });

    await expect(
      supervisor.switchModel({
        provider: "openai",
        modelId: "gpt-4o",
        reason: "failover",
      }),
    ).rejects.toThrow(/auth missing/);
    expect(supervisor.binding.provider).toBe("minimax-cn");
    expect(supervisor.binding.switchJournal.at(-1)?.status).toBe("failed");
  });

  it("drops an invalid continueFrom from a text-only (non-tool-call) reply instead of letting it reach the controller", async () => {
    const staleSession: AgentSessionView = {
      operationId: "op-1",
      stageId: "fix",
      attempt: 1,
      generation: 1,
      dispatchKey: "review:graphloom.coding-agent/run",
      executorId: "graphloom.coding-agent/run",
      status: "failed",
    };
    const badJob = {
      stageId: "fix",
      kind: "agent" as const,
      purpose: "work" as const,
      instruction: "finish the review",
      writeScope: ["."],
      continueFrom: "op-1",
    };
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: [JSON.stringify(dispatch(badJob, "finish the stuck review"))] }),
    });
    const input = sampleInput();
    input.view.agentSessions = [staleSession];
    const decision = await supervisor.decide(input);
    expect(decision).toMatchObject({ action: { type: "dispatch", job: { instruction: "finish the review" } } });
    if (!("action" in decision) || decision.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(decision.action.job.continueFrom).toBeUndefined();
  });

  it("keeps a valid continuation from a text-only reply whose job omits executor", async () => {
    const defaultAgentSession: AgentSessionView = {
      operationId: "op-2",
      stageId: "fix",
      attempt: 5,
      generation: 1,
      dispatchKey: "work:graphloom.agent/run",
      executorId: "graphloom.agent/run",
      status: "failed",
    };
    const okJob = {
      stageId: "fix",
      kind: "agent" as const,
      purpose: "work" as const,
      instruction: "finish the implementation",
      writeScope: ["."],
      continueFrom: "op-2",
    };
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: [JSON.stringify(dispatch(okJob, "finish it"))] }),
    });
    const input = sampleInput();
    input.view.agentSessions = [defaultAgentSession];
    const decision = await supervisor.decide(input);
    expect(decision).toMatchObject({ action: { type: "dispatch", job: { continueFrom: "op-2" } } });
  });

  it("keeps a valid continuation from a text-only reply inheriting a run's own custom-catalog executor", async () => {
    const customCatalogSession: AgentSessionView = {
      operationId: "op-3",
      stageId: "fix",
      attempt: 5,
      generation: 1,
      dispatchKey: "work:graphloom.coding-agent/run",
      executorId: "graphloom.coding-agent/run",
      status: "failed",
    };
    const okJob = {
      stageId: "fix",
      kind: "agent" as const,
      purpose: "work" as const,
      instruction: "finish the implementation",
      writeScope: ["."],
      continueFrom: "op-3",
    };
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: [JSON.stringify(dispatch(okJob, "finish it"))] }),
    });
    const input = sampleInput();
    input.view.agentSessions = [customCatalogSession];
    const decision = await supervisor.decide(input);
    expect(decision).toMatchObject({ action: { type: "dispatch", job: { continueFrom: "op-3" } } });
  });

  it("replaces a text-only work dispatch missing its writeScope with a reenter, instead of letting it reach the controller", async () => {
    const badJob = {
      stageId: "fix",
      kind: "agent" as const,
      purpose: "work" as const,
      instruction: "implement the fix",
    };
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: [JSON.stringify(dispatch(badJob, "implement it"))] }),
    });
    const decision = await supervisor.decide(sampleInput());
    expect(decision).toMatchObject({ action: { type: "reenter", reenter: { stageId: "fix" } } });
  });
});

describe("buildRecoveryPrompt", () => {
  const review = (verdict: string, ref = "ev-review"): EvidenceRecord => ({
    ref,
    kind: "review",
    generation: 1,
    payload: {
      verdict,
      reason: "looks fine",
      producer: { stageId: "fix", purpose: "review" },
    },
  });

  it("describes the current generation's own evidence by producer and verdict, not just its ref", () => {
    const input = sampleInput();
    input.view.evidence = [review("approved")];
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).toContain("ev-review (fix/review): approved, looks fine");
  });

  it("nudges toward reentering and returning when the plan is already approved but unattempted this generation", () => {
    const input = sampleInput();
    input.view.evidence = [review("approved")];
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).toContain("Prefer reenter then return over re-dispatching another review of the same approved plan.");
  });

  it("does not nudge once work-purpose evidence already exists this generation", () => {
    const input = sampleInput();
    const work: EvidenceRecord = {
      ref: "ev-work",
      kind: "other",
      generation: 1,
      payload: { producer: { stageId: "fix", purpose: "work" } },
    };
    input.view.evidence = [review("approved"), work];
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).not.toContain("Prefer reenter then return");
  });

  it("does not nudge when the latest review in this generation requested changes", () => {
    const input = sampleInput();
    input.view.evidence = [review("request_changes")];
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).not.toContain("Prefer reenter then return");
  });

  it("tells the supervisor to dispatch the stage's work itself on a correction_limit trigger, not reenter", () => {
    const input = sampleInput();
    input.trigger = { code: "correction_limit", message: "stage fix is still unresolved after 2 correction trials; the supervisor decides any further trial" };
    input.view.evidence = [review("approved")];
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).toContain("reenter then return only sends the graph back to the same refusal");
    expect(prompt).toContain("Dispatch that stage's work yourself");
    expect(prompt).toContain('job.writeScope: ["."]');
    expect(prompt).not.toContain("Prefer reenter then return over re-dispatching");
  });

  it("only names older-generation evidence by ref, keeping full detail to the current generation", () => {
    const input = sampleInput();
    input.view.generation = 2;
    input.view.evidence = [review("approved", "ev-old"), { ...review("approved", "ev-new"), generation: 2 }];
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).toContain('"ev-old"');
    expect(prompt).not.toContain("ev-old (fix/review)");
    expect(prompt).toContain("ev-new (fix/review): approved, looks fine");
  });
});
