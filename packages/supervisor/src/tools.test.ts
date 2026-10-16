import { describe, expect, it } from "vitest";
import type { AgentSessionView, GraphAction } from "@graphloom/sdk";
import { createAdmissionTools, GRAPHLOOM_SUPERVISOR_ACTIONS, offeredActions, supervisorProposalKey } from "./tools.js";

type Execute = (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; terminate?: boolean }>;

function actionTool(name: string, agentSessions: AgentSessionView[] = [], generation = 1) {
  const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }], agentSessions, generation);
  const tool = toolbox.tools.find((t) => t.name === name)!;
  return { toolbox, execute: (tool as unknown as { execute: Execute }).execute };
}
const dispatchTool = (agentSessions: AgentSessionView[] = [], generation = 1) =>
  actionTool("dispatch", agentSessions, generation);

const job = { stageId: "fix", kind: "agent", purpose: "work", instruction: "Implement the fix." };

const reviewSession: AgentSessionView = {
  operationId: "op-1",
  stageId: "fix",
  attempt: 10,
  generation: 1,
  dispatchKey: "review:graphloom.coding-agent/run",
  executorId: "graphloom.coding-agent/run",
  status: "failed",
};

describe("admission tools", () => {
  it("rejects work without a writeScope so the model can correct it in the same turn", async () => {
    const { toolbox, execute } = dispatchTool();
    const rejected = await execute("1", { reason: "retry", job });
    expect(rejected.terminate).toBeUndefined();
    expect(rejected.content[0]!.text).toMatch(/^Rejected: .*writeScope/);
    expect(toolbox.proposal()).toBeUndefined();

    const accepted = await execute("2", { reason: "retry", job: { ...job, writeScope: ["pkg/timestamp"] } });
    expect(accepted.terminate).toBe(true);
    expect(toolbox.proposal()).toMatchObject({ action: { type: "dispatch", job: { writeScope: ["pkg/timestamp"] } } });
  });

  it("admits read-only work and other purposes without a writeScope", async () => {
    const { toolbox, execute } = dispatchTool();
    await execute("1", { reason: "look", job: { ...job, purpose: "diagnostic", readOnly: true } });
    expect(toolbox.proposal()).toMatchObject({ action: { job: { purpose: "diagnostic" } } });
  });

  it("rejects a continuation dispatched as a command job so the model can correct it in the same turn", async () => {
    const { toolbox, execute } = dispatchTool([reviewSession]);
    const rejected = await execute("1", {
      reason: "finish the review",
      job: { ...job, kind: "command", purpose: "review", readOnly: true, executor: { id: "graphloom.coding-agent/run" }, continueFrom: "op-1" },
    });
    expect(rejected.terminate).toBeUndefined();
    expect(rejected.content[0]!.text).toMatch(/^Rejected: only agent jobs carry sessions/);
    expect(toolbox.proposal()).toBeUndefined();

    const accepted = await execute("2", {
      reason: "finish the review",
      job: { ...job, purpose: "review", readOnly: true, executor: { id: "graphloom.coding-agent/run" }, continueFrom: "op-1" },
    });
    expect(accepted.terminate).toBe(true);
    expect(toolbox.proposal()).toMatchObject({ action: { type: "dispatch", job: { continueFrom: "op-1" } } });
  });

  it("rejects a continuation whose dispatch key does not match the session it names", async () => {
    const { toolbox, execute } = dispatchTool([reviewSession]);
    const rejected = await execute("1", {
      reason: "finish the review",
      job: { ...job, readOnly: true, executor: { id: "graphloom.agent/run" }, continueFrom: "op-1" },
    });
    expect(rejected.terminate).toBeUndefined();
    expect(rejected.content[0]!.text).toMatch(
      /^Rejected: operation op-1 has dispatch key review:graphloom\.coding-agent\/run, not work:graphloom\.agent\/run/,
    );
    expect(toolbox.proposal()).toBeUndefined();
  });

  it("accepts a continuation whose job omits executor, inheriting the session's default-pinned executor", async () => {
    const defaultAgentSession: AgentSessionView = {
      operationId: "op-2",
      stageId: "fix",
      attempt: 5,
      generation: 1,
      dispatchKey: "work:graphloom.agent/run",
      executorId: "graphloom.agent/run",
      status: "failed",
    };
    const { toolbox, execute } = dispatchTool([defaultAgentSession]);
    const accepted = await execute("1", {
      reason: "finish the implementation",
      job: { ...job, readOnly: true, continueFrom: "op-2" },
    });
    expect(accepted.terminate).toBe(true);
    expect(toolbox.proposal()).toMatchObject({ action: { type: "dispatch", job: { continueFrom: "op-2" } } });
  });

  it("accepts a continuation whose job omits executor, inheriting a run's own custom-catalog executor", async () => {
    // RunView exposes no executor catalog, so the supervisor cannot predict a
    // run's own override (here, the catalog pins "agent" kind work to a
    // specific coding-agent executor rather than the generic built-in
    // default). Continuing the session names the answer directly.
    const customCatalogSession: AgentSessionView = {
      operationId: "op-3",
      stageId: "fix",
      attempt: 5,
      generation: 1,
      dispatchKey: "work:graphloom.coding-agent/run",
      executorId: "graphloom.coding-agent/run",
      status: "failed",
    };
    const { toolbox, execute } = dispatchTool([customCatalogSession]);
    const accepted = await execute("1", {
      reason: "finish the implementation",
      job: { ...job, readOnly: true, continueFrom: "op-3" },
    });
    expect(accepted.terminate).toBe(true);
    expect(toolbox.proposal()).toMatchObject({ action: { type: "dispatch", job: { continueFrom: "op-3" } } });
  });

  it("rejects a continuation naming an operation with no recorded session", async () => {
    const { toolbox, execute } = dispatchTool([]);
    const rejected = await execute("1", {
      reason: "finish the review",
      job: { ...job, readOnly: true, continueFrom: "op-missing" },
    });
    expect(rejected.content[0]!.text).toMatch(/^Rejected: no agent session was recorded for operation op-missing/);
    expect(toolbox.proposal()).toBeUndefined();
  });

  it("rejects observe paths outside the run worktree", async () => {
    const { toolbox, execute } = actionTool("observe");
    for (const p of ["/srv/elsewhere", "../outside"]) {
      const rejected = await execute("1", { reason: "look", observe: { paths: [p] } });
      expect(rejected.content[0]!.text).toMatch(/^Rejected: observe paths are relative/);
    }
    expect(toolbox.proposal()).toBeUndefined();
    await execute("2", { reason: "look", observe: { paths: ["CHANGES.md"], includeWorkspaceManifest: true } });
    expect(toolbox.proposal()).toMatchObject({ action: { type: "observe", observe: { paths: ["CHANGES.md"] } } });
  });

  it("accepts a repeated no-progress proposal at its 2nd occurrence but rejects it in-turn at its 3rd", async () => {
    const dispatchJob = { stageId: "fix", kind: "agent" as const, purpose: "work" as const, instruction: "retry", writeScope: ["pkg/timestamp"] };
    const action: GraphAction = { type: "dispatch", job: dispatchJob };
    const key = supervisorProposalKey("correction_limit", action);

    const accepting = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, "correction_limit", {
      [key]: { count: 1 },
    });
    const acceptTool = accepting.tools.find((t) => t.name === "dispatch")!;
    const accepted = await (acceptTool as unknown as { execute: Execute }).execute("1", { reason: "retry", job: dispatchJob });
    expect(accepted.terminate).toBe(true);
    expect(accepting.proposal()).toMatchObject({ action: { type: "dispatch" } });

    const rejecting = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, "correction_limit", {
      [key]: { count: 2 },
    });
    const rejectTool = rejecting.tools.find((t) => t.name === "dispatch")!;
    const rejected = await (rejectTool as unknown as { execute: Execute }).execute("1", { reason: "retry", job: dispatchJob });
    expect(rejected.terminate).toBeUndefined();
    expect(rejected.content[0]!.text).toMatch(
      /^Rejected: this exact dispatch proposal would be the 3rd time with no progress since the controller last checked/,
    );
    expect(rejecting.proposal()).toBeUndefined();
  });
});

const noRefuse = async (action: string, reason: string) => ({ action, reason, remaining: 2 });

describe("admission tools narrowed by state (#117)", () => {
  const names = (facts: { inRecovery: boolean; canQualify: boolean; qualifiedArtifactIds: string[] }) =>
    createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, "supervise", {}, { facts, check: async () => undefined, refuse: noRefuse })
      .tools.map((t) => t.name);

  it("offers no activate_repair without a qualified candidate", () => {
    expect(names({ inRecovery: true, canQualify: true, qualifiedArtifactIds: [] })).not.toContain("activate_repair");
    expect(names({ inRecovery: true, canQualify: true, qualifiedArtifactIds: ["repair-1"] })).toContain("activate_repair");
  });

  it("offers no qualify_repair without repair authority, and no return outside recovery", () => {
    const narrowed = names({ inRecovery: false, canQualify: false, qualifiedArtifactIds: [] });
    expect(narrowed).toEqual(["dispatch", "observe", "validate", "reenter", "stop", "switch_model"]);
  });

  it("offers every action when the controller gives no facts", () => {
    expect(offeredActions()).toEqual([...GRAPHLOOM_SUPERVISOR_ACTIONS]);
  });
});

describe("controller admission check within the turn (#117)", () => {
  const facts = { inRecovery: true, canQualify: false, qualifiedArtifactIds: ["repair-f7a36302"] };

  it("returns an inadmissible proposal to the model with the reason and current value, then admits the next", async () => {
    const check = async (d: { action: GraphAction }) =>
      d.action.type === "activate_repair"
        ? {
            action: "activate_repair",
            reason:
              "activate_repair missing qualified artifact: repair-f7a36302 is `activated`, not `qualified`; active version is g@repair-repair-f7a36302",
            remaining: 2,
          }
        : undefined;
    const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, "supervise", {}, { facts, check, refuse: noRefuse });
    const exec = (name: string) => (toolbox.tools.find((t) => t.name === name) as unknown as { execute: Execute }).execute;

    const rejected = await exec("activate_repair")("1", {
      reason: "activate",
      activate: { qualifiedArtifactId: "repair-f7a36302", reason: "fix" },
    });
    expect(rejected.terminate).toBeUndefined();
    expect(rejected.content[0]!.text).toContain("repair-f7a36302 is `activated`, not `qualified`");
    expect(rejected.content[0]!.text).toContain("2 more inadmissible proposals allowed this turn");
    expect(toolbox.proposal()).toBeUndefined();

    const accepted = await exec("return")("2", { reason: "already active", return: { summary: "repair is active" } });
    expect(accepted.terminate).toBe(true);
    expect(toolbox.proposal()).toMatchObject({ action: { type: "return" } });
    expect(toolbox.exhausted()).toBeUndefined();
  });

  it("ends the turn when the controller says no inadmissible proposals remain", async () => {
    const check = async () => ({
      action: "validate",
      reason: "undeclared stage: stageId nope is not in the pinned graph definition",
      remaining: 0,
    });
    const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, "supervise", {}, { facts, check, refuse: noRefuse });
    const validateTool = toolbox.tools.find((t) => t.name === "validate") as unknown as { execute: Execute };
    const last = await validateTool.execute("1", { reason: "check", validate: { stageId: "nope" } });
    expect(last.terminate).toBe(true);
    expect(last.content[0]!.text).toMatch(/last inadmissible proposal allowed this turn/);
    expect(toolbox.proposal()).toBeUndefined();
    expect(toolbox.exhausted()).toMatchObject({ action: "validate", remaining: 0 });
  });
});

describe("locally detected rejections count toward the controller's allowance (#117)", () => {
  it("charges each invalid write scope through admission.refuse and ends the turn at the third", async () => {
    const charged: string[] = [];
    const refuse = async (action: string, reason: string) => {
      charged.push(`${action}: ${reason}`);
      return { action, reason, remaining: 3 - charged.length };
    };
    const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, "supervise", {}, {
      facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
      check: async () => undefined,
      refuse,
    });
    const tool = toolbox.tools.find((t) => t.name === "dispatch") as unknown as { execute: Execute };
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await tool.execute(String(i), { reason: "retry", job }));
    expect(charged).toHaveLength(3);
    expect(charged[0]).toMatch(/^dispatch: a work job needs a non-empty writeScope/);
    expect(results.slice(0, 2).map((r) => r.terminate)).toEqual([undefined, undefined]);
    expect(results[2]!.terminate).toBe(true);
    expect(toolbox.exhausted()).toMatchObject({ action: "dispatch", remaining: 0 });
    expect(toolbox.proposal()).toBeUndefined();
  });

  it("keeps uncounted local rejections when no controller admission is given", async () => {
    const { toolbox, execute } = dispatchTool();
    for (let i = 0; i < 4; i += 1) {
      const rejected = await execute(String(i), { reason: "retry", job });
      expect(rejected.terminate).toBeUndefined();
    }
    expect(toolbox.exhausted()).toBeUndefined();
  });
});

describe("record_finding", () => {
  it("is offered only with a case-file sink, and reports the controller's answer without ending the turn", async () => {
    expect(createAdmissionTools([{ provider: "p", modelId: "m" }]).tools.map((t) => t.name)).not.toContain("record_finding");

    const submitted: unknown[] = [];
    const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, undefined, {}, undefined, async (finding) => {
      submitted.push(finding);
      return finding.evidence?.includes("ev-1") === true
        ? { kept: true, id: "fact-1" }
        : { kept: false, reason: "no recorded evidence has ref ev-9" };
    });
    const tool = toolbox.tools.find((t) => t.name === "record_finding")!;
    const execute = (tool as unknown as { execute: Execute }).execute;

    const kept = await execute("1", { kind: "fact", text: "the fix is on disk", evidence: ["ev-1"] });
    expect(kept.content[0]!.text).toBe("Kept as fact-1.");
    expect(kept.terminate).toBeUndefined();
    const refused = await execute("2", { kind: "fact", text: "invented", evidence: ["ev-9"] });
    expect(refused.content[0]!.text).toBe("Not kept: no recorded evidence has ref ev-9.");
    expect(toolbox.proposal()).toBeUndefined();
    expect(submitted).toHaveLength(2);
  });
});
