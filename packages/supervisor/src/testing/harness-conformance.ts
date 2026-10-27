// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `harnessConformance(target)`: what every SupervisorHarness must do behind
 * the supervisor host (design-supervisor-harnesses.md §9, "S2 host
 * contract"), driven through scripted sessions: decisions, the rejection loop,
 * every remedy, inspection, findings, model switching, candidate grants,
 * episodes and investigation steps, restore, and replay fidelity. Tests only.
 */
import {
  dispatch,
  observe,
  reenter,
  returnToNormal,
  stop,
  validate,
  type CaseFinding,
  type CaseFindingOutcome,
  type GraphDecision,
  type RunView,
} from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import type { SupervisorEpisodeRecord } from "../episode.js";
import { loadReplayFixtures, replayEpisodes } from "../episode-replay.js";
import type { HarnessCapabilities, SupervisorHarness, SupervisorHost, SupervisorModelRef } from "../harness.js";
import { isSupervisorProviderError } from "../provider-failure.js";
import { MAX_INSPECT_ROUNDS } from "../reply.js";
import type { ProbeResult, SupervisorInput, SupervisorInspection, SupervisorRejection } from "../types.js";
import type { DecisionMode, ScriptLog, ScriptStep } from "./scripted-harness.js";

export interface ConformanceBuild {
  harness: SupervisorHarness;
  log: ScriptLog;
  /** A new logical supervisor on the first configured model. */
  start(): Promise<SupervisorHost>;
  remaining(): number;
}

export interface ConformanceTarget {
  /** The harness name its bindings record. */
  name: string;
  capabilities: HarnessCapabilities;
  mode: DecisionMode;
  build(args: { script: ScriptStep[]; models: SupervisorModelRef[]; transientRetryBaseMs?: number; quotaRetryMs?: number }): ConformanceBuild;
}

function view(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run-conf",
    task: { request: "fix it", repo: "." },
    current: { stageId: "fix", attempt: 1 },
    receipts: [],
    evidence: [{ ref: "ev-1", kind: "command", stageId: "fix", generation: 1, payload: { exitCode: 1 } } as unknown as RunView["evidence"][number]],
    outstanding: [],
    budgets: { agentInvocations: 40, jobs: 10, decisions: 10, corrections: 4 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 3,
    activeVersion: "hello@0.1.0",
    ...over,
  };
}

interface Controls {
  /** Rejections `admission.check` returns before it admits, in order. */
  rejections?: SupervisorRejection[];
  findings?: CaseFinding[];
}

/** A decide() input with the controller's admission, findings and inspection as fakes that record their use. */
function turn(episodeId: string, controls: Controls = {}, extra: Partial<SupervisorInput> = {}) {
  const pendingRejections = [...(controls.rejections ?? [])];
  const checked: GraphDecision[] = [];
  const refused: string[] = [];
  const findings: CaseFinding[] = [];
  const order: string[] = [];
  const probes: Array<{ stageId: string }> = [];
  let findingIds = 0;
  const inspect: SupervisorInspection = {
    getEvidence: (ref) => (ref === "ev-1" ? view().evidence[0] : undefined),
    listEvidence: () => view().evidence,
    listReceipts: () => [],
    readCandidate: async (p) => ({ text: `contents of ${p}` }),
    diffCandidate: async () => ({ diff: "" }),
    checkValidate: async (spec): Promise<ProbeResult> => {
      probes.push({ stageId: spec.stageId });
      return { probeId: `probe-${probes.length}`, accepted: false, reason: "greeting-bytes failed", stateRevision: 3, evaluated: true };
    },
    checkActivation: async () => ({ probeId: "probe-a", accepted: false, reason: "no candidate", stateRevision: 3 }),
    checkCheckout: async () => ({ probeId: "probe-c", accepted: true, reason: "applies", stateRevision: 3 }),
  };
  const input: SupervisorInput = {
    runId: "run-conf",
    episodeId,
    trigger: { code: "executor_failed", message: "the fix job failed" },
    view: view(),
    maxWaitMs: 60_000,
    admission: {
      facts: { inRecovery: true, canQualify: true, qualifiedArtifactIds: [] },
      async check(decision) {
        order.push(`check:${decision.action.type}`);
        checked.push(decision);
        return pendingRejections.shift();
      },
      async refuse(action, reason) {
        refused.push(`${action}: ${reason}`);
        return { action, reason, remaining: 2 };
      },
    },
    async recordFinding(finding): Promise<CaseFindingOutcome> {
      order.push("finding");
      findings.push(finding);
      findingIds += 1;
      return { kept: true, id: `f-${findingIds}` };
    },
    inspect,
    ...extra,
  };
  return { input, checked, refused, findings, order, probes };
}

const PRIMARY = (name: string): SupervisorModelRef => ({ provider: name === "pi" ? "faux" : name, modelId: "primary" });
const SECONDARY = (name: string): SupervisorModelRef => ({ provider: name === "pi" ? "faux" : name, modelId: "secondary" });

const REENTER = reenter({ stageId: "fix", reason: "the job failed on a flaky step", evidenceRefs: ["ev-1"] }, "retry the stage");
const RETURN = returnToNormal({ summary: "let the graph retry" }, "hand back");

/** Why the remedies did not apply, from the SupervisorProviderError `p` rejects with. */
async function unremedied(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isSupervisorProviderError(err)) throw new Error(`expected a SupervisorProviderError, got ${String(err)}`);
  return err.unremedied;
}

/**
 * The action types admission checked, each run of repeats once: a tool-call
 * harness's admitted proposal is checked by its tool and again by the host.
 */
function checkedTypes(checked: readonly GraphDecision[]): string[] {
  return checked.map((d) => d.action.type).filter((type, i, all) => i === 0 || all[i - 1] !== type);
}

function actionOf(proposal: unknown): string | undefined {
  const p = proposal as { action?: { type?: string }; type?: string };
  return p.action?.type ?? p.type;
}

export function harnessConformance(target: ConformanceTarget): void {
  const { name, mode, capabilities } = target;
  const models = [PRIMARY(name), SECONDARY(name)];
  const build = (script: ScriptStep[], extra: { transientRetryBaseMs?: number; quotaRetryMs?: number } = {}) =>
    target.build({ script, models, ...extra });
  const promptsOf = (log: ScriptLog) => log.prompts.map((p) => p.text);

  describe(`${name} harness conformance (${mode} protocol)`, () => {
    it("decides, records the harness in the binding, and charges the turn's provider calls", async () => {
      const b = build([{ decide: REENTER }]);
      const host = await b.start();
      const t = turn("ep-1");
      const proposal = await host.decide(t.input);
      expect(actionOf(proposal)).toBe("reenter");
      expect(checkedTypes(t.checked)).toEqual(["reenter"]);
      expect(host.binding).toMatchObject({ harness: name, provider: models[0]!.provider, modelId: "primary" });
      expect(host.drainProviderCalls()).toBeGreaterThanOrEqual(1);
      expect(host.drainProviderCalls()).toBe(0);
      expect(b.log.prompts[0]!.text).toContain("You are the GraphLoom run supervisor in recovery.");
      if (mode === "reply") {
        expect(b.log.prompts[0]!.text).toContain('{"inspect"');
        expect(b.log.prompts[0]!.text).not.toContain("by calling one GraphLoom tool");
      } else {
        expect(b.log.prompts[0]!.text).toContain("by calling one GraphLoom tool");
      }
      await host.close();
    });

    it("returns an inadmissible proposal to the agent in the same turn, and stops on the controller's last rejection", async () => {
      const b = build([{ decide: RETURN }, { decide: REENTER }, { decide: validate({ stageId: "fix" }, "check it") }]);
      const host = await b.start();
      const t = turn("ep-1", {
        rejections: [
          { action: "return", reason: "the stage has no receipt yet", remaining: 2 },
          { action: "reenter", reason: "attempt limit", remaining: 1 },
        ],
      });
      const proposal = await host.decide(t.input);
      expect(actionOf(proposal)).toBe("validate");
      expect(checkedTypes(t.checked)).toEqual(["return", "reenter", "validate"]);
      if (mode === "reply") {
        // Each rejection is the next user turn of the same session.
        expect(new Set(b.log.prompts.map((p) => p.session)).size).toBe(1);
        expect(b.log.prompts[1]!.text).toContain("Rejected: the controller would not admit this return: the stage has no receipt yet");
      }
      const exhausted = build([{ decide: RETURN }]);
      const host2 = await exhausted.start();
      const t2 = turn("ep-1", { rejections: [{ action: "return", reason: "no", remaining: 0 }] });
      await expect(host2.decide(t2.input)).rejects.toThrow(/inadmissible proposal/);
      await host.close();
      await host2.close();
    });

    it("applies the slip ladder to empty and malformed replies: re-ask, fresh session, next model, then stop", async () => {
      const b = build([{ empty: true }, { text: "I think we should retry." }, { empty: true }, { empty: true }]);
      const host = await b.start();
      const t = turn("ep-1");
      expect(await unremedied(host.decide(t.input))).toMatch(/re-asked once, then retried in a fresh session, then retried on .*secondary/);
      expect(host.drainRemedies().map((r) => r.remedy)).toEqual(["reask", "fresh_session_retry", "model_retry"]);
      expect(b.log.opened.map((o) => o.model)).toEqual([`${models[0]!.provider}/primary`, `${models[0]!.provider}/primary`, `${models[0]!.provider}/secondary`]);
      // The transient model is for that turn only.
      expect(host.binding.modelId).toBe("primary");
      await host.close();

      const recovered = build([{ text: "not json" }, { decide: REENTER }]);
      const host2 = await recovered.start();
      expect(actionOf(await host2.decide(turn("ep-1").input))).toBe("reenter");
      expect(host2.drainRemedies().map((r) => [r.failureClass, r.remedy])).toEqual([["malformed", "reask"]]);
      expect(promptsOf(recovered.log)[1]).toContain("Your reply could not be read as a decision");
      await host2.close();
    });

    it("waits out a quota reset, backs off a transient error, and retries", async () => {
      const soon = new Date(Date.now() + 20).toISOString();
      const b = build(
        [
          { fail: { failureClass: "quota", message: "usage limit", retryAt: soon } },
          { fail: { failureClass: "transient", message: "529 overloaded" } },
          { decide: REENTER },
        ],
        { transientRetryBaseMs: 1 },
      );
      const host = await b.start();
      expect(actionOf(await host.decide(turn("ep-1").input))).toBe("reenter");
      expect(host.drainRemedies().map((r) => [r.failureClass, r.remedy])).toEqual([
        ["quota", "wait_and_retry"],
        ["transient", "backoff_and_retry"],
      ]);
      await host.close();

      const noReset = build([{ fail: { failureClass: "quota", message: "usage limit" } }]);
      const host2 = await noReset.start();
      expect(await unremedied(host2.decide(turn("ep-1").input))).toMatch(/no reset time/);
      await host2.close();
    });

    it("retries a timed-out prompt once in a fresh session, then stops naming the timeout", async () => {
      const b = build([{ timeout: true }, { decide: REENTER }]);
      const host = await b.start();
      expect(actionOf(await host.decide(turn("ep-1").input))).toBe("reenter");
      expect(host.drainRemedies().map((r) => r.remedy)).toEqual(["fresh_session_retry"]);
      expect(b.log.opened).toHaveLength(2);
      // The fresh session gets the full prompt.
      expect(promptsOf(b.log)[1]).toContain("You are the GraphLoom run supervisor in recovery.");
      await host.close();

      const twice = build([{ timeout: true }, { timeout: true }]);
      const host2 = await twice.start();
      const err = await host2.decide(turn("ep-1").input).catch((e: unknown) => e);
      expect(isSupervisorProviderError(err) && err.failureClass).toBe("timeout");
      expect(await unremedied(Promise.reject(err))).toBe("already retried once");
      await host2.close();
    });

    it(`recovers from a context overflow once (${capabilities.compaction ? "compact_and_retry" : "fresh_session_retry"})`, async () => {
      const b = build([{ fail: { failureClass: "overflow", message: "context window exceeded" } }, { decide: REENTER }]);
      const host = await b.start();
      expect(actionOf(await host.decide(turn("ep-1").input))).toBe("reenter");
      expect(host.drainRemedies().map((r) => r.remedy)).toEqual([capabilities.compaction ? "compact_and_retry" : "fresh_session_retry"]);
      if (capabilities.compaction) expect(b.log.compactions).toBe(1);
      else expect(b.log.opened).toHaveLength(2);
      await host.close();
    });

    it("runs GraphLoom's inspection for the agent and charges each round to the turn", async () => {
      const b = build([
        { inspect: [{ tool: "check_validate", args: { stageId: "fix" } }, { tool: "get_evidence", args: { ref: "ev-1" } }] },
        { decide: { ...stop({ reason: "validation cannot pass", blocker: "greeting-bytes", evidenceRefs: ["probe-1"] }, "stop"), evidence: ["probe-1"] } },
      ]);
      const host = await b.start();
      const t = turn("ep-1");
      const proposal = await host.decide(t.input);
      expect(actionOf(proposal)).toBe("stop");
      expect(t.probes).toEqual([{ stageId: "fix" }]);
      if (mode === "reply") {
        expect(promptsOf(b.log)[1]).toContain("GraphLoom inspection results:");
        expect(promptsOf(b.log)[1]).toContain("probe-1");
        expect(host.drainProviderCalls()).toBe(2);
      } else {
        expect(b.log.toolCalls).toEqual(["check_validate", "get_evidence", "stop"]);
      }
      await host.close();
    });

    if (mode === "reply") {
      it(`asks for a decision after ${MAX_INSPECT_ROUNDS} inspect rounds`, async () => {
        const ask = { inspect: [{ tool: "list_receipts", args: {} }] };
        const b = build([...Array.from({ length: MAX_INSPECT_ROUNDS + 1 }, () => ask), { decide: REENTER }]);
        const host = await b.start();
        expect(actionOf(await host.decide(turn("ep-1").input))).toBe("reenter");
        expect(promptsOf(b.log)[MAX_INSPECT_ROUNDS]).toContain("That was the last inspect round this turn");
        expect(host.drainRemedies().map((r) => [r.failureClass, r.remedy])).toEqual([["malformed", "reask"]]);
        await host.close();
      });
    }

    it("records findings before the decision is checked and reports them back", async () => {
      const finding: CaseFinding = { kind: "fact", text: "the fix job fails on a missing tool", evidence: ["ev-1"] };
      const b = build([{ decide: RETURN, findings: [finding] }, { decide: REENTER }]);
      const host = await b.start();
      const t = turn("ep-1", { rejections: [{ action: "return", reason: "no receipt", remaining: 2 }] });
      expect(actionOf(await host.decide(t.input))).toBe("reenter");
      expect(t.findings).toEqual([finding]);
      expect(t.order.slice(0, 2)).toEqual(["finding", "check:return"]);
      if (mode === "reply") expect(promptsOf(b.log)[1]).toContain("Finding kept as f-1");
      await host.close();
    });

    it("switches only to a configured model, journaling every switch", async () => {
      const b = build([{ switchModel: { ...models[1]!, reason: "the primary keeps slipping" } }, { decide: REENTER }]);
      const host = await b.start();
      const proposal = await host.decide(turn("ep-1").input);
      expect(proposal).toEqual({ type: "switch_model", provider: models[1]!.provider, modelId: "secondary", reason: "the primary keeps slipping" });
      await host.switchModel({ ...models[1]!, reason: "the primary keeps slipping" });
      expect(host.binding).toMatchObject({ modelId: "secondary", harness: name });
      expect(host.binding.switchJournal.map((r) => r.status)).toEqual(["committed"]);
      if (capabilities.inSessionModelSwitch) {
        expect(b.log.setModel.map((s) => s.model)).toEqual([`${models[1]!.provider}/secondary`]);
        expect(b.log.opened).toHaveLength(1);
      } else {
        // A fresh session on the target; the turn's full prompt goes to it.
        expect(b.log.setModel).toEqual([]);
        expect(b.log.opened.map((o) => o.model)).toEqual([`${models[0]!.provider}/primary`, `${models[1]!.provider}/secondary`]);
      }
      const t2 = turn("ep-1", {}, { rejection: { action: "return", reason: "no receipt", remaining: 2 } });
      expect(actionOf(await host.decide(t2.input))).toBe("reenter");
      if (!capabilities.inSessionModelSwitch) expect(promptsOf(b.log).at(-1)).toContain("You are the GraphLoom run supervisor in recovery.");
      await expect(host.switchModel({ provider: "elsewhere", modelId: "x", reason: "try" })).rejects.toThrow(/not configured/);
      expect(host.binding.switchJournal.map((r) => r.status)).toEqual(["committed", "failed"]);
      await host.close();

      if (mode === "reply") {
        const off = build([{ switchModel: { provider: "other-harness", modelId: "big", reason: "bigger" } }, { decide: REENTER }]);
        const host2 = await off.start();
        expect(actionOf(await host2.decide(turn("ep-1").input))).toBe("reenter");
        expect(promptsOf(off.log)[1]).toMatch(/resume --supervisor/);
        await host2.close();
      }
    });

    it("grants candidate coding to the session that patches, and keeps the grant across a fresh session", async () => {
      const b = build([{ decide: REENTER }, { text: "Patched the validator's off-by-one; added a regression case." }, { decide: RETURN }]);
      const host = await b.start();
      await host.decide(turn("ep-1").input);
      await host.grantCandidateCoding("/state/repairs/a1/candidate");
      expect(host.candidateCodingRoot()).toBe("/state/repairs/a1/candidate");
      const patched = await host.patchCandidate!({ candidateRoot: "/state/repairs/a1/candidate", target: "validator", reason: "off by one" });
      expect(patched.summary).toContain("off-by-one");
      await expect(host.patchCandidate!({ candidateRoot: "/elsewhere", target: "validator", reason: "x" })).rejects.toThrow(/!= granted/);
      // A new episode opens a new session, which inherits the grant.
      await host.decide(turn("ep-2").input);
      expect(b.log.granted.map((g) => g.root)).toEqual(["/state/repairs/a1/candidate", "/state/repairs/a1/candidate"]);
      expect(new Set(b.log.granted.map((g) => g.session)).size).toBe(2);
      await host.revokeCandidateCoding();
      expect(host.candidateCodingRoot()).toBeUndefined();
      await host.close();
    });

    it("gives each episode its own session and its own investigation steps", async () => {
      const ran = { tool: "Bash", input: { command: "go test ./pkg/x" }, output: "FAIL", exitCode: 1 };
      const b = build([
        { text: "not json", observe: [ran] },
        { decide: REENTER, observe: [{ tool: "Read", input: { file_path: "pkg/x/x.go" }, output: "package x" }] },
        { decide: RETURN, observe: [ran] },
      ]);
      const host = await b.start();
      await host.decide(turn("ep-1").input);
      const first = host.drainInvestigation();
      await host.decide(turn("ep-2").input);
      const second = host.drainInvestigation();
      expect(new Set(b.log.prompts.map((p) => p.session)).size).toBe(2);
      if (mode === "reply") {
        expect(first.map((s) => [s.id, s.tool, s.exitCode])).toEqual([["inv-1", "Bash", 1], ["inv-2", "Read", undefined]]);
        expect(first.every((s) => s.harness === name)).toBe(true);
        // Numbering restarts with the episode.
        expect(second.map((s) => s.id)).toEqual(["inv-1"]);
        // The follow-up lists the steps so far, so the agent can cite them.
        expect(promptsOf(b.log)[1]).toContain('inv-1: Bash "go test ./pkg/x" exit 1');
      } else {
        expect(first).toEqual([]);
        expect(second).toEqual([]);
      }
      await host.close();
    });

    it("restores the logical supervisor from its binding on the bound model, in a fresh session", async () => {
      const b = build([{ decide: REENTER }]);
      const host = await b.harness.restore({
        sessionId: "logical-1",
        sessionFile: "/state/supervisor/old.jsonl",
        provider: models[1]!.provider,
        modelId: "secondary",
        switchJournal: [{ at: "2026-10-01T00:00:00.000Z", from: models[0]!, to: models[1]!, reason: "earlier", status: "committed" }],
        configuredModels: models,
        harness: name,
      });
      expect(host.sessionId).toBe("logical-1");
      expect(host.binding).toMatchObject({ sessionId: "logical-1", modelId: "secondary", harness: name });
      expect(host.binding.switchJournal).toHaveLength(1);
      expect(b.log.opened.map((o) => o.model)).toEqual([`${models[1]!.provider}/secondary`]);
      expect(actionOf(await host.decide(turn("ep-9").input))).toBe("reenter");
      await host.close();
    });

    it("scores the 9bfa446d-4ea replay fixtures as the scripted baseline does", async () => {
      const { episodes, labels } = await loadReplayFixtures();
      const byId = new Map(labels.map((l) => [l.episodeId, l]));
      const baseline = (e: SupervisorEpisodeRecord): GraphDecision => {
        const first = byId.get(e.episodeId)!.acceptable[0]!;
        const stageId = first.stageId ?? "fix";
        switch (first.type) {
          case "validate":
            return validate({ stageId }, "baseline");
          case "reenter":
            return reenter({ stageId, reason: "baseline" }, "baseline");
          case "dispatch":
            return dispatch({ stageId, kind: "agent", purpose: (first.purpose ?? "work") as "work", instruction: "baseline", writeScope: ["."] }, "baseline");
          case "return":
            return returnToNormal({ summary: "baseline" }, "baseline");
          case "observe":
            return observe({}, "baseline");
          case "activate_repair":
            return { action: { type: "activate_repair", activate: { qualifiedArtifactId: "cand-3", reason: "baseline" } }, reason: "baseline" };
          case "qualify_repair":
            return { action: { type: "qualify_repair", qualify: { target: "plugin", reason: "baseline" } }, reason: "baseline" };
          default:
            return stop({ reason: "baseline", blocker: "baseline" }, "baseline");
        }
      };
      const score = await replayEpisodes({
        episodes,
        labels,
        createSupervisor: (e) => build([{ decide: baseline(e) }]).start(),
      });
      expect(score.results).toHaveLength(episodes.length);
      expect(score.inadmissibleStops).toBe(0);
      expect(score.accuracy).toBe(1);
    });
  });
}
