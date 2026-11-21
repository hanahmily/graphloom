// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * pr-review 1.1.2: what the first live run (apache/skywalking-banyandb#1485) showed. The round-1 lines say what each open item is
 * and its state, and nest correctly wherever they are embedded; a verifier's factual correction of a confirmed finding reaches the
 * posted text, and `draft-composed` refuses a draft that ignores it; a verification recorded under v1 still reads.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { round1Section, round1Status, MAX_ROUND1_QUESTION, type Round1Status } from "../src/context.js";
import { composeDraft, correctionMismatch, draftJson, draftMarkdown, withReview, type Draft, type DraftInput } from "../src/draft.js";
import { planReview } from "../src/publish.js";
import { correctedContent, parseVerification, VERIFY_SCHEMA_NAME, VERIFY_SCHEMA_NAME_V1, type AspectRecord, type Finding } from "../src/review.js";
import { recordedAspect, writtenDraftFiles } from "../src/reviewdraft.js";
import { codeReview, draftComposed } from "../src/reviewvalidators.js";
import { REHEARSAL_REQUEST } from "../src/rehearsal.js";
import { partCommands, readParts } from "../src/kit/parts.js";
import { parsePatch } from "../src/kit/patch.js";
import type { PullFile } from "../src/kit/snapshot.js";
import { BANYANDB, assignmentOf, candidateEvidence, scenarioWith, simulate } from "./support.js";

const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 1485 };
const HEAD = "702b6a229a3fe8f349ff68c153cbc151b66d71e2";
const DESIGN = "8382af2375cbcd41c7f85cadca34c7480a93577c";
const Q4 = "What aggregation contract should operators use across liaison and data-node instances to distinguish dropped logical rows from drop observations caused by retries or replication?";
const Q5 = "How should the group label handle nonexistent or arbitrarily supplied group names so that group_not_found reporting has bounded metric cardinality?";

/** The design section #1485's ledger held (trimmed): one design head with round 1 recorded, Q4 and Q5 open and posted. */
const item = (id: string, q: string, commentId: number) => ({
  head: DESIGN,
  id,
  origin: "round1",
  path: "banyand/measure/metrics.go",
  line: 505,
  text: `**partially answered** (${id}). ${q}\n\nAnswer (partially answered): Neither the code nor the docs define it.`,
  state: "open",
  github: { head: DESIGN, reviewId: 5971198998, commentId, inline: true },
  history: [{ head: DESIGN, status: "open" }],
});
const designSection = {
  schema: "pr-design-review-ledger-v1",
  heads: [{ sha: DESIGN, base: "3c4844fe2db1907d954c125646873b60fd76c4dc", files: 27, commits: 1, facts: 0, round1: "items", open: 2, reviewId: 5971198998 }],
  purposes: [],
  qa: [],
  items: [item("Q4", Q4, 4625798480), item("Q5", Q5, 4625798492)],
};
const qaJson = JSON.stringify({ schema: "pr-qa-v1", pull: { ...PULL, head: DESIGN }, questions: [{ id: "N1", text: "Is this change necessary? Does the problem it claims to fix exist on the base?" }, { id: "Q4", text: Q4 }, { id: "Q5", text: Q5 }] });

const PATCH = "@@ -510,0 +511,20 @@\n" + Array.from({ length: 20 }, (_, i) => `+line ${i}`).join("\n");
const files: PullFile[] = [{ path: "banyand/measure/metrics.go", status: "modified", previousPath: null, additions: 20, deletions: 0, patch: PATCH, patchOmitted: false, parsed: parsePatch(PATCH) }];
const scope = { schema: "pr-review-scope-v2" as const, mode: "standard" as const, source: "whole" as const, areas: [], files: ["banyand/measure/metrics.go"], context: { kind: "seeded" as const, reason: "every reviewer starts a fresh session seeded with review.md only" }, contextSource: "design-review" as const, harnesses: {} };
const record = (aspect: AspectRecord["aspect"], findings: Finding[]): AspectRecord => ({ schema: "pr-review-aspect-v2", aspect, reviewer: "claude-code", verifier: "codex", context: { kind: "seeded", reason: "every reviewer starts a fresh session seeded with review.md only" }, scopeFiles: 1, passes: [{ n: 1, reviewed: 1, raised: findings.map((f) => f.id), reaffirmed: [], nits: 0, merged: 0 }], findings, unsaturated: false, leads: [] });

/** F6 of #1485: the verifier confirmed it and found six call sites, not nine. */
const F6_CONTENT = "`heldGroup` is copied word for word into three packages. All 9 drop sites call it as `heldGroup(w.schemaRepo, metadata.GetGroup())`. Move this logic to pkg/schema as one function.";
const F6 = (corrections?: Array<{ original: string; corrected: string }>): Finding => ({
  id: "F6",
  aspect: "maintainability",
  raisedBy: "maintainability",
  pass: 1,
  path: "banyand/measure/metrics.go",
  side: "RIGHT",
  startLine: 517,
  endLine: 527,
  severity: "P2",
  kind: "non-behavioral",
  content: F6_CONTENT,
  suggestion: "",
  evidence: "",
  distinct: false,
  state: "confirmed",
  reaffirmed: [],
  notes: [],
  verdict: { verdict: "confirmed", kind: "non-behavioral", witness: "banyand/measure/metrics.go:519", quotes: [], reason: "The finding overstates the call count: there are six heldGroup calls, not nine.", fixes: false, ...(corrections !== undefined ? { corrections } : {}) },
});
const input = (round1: Round1Status | null, head = HEAD, f: Finding = F6()): DraftInput => ({ pull: PULL, head, files, scope, records: [record("correctness", []), record("maintainability", [f]), record("security", [])], context: { source: "design-review", head: DESIGN }, round1 });

describe("the round-1 lines (design §8.4)", () => {
  it("say each open item's id, question and state: open as of an earlier design head and not re-checked on this head", () => {
    const r = round1Status(designSection, PULL, { head: DESIGN, qaJson })!;
    expect(r.open.map((o) => [o.id, o.question])).toEqual([["Q4", Q4], ["Q5", Q5]]);
    const s = round1Section(r, HEAD);
    expect(s.lead).toBe("Design review as of 8382af2; run pr-design-review on this head to re-check them: 2 open items:");
    expect(s.items).toEqual([
      `Q4 (open as of 8382af2, not re-checked on this head): ${Q4} [comment](https://github.com/apache/skywalking-banyandb/pull/1485#discussion_r4625798480)`,
      `Q5 (open as of 8382af2, not re-checked on this head): ${Q5} [comment](https://github.com/apache/skywalking-banyandb/pull/1485#discussion_r4625798492)`,
    ]);
    // The counts are unchanged: two open round-1 items.
    expect(planReview({ pull: PULL, head: HEAD, nonce: "n", draft: composeDraft(input(r)), round1: r }).open).toBe(1 + 2);
  });

  it("keep the this-head wording when the design review reviewed this head", () => {
    const same = { ...designSection, heads: [{ ...designSection.heads[0]!, sha: HEAD }], items: designSection.items.map((x) => ({ ...x, history: [{ head: HEAD, status: "open" }] })) };
    const r = round1Status(same, PULL)!;
    const s = round1Section(r, HEAD);
    expect(s.lead).toBe("Design review at 702b6a2 (this head): 2 open items:");
    expect(s.items[0]).toBe(`Q4 (open on this head): ${Q4} [comment](https://github.com/apache/skywalking-banyandb/pull/1485#discussion_r4625798480)`);
    expect(s.items.join("\n")).not.toContain("not re-checked");
  });

  it("read the question from the item's posted text when the design head's Q&A is not read, and clip a long one", () => {
    const fromText = round1Status(designSection, PULL)!;
    expect(fromText.open.map((o) => o.question)).toEqual([Q4, Q5]);
    // A Q&A of another head is not this head's questions: the posted text is read instead.
    expect(round1Status(designSection, PULL, { head: HEAD, qaJson: JSON.stringify({ questions: [{ id: "Q4", text: "another question" }] }) })!.open[0]!.question).toBe(Q4);
    const long = "Why ".repeat(100).trim() + "?";
    const r = round1Status({ ...designSection, items: [item("Q4", long, 1)] }, PULL)!;
    expect(r.open[0]!.question!.length).toBe(MAX_ROUND1_QUESTION);
    expect(r.open[0]!.question!.endsWith("…")).toBe(true);
  });

  it("never render as `- - ` in draft.md, review.md, the HTML or the posted body: the maintainer's list nests them (#1485's shape)", () => {
    const r = round1Status(designSection, PULL, { head: DESIGN, qaJson })!;
    const draft = composeDraft(input(r));
    const md = draftMarkdown(draft);
    expect(md).toContain(`## Design review (round 1)\nDesign review as of 8382af2; run pr-design-review on this head to re-check them: 2 open items:\n- Q4 (open as of 8382af2, not re-checked on this head): ${Q4}`);
    expect(md).toContain(`\n- Design review as of 8382af2; run pr-design-review on this head to re-check them: 2 open items:\n  - Q4 (open as of 8382af2, not re-checked on this head): ${Q4}`);
    const review = withReview("# apache/skywalking-banyandb#1485\n", draft);
    const body = planReview({ pull: PULL, head: HEAD, nonce: "n", draft, round1: r }).body;
    expect(body).toContain(`Design review (round 1):\nDesign review as of 8382af2; run pr-design-review on this head to re-check them: 2 open items:\n- Q4 (open as of 8382af2, not re-checked on this head): ${Q4}`);
    for (const text of [md, review, body, draftJson(draft)]) expect(text).not.toMatch(/(^|\\n|\n)\s*- - /);
  });
});

describe("a verifier's correction reaches the posted text (design §8.1, §8.4)", () => {
  const fix = [{ original: "All 9 drop sites", corrected: "All 6 drop sites" }];

  it("applies a confirmed finding's correction to its draft body, the report and the posted review", () => {
    const draft = composeDraft(input(null, HEAD, F6(fix)));
    const entry = draft.comments.find((c) => c.id === "F6")!;
    expect(entry.body.startsWith("`heldGroup` is copied word for word into three packages. All 6 drop sites call it as")).toBe(true);
    expect(entry.body).not.toContain("All 9");
    expect(draft.review.findings.find((f) => f.id === "F6")!.content).toContain("All 6 drop sites");
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", draft, round1: null });
    expect([plan.body, ...plan.comments.map((c) => c.body)].join("\n")).toContain("All 6 drop sites call it");
    expect([plan.body, ...plan.comments.map((c) => c.body)].join("\n")).not.toContain("All 9");
    // The appendix says what the verifier corrected.
    expect(withReview("# r\n", draft)).toContain('The verifier corrected the reviewer\'s text (applied above): "All 9 drop sites" should read "All 6 drop sites".');
    expect(correctionMismatch(JSON.parse(draftJson(draft)), draft)).toBeUndefined();
  });

  it("names a draft that ignores the correction", () => {
    const draft = composeDraft(input(null, HEAD, F6(fix)));
    const ignored = JSON.parse(draftJson(draft)) as Draft;
    ignored.comments[0]!.body = ignored.comments[0]!.body.replace("All 6 drop sites", "All 9 drop sites");
    expect(correctionMismatch(ignored, draft)).toBe('F6 ignores its verifier\'s correction of "All 9 drop sites" to "All 6 drop sites"');
  });

  it("applies only a confirmed finding's corrections, and states one that cannot be applied in place", () => {
    expect(correctedContent({ ...F6(fix), state: "disputed" }).text).toBe(F6_CONTENT);
    // A record written by hand whose span is not in the claim: the draft says the correction on its own line.
    const odd = F6([{ original: "All 12 drop sites", corrected: "All 6 drop sites" }]);
    const body = composeDraft(input(null, HEAD, odd)).comments[0]!.body;
    expect(body).toContain(F6_CONTENT);
    expect(body).toContain('Corrected by the verifier: "All 12 drop sites" should read "All 6 drop sites".');
  });

  it("reads corrections from a v2 verdict, sends a span the claim does not hold once back, and reads a v1 verdict as none", () => {
    const v = { finding: "F6", verdict: "confirmed", kind: "non-behavioral", witness: "banyand/measure/metrics.go:519", quotes: [], reason: "six, not nine", fixes: false, test: { demonstrates: false, reason: "no test" } };
    const contents = new Map([["F6", F6_CONTENT]]);
    const ok = parseVerification({ verdicts: [{ ...v, corrections: [{ original: "All 9  drop\nsites", corrected: "All 6 drop sites" }] }] }, new Set(["F6"]), contents);
    expect("verdicts" in ok && ok.verdicts.get("F6")!.corrections).toEqual([{ original: "All 9  drop\nsites", corrected: "All 6 drop sites" }]);
    // Whitespace in the span matches any whitespace in the claim, so the folded claim the verifier read still applies.
    expect(correctedContent({ ...F6(), verdict: { ...F6().verdict!, corrections: [{ original: "All 9  drop\nsites", corrected: "All 6 drop sites" }] } }).text).toContain("All 6 drop sites call it");
    expect(parseVerification({ verdicts: [{ ...v, corrections: [{ original: "All 12 drop sites", corrected: "x" }] }] }, new Set(["F6"]), contents)).toMatchObject({ problems: [expect.stringMatching(/occurs nowhere in the finding's claim/)] });
    expect(parseVerification({ verdicts: [{ ...v, corrections: [{ original: "heldGroup", corrected: "x" }] }] }, new Set(["F6"]), contents)).toMatchObject({ problems: [expect.stringMatching(/occurs 2 times/)] });
    expect(parseVerification({ verdicts: [{ ...v, corrections: [{ original: "All 9 drop sites", corrected: "a" }, { original: "9 drop", corrected: "b" }] }] }, new Set(["F6"]), contents)).toMatchObject({ problems: [expect.stringMatching(/overlaps/)] });
    expect(parseVerification({ verdicts: [{ ...v, corrections: "none" }] }, new Set(["F6"]), contents)).toMatchObject({ problems: [expect.stringMatching(/corrections must be a list/)] });
    // A refutation's corrections are dropped; a v1 verdict has none.
    const refuted = parseVerification({ verdicts: [{ ...v, verdict: "refuted", corrections: [{ original: "nowhere at all", corrected: "x" }] }] }, new Set(["F6"]), contents);
    expect("verdicts" in refuted && refuted.verdicts.get("F6")!.corrections).toBeUndefined();
    const v1 = parseVerification({ verdicts: [v] }, new Set(["F6"]), contents);
    expect("verdicts" in v1 && v1.verdicts.get("F6")!.corrections).toBeUndefined();
  });
});

describe("the review-layer scenario with a verifier's correction, end to end", () => {
  const F3_SPAN = "adds 0+1+2 to n";
  const corrected = "adds the constants 0, 1 and 2 to n";
  const withCorrection = (span: string) =>
    scenarioWith("review-layer", (s) => {
      const replies = s.results[VERIFY_SCHEMA_NAME]! as Array<{ output: { verdicts: Array<Record<string, unknown>> } }>;
      const reply = replies.find((r) => r.output.verdicts.some((v) => v.finding === "F3"))!;
      const at = reply.output.verdicts.findIndex((v) => v.finding === "F3");
      const fixed = { ...reply, output: { verdicts: reply.output.verdicts.map((v, i) => (i === at ? { ...v, corrections: [{ original: span, corrected }] } : v)) } };
      s.results[VERIFY_SCHEMA_NAME] = replies.flatMap((r) => (r === reply ? (span === F3_SPAN ? [fixed] : [fixed, reply]) : [r])) as never;
    });
  const sim = simulate({ scenario: withCorrection(F3_SPAN), request: REHEARSAL_REQUEST, through: "end", maxSteps: 400 });
  const evidence = candidateEvidence(sim.evidence, "d1");
  const evaluate = (ev: EvidenceRecord[]) => draftComposed.evaluate({ requirementId: "draft-composed", statement: "", evidence: ev, candidateDigest: "d1", config: BANYANDB, request: REHEARSAL_REQUEST });

  it("posts the corrected text, and draft-composed passes", () => {
    const create = sim.github.creates.at(-1)!;
    const posted = [String(create.body), ...(create.comments as Array<{ body: string }>).map((c) => c.body)].join("\n");
    expect(posted).toContain(`The loop that ${corrected}`);
    expect(posted).not.toContain(F3_SPAN);
    expect(evaluate(evidence)).toMatchObject({ status: "passed" });
  });

  it("fails draft-composed when draft.json ignores the correction", () => {
    const written = readParts(evidence, "draft-json", ".graphloom/review/draft.json");
    expect(written.state).toBe("read");
    if (written.state !== "read") return;
    const d = JSON.parse(written.value) as Draft;
    const e = d.comments.find((c) => c.id === "F3")!;
    e.body = e.body.replace(corrected, F3_SPAN);
    const parts = partCommands("draft-json", ".graphloom/review/draft.json", draftJson(d));
    const tampered = evidence.map((x) => {
      const c = (x.payload as { command?: { id: string; argv: string[] } } | undefined)?.command;
      const part = parts.find((p) => p.id === c?.id);
      return part === undefined ? x : { ...x, payload: { ...(x.payload as object), command: { ...c, argv: part.argv } } };
    });
    expect(evaluate(tampered)).toMatchObject({ status: "failed", reason: `draft.json does not carry a verifier's correction: F3 ignores its verifier's correction of "${F3_SPAN}" to "${corrected}"` });
  });

  it("sends a correction whose span the claim does not hold back to the verifier, which then corrects it", () => {
    const retried = simulate({ scenario: withCorrection("adds 9 to n"), request: REHEARSAL_REQUEST, through: "end", maxSteps: 400 });
    const verifies = retried.jobs.filter((j) => j.resultSchema === VERIFY_SCHEMA_NAME && j.instruction.includes("maintainability"));
    expect(verifies.length).toBeGreaterThanOrEqual(2);
    expect(assignmentOf(verifies[1]!)).toMatch(/corrections\[0\]\.original "adds 9 to n" occurs nowhere in the finding's claim/);
  });

  it("reads a verification recorded under v1 (no corrections) as before", () => {
    // Every verifier's result as 1.1.1 recorded it: under pr-finding-verification-v1, without corrections.
    const strip = (o: unknown): unknown => (o !== null && typeof o === "object" && Array.isArray((o as { verdicts?: unknown }).verdicts) ? { ...(o as object), verdicts: (o as { verdicts: Array<Record<string, unknown>> }).verdicts.map(({ corrections: _c, ...rest }) => rest) } : o);
    const asV1 = (e: EvidenceRecord): EvidenceRecord => {
      const p = e.payload as Record<string, unknown>;
      const agent = p.codingAgent as Record<string, unknown> | undefined;
      return { ...e, resultSchema: VERIFY_SCHEMA_NAME_V1, ...(e.contract !== undefined ? { contract: { ...e.contract, name: VERIFY_SCHEMA_NAME_V1 } } : {}), payload: agent !== undefined ? { ...p, codingAgent: { ...agent, output: strip(agent.output) } } : strip(p) } as EvidenceRecord;
    };
    const plain = simulate({ scenarioName: "review-layer", request: REHEARSAL_REQUEST, through: "end", maxSteps: 400 });
    const v1 = simulate({ scenarioName: "review-layer", request: REHEARSAL_REQUEST, through: "end", maxSteps: 400, tamper: (job, records) => (job.resultSchema === VERIFY_SCHEMA_NAME ? records.map(asV1) : undefined) });
    expect(v1.evidence.filter((e) => e.resultSchema === VERIFY_SCHEMA_NAME_V1).length).toBeGreaterThan(0);
    expect(v1.evidence.filter((e) => e.resultSchema === VERIFY_SCHEMA_NAME)).toEqual([]);
    // The sweep reads the v1 verdicts: the same findings, verdicts and posted review as a v2 run with no correction.
    const findings = (s: typeof plain) => {
      const m = recordedAspect(s.evidence, "maintainability");
      const c = recordedAspect(s.evidence, "correctness");
      return [m, c].flatMap((r) => (r.state === "read" ? r.value.findings.map((f) => [f.id, f.state, f.verdict?.verdict, f.verdict?.corrections]) : []));
    };
    expect(findings(v1)).toEqual(findings(plain));
    expect(findings(v1).length).toBeGreaterThan(0);
    expect(String(v1.github.creates.at(-1)?.body)).toBe(String(plain.github.creates.at(-1)?.body));
    const ev = candidateEvidence(v1.evidence, "d1");
    expect(codeReview.evaluate({ requirementId: "code-review", statement: "", evidence: ev, candidateDigest: "d1", config: BANYANDB, request: REHEARSAL_REQUEST })).toMatchObject({ status: "passed" });
    expect(evaluate(ev)).toMatchObject({ status: "passed" });
  });

  it("renders the HTML pages with the corrected text", () => {
    const html = writtenDraftFiles(evidence).html;
    expect(html.state).toBe("read");
    if (html.state === "read") expect(html.value).toContain(corrected);
  });
});
