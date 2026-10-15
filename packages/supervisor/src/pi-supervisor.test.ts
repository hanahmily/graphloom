import { describe, expect, it } from "vitest";
import { dispatch, reenter, returnToNormal, stop, WireValidationError, type AgentSessionView, type EvidenceRecord } from "@graphloom/sdk";
import {
  buildRecoveryPrompt,
  buildRepairPrompt,
  createPiSupervisor,
  findConfigured,
  type PiSupervisorSessionPort,
  type SupervisorModelRef,
} from "./pi-supervisor.js";
import { supervisorProposalKey } from "./tools.js";
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
        // Re-asked once with the parse error; a second Accept still fails the turn.
        replies: [
          JSON.stringify({ action: { type: "accept" }, reason: "ship it" }),
          JSON.stringify({ action: { type: "accept" }, reason: "ship it" }),
        ],
      }),
    });
    await expect(supervisor.decide(sampleInput())).rejects.toThrow(WireValidationError);
  });

  it("rejects a JSON-only reply that repeats a proposal already at its rejection threshold", async () => {
    const repeated = reenter({ stageId: "write", reason: "check again" }, "reenter");
    const key = supervisorProposalKey("correction_limit", repeated.action);
    const input: SupervisorInput = {
      ...sampleInput(),
      trigger: { code: "correction_limit", message: "stage write is still unresolved" },
      view: {
        ...sampleInput().view,
        escalation: {
          correctionTrials: {},
          handoff: {},
          repeatedProposals: { [key]: { triggerCode: "correction_limit", actionType: "reenter", stageId: "write", count: 2 } },
        },
      },
    };
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: [JSON.stringify(repeated)] }),
    });
    // A JSON-only reply never calls the admission tools, so there is no
    // in-turn reject() to catch this: it must still be refused here, the
    // same way the tool-calling path's execute() refuses a 3rd repeat.
    await expect(supervisor.decide(input)).rejects.toThrow(/3rd time with no progress/);
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

  it("passes the configured target's own thinkingLevel to the session, not the switch call's", async () => {
    const seen: SupervisorModelRef[] = [];
    const supervisor = createPiSupervisor({
      session: fakeSession({
        replies: [],
        provider: "minimax-cn",
        modelId: "MiniMax-M3",
        switchImpl: async (ref) => {
          seen.push(ref);
        },
      }),
      configuredModels: [
        { provider: "minimax-cn", modelId: "MiniMax-M3" },
        { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" },
      ],
    });

    await supervisor.switchModel({
      provider: "minimax-cn",
      modelId: "MiniMax-M3.1-Flash-Preview",
      reason: "model requires adaptive thinking",
    });
    expect(seen).toEqual([{ provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" }]);

    // Switching back to a model with no configured thinkingLevel must not keep
    // "low" from the previous model: it goes through unset, not re-sent as-is.
    await supervisor.switchModel({ provider: "minimax-cn", modelId: "MiniMax-M3", reason: "revert" });
    expect(seen[1]).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
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

describe("createPiSupervisor in-turn feedback (#117)", () => {
  it("re-asks an unparseable reply once with the parse error, within the same decide()", async () => {
    const prompted: string[] = [];
    const supervisor = createPiSupervisor({
      session: fakeSession({
        replies: ["I think we should return now.", JSON.stringify(returnToNormal({ summary: "ok" }, "return"))],
        onPrompt: (t) => prompted.push(t),
      }),
    });
    await expect(supervisor.decide(sampleInput())).resolves.toMatchObject({ action: { type: "return" } });
    expect(prompted).toHaveLength(2);
    expect(prompted[1]).toMatch(/could not be read as a decision: .*GraphDecision/);
    expect(supervisor.drainProviderCalls()).toBe(2);
  });

  it("does not re-ask when the turn's provider-call allowance is spent", async () => {
    const supervisor = createPiSupervisor({
      session: fakeSession({ replies: ["not json", JSON.stringify(returnToNormal({ summary: "ok" }, "return"))] }),
    });
    await expect(supervisor.decide({ ...sampleInput(), maxProviderCalls: 1 })).rejects.toThrow(/no GraphDecision JSON/);
    expect(supervisor.drainProviderCalls()).toBe(1);
  });

  it("returns a JSON reply the controller would not admit to the model in the same decide(), then admits the next", async () => {
    const prompted: string[] = [];
    const bad = { reason: "activate", action: { type: "activate_repair", activate: { qualifiedArtifactId: "repair-1", reason: "fix" } } };
    let rejections = 0;
    const supervisor = createPiSupervisor({
      session: fakeSession({
        replies: [JSON.stringify(bad), JSON.stringify(returnToNormal({ summary: "already active" }, "return"))],
        onPrompt: (t) => prompted.push(t),
      }),
    });
    const decided = await supervisor.decide({
      ...sampleInput(),
      admission: {
        facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
        refuse: async (action, reason) => ({ action, reason, remaining: 2 }),
        check: async (d) => {
          if (d.action.type !== "activate_repair") return undefined;
          rejections += 1;
          return { action: "activate_repair", reason: "repair-1 is `activated`, not `qualified`", remaining: 2 };
        },
      },
    });
    expect(decided).toMatchObject({ action: { type: "return" } });
    expect(rejections).toBe(1);
    expect(prompted[1]).toContain("repair-1 is `activated`, not `qualified`");
    expect(prompted[1]).toContain("Call one GraphLoom tool: dispatch, observe, validate, reenter, return, or stop.");
  });

  it("rejects a JSON work dispatch missing its writeScope in-turn and charges it, instead of rewriting it into a reenter", async () => {
    const prompted: string[] = [];
    const charged: string[] = [];
    const noScope = dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "fix it" }, "retry the work");
    const supervisor = createPiSupervisor({
      session: fakeSession({
        replies: [JSON.stringify(noScope), JSON.stringify(returnToNormal({ summary: "let the graph rerun it" }, "return"))],
        onPrompt: (t) => prompted.push(t),
      }),
    });
    const decided = await supervisor.decide({
      ...sampleInput(),
      admission: {
        facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
        check: async () => undefined,
        refuse: async (action, reason) => {
          charged.push(`${action}: ${reason}`);
          return { action, reason, remaining: 3 - charged.length };
        },
      },
    });
    expect(decided).toMatchObject({ action: { type: "return" } });
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatch(/^dispatch: a work job needs a non-empty writeScope/);
    expect(prompted).toHaveLength(2);
    expect(prompted[1]).toContain("a work job needs a non-empty writeScope");
    expect(prompted[1]).toContain("2 more inadmissible proposals allowed this turn");
  });

  it("lists exactly the offered tools in the recovery prompt", async () => {
    let tools: string[] = [];
    const prompted: string[] = [];
    const session = fakeSession({
      replies: [JSON.stringify(stop({ reason: "blocked", blocker: "x" }, "stop"))],
      onPrompt: (t) => prompted.push(t),
    });
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
      tools = (options?.tools ?? []).map((t) => t.name);
      return prompt(text, options);
    };
    const supervisor = createPiSupervisor({ session });
    await supervisor.decide({
      ...sampleInput(),
      admission: { facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] }, check: async () => undefined, refuse: async (action, reason) => ({ action, reason, remaining: 2 }) },
    });
    expect(tools).toEqual(["dispatch", "observe", "validate", "reenter", "return", "stop", "switch_model"]);
    expect(prompted[0]).toContain("Propose exactly one action by calling one GraphLoom tool: dispatch, observe, validate, reenter, return, or stop.");
    expect(prompted[0]).not.toContain("For activate_repair");
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

  it("tells the supervisor to re-verify stale rejections only on the first turn after a resume", () => {
    const resumedInput = sampleInput();
    resumedInput.resumed = true;
    expect(buildRecoveryPrompt(resumedInput)).toContain("This run was just resumed");

    const laterInput = sampleInput();
    expect(buildRecoveryPrompt(laterInput)).not.toContain("This run was just resumed");
  });
});

describe("buildRepairPrompt", () => {
  const request = {
    candidateRoot: "/repairs/r1/candidate",
    target: "executor" as const,
    reason: "the executor writes outside its write scope on review-purpose jobs",
  };

  it("asks for a first patch with no reviewer feedback", () => {
    const prompt = buildRepairPrompt(request);
    expect(prompt).toContain("now authoring the qualified repair you proposed");
    expect(prompt).not.toContain("independent reviewer rejected");
  });

  it("sends the independent reviewer's own rejection back for a revision, not a fresh patch", () => {
    const prompt = buildRepairPrompt({ ...request, reviewFeedback: "the read-only flag is set but never enforced" });
    expect(prompt).toContain("revising the qualified repair you are authoring after the independent reviewer sent it back");
    expect(prompt).toContain("independent reviewer rejected your last revision");
    expect(prompt).toContain("the read-only flag is set but never enforced");
    expect(prompt).not.toContain("now authoring the qualified repair you proposed");
  });
});

describe("findConfigured", () => {
  const configured: SupervisorModelRef[] = [
    { provider: "minimax-cn", modelId: "MiniMax-M3" },
    { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" },
  ];

  it("returns the operator's own entry, thinkingLevel included, for a configured model", () => {
    expect(findConfigured(configured, { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview" })).toEqual({
      provider: "minimax-cn",
      modelId: "MiniMax-M3.1-Flash-Preview",
      thinkingLevel: "low",
    });
  });

  it("returns an entry with no thinkingLevel key for a model that does not need one", () => {
    const found = findConfigured(configured, { provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(found).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(found).not.toHaveProperty("thinkingLevel");
  });

  it("returns undefined for a model the operator never configured", () => {
    expect(findConfigured(configured, { provider: "anthropic", modelId: "claude-sonnet-4-5" })).toBeUndefined();
  });
});
