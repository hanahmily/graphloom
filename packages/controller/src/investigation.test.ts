// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { reenter, stop, type GraphDecision } from "@graphloom/sdk";
import type { InvestigationStep, SupervisorEpisodeRecord } from "@graphloom/supervisor";
import { recordFinding } from "./case-file.js";
import { groundingRefusal } from "./inadmissible.js";
import { citedInvestigationEvidence, episodeInvestigation } from "./investigation.js";
import type { DurableRunState } from "./state.js";

function step(n: number, tool = "Bash"): InvestigationStep {
  return { id: `inv-${n}`, harness: "claude-code", kind: "command", tool, input: { command: `cmd ${n}` }, output: "out", exitCode: 1, at: "2026-10-27T00:00:00.000Z" };
}

function state(records: Array<Partial<SupervisorEpisodeRecord>> = []): DurableRunState {
  return {
    generation: 1,
    activeVersion: "hello@0.1.0",
    candidateDigest: "digest-a",
    evidence: [{ ref: "ev-1", kind: "other" }],
    intake: { bundle: { manifestDigest: "m", entryDigest: "e" } },
    supervisorEpisodes: records as SupervisorEpisodeRecord[],
  } as unknown as DurableRunState;
}

const qualify = (target: string, refs: string[]): GraphDecision => ({
  action: { type: "qualify_repair", qualify: { target: target as "validator", reason: "x", evidenceRefs: refs } },
  reason: "repair",
});

describe("investigation steps as citations (design-supervisor-harnesses.md §5.3)", () => {
  it("collects the episode's recorded and live steps, and what a restart numbers after", () => {
    const s = state([
      { episodeId: "ep-1", investigation: [step(1), step(2)], droppedInvestigation: 2 },
      { episodeId: "ep-2", investigation: [step(1)] },
      { episodeId: "ep-1", investigation: [step(5)] },
    ]);
    const inv = episodeInvestigation(s, "ep-1", [step(6)]);
    expect([...inv.ids].sort()).toEqual(["inv-1", "inv-2", "inv-3", "inv-4", "inv-5", "inv-6"]);
    // A dropped step is still citable, its content is not kept.
    expect(inv.steps.has("inv-3")).toBe(false);
    expect(inv.numbered).toBe(5);
    expect(episodeInvestigation(s, "ep-3").numbered).toBe(0);
    // A record the size bound shrank from the front still makes its earlier ids citable.
    const shrunk = episodeInvestigation(state([{ episodeId: "ep-1", investigation: [step(31), step(50)] }]), "ep-1");
    expect(shrunk.ids.has("inv-1")).toBe(true);
    expect(shrunk.ids.has("inv-51")).toBe(false);
    expect(shrunk.numbered).toBe(50);
    expect(citedInvestigationEvidence(inv, ["inv-1", "inv-3", "ev-1"])).toEqual([
      { ref: "inv-1", kind: "other", payload: { investigation: step(1) } },
      { ref: "inv-3", kind: "other", payload: { investigation: { id: "inv-3", note: expect.stringMatching(/no longer kept/) } } },
    ]);
  });

  it("admits a reenter grounded on a step, and refuses an unknown step", () => {
    const s = state();
    const steps = new Set(["inv-1", "inv-2"]);
    const grounded = reenter({ stageId: "fix", reason: "the build fails", evidenceRefs: ["inv-2"] }, "retry");
    expect(groundingRefusal(s, grounded, new Set(), steps)).toBeUndefined();
    const unknown = reenter({ stageId: "fix", reason: "x", evidenceRefs: ["inv-9"] }, "retry");
    expect(groundingRefusal(s, unknown, new Set(), steps)).toMatchObject({
      precondition: "reenter cites unknown evidence",
      detail: expect.stringMatching(/inv-9 .*investigation steps this episode: inv-1, inv-2/),
    });
    // Without steps (Pi) an inv- id is unknown, as before.
    expect(groundingRefusal(s, grounded, new Set())).toMatchObject({ precondition: "reenter cites unknown evidence" });
  });

  it("refuses a claim about the controller or a validator that rests on steps alone", () => {
    const s = state();
    const steps = new Set(["inv-1"]);
    const stopOnStep = stop({ reason: "validation cannot pass", blocker: "greeting-bytes", evidenceRefs: ["inv-1"] }, "stop");
    expect(groundingRefusal(s, stopOnStep, new Set(), steps)).toMatchObject({
      precondition: "stop rests on investigation steps alone",
      detail: expect.stringMatching(/cite check_validate for a claim about validation/),
    });
    expect(groundingRefusal(s, qualify("validator", ["inv-1"]), new Set(), steps)).toMatchObject({ precondition: "qualify_repair rests on investigation steps alone" });
    expect(groundingRefusal(s, qualify("executor", ["inv-1"]), new Set(), steps)).toMatchObject({ precondition: "qualify_repair rests on investigation steps alone" });
    // A probe or recorded evidence beside the step grounds it; a plugin repair may rest on code alone.
    expect(groundingRefusal(s, { ...stopOnStep, evidence: ["probe-1"] }, new Set(["probe-1"]), steps)).toBeUndefined();
    expect(groundingRefusal(s, qualify("validator", ["inv-1", "ev-1"]), new Set(), steps)).toBeUndefined();
    expect(groundingRefusal(s, qualify("plugin", ["inv-1"]), new Set(), steps)).toBeUndefined();
  });

  it("keeps a finding that cites a step, qualified by its episode", () => {
    const kept = recordFinding(state(), { kind: "fact", text: "x.go lacks the nil check", evidence: ["inv-2", "ev-1"] }, "ep-4", new Set(["inv-2"]));
    expect(kept.outcome).toEqual({ kept: true, id: "fact-1" });
    expect(kept.state.caseFile?.facts[0]?.evidence).toEqual(["inv-2@ep-4", "ev-1"]);
    const refused = recordFinding(state(), { kind: "fact", text: "x", evidence: ["inv-7"] }, "ep-4", new Set(["inv-2"]));
    expect(refused.outcome).toEqual({ kept: false, reason: "no recorded evidence or investigation step of this episode has ref inv-7" });
  });
});
