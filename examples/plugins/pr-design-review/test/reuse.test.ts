// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// An existing-feature answer whose equivalent the pull request already reuses (apache/skywalking-banyandb#1496): the answer's
// structured claim, its deterministic and checker verification, and the gate that notes it instead of raising an `existing` item.

import { describe, expect, it } from "vitest";
import { answerProblems, ANSWERS_SCHEMA, namesEquivalent, readAnswerCheck, reuseClaims, type Answer, type AnswerContext, type Equivalent } from "../src/answers.js";
import type { Groundwork } from "../src/kit/groundwork.js";
import { pullFile } from "../src/kit/snapshot.js";
import { necessityJson } from "../src/necessity.js";
import type { Question } from "../src/questions.js";
import { reuseRehearsal } from "../src/rehearsal.js";
import { recordedRound1, round1Record, type GateFile } from "../src/round1.js";
import { validateResultShape } from "@graphloom/sdk";
import { assignmentOf, BANYANDB, jobsOf, qaOf, simulate } from "./support.js";

const HEAD = "5".repeat(40);
const SUITE = "test/integration/distributed/schema_missing/suite_test.go";
const STREAM = "test/integration/distributed/schema_missing/stream_test.go";

// ---- the gate on #1496's Q1, as qa.json recorded it (run hub-4b7895f9), with the structured reuse claim beside it ----

const Q1_TEXT = "In one statement, does the codebase or an already-declared dependency provide an equivalent cluster setup and schema-watch pause mechanism?";
const Q1_ANSWER =
  "Yes, the base already has both pieces, and the PR uses them instead of adding its own. Cluster setup: `setup.PropertyClusterConfig`, `setup.DataNodeWithAddrAndDir` and `setup.LiaisonNode` start in-process data nodes and a liaison. Other distributed suites already use them, for example `test/integration/distributed/schema/common.go` starts two data nodes and a liaison this way. Pause mechanism: `setup.PauseDataNodeWatch` and `setup.ResumeDataNodeWatch` in `pkg/test/setup/watch_control.go` look up the node's registered `SchemaRegistry` and call `PauseNotifications` / `ResumeNotifications`. When paused, events are queued; on resume, the queue is replayed (`banyand/metadata/schema/property/client.go`). `DataNodeFromDataDir` registers each data node's registry under its address after the health check, so the pause can target that node. The only existing caller of the pause is `test/cases/schema/barrier_cluster.go`, which pauses the liaison's watch, not a data node's. The new suite (`suite_test.go`, `stream_test.go`) defines no helper of its own and calls these existing functions.";
const Q1_CITATIONS = [
  { path: "pkg/test/setup/watch_control.go", tree: "base", start: 70, end: 86, quote: "func PauseDataNodeWatch(nodeAddr string) error {" },
  { path: "pkg/test/setup/watch_control.go", tree: "base", start: 91, end: 98, quote: "func ResumeDataNodeWatch(nodeAddr string) error {" },
  { path: "pkg/test/setup/setup.go", tree: "base", start: 620, end: 635, quote: "so PauseDataNodeWatch / ResumeDataNodeWatch\n\t// accept either form." },
  { path: "banyand/metadata/schema/property/client.go", tree: "base", start: 1927, end: 1957, quote: "func (r *SchemaRegistry) PauseNotifications() {" },
  { path: "test/cases/schema/barrier_cluster.go", tree: "base", start: 135, end: 137, quote: "gm.Expect(setup.PauseDataNodeWatch(paused)).Should(gm.Succeed())" },
  { path: "test/integration/distributed/schema/common.go", tree: "base", start: 63, end: 69, quote: "addrDataNode0, _, _, closeDataNode0 := setup.DataNodeWithAddrAndDir(config)" },
  { path: STREAM, tree: "head", start: 69, end: 72, quote: "Expect(setup.PauseDataNodeWatch(addr)).To(Succeed())" },
];
/** The equivalents the answer names, every outside citation under the one it is about, each reused at the head lines that call it. */
const Q1_EQUIVALENTS: Equivalent[] = [
  { name: "setup.PauseDataNodeWatch", cites: [1, 3, 4, 5, 7], reusedByPullRequest: true, uses: [{ path: STREAM, start: 69, end: 72, quote: "Expect(setup.PauseDataNodeWatch(addr)).To(Succeed())" }] },
  { name: "setup.ResumeDataNodeWatch", cites: [2], reusedByPullRequest: true, uses: [{ path: STREAM, start: 96, end: 96, quote: "Expect(setup.ResumeDataNodeWatch(addr)).To(Succeed())" }] },
  { name: "setup.DataNodeWithAddrAndDir", cites: [6], reusedByPullRequest: true, uses: [{ path: SUITE, start: 58, end: 58, quote: "addr, _, _, closeFn := setup.DataNodeWithAddrAndDir(config)" }] },
];
const supported = (n: number) => ({ equivalent: n, verdict: "supported", note: "" });

interface Q1Over {
  equivalents?: Equivalent[] | undefined;
  reuse?: Array<{ equivalent: number; verdict: string; note: string }> | undefined;
}
function qa1496(over: Q1Over = {}): string {
  const equivalents = "equivalents" in over ? over.equivalents : Q1_EQUIVALENTS;
  const reuse = "reuse" in over ? over.reuse : [supported(1), supported(2), supported(3)];
  return JSON.stringify({
    schema: "pr-qa-v1",
    questions: [
      { id: "N1", type: "necessity", item: "", stable: "necessity|N1", text: "Is this change necessary?" },
      {
        id: "Q1",
        type: "existing-feature",
        item: "W1",
        stable: `existing-feature|item|${SUITE}`,
        text: Q1_TEXT,
        answer: {
          answer: Q1_ANSWER,
          status: "answered",
          none_found: false,
          reusable: true,
          ...(equivalents !== undefined ? { equivalents } : {}),
          citations: Q1_CITATIONS,
          searches: [],
          inventory: [{ name: "github.com/onsi/ginkgo/v2", version: "v2.32.1" }],
          metrics: [],
          proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" },
          notes: [],
          check: { verdict: "supported", note: "", searches: [], ...(reuse !== undefined ? { reuse } : {}) },
          history: [],
        },
      },
    ],
  });
}
const necessary = necessityJson({
  final: { question: "N1", answer: "", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" }, check: { verdict: "supported", note: "" }, history: [], notes: [], necessity: { conclusion: "necessary", rationale: "why", problem: { claim: "", quotes: [], trace: [], canHappen: "yes", explanation: "" }, reproduction: "", principles: [], design: { statements: [], changed: [], effect: "unrelated", explanation: "", searches: [] }, alternatives: { exists: false, explanation: "", citations: [] }, searches: [] } } as never,
  decision: { action: "ask-all", reason: "" } as never,
});
const GATE_FILES: GateFile[] = [
  { path: SUITE, previousPath: null },
  { path: STREAM, previousPath: null },
];
const gate = (qaJson: string) => round1Record({ head: HEAD, necessity: necessary, qa: qaJson, files: GATE_FILES, itemCites: {} })!;

describe("the gate on an equivalent the pull request already reuses (#1496)", () => {
  it("notes #1496's Q1, whose every outside equivalent the pull request is verified to reuse: no `existing` item, round 1 clean", () => {
    const r = gate(qa1496());
    expect(r.issues).toEqual([]);
    expect(r.noted).toEqual([{ id: "Q1", key: `existing-feature|item|${SUITE}`, note: "the pull request already reuses it: `setup.PauseDataNodeWatch`, `setup.ResumeDataNodeWatch`, `setup.DataNodeWithAddrAndDir`" }]);
  });

  it("keeps today's item for the answer as recorded before 0.1.9, with no equivalents: an outside citation is an equivalent", () => {
    const r = gate(qa1496({ equivalents: undefined, reuse: undefined }));
    expect(r.issues.map((x) => [x.id, x.kinds])).toEqual([["Q1", ["existing"]]]);
    expect(r.issues[0]!.body).toMatch(/^\*\*the codebase or a declared library already has this\*\* \(Q1\)\. In one statement/);
    expect(r.issues[0]!.body).not.toContain("already reuses");
    expect(r.noted).toBeUndefined();
  });

  it("stays an item for the equivalents the pull request does not reuse, saying which it reuses", () => {
    const partly = Q1_EQUIVALENTS.map((e, i) => (i === 2 ? { ...e, reusedByPullRequest: false, uses: [] } : e));
    const r = gate(qa1496({ equivalents: partly, reuse: [supported(1), supported(2)] }));
    expect(r.issues.map((x) => [x.id, x.kinds])).toEqual([["Q1", ["existing"]]]);
    expect(r.issues[0]!.body).toContain("The pull request already reuses `setup.PauseDataNodeWatch`, `setup.ResumeDataNodeWatch`; this item is about the other equivalents the answer names.");
    expect(r.noted).toBeUndefined();
  });

  it("stays an item when the checker refutes a reuse claim, or did not judge it: an unsupported claim is not reuse", () => {
    for (const reuse of [[supported(1), supported(2), { equivalent: 3, verdict: "unsupported", note: "line 58 calls a local copy" }], [supported(1), supported(2)], [supported(1), supported(2), { equivalent: 3, verdict: "partial", note: "" }]]) {
      const r = gate(qa1496({ reuse }));
      expect(r.issues.map((x) => [x.id, x.kinds])).toEqual([["Q1", ["existing"]]]);
      expect(r.issues[0]!.body).toContain("already reuses `setup.PauseDataNodeWatch`, `setup.ResumeDataNodeWatch`;");
    }
    // No judgment at all (a check recorded before 0.1.9): no claim is verified, and the item names none as reused.
    const unjudged = gate(qa1496({ reuse: undefined }));
    expect(unjudged.issues.map((x) => [x.id, x.kinds])).toEqual([["Q1", ["existing"]]]);
    expect(unjudged.issues[0]!.body).not.toContain("already reuses");
  });

  it("keeps an outside citation open when an equivalent the pull request does not reuse also lists it, or no equivalent lists it", () => {
    const shared = [...Q1_EQUIVALENTS, { name: "setup.LiaisonNode", cites: [6], reusedByPullRequest: false, uses: [] }];
    expect(gate(qa1496({ equivalents: shared })).issues.map((x) => x.id)).toEqual(["Q1"]);
    const unlisted = Q1_EQUIVALENTS.map((e, i) => (i === 0 ? { ...e, cites: [1, 3, 4] } : e));
    expect(gate(qa1496({ equivalents: unlisted })).issues.map((x) => x.id)).toEqual(["Q1"]);
  });

  it("decides from the structured claim alone, never from the answer's words", () => {
    // The recorded answer says "the PR uses them", but no equivalent claims reuse: an item.
    const unclaimed = Q1_EQUIVALENTS.map((e) => ({ ...e, reusedByPullRequest: false, uses: [] }));
    expect(gate(qa1496({ equivalents: unclaimed, reuse: [] })).issues.map((x) => x.id)).toEqual(["Q1"]);
  });
});

// ---- the answer contract: the deterministic checks on a reuse claim, and the checker's judgment of it ----

const HEAD_GO = "package schema_missing\n\nfunc stream() {\n\tsetup.PauseDataNodeWatch(addr)\n\tPauseDataNodeWatchLocal(addr)\n}\n";
const FILES = [pullFile({ path: STREAM, previousPath: null, status: "modified", additions: 2, deletions: 0, patch: "@@ -1,3 +1,6 @@\n package schema_missing\n \n func stream() {\n+\tsetup.PauseDataNodeWatch(addr)\n+\tPauseDataNodeWatchLocal(addr)\n+}" })!];
const QUESTION = { id: "Q1", type: "existing-feature", item: "W1", text: Q1_TEXT, origin: "required" } as Question;
const CTX: AnswerContext = { questions: [QUESTION], groundwork: { inventory: { dependencies: [], packages: [], truncated: [] }, symbols: [] } as unknown as Groundwork, view: { items: [], records: [] }, packs: [], files: FILES };
const proposal = { kind: "none" as const, splits: [], testFile: "", testName: "", cases: [], assertion: "" };
const answer = (equivalents: Equivalent[], over: Partial<Answer> = {}): Answer => ({
  question: "Q1",
  answer: "The base has setup.PauseDataNodeWatch and the pull request calls it.",
  status: "answered",
  none_found: false,
  reusable: true,
  equivalents,
  citations: [{ path: "pkg/test/setup/watch_control.go", tree: "base", start: 70, end: 86, quote: "func PauseDataNodeWatch(nodeAddr string) error {" }],
  searches: [],
  inventory: [],
  metrics: [],
  proposal,
  ...over,
});
const pause = (uses: Equivalent["uses"], cites = [1]): Equivalent => ({ name: "setup.PauseDataNodeWatch", cites, reusedByPullRequest: true, uses });
const site = (start: number, end = start) => ({ path: STREAM, start, end, quote: "" });

describe("the existing-feature answer's equivalents (design §5.4)", () => {
  it("are part of the answerer's contract, and the checker judges each reuse claim", () => {
    expect(ANSWERS_SCHEMA.properties.answers.items.required).toContain("equivalents");
    expect(validateResultShape({ answers: [answer([pause([site(4)])])] }, ANSWERS_SCHEMA as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("accept a reuse claim whose site is an added head line of the diff that names the equivalent", () => {
    expect(HEAD_GO.split("\n")[3]).toContain("setup.PauseDataNodeWatch");
    expect(answerProblems([answer([pause([site(4)])])], CTX)).toEqual([]);
    expect(namesEquivalent("\tPauseDataNodeWatch(addr)", "setup.PauseDataNodeWatch")).toBe(true);
    expect(namesEquivalent("\tPauseDataNodeWatchLocal(addr)", "setup.PauseDataNodeWatch")).toBe(false);
    // A prefix collision never names it, qualified or not.
    expect(namesEquivalent("\tsetup.PauseDataNodeWatchLocal(addr)", "setup.PauseDataNodeWatch")).toBe(false);
    expect(namesEquivalent("\tschedulePrune(spec)", "schedule")).toBe(false);
    expect(namesEquivalent("\tschedule(spec)", "schedule")).toBe(true);
    expect(namesEquivalent('\t"github.com/onsi/ginkgo/v2"', "github.com/onsi/ginkgo/v2")).toBe(true);
    expect(namesEquivalent('\t"github.com/onsi/ginkgo/v2extra"', "github.com/onsi/ginkgo/v2")).toBe(false);
  });

  it("send back a reuse claim the diff does not show: a namesake, a context line, a line outside every hunk, a file the pull request does not change", () => {
    const problems = (uses: Equivalent["uses"]) => answerProblems([answer([pause(uses)])], CTX).join("\n");
    expect(problems([site(5)])).toMatch(/no line the pull request adds at .*stream_test\.go:5-5 names "setup\.PauseDataNodeWatch"/);
    expect(problems([site(3)])).toContain("has no line the pull request adds");
    expect(problems([site(40)])).toContain("line 40 is not in a hunk of the diff at the head");
    expect(problems([{ ...site(4), path: "pkg/other.go" }])).toContain("is not in a file this pull request changes");
    expect(problems([])).toContain("cites the added head lines of the diff that call or import it in uses");
  });

  it("send back equivalents that do not fit the answer: a citation number it does not have, a listed equivalent on a none-found answer, none listed at all", () => {
    expect(answerProblems([answer([pause([site(4)], [2])])], CTX).join("\n")).toContain("citation number 2 is not one of the answer's 1 citations");
    expect(answerProblems([answer([], {})], CTX).join("\n")).toContain("list each equivalent the answer names in equivalents");
    expect(answerProblems([answer([pause([site(4)])], { reusable: false })], CTX).join("\n")).toContain("lists no equivalents");
    expect(answerProblems([answer([{ ...pause([]), reusedByPullRequest: false, uses: [site(4)] }])], CTX).join("\n")).toContain("an equivalent the pull request does not use has no uses");
  });

  it("leave a reuse claim the checker did not judge unchecked, and read its judgment by the equivalent's number", () => {
    const a = answer([pause([site(4)]), { name: "setup.ResumeDataNodeWatch", cites: [1], reusedByPullRequest: false, uses: [] }]);
    expect(reuseClaims(a)).toEqual([1]);
    const answers = new Map([["Q1", a]]);
    const verdict = (reuse: unknown[]) => ({ verdicts: [{ question: "Q1", verdict: "supported", note: "", searches: [], principles: [], reuse }] });
    const unjudged = readAnswerCheck(verdict([]), [QUESTION], answers);
    expect("unchecked" in unjudged && unjudged.unchecked).toEqual(["Q1"]);
    const judged = readAnswerCheck(verdict([{ equivalent: 1, verdict: "supported", note: "" }, { equivalent: 1, verdict: "unsupported", note: " a namesake " }]), [QUESTION], answers);
    // Two judgments of one claim: the weaker stands.
    expect("reuse" in judged && judged.reuse.get("Q1")).toEqual([{ equivalent: 1, verdict: "unsupported", note: "a namesake" }]);
  });
});

// ---- through Answers to Round 1: the rehearsal scenario ----

describe("a run whose existing-feature answer names an equivalent the pull request reuses", () => {
  it("records the claim and the checker's judgment in qa.json, notes it in round 1, and ends clean", () => {
    const sim = simulate({ scenarioName: "answer-reuses-existing-feature", maxSteps: 900, through: "end" });
    const stop = sim.final.action.type === "stop" ? sim.final.action.stop : undefined;
    expect(stop?.reason, JSON.stringify(sim.final).slice(0, 400)).toBe("complete");
    expect(stop?.blocker).toMatch(/^design review clean at /);
    const feature = qaOf(sim).questions.find((q) => q.type === "existing-feature" && (q.answer as { equivalents?: unknown[] } | undefined)?.equivalents?.length === 1)!;
    const a = feature.answer as unknown as { equivalents: Equivalent[]; check: { reuse: unknown[] } };
    expect(a.equivalents[0]).toMatchObject({ name: "schedule", reusedByPullRequest: true, uses: [{ path: "banyand/cmd/server/flags.go", start: 16, end: 16 }] });
    expect(a.check.reuse).toEqual([{ equivalent: 1, verdict: "supported", note: "" }]);
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues).toEqual([]);
    expect(r1.state === "read" && r1.value.noted?.find((n) => n.id === feature.id)?.note).toBe("the pull request already reuses it: `schedule`");
    expect(sim.github.creates).toEqual([]);
    // The answerer is asked for the claim, and the checker is shown it to judge, numbered as its verdict's reuse names it.
    expect(assignmentOf(jobsOf(sim, "Answer the questions").find((j) => j.kind === "agent")!)).toContain("reusedByPullRequest");
    const check = assignmentOf(jobsOf(sim, "Check the answers").find((j) => j.kind === "agent")!);
    expect(check).toContain('E1 schedule (cites 1): the pull request already uses it at head:banyand/cmd/server/flags.go:16-16 "schedule("0 3 * * *")"');
    expect(check).toContain("judge that claim on its own in the reuse of your verdict");
  });

  it("raises the `existing` item when the checker refutes the reuse claim", () => {
    const refuted = reuseRehearsal(BANYANDB, [(_q, a) => (reuseClaims(a).length > 0 ? { verdict: "supported", note: "", reuse: [{ equivalent: 1, verdict: "unsupported", note: "flags.go:16 calls a local schedule, not the base's" }] } : undefined)]);
    const sim = simulate({ scenario: refuted, maxSteps: 900, through: "end" });
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues.map((x) => x.kinds)).toEqual([["existing"]]);
  });
});
