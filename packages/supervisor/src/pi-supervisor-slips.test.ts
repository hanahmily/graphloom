// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { RunView } from "@graphloom/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { wrapPiAgentSession, type PiSupervisorSession } from "./pi-session.js";
import { createPiSupervisor, type SupervisorModelRef } from "./pi-supervisor.js";
import { isSupervisorProviderError, type SupervisorProviderError } from "./provider-failure.js";
import type { SupervisorInput } from "./types.js";

type Step = unknown;
interface Faux {
  provider: unknown;
  state: { callCount: number };
  setResponses(responses: Step[]): void;
  getModel(id?: string): unknown;
}
interface FauxModule {
  fauxProvider(options?: { provider?: string; models?: Array<{ id: string }> }): Faux;
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
  fauxThinking(text: string): unknown;
}
interface FauxContext {
  messages: Array<{ role: string; content?: unknown }>;
}

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

const PROVIDER = "faux-slip";
/** Markers a faux reply carries so the session gives it real-provider usage (see World.open). */
const BILLED = "#billed-undelivered";
const NO_SURPLUS = "#no-surplus";
const PRIMARY: SupervisorModelRef = { provider: PROVIDER, modelId: "faux" };
const SECONDARY: SupervisorModelRef = { provider: PROVIDER, modelId: "faux-2" };

interface World {
  ai: FauxModule;
  faux: Faux;
  /** Models each session was opened on, in order. */
  opened: string[];
  open(model?: SupervisorModelRef): Promise<PiSupervisorSession>;
}

async function world(): Promise<World> {
  const ai = await loadPiAi();
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-slip-"));
  temps.push(dir);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
  const faux = ai.fauxProvider({ provider: PROVIDER, models: [{ id: "faux" }, { id: "faux-2" }] });
  modelRuntime.registerNativeProvider(faux.provider as never);
  const w: World = {
    ai,
    faux,
    opened: [],
    async open(model = PRIMARY) {
      w.opened.push(model.modelId);
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: faux.getModel(model.modelId) as never,
        thinkingLevel: "off",
        modelRuntime,
        noTools: "all",
        tools: [],
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      // The faux provider estimates usage from the delivered content; give a
      // marked reply the usage a real provider reports (reasoning within output).
      session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const message = event.message as { content: Array<{ type: string; thinking?: string }>; usage: { output: number; reasoning?: number } };
        const thinking = message.content.find((c) => c.type === "thinking")?.thinking ?? "";
        if (thinking.includes(BILLED)) Object.assign(message.usage, { output: 3694, reasoning: 3118 });
        else if (thinking.includes(NO_SURPLUS)) Object.assign(message.usage, { output: 800, reasoning: 790 });
      });
      return wrapPiAgentSession({
        session,
        modelRuntime,
        runId: "run-slip",
        provider: model.provider,
        modelId: model.modelId,
        agentDir: dir,
        credentialSource: "pi-stored",
        promptTimeoutMs: 10_000,
      });
    },
  };
  return w;
}

function input(extra: Partial<SupervisorInput> = {}): SupervisorInput {
  const view: RunView = {
    runId: "run-slip",
    task: { request: "write hello", repo: "/repo" },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 20, jobs: 8, decisions: 8, corrections: 2 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 1,
    activeVersion: "hello@1",
  };
  return { runId: "run-slip", episodeId: "ep-1", trigger: { code: "supervise", message: "stuck" }, view, maxProviderCalls: 20, ...extra };
}

async function failure(promise: Promise<unknown>): Promise<SupervisorProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isSupervisorProviderError(err)) throw new Error(`expected a SupervisorProviderError, got ${String(err)}`);
  return err;
}

const thinkingOnly = (w: World) => w.ai.fauxAssistantMessage([w.ai.fauxThinking("record_finding, then reenter write")]);
const bareText = (w: World) => w.ai.fauxAssistantMessage("reenter");
const reenterCall = (w: World) =>
  w.ai.fauxToolCall("reenter", { reason: "retry the write", reenter: { stageId: "write", reason: "transient failure" } });
const stopTurn = (w: World) =>
  w.ai.fauxAssistantMessage(
    w.ai.fauxToolCall("stop", { reason: "nothing left", stop: { reason: "no remedy", blocker: "none" } }),
    { stopReason: "toolUse" },
  );

describe("Pi supervisor: no provider call after an admitted proposal (faux provider)", () => {
  it("ends a [record_finding, reenter] batch with the proposal and no further provider request", async () => {
    const w = await world();
    const findings: unknown[] = [];
    w.faux.setResponses([
      w.ai.fauxAssistantMessage(
        [w.ai.fauxToolCall("record_finding", { kind: "open", text: "why did write fail?" }), reenterCall(w)],
        { stopReason: "toolUse" },
      ),
      // What Pi would otherwise ask for: a summary after the tool batch.
      w.ai.fauxAssistantMessage("I recorded a finding and proposed reenter."),
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      const proposal = await supervisor.decide(
        input({
          recordFinding: async (finding) => {
            findings.push(finding);
            return { kept: true, id: "f1" };
          },
        }),
      );
      expect(proposal).toMatchObject({ action: { type: "reenter", reenter: { stageId: "write" } } });
      expect(findings).toHaveLength(1);
      expect(w.faux.state.callCount).toBe(1);
      expect(supervisor.drainProviderCalls()).toBe(1);
      expect(supervisor.drainRemedies()).toEqual([]);

      // The aborted turn left the session usable: the next turn is one call too.
      w.faux.setResponses([stopTurn(w)]);
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "stop" } });
      expect(w.faux.state.callCount).toBe(2);
      expect(supervisor.drainProviderCalls()).toBe(1);
    } finally {
      await supervisor.close!();
    }
  });
});

describe("Pi supervisor: bounded remedies for empty and malformed replies (faux provider)", () => {
  it("retries in a fresh episode session after a thinking-only reply and a thinking-only re-ask", async () => {
    const w = await world();
    let retried: FauxContext | undefined;
    w.faux.setResponses([
      thinkingOnly(w),
      thinkingOnly(w),
      (context: FauxContext) => {
        retried = context;
        return stopTurn(w);
      },
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "stop" } });
      expect(w.faux.state.callCount).toBe(3);
      expect(w.opened).toEqual(["faux", "faux"]);
      // The fresh session holds only the full recovery prompt, none of the slipped turns.
      expect(retried?.messages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user"]);
      expect(JSON.stringify(retried?.messages)).toContain("Episode: ep-1");
      expect(JSON.stringify(retried?.messages)).not.toContain("could not be read as a decision");
      expect(supervisor.drainProviderCalls()).toBe(3);
      expect(supervisor.drainRemedies()).toMatchObject([
        { failureClass: "empty", remedy: "reask" },
        { failureClass: "empty", remedy: "fresh_session_retry" },
      ]);
    } finally {
      await supervisor.close!();
    }
  });

  it("retries on the next configured model after three slips, for that turn only", async () => {
    const w = await world();
    let servedBy: string | undefined;
    let prompted: string | undefined;
    w.faux.setResponses([
      thinkingOnly(w),
      bareText(w),
      thinkingOnly(w),
      (context: FauxContext, _options: unknown, _state: unknown, model: { id: string }) => {
        servedBy = model.id;
        prompted = JSON.stringify(context.messages);
        return stopTurn(w);
      },
    ]);
    const supervisor = createPiSupervisor({
      session: await w.open(),
      openSession: (m) => w.open(m),
      configuredModels: [PRIMARY, SECONDARY],
    });
    try {
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "stop" } });
      expect(servedBy).toBe("faux-2");
      expect(prompted).toContain(`Your model is ${PROVIDER}/faux-2`);
      expect(w.faux.state.callCount).toBe(4);
      expect(w.opened).toEqual(["faux", "faux", "faux-2"]);
      expect(supervisor.drainProviderCalls()).toBe(4);
      expect(supervisor.drainRemedies()).toMatchObject([
        { failureClass: "empty", remedy: "reask" },
        { failureClass: "malformed", remedy: "fresh_session_retry" },
        { failureClass: "empty", remedy: "model_retry", model: SECONDARY },
      ]);
      // A transient per-attempt model: the binding never moved, so nothing is journaled.
      expect(supervisor.binding).toMatchObject({ provider: PROVIDER, modelId: "faux", switchJournal: [] });

      // The next turn runs on the bound model again.
      let nextServedBy: string | undefined;
      w.faux.setResponses([
        (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
          nextServedBy = model.id;
          return stopTurn(w);
        },
      ]);
      await supervisor.decide(input());
      expect(nextServedBy).toBe("faux");
    } finally {
      await supervisor.close!();
    }
  });

  it("stops naming every remedy it tried once all of them slipped", async () => {
    const w = await world();
    w.faux.setResponses([thinkingOnly(w), thinkingOnly(w), bareText(w), bareText(w), stopTurn(w)]);
    const supervisor = createPiSupervisor({
      session: await w.open(),
      openSession: (m) => w.open(m),
      configuredModels: [PRIMARY, SECONDARY],
    });
    try {
      const err = await failure(supervisor.decide(input()));
      expect(err.failureClass).toBe("malformed");
      expect(err.message).toMatch(/^supervisor provider malformed: .*reply began: "reenter"/);
      expect(err.unremedied).toBe(
        `already re-asked once, then retried in a fresh session, then retried on ${PROVIDER}/faux-2 in this turn`,
      );
      expect(w.faux.state.callCount).toBe(4);
      expect(supervisor.drainProviderCalls()).toBe(4);
      expect(supervisor.drainRemedies().map((r) => r.remedy)).toEqual(["reask", "fresh_session_retry", "model_retry"]);
      expect(supervisor.binding.modelId).toBe("faux");
    } finally {
      await supervisor.close!();
    }
  });

  it("names why a remedy was unavailable: one configured model", async () => {
    const w = await world();
    w.faux.setResponses([thinkingOnly(w), thinkingOnly(w), thinkingOnly(w), stopTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      const err = await failure(supervisor.decide(input()));
      expect(err.failureClass).toBe("empty");
      expect(err.unremedied).toBe("already re-asked once, then retried in a fresh session in this turn; no other configured model to try");
      expect(w.faux.state.callCount).toBe(3);
    } finally {
      await supervisor.close!();
    }
  });

  it("makes no further attempt once the turn's provider-call allowance is spent", async () => {
    const w = await world();
    w.faux.setResponses([thinkingOnly(w), thinkingOnly(w), stopTurn(w)]);
    const supervisor = createPiSupervisor({
      session: await w.open(),
      openSession: (m) => w.open(m),
      configuredModels: [PRIMARY, SECONDARY],
    });
    try {
      const err = await failure(supervisor.decide(input({ maxProviderCalls: 2 })));
      expect(err.failureClass).toBe("empty");
      expect(err.unremedied).toBe("already re-asked once in this turn; no provider calls left in the run's budget to retry");
      expect(w.faux.state.callCount).toBe(2);
      expect(w.opened).toEqual(["faux"]);
      expect(supervisor.drainProviderCalls()).toBe(2);
    } finally {
      await supervisor.close!();
    }
  });

  it("lets Stop win over a slip remedy", async () => {
    const w = await world();
    const abort = new AbortController();
    w.faux.setResponses([
      () => {
        abort.abort();
        return thinkingOnly(w);
      },
      stopTurn(w),
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      const err = await supervisor.decide(input({ signal: abort.signal })).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(w.faux.state.callCount).toBe(1);
      expect(w.opened).toEqual(["faux"]);
      expect(supervisor.drainRemedies()).toEqual([]);
    } finally {
      await supervisor.close!();
    }
  });
});

describe("Pi supervisor: interrupted replies are resent unchanged (faux provider)", () => {
  /** MiniMax's failure: thinking only, end_turn, but billed for output (the dropped tool calls) it never sent. */
  const interrupted = (w: World) => w.ai.fauxAssistantMessage([w.ai.fauxThinking(`Let me write it. ${BILLED}`)]);
  const reenterTurn = (w: World) => w.ai.fauxAssistantMessage(reenterCall(w), { stopReason: "toolUse" });
  /** What the model sees of a request: each non-system message's role and content (timestamps differ on a resend). */
  const visible = (context: FauxContext | undefined) =>
    (context?.messages ?? []).filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

  it("resends the identical prompt once, without the broken reply or any re-ask text", async () => {
    const w = await world();
    let first: string | undefined;
    let resent: FauxContext | undefined;
    w.faux.setResponses([
      (context: FauxContext) => {
        first = JSON.stringify(visible(context));
        return interrupted(w);
      },
      (context: FauxContext) => {
        resent = context;
        return reenterTurn(w);
      },
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "reenter" } });
      expect(w.faux.state.callCount).toBe(2);
      expect(w.opened).toEqual(["faux"]);
      expect(visible(resent).map((m) => m.role)).toEqual(["user"]);
      const sent = JSON.stringify(visible(resent));
      expect(sent).toBe(first);
      expect(sent).not.toContain(BILLED);
      expect(sent).not.toContain("could not be read as a decision");
      expect(supervisor.drainProviderCalls()).toBe(2);
      expect(supervisor.drainRemedies()).toMatchObject([
        { failureClass: "interrupted", remedy: "resend_interrupted", message: expect.stringMatching(/billed 576 output tokens beyond thinking/) },
      ]);
    } finally {
      await supervisor.close!();
    }
  });

  it("resends twice, then succeeds", async () => {
    const w = await world();
    w.faux.setResponses([interrupted(w), interrupted(w), reenterTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "reenter" } });
      expect(w.faux.state.callCount).toBe(3);
      expect(supervisor.drainRemedies().map((r) => r.remedy)).toEqual(["resend_interrupted", "resend_interrupted"]);
    } finally {
      await supervisor.close!();
    }
  });

  it("falls into the slip remedies after a third interrupted reply", async () => {
    const w = await world();
    let reasked: string | undefined;
    w.faux.setResponses([
      interrupted(w),
      interrupted(w),
      interrupted(w),
      (context: FauxContext) => {
        reasked = JSON.stringify(visible(context));
        return reenterTurn(w);
      },
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "reenter" } });
      expect(w.faux.state.callCount).toBe(4);
      expect(reasked).toContain("could not be read as a decision");
      expect(supervisor.drainRemedies()).toMatchObject([
        { failureClass: "interrupted", remedy: "resend_interrupted" },
        { failureClass: "interrupted", remedy: "resend_interrupted" },
        { failureClass: "interrupted", remedy: "reask" },
      ]);
    } finally {
      await supervisor.close!();
    }
  });

  it("still classifies a thinking-only reply with no undelivered output as empty and re-asks", async () => {
    const w = await world();
    w.faux.setResponses([w.ai.fauxAssistantMessage([w.ai.fauxThinking(`Thinking. ${NO_SURPLUS}`)]), reenterTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      expect(await supervisor.decide(input())).toMatchObject({ action: { type: "reenter" } });
      expect(w.faux.state.callCount).toBe(2);
      expect(supervisor.drainRemedies()).toMatchObject([{ failureClass: "empty", remedy: "reask" }]);
    } finally {
      await supervisor.close!();
    }
  });

  it("does not resend without a provider call left in the turn's allowance", async () => {
    const w = await world();
    w.faux.setResponses([interrupted(w), reenterTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      const err = await failure(supervisor.decide(input({ maxProviderCalls: 1 })));
      expect(err.failureClass).toBe("interrupted");
      expect(err.unremedied).toBe("no provider calls left in the run's budget to retry");
      expect(w.faux.state.callCount).toBe(1);
      expect(supervisor.drainRemedies()).toEqual([]);
    } finally {
      await supervisor.close!();
    }
  });

  it("lets Stop win over a resend", async () => {
    const w = await world();
    const abort = new AbortController();
    w.faux.setResponses([
      () => {
        abort.abort();
        return interrupted(w);
      },
      reenterTurn(w),
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: (m) => w.open(m) });
    try {
      await expect(supervisor.decide(input({ signal: abort.signal }))).rejects.toThrow();
      expect(w.faux.state.callCount).toBe(1);
      expect(supervisor.drainRemedies()).toEqual([]);
    } finally {
      await supervisor.close!();
    }
  });
});
