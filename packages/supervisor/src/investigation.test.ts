// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { returnToNormal, type RunView } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import {
  buildEpisodeRecord,
  createEpisodeRecorder,
  MAX_EPISODE_RECORD_CHARS,
  MAX_EPISODE_TOOL_CALLS,
  MAX_EPISODE_TOOL_RESULT_CHARS,
} from "./episode.js";
import { investigationLines, isInvestigationStepId, type InvestigationStep } from "./investigation.js";

const view: RunView = {
  runId: "run-1",
  task: { request: "fix", repo: "." },
  current: { stageId: "fix", attempt: 1 },
  receipts: [],
  evidence: [],
  outstanding: [],
  budgets: { agentInvocations: 8, jobs: 8, decisions: 8, corrections: 2 },
  validatorBindings: [],
  generation: 1,
  stateRevision: 1,
  activeVersion: "hello@1",
};

function step(n: number, output: unknown = "ok"): InvestigationStep {
  return { id: `inv-${n}`, harness: "fake-cli", kind: "command", tool: "Bash", input: { command: `make test-${n}` }, output, exitCode: n % 2, at: "2026-10-27T00:00:00.000Z" };
}

function record(investigation?: InvestigationStep[]) {
  return buildEpisodeRecord({
    episodeId: "ep-1",
    turn: 1,
    runId: "run-1",
    trigger: { code: "supervise", message: "m" },
    view,
    recorder: createEpisodeRecorder(),
    ...(investigation !== undefined ? { investigation } : {}),
    proposal: returnToNormal({ summary: "s" }, "r"),
    admission: { rejections: [], outcome: "pending" },
    providerCalls: 1,
  });
}

describe("investigation steps in episode records", () => {
  it("adds nothing to a record when the harness recorded no steps (Pi)", () => {
    expect(record()).not.toHaveProperty("investigation");
    expect(record([])).not.toHaveProperty("investigation");
    expect(record([])).not.toHaveProperty("truncated");
  });

  it("keeps steps under the tool calls' bounds: count, per-field size, and the record's size", () => {
    const many = Array.from({ length: MAX_EPISODE_TOOL_CALLS + 5 }, (_, i) => step(i + 1));
    const kept = record(many);
    expect(kept.investigation).toHaveLength(MAX_EPISODE_TOOL_CALLS);
    expect(kept.investigation![0]).toMatchObject({ id: "inv-1", tool: "Bash", exitCode: 1 });
    expect(kept.droppedInvestigation).toBe(5);
    expect(kept.truncated).toBe(true);

    const big = record([step(1, "x".repeat(MAX_EPISODE_TOOL_RESULT_CHARS * 3))]);
    expect(JSON.stringify(big.investigation![0]!.output).length).toBeLessThanOrEqual(MAX_EPISODE_TOOL_RESULT_CHARS);
    expect(big.truncated).toBe(true);

    const huge = record(Array.from({ length: MAX_EPISODE_TOOL_CALLS }, (_, i) => step(i + 1, "y".repeat(MAX_EPISODE_TOOL_RESULT_CHARS))));
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(MAX_EPISODE_RECORD_CHARS);
    expect(Array.isArray(huge.investigation ?? [])).toBe(true);
  });

  it("lists steps for a follow-up prompt, one line each, and nothing when there are none", () => {
    expect(investigationLines([])).toEqual([]);
    const lines = investigationLines([step(3), { ...step(4), tool: "Read", kind: "file_read", input: { file_path: "pkg/x.go" }, exitCode: undefined }] as InvestigationStep[]);
    expect(lines.slice(1)).toEqual(['- inv-3: Bash "make test-3" exit 1', '- inv-4: Read "pkg/x.go"']);
    expect(isInvestigationStepId("inv-12")).toBe(true);
    expect(isInvestigationStepId("inv-0")).toBe(false);
    expect(isInvestigationStepId("ev-1")).toBe(false);
  });
});
