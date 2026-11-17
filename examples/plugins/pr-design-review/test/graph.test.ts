// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { agentRoles, createGraph, definitionFor, resultLine } from "../src/graph.js";
import { CREATE_PULL_REVIEW, GET_VIEWER } from "../src/kit/constants.js";
import { parseProfile } from "../src/kit/profile.js";
import { NOTE_LINE, PASSED_LINE, ROUND_LINE } from "../src/publish.js";
import { REHEARSAL_HEAD } from "../src/rehearsal.js";
import { recordedRound1 } from "../src/round1.js";
import { BANYANDB, simulate, type Simulation } from "./support.js";

const end = (scenarioName: string, over: Parameters<typeof simulate>[0] = {}): Simulation => simulate({ scenarioName, maxSteps: 900, through: "end", ...over });
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const commandIds = (s: Simulation): string[] => s.jobs.flatMap((j) => (j.kind === "command" && j.executor === undefined ? (j.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id) : []));
const NO_GRANT = [{ id: CREATE_PULL_REVIEW.id, version: "1", effectGranted: false }];
const PR = { owner: "apache", repo: "skywalking-banyandb", number: 7, head: REHEARSAL_HEAD };

describe("the design review's definition", () => {
  it("has six stages, round 1 only: Fetch, Report, Questions, Answers, Round 1 and Publish", () => {
    const d = definitionFor(parseProfile(BANYANDB, "pr-design-review"));
    expect(d.graphId).toBe("pr-design-review");
    expect(d.stages.map((s) => s.name)).toEqual(["Fetch", "Report", "Questions", "Answers", "Round 1", "Publish"]);
    expect(d.resultContracts!.map((c) => c.name)).not.toEqual(expect.arrayContaining(["pr-code-review-v1"]));
  });

  it("checks no Docker image and declares no reviewer or verifier role", () => {
    const d = createGraph().describe(BANYANDB);
    expect((d.environment?.checks ?? []).map((c) => c.id).filter((id) => id.startsWith("docker-") || id.startsWith("sandbox-"))).toEqual([]);
    expect(agentRoles(parseProfile(BANYANDB, "pr-design-review")).map((r) => r.role)).toEqual(["reporter", "diagrammer", "report-checker", "questioner", "answerer", "batch-answerer", "answer-checker"]);
  });

  it("reads a profile that also holds pr-review's keys, unread", () => {
    const shared = { ...BANYANDB, review: { repro: { enabled: false } }, rules: { anything: true }, checks: [{ id: "x" }], metrics: { ...(BANYANDB.metrics as object), coverage: true, sandbox: { go: { image: "golang:latest" } } }, harnesses: { ...(BANYANDB.harnesses as object), "reviewer-correctness": "codex" }, comments: { minSeverity: "P2", footer: "Reviewed by GraphLoom." } };
    expect(createGraph().describe(shared).stages).toHaveLength(6);
  });
});

describe("a run of the design review", () => {
  it("a clean round 1 posts nothing, makes no GitHub call, needs no write grant, records the head clean and names the PR review", () => {
    const sim = end("design-clean", { executors: NO_GRANT });
    expect(stopOf(sim)).toEqual({ reason: "complete", blocker: `design review clean at ${REHEARSAL_HEAD.slice(0, 7)}; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#7 --profile banyandb`, retryable: false });
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues).toEqual([]);
    expect(sim.github.creates).toEqual([]);
    expect(sim.jobs.filter((j) => j.executor?.id === GET_VIEWER.id || j.executor?.id === CREATE_PULL_REVIEW.id)).toEqual([]);
    expect(sim.receipts.filter((r) => r.valid).map((r) => r.stageId)).toContain("publish");
    expect(commandIds(sim)).toContain("ledger-published");
    const published = sim.jobs.find((j) => j.instruction.startsWith("Record this head's outcome"))!;
    const argv = (published.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    // The design section only: the review section is never written by this graph.
    expect(argv[8]).toBe("design");
    expect(argv[5]).toContain("clean, nothing posted");
  });

  it("measures statically only: no Docker probe, no coverage job, no per-symbol search", () => {
    const sim = end("design-clean");
    const ids = commandIds(sim);
    expect(ids.filter((id) => /^(sandbox-|host-|cover-|search-S|cand-)/.test(id))).toEqual([]);
    expect(ids).toContain("static-go-1");
    expect(sim.written!.markdown).toContain("Coverage, CRAP and mutation are measured by the PR review (`pr-review`).");
    expect(sim.written!.markdown).toMatch(/\| Function \| Change \| Complexity \(limit < 10\) \| Nesting \(limit ≤ 3\) \|\n\|---\|---\|---\|---\|/);
    expect(sim.written!.markdown).not.toContain("CRAP (threshold");
  });

  it("with comments.designPassedNote, a clean round 1 posts the note: one COMMENT review with no item", () => {
    const config = { comments: { designPassedNote: true } };
    const sim = end("design-clean", { config });
    expect(sim.github.creates).toHaveLength(1);
    const input = sim.github.creates[0]!;
    expect(input).toMatchObject({ event: "COMMENT", comments: [], idempotencyKey: `design-${REHEARSAL_HEAD.slice(0, 12)}` });
    const lines = String(input.body).split("\n");
    expect(lines[0]).toBe(PASSED_LINE);
    expect(lines[1]).toMatch(new RegExp(`^<!-- graphloom-design-review: ${REHEARSAL_HEAD} \\S+ -->$`));
    expect(lines[2]).toBe(NOTE_LINE);
    expect(stopOf(sim)!.blocker).toMatch(/^design review clean at 0123456; the design-review-passed note is posted \(https:\/\/github\.com\/o\/r\/pull\/1#pullrequestreview-\d+\)\. Next: graphloom task new pr-review apache\/skywalking-banyandb#7 --profile banyandb$/);
    // Without the grant the note is a write like any other: the run stops "posting not enabled".
    const withheld = end("design-clean", { config, executors: NO_GRANT });
    expect(stopOf(withheld)).toMatchObject({ reason: "posting not enabled", blocker: expect.stringContaining("asks for the design-review-passed note") });
  });

  it("round 1's open items are posted as one review with the design marker, and the result line counts them and names no next command", () => {
    const sim = end("needs-author-purpose");
    const r1 = recordedRound1(sim.evidence);
    const n = r1.state === "read" ? r1.value.issues.length : 0;
    expect(n).toBeGreaterThan(0);
    expect(sim.github.creates).toHaveLength(1);
    const lines = String(sim.github.creates[0]!.body).split("\n");
    expect(lines[0]).toBe(`Changes requested: ${n} open`);
    expect(lines[1]).toMatch(/^<!-- graphloom-design-review: /);
    expect(lines[2]).toBe(ROUND_LINE);
    expect(stopOf(sim)!.blocker).toMatch(new RegExp(`^design review: changes requested: ${n} open on apache/skywalking-banyandb#7 at 0123456; posted \\(https://`));
    expect(stopOf(sim)!.blocker).not.toContain("Next:");
  });

  it("the result line", () => {
    expect(resultLine(PR, "banyandb", 0, undefined, false)).toBe("design review clean at 0123456; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#7 --profile banyandb");
    expect(resultLine(PR, "banyandb", 2, "https://x/1", false)).toBe("design review: changes requested: 2 open on apache/skywalking-banyandb#7 at 0123456; posted (https://x/1)");
  });
});
