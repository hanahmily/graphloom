// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { findingMeta, ledgerPublishedCommand, ledgerPatch, planReview, priorLines, type PriorLine } from "../src/publish.js";
import { partCommands } from "../src/kit/parts.js";
import { priorChunkText } from "../src/kit/ledger.js";
import { baselinesNow, LedgerRepo, v2Ledger, withLedger, type LedgerState } from "./ledgerrepo.js";
import { patchId, reanchor, registryOf, REANCHOR_WINDOW, type PriorItem, type PriorRegistry } from "../src/prior.js";
import { passReply, verifyReply } from "../src/rehearsal-review.js";
import { REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME, parsePass } from "../src/review.js";
import { recordedAspect } from "../src/reviewdraft.js";
import type { LeadEntry } from "../src/leads.js";
import { parsePatch } from "../src/kit/patch.js";
import type { PullFile } from "../src/kit/snapshot.js";
import type { Draft } from "../src/draft.js";
import { scenarioWith, simulate, type Simulation } from "./support.js";


const sh = promisify(execFile);
const REF = "refs/graphloom/pr-review/apache/skywalking-banyandb/7/ledger";
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7 };
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const hexOf = (c: string): string => c.repeat(40);

describe("re-anchoring an earlier finding to the new head", () => {
  const body = (n: number): string => Array.from({ length: n }, (_, i) => `+line ${i + 1}`).join("\n");
  const file = (patch: string): PullFile => ({ path: "pkg/a.go", status: "modified", previousPath: null, additions: 1, deletions: 0, patch, patchOmitted: false, parsed: parsePatch(patch) });
  const old = "@@ -10,3 +10,4 @@\n a\n+the anchor\n b\n c";
  const item = { path: "pkg/a.go", line: 11, endLine: 11, side: "RIGHT" as const, anchorText: "the anchor", patchId: "", hunk: [0, 10, 10] as [number, number, number] };
  it("is the same place when the file's patch is unchanged, and shifts by the hunk's offset when only the hunk's numbers moved", () => {
    const recorded = { ...item, patchId: patchId(old)! };
    expect(reanchor(recorded, [file(old)])).toEqual({ state: "found", line: 11, endLine: 11, how: "same" });
    const moved = "@@ -25,3 +27,4 @@\n a\n+the anchor\n b\n c";
    expect(patchId(moved)).toBe(patchId(old));
    expect(reanchor(recorded, [file(moved)])).toEqual({ state: "found", line: 28, endLine: 28, how: "shifted" });
  });

  it("finds the anchor text within 20 lines of the old place when the patch changed, and no farther", () => {
    const rec = { ...item, patchId: "other", line: 40, endLine: 40 };
    const near = `@@ -1,0 +50,25 @@\n${body(9)}\n+the anchor\n${body(14)}`;
    // The anchor is on head line 59 in this patch: 19 lines from 40, inside the window.
    expect(reanchor(rec, [file(near)])).toEqual({ state: "found", line: 59, endLine: 59, how: "searched" });
    expect(REANCHOR_WINDOW).toBe(20);
    const far = `@@ -1,0 +50,25 @@\n${body(20)}\n+the anchor\n${body(4)}`;
    expect(reanchor(rec, [file(far)])).toEqual({ state: "outdated" });
  });

  it("is outdated when the text is nowhere near, and gone when the file left the change", () => {
    expect(reanchor({ ...item, patchId: "x" }, [file("@@ -10,2 +10,2 @@\n a\n+something else\n")])).toEqual({ state: "outdated" });
    expect(reanchor(item, [{ ...file(old), path: "pkg/z.go" }])).toEqual({ state: "gone" });
  });
});


describe("a pass judges the earlier findings it is given", () => {
  const scope = new Set(["pkg/a.go"]);
  const summary = { total_files: 1, reviewed_files: 1, skipped: [] };
  const read = (prior: unknown) => parsePass({ comments: [], summary, prior }, { aspect: "correctness", scope, known: new Set(["F3"]), prior: new Set(["F3", "F4"]) });

  it("needs each one, once, with still_present or fixed", () => {
    expect(read([{ finding: "F3", status: "fixed", reason: "gone" }, { finding: "F4", status: "still_present", reason: "same" }])).toMatchObject({ prior: [{ finding: "F3", status: "fixed" }, { finding: "F4", status: "still_present" }] });
    expect(read([{ finding: "F3", status: "fixed", reason: "gone" }])).toMatchObject({ problems: [expect.stringMatching(/missing F4/)] });
    expect(read([{ finding: "F3", status: "maybe", reason: "" }, { finding: "F4", status: "fixed", reason: "x" }, { finding: "F4", status: "fixed", reason: "x" }])).toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/prior\[0\]/), expect.stringMatching(/F4 is judged twice/)]) });
  });

  it("asks for nothing when no earlier finding was given", () => {
    expect(parsePass({ comments: [], summary, prior: [] }, { aspect: "correctness", scope, known: new Set() })).toMatchObject({ prior: [] });
  });
});

describe("the review body and the verdict with earlier findings", () => {
  const item = (id: string, over: Partial<PriorItem> = {}): PriorItem => ({ id, origin: "round2", key: `k|${id}`, status: "open", head: hexOf("a"), commentId: 901, reviewId: 800, inline: true, text: "The loop drops the error.", path: "pkg/a.go", line: 12, endLine: 12, side: "RIGHT", history: [], ...over });
  const line = (id: string, over: Partial<PriorLine> = {}): PriorLine => ({ id, origin: "round2", status: "open", reason: "it is still an issue on this head", carried: false, link: `https://github.com/apache/skywalking-banyandb/pull/7#discussion_r901`, repost: false, item: item(id), ...over });
  const pull = { ...PULL, head: hexOf("b") };
  const empty = { comments: [], summary: "", context: { source: "prelude" }, leads: { given: 0, raised: 0 } } as unknown as Draft;

  it("lists a still-open finding with a link to its earlier comment, posts no new comment for it, and counts it open", () => {
    const plan = planReview({ pull, head: hexOf("b"), nonce: "n", round1: null, draft: empty, prior: [line("F3")] });
    expect(plan).toMatchObject({ verdict: "changes-requested", open: 1, items: [], comments: [] });
    expect(plan.body).toContain("Earlier items (0 fixed, 1 still open):");
    expect(plan.body).toContain("- F3: still open ([earlier comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r901))");
  });

  it("says Review passed only when every earlier finding is fixed and nothing is open, and names the commit each was fixed in", () => {
    const passed = planReview({ pull, head: hexOf("b"), nonce: "n", round1: null, draft: empty, prior: [line("F3", { status: "fixed", reason: "the code no longer has it" })] });
    expect(passed).toMatchObject({ verdict: "passed", open: 0, firstLine: "Review passed" });
    expect(passed.body).toContain(`- F3: fixed in ${hexOf("b").slice(0, 7)} (the code no longer has it)`);
  });

  it("reposts a finding whose thread is outdated, at its place on this head, once", () => {
    const place = { path: "pkg/a.go", line: 30, endLine: 30, side: "RIGHT" as const, anchored: true };
    const plan = planReview({ pull, head: hexOf("b"), nonce: "n", round1: null, draft: empty, prior: [line("F3", { repost: true, place })] });
    expect(plan.open).toBe(1);
    expect(plan.comments).toEqual([{ path: "pkg/a.go", line: 30, side: "RIGHT", body: expect.stringMatching(/Still open.*first raised on aaaaaaa[\s\S]*<!-- graphloom-finding: F3 -->$/) }]);
    expect(ledgerPatch({ head: hexOf("b") }, plan, empty, { reviewId: 5, url: null, how: "created" }, new Map([["F3", 77]])).items).toMatchObject([{ id: "F3", repost: true, commentId: 77 }]);
  });

  it("derives each earlier finding's line from the sweep's record, and never re-checks round 1's items", () => {
    const registry: PriorRegistry = { items: [item("Q1", { origin: "round1" }), item("F3", { aspect: "maintainability" }), item("F4", { aspect: "security" })], qa: [], nextQ: 2, nextF: 5, heads: [hexOf("a")] };
    const threads = [{ isOutdated: true, comments: [{ id: 901 }] }];
    const outcome = (id: string, status: "open" | "fixed", outdated: boolean) => ({ id, status, how: "reviewer" as const, reason: "r", path: "pkg/a.go", side: "RIGHT" as const, line: 12, endLine: 12, outdated });
    const records = [{ aspect: "maintainability", prior: [outcome("F3", "fixed", false)] }, { aspect: "security", prior: [outcome("F4", "open", true)] }] as never;
    const judged = priorLines(registry, PULL, records, [], threads);
    expect(judged.map((l) => [l.id, l.status, l.repost])).toEqual([["F3", "fixed", false], ["F4", "open", false]]);
    expect(judged[1]).toMatchObject({ outdated: true });
    // Found again, with its old thread outdated on GitHub, it is posted again at the place found.
    const found = [{ aspect: "security", prior: [outcome("F4", "open", false)] }] as never;
    expect(priorLines(registry, PULL, found, [], threads).find((l) => l.id === "F4")).toMatchObject({ repost: true, outdated: false });
  });
});

describe("a finding's place in the ledger across three heads", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  /** The same three-line change at three places: only the hunk's numbers differ, so each head's patch has the same id. */
  const patch = (at: number): PullFile => {
    const text = `@@ -${at},3 +${at},5 @@\n ctx\n+first line\n+second line\n+third line\n ctx`;
    return { path: "pkg/a.go", status: "modified", previousPath: null, additions: 3, deletions: 0, patch: text, patchOmitted: false, parsed: parsePatch(text) };
  };
  const pull = { ...PULL, head: hexOf("c") };
  const empty = { comments: [], summary: "", context: { source: "prelude" }, leads: { given: 0, raised: 0 } } as unknown as Draft;
  const draftOf = (line: number, startLine: number) => ({ ...empty, comments: [{ id: "F1", kind: "finding", aspects: ["maintainability"], severity: "P2", proof: { state: "non-behavioral" }, path: "pkg/a.go", side: "RIGHT", startLine, line, anchored: true, body: "Say what this is for." }] }) as unknown as Draft;

  it("records the first line and the last, anchored at the first; a finding re-posted at a shifted place is recorded there, and the next head shifts from there", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-place-"));
    dirs.push(dir);
    await sh("git", ["init", "-q", "-b", "main", dir], { env });
    await v2Ledger(dir, { design: { schema: "pr-design-review-ledger-v1", heads: [{ sha: hexOf("a") }, { sha: hexOf("b") }, { sha: hexOf("c") }], purposes: [], qa: [], items: [] } });
    const publish = async (head: string, p: ReturnType<typeof ledgerPatch>) => {
      const text = JSON.stringify({ ...p, head });
      for (const part of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", text)) await sh(part.argv[0]!, part.argv.slice(1), { cwd: dir, env });
      const c = ledgerPublishedCommand({ ...PULL, head }, JSON.parse(text), await baselinesNow(dir), process.execPath);
      await sh(c.argv[0]!, c.argv.slice(1), { cwd: dir, env });
      const show = async (p: string): Promise<unknown> => JSON.parse((await sh("git", ["show", `${REF}:${p}`], { cwd: dir, env })).stdout);
      return registryOf({ schema: "graphloom-pr-ledger-v2", design: await show("design/ledger.json"), review: await show("review/ledger.json") }).items.find((i) => i.id === "F1")!;
    };

    // Head 1: the finding covers lines 11 to 13 (the draft's `line` is the range's end). The ledger keeps 11 and 13, and the anchor is line 11's text.
    const meta1 = findingMeta({ id: "F1", raisedBy: "maintainability", severity: "P2", kind: "non-behavioral", path: "pkg/a.go", side: "RIGHT", startLine: 11, endLine: 13 }, [patch(10)]);
    const plan1 = planReview({ pull, head: hexOf("a"), nonce: "n", round1: null, draft: draftOf(13, 11), meta: new Map([["F1", meta1]]) });
    expect(plan1.comments).toMatchObject([{ path: "pkg/a.go", startLine: 11, line: 13 }]);
    const one = await publish(hexOf("a"), ledgerPatch(pull, plan1, empty, { reviewId: 1, url: null, how: "created" }, new Map([["F1", 501]])));
    expect(one).toMatchObject({ line: 11, endLine: 13, anchorText: "first line", hunk: [0, 10, 10] });

    // Head 2: the same change, 9 lines lower, and the old thread is outdated: the finding is posted again at 20 to 22 and recorded there with its anchor recomputed.
    const moved = reanchor(one, [patch(19)]);
    expect(moved).toEqual({ state: "found", line: 20, endLine: 22, how: "shifted" });
    const outcome = { id: "F1", status: "open" as const, how: "verifier" as const, reason: "still there", path: "pkg/a.go", side: "RIGHT" as const, line: 20, endLine: 22, outdated: false };
    const registry1: PriorRegistry = { items: [one], qa: [], nextQ: 1, nextF: 2, heads: [hexOf("a")] };
    const lines2 = priorLines(registry1, pull, [{ aspect: "maintainability", prior: [outcome] }] as never, [patch(19)], [{ isOutdated: true, comments: [{ id: 501 }] }]);
    expect(lines2[0]).toMatchObject({ repost: true, place: { line: 20, endLine: 22, anchored: true } });
    const plan2 = planReview({ pull, head: hexOf("b"), nonce: "n", round1: null, draft: empty, prior: lines2 });
    expect(plan2.comments).toMatchObject([{ path: "pkg/a.go", startLine: 20, line: 22 }]);
    const two = await publish(hexOf("b"), ledgerPatch(pull, plan2, empty, { reviewId: 2, url: null, how: "created" }, new Map([["F1", 777]])));
    expect(two).toMatchObject({ line: 20, endLine: 22, anchorText: "first line", hunk: [0, 19, 19], commentId: 777 });

    // Head 3: 10 lines lower again. From the recorded place it is 30 to 32, not shifted twice (40 to 42) and not an inverted range.
    expect(reanchor(two, [patch(29)])).toEqual({ state: "found", line: 30, endLine: 32, how: "shifted" });

    // A still-open item found again but not posted again is recorded at its new place as well.
    const registry2: PriorRegistry = { items: [two], qa: [], nextQ: 1, nextF: 2, heads: [hexOf("a"), hexOf("b")] };
    const outcome3 = { ...outcome, line: 30, endLine: 32 };
    const lines3 = priorLines(registry2, pull, [{ aspect: "maintainability", prior: [outcome3] }] as never, [patch(29)], []);
    expect(lines3[0]).toMatchObject({ repost: false, moved: { line: 30, endLine: 32, meta: { hunk: [0, 29, 29], anchorText: "first line" } } });
    const plan3 = planReview({ pull: PULL, head: hexOf("c"), nonce: "n", round1: null, draft: empty, prior: lines3 });
    const three = await publish(hexOf("c"), ledgerPatch(pull, plan3, empty, { reviewId: 3, url: null, how: "created" }, new Map()));
    expect(three).toMatchObject({ line: 30, endLine: 32, hunk: [0, 29, 29], commentId: 777 });
    expect(reanchor(three, [patch(39)])).toEqual({ state: "found", line: 40, endLine: 42, how: "shifted" });
  });
});

describe("recording a published review keeps non-ASCII text whole in a ledger far past one pipe buffer", () => {
  it("merges into a 250 KB ledger of CJK and emoji findings without altering a character", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-utf8-"));
    try {
      await sh("git", ["init", "-q", "-b", "main", dir], { env });
      const findings = Array.from({ length: 120 }, (_, i) => ({ head: hexOf("a"), id: `F${i + 1}`, origin: "round2", state: "open", path: "pkg/a.go", line: 1, text: `${"漢字かな한글".repeat(60)} ${"😀🎉".repeat(60)} ${i}`, history: [] }));
      const review = { schema: "pr-review-ledger-v1", heads: [], findings };
      expect(Buffer.byteLength(JSON.stringify(review), "utf8")).toBeGreaterThan(150_000);
      await v2Ledger(dir, { design: { schema: "pr-design-review-ledger-v1", heads: [{ sha: hexOf("a") }], purposes: [], qa: [], items: [] }, review });
      const empty = { comments: [], summary: "", context: { source: "prelude" }, leads: { given: 0, raised: 0 } } as unknown as Draft;
      const plan = planReview({ pull: { ...PULL }, head: hexOf("b"), nonce: "n", round1: null, draft: empty });
      const patch = JSON.stringify({ ...ledgerPatch({ ...PULL, head: hexOf("b") }, plan, empty, { reviewId: 1, url: null, how: "created" }, new Map()), head: hexOf("a") });
      for (const part of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", patch)) await sh(part.argv[0]!, part.argv.slice(1), { cwd: dir, env });
      const c = ledgerPublishedCommand({ ...PULL, head: hexOf("a") }, JSON.parse(patch), await baselinesNow(dir), process.execPath);
      await sh(c.argv[0]!, c.argv.slice(1), { cwd: dir, env });
      const after = (await sh("git", ["show", `${REF}:review/ledger.json`], { cwd: dir, env, maxBuffer: 10_000_000 })).stdout;
      expect(after).not.toContain("�");
      expect((JSON.parse(after) as { findings: Array<{ text: string }> }).findings.map((f) => f.text)).toEqual(findings.map((f) => f.text));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A real repository holding the ledger across runs, as the Answers and Publish stages advance it. */

describe("a pull request reviewed on three heads", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  /** A scenario that runs on the ledger `at` holds: the ledger ref and its registry, as Fetch reads them. */
  const onLedger = (name: string, at: Pick<LedgerState, "reads">, change: (s: ReturnType<typeof scenarioWith>) => void = () => undefined) =>
    scenarioWith(name, (s) => {
      withLedger(s, at);
      change(s);
    });
  /** What a v1 ledger (0.21 to 0.26) at commit `sha` reads as, when its registry is `v1`: the ref, and the registry in one part. */
  const v1At = (sha: string, v1: unknown): Pick<LedgerState, "reads"> => ({ reads: { "ledger-read": `present ${sha}\n`, "ledger-prior": priorChunkText(JSON.stringify(v1), 0) } });
  const end = (scenario: ReturnType<typeof scenarioWith>): Simulation => simulate({ scenario, maxSteps: 800, through: "end" });
  const body = (s: Simulation): string => String(s.github.creates[0]!.body);

  const state: { repo?: LedgerRepo; a?: Simulation; la?: LedgerState; lb?: LedgerState } = {};
  const HEAD1 = hexOf("1");
  const HEAD2 = hexOf("2");

  it("head 1: round 2 posts its finding; the ledger's review section holds it with its key, place and comment id, and the dismissed one closed", async () => {
    state.repo = await new LedgerRepo().init(dirs, "pr-review-heads-");
    state.a = end(scenarioWith("review-layer", () => undefined));
    const a = state.a;
    expect(stopOf(a)).toMatchObject({ reason: "complete" });
    expect(body(a).split("\n")[0]).toBe("Changes requested: 1 open");
    state.la = await state.repo.advance(a, HEAD1);
    expect(state.la.design).toBeUndefined();
    expect(state.la.review!.findings.find((f) => f.id === "F3")).toMatchObject({ origin: "round2", state: "open", aspect: "maintainability", key: expect.stringMatching(/^maintainability\|pkg\/schema\/ttl\.go\|/), anchorText: expect.any(String), patchId: expect.any(String), hunk: expect.any(Array), github: { head: HEAD1, inline: true, commentId: a.github.reviews[0]!.comments[0]!.id } });
    expect(state.la.review!.findings.find((f) => f.id === "F2")).toMatchObject({ state: "withdrawn", origin: "round2" });
    expect(state.la.review!.heads.map((h) => [h.sha, h.verdict, h.context, h.round1])).toEqual([[HEAD1, "changes-requested", { source: "prelude" }, null]]);
  });

  /** The reviewers' scripted replies for a later head: the aspects' passes in order, and the verifier's. */
  const reviewers = (review: Array<Parameters<typeof passReply>>, verify: Array<ReturnType<typeof verifyReply>> = [], commands: Record<string, { exitCode: number; stdout?: string }> = {}) => (s: ReturnType<typeof scenarioWith>): void => {
    // The maintainability reviewer's first pass (the second reply) judges every lead it is given: none is an issue here.
    const given = (s.results[REVIEW_SCHEMA_NAME]![2]!.output as { leads: LeadEntry[] }).leads.map((l) => ({ ...l, status: "not-an-issue" as const, comment: -1, reason: "not an issue in this change" }));
    s.results[REVIEW_SCHEMA_NAME] = review.map((a, k) => (k === 1 ? passReply(a[0], a[1], a[2], given) : passReply(...a)));
    s.results[VERIFY_SCHEMA_NAME] = verify;
    Object.assign(s.commands!, commands);
  };
  const F3_COMMENT = "The loop that adds 0+1+2 to n has no purpose a reader can find; remove it or say what it is for.";
  const aspectOf = (s: Simulation, aspect: "correctness" | "maintainability" | "security") => {
    const r = recordedAspect(s.evidence, aspect);
    if (r.state !== "read") throw new Error(`${aspect} was not recorded`);
    return r.value;
  };

  it("head 2: the finding is fixed, so the review passes and says which finding was fixed in which commit", async () => {
    const c = end(onLedger("review-layer", state.la!, reviewers([[1, []], [1, [], [{ finding: "F3", status: "fixed", reason: "the loop is gone from ParseTTL" }]], [1, []]])));
    expect(stopOf(c)).toMatchObject({ reason: "complete", blocker: expect.stringMatching(/^review passed on /) });
    expect(body(c).split("\n")[0]).toBe("Review passed");
    expect(body(c)).toContain("Earlier items (1 fixed, 0 still open):");
    expect(body(c)).toContain("- F3: fixed in 0123456 (the loop is gone from ParseTTL)");
    expect(c.github.creates[0]!.comments).toEqual([]);
    expect(aspectOf(c, "maintainability").prior).toMatchObject([{ id: "F3", status: "fixed", how: "reviewer" }]);
    // No verifier job: a finding the reviewer calls fixed is not a claim to confirm.
    expect(c.jobs.filter((j) => j.instruction.startsWith("Verify")).length).toBe(0);
    const l = await state.repo!.advance(c, HEAD2);
    expect(l.review!.findings.find((f) => f.id === "F3")).toMatchObject({ state: "fixed", fixedIn: HEAD2, history: [{ head: HEAD1, status: "open" }, { head: HEAD2, status: "fixed" }] });
    expect(l.review!.heads.map((h) => [h.sha, h.verdict])).toEqual([[HEAD1, "changes-requested"], [HEAD2, "passed"]]);
    expect(l.design).toBeUndefined();
    state.lb = l;
  });

  it("head 2: a finding still present is confirmed like a new one, stays open, links its earlier comment, and is not commented again", () => {
    const earlier = state.a!.github.reviews[0]!.comments[0]!.id;
    const verified = verifyReply([{ finding: "F3", verdict: "confirmed", kind: "non-behavioral", witness: "pkg/schema/ttl.go:14", reason: "the loop is still there", fixes: false }]);
    const c = end(onLedger("review-layer", state.la!, reviewers([[1, []], [1, [], [{ finding: "F3", status: "still_present" }]], [1, []]], [verified])));
    expect(stopOf(c)).toMatchObject({ reason: "complete", blocker: expect.stringMatching(/^changes requested: 1 open/) });
    expect(body(c).split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body(c)).toContain(`- F3: still open ([earlier comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r${earlier}))`);
    expect(c.github.creates[0]!.comments).toEqual([]);
    expect(aspectOf(c, "maintainability").prior).toMatchObject([{ id: "F3", status: "open", how: "verifier", reason: "the loop is still there" }]);
    // The verifier was asked about it as a finding of an earlier head.
    const asked = c.jobs.find((j) => j.instruction.startsWith("Verify the maintainability"))!;
    expect((asked.input as { assignment: string }).assignment).toContain("an earlier head's finding");
  });

  it("head 2: a still-present finding the verifier refutes with quotes of the head is fixed", () => {
    const refuted = verifyReply([{ finding: "F3", verdict: "refuted", quotes: [{ path: "pkg/schema/ttl.go", line: 14, text: "for i := 0; i < 3; i++ {" }], reason: "the head no longer adds to n" }]);
    const c = end(onLedger("review-layer", state.la!, reviewers([[1, []], [1, [], [{ finding: "F3", status: "still_present" }]], [1, []]], [refuted], { "rvq-maintainability-1-1": { exitCode: 0, stdout: "1 ok\nchecked 1\n" } })));
    expect(body(c).split("\n")[0]).toBe("Review passed");
    expect(body(c)).toContain("- F3: fixed in 0123456 (the head no longer adds to n)");
    expect(aspectOf(c, "maintainability").prior).toMatchObject([{ id: "F3", status: "fixed", how: "verifier" }]);
  });

  it("head 2: a new finding numbers on from the ledger (F4), beside an earlier one fixed", () => {
    const comment = { path: "pkg/schema/ttl.go", start_line: 20, end_line: 22, aspect: "maintainability", kind: "non-behavioral", severity: "P2", content: "The unit switch repeats the hour arithmetic for each case; name it once." };
    const verified = verifyReply([{ finding: "F4", verdict: "confirmed", kind: "non-behavioral", witness: "pkg/schema/ttl.go:20", reason: "the arithmetic is repeated", fixes: false }]);
    const c = end(onLedger("review-layer", state.la!, reviewers([[1, []], [1, [comment], [{ finding: "F3", status: "fixed" }]], [1, []], [1, []]], [verified])));
    expect(aspectOf(c, "maintainability").findings.map((f) => f.id)).toEqual(["F4"]);
    expect(body(c).split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body(c)).toContain("- F3: fixed in 0123456");
    expect(c.github.creates[0]!.comments).toMatchObject([{ path: "pkg/schema/ttl.go", body: expect.stringMatching(/<!-- graphloom-finding: F4 -->$/) }]);
  });

  it("head 2: the earlier findings are verified in the first pass only; a later pass keeps their settled outcomes and asks nothing more of them", () => {
    const comment = { path: "pkg/schema/ttl.go", start_line: 20, end_line: 22, aspect: "maintainability", kind: "non-behavioral", severity: "P2", content: "The unit switch repeats the hour arithmetic for each case; name it once." };
    const verified = verifyReply([
      { finding: "F4", verdict: "confirmed", kind: "non-behavioral", witness: "pkg/schema/ttl.go:20", reason: "the arithmetic is repeated", fixes: false },
      { finding: "F3", verdict: "confirmed", kind: "non-behavioral", witness: "pkg/schema/ttl.go:14", reason: "the loop is still there", fixes: false },
    ]);
    // Pass 2 raises nothing; with the earlier finding queued again it would need a second verifier job, which the script does not have.
    const c = end(onLedger("review-layer", state.la!, reviewers([[1, []], [1, [comment], [{ finding: "F3", status: "still_present" }]], [1, []], [1, []]], [verified])));
    expect(stopOf(c)).toMatchObject({ reason: "complete" });
    expect(c.jobs.filter((j) => j.instruction.startsWith("Verify the maintainability")).length).toBe(1);
    expect(aspectOf(c, "maintainability").prior).toMatchObject([{ id: "F3", status: "open", how: "verifier" }]);
    expect(aspectOf(c, "maintainability").passes).toHaveLength(2);
  });

  it("head 2 of a 0.21 ledger: a finding recorded without its aspect goes to the maintainability sweep, with its legacy body as the claim, and is judged there", () => {
    // What a 0.21 run left: no aspect, no key, no anchor, a single line.
    const old21 = { schema: "graphloom-pr-ledger-v1", heads: [{ sha: hexOf("a"), reviewed: true }], qa: [], findings: [{ head: hexOf("a"), id: "F3", origin: "round2", path: "pkg/schema/ttl.go", line: 16, state: "open", body: "The loop that adds 0+1+2 to n has no purpose a reader can find.", github: { head: hexOf("a"), reviewId: 9, commentId: 55, inline: true } }] };
    const at = v1At(hexOf("d"), old21);
    const c = end(onLedger("review-layer", at, reviewers([[1, []], [1, [], [{ finding: "F3", status: "fixed", reason: "gone" }]], [1, []]])));
    expect(aspectOf(c, "maintainability").prior).toMatchObject([{ id: "F3", status: "fixed" }]);
    expect(aspectOf(c, "correctness").prior).toBeUndefined();
    expect(body(c).split("\n")[0]).toBe("Review passed");
    expect(body(c)).toContain("- F3: fixed in 0123456 (gone)");
    // Its anchor was never recorded, so a pass that cannot find it says so and the finding is listed, with its link, not posted again.
    const open = end(onLedger("review-layer", at, reviewers([[1, []], [1, [], [{ finding: "F3", status: "still_present" }]], [1, []]], [verifyReply([{ finding: "F3", verdict: "confirmed", kind: "non-behavioral", witness: "pkg/schema/ttl.go:16", reason: "still there", fixes: false }])])));
    expect(aspectOf(open, "maintainability").prior).toMatchObject([{ id: "F3", status: "open", outdated: true }]);
    expect(body(open)).toContain("- F3: still open ([earlier comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r55))");
    expect(open.github.creates[0]!.comments).toEqual([]);
  });

  it("head 2 of a 0.21 ledger: a finding with no recorded claim is not sent to a reviewer; it stays open, listed with its link and the reason", () => {
    const old21 = { schema: "graphloom-pr-ledger-v1", heads: [{ sha: hexOf("a"), reviewed: true }], qa: [], findings: [{ head: hexOf("a"), id: "F3", origin: "round2", path: "pkg/schema/ttl.go", line: 16, state: "open", github: { head: hexOf("a"), reviewId: 9, commentId: 55, inline: true } }] };
    const at = v1At(hexOf("d"), old21);
    // The reviewer is given nothing to judge (its `prior` list is empty), so it cannot close the finding unchecked.
    const c = end(onLedger("review-layer", at, reviewers([[1, []], [1, []], [1, []]])));
    expect(aspectOf(c, "maintainability").prior).toMatchObject([{ id: "F3", status: "open", how: "carried", reason: "not re-checked: no recorded claim" }]);
    const asked = c.jobs.filter((j) => j.instruction.startsWith("Review the maintainability")).map((j) => (j.input as { assignment: string }).assignment).join("\n");
    expect(asked).not.toContain("an earlier review of this pull request raised");
    expect(body(c).split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body(c)).toContain("- F3: still open ([earlier comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r55)) (not re-checked: no recorded claim)");
    expect(c.github.creates[0]!.comments).toEqual([]);
  });

  it("head 3: a finding that was closed, fixed or dismissed, is not raised again; a comment over its place is dropped before verification", () => {
    const again = { path: "pkg/schema/ttl.go", start_line: 14, end_line: 16, aspect: "maintainability", kind: "non-behavioral", severity: "P2", content: F3_COMMENT };
    const dismissed = { path: "pkg/schema/ttl.go", start_line: 8, end_line: 9, aspect: "correctness", kind: "behavioral", severity: "P2", content: "unit is read before it is set when the string has no letter, so a bare number is accepted as hours." };
    const d = end(onLedger("review-layer", state.lb!, reviewers([[1, [dismissed]], [1, [again]], [1, []]])));
    // Nothing was raised, so no verifier ran, and the sweeps ended on their first pass.
    expect(d.jobs.filter((j) => j.instruction.startsWith("Verify")).length).toBe(0);
    expect(aspectOf(d, "correctness")).toMatchObject({ findings: [], passes: [{ raised: [], suppressed: 1 }] });
    expect(aspectOf(d, "maintainability")).toMatchObject({ findings: [], passes: [{ raised: [], suppressed: 1 }] });
    expect(body(d).split("\n")[0]).toBe("Review passed");
  });

});
