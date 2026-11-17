// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { LEDGER_MOVED } from "../src/constants.js";
import { ledgerRead, ledgerWriteCommands, migrationOf, oldValue, parseSectionRecord, priorChunkText, priorState, readBaselines, writtenLedger } from "../src/ledger.js";
import { blobId, DESIGN_SCHEMA, migratedDesignMarkdown, migratedTrees, migrateV1, MOVED_REASON, reviewMarkdown, REVIEW_SCHEMA, SKIPPED_NOTE, SUPERSEDED_REASON, topLedgerJson, treeId } from "../src/ledgerv2.js";
import { registryOf } from "../src/prior.js";
import { ledgerPatch, ledgerPublishedCommand, planReview } from "../src/publish.js";
import type { PullRequest } from "../src/request.js";
import { ROUND1_SCHEMA, type Round1Issue } from "../src/round1.js";
import { answersComplete } from "../src/validators.js";
import { commitLedger, LEDGER_PULL, LEDGER_REF, ledgerFiles, LedgerRepo, v2Ledger, withLedger } from "./ledgerrepo.js";
import { BANYANDB, candidateEvidence, scenarioWith, simulate } from "./support.js";

const hex = (c: string): string => c.repeat(40);
const [H0, H1, H2, H3, H4, B] = ["0", "1", "2", "3", "4", "b"].map(hex) as [string, string, string, string, string, string];
const url = (id: number): string => `https://github.com/apache/skywalking-banyandb/pull/7#pullrequestreview-${id}`;
const gh = (head: string, reviewId: number, commentId: number | null) => ({ head, reviewId, commentId, inline: commentId !== null });
const PR = { ...LEDGER_PULL, head: hex("5"), mode: "review" } as PullRequest;

/** A question of a v1 ledger's Q&A, as 0.26's Answers write recorded it. */
const q = (id: string, type: string, key: string, item: string, symbol: string | null = null) => ({ id, type, key, symbol, item, status: "partially answered", answer: "Some of it.", state: "open", history: [] });
/** A round-1 item of a v1 ledger, as 0.26's `ledger-published` recorded it: posted on H2 and still open, carried by the review-only H3. */
const posted = (id: string, key: string, over: Record<string, unknown> = {}) => ({
  head: H2,
  id,
  origin: "round1",
  path: "pkg/quota/limit.go",
  line: 6,
  text: `**partially answered** (${id}). Why?`,
  key,
  side: "RIGHT",
  state: "open",
  github: gh(H2, 7002, null),
  history: [{ head: H2, status: "open" }, { head: H3, status: "open", reason: "not re-checked: round 1 was skipped by the operator's choice", carried: true }],
  ...over,
});

/**
 * A v1 ledger as 0.21 to 0.26 left it after five heads of one pull request, every kind of head and item in it: H0's round 1 posted
 * Q1, which H1 fixed; H1's round 1 was clean and round 2 posted F1; H2's round 1 posted N1 and ten questions; H3 was a review-only
 * run (round 1 skipped) whose round 2 fixed F1, posted F2 and withdrew F3; H4's Answers stage wrote the ledger and Publish never ran.
 */
const V1 = {
  schema: "graphloom-pr-ledger-v1",
  pull: { owner: "apache", repo: "skywalking-banyandb", number: 7 },
  heads: [
    { sha: H0, base: B, files: 2, commits: 1, facts: 3, reported: true, reviewed: false, reviewId: 7000, round1: "issues", verdict: "changes-requested", open: 1, reviewUrl: url(7000) },
    { sha: H1, base: B, files: 2, commits: 2, facts: 3, reported: true, reviewed: true, reviewId: 7001, round1: "clean", verdict: "changes-requested", open: 1, reviewUrl: url(7001) },
    { sha: H2, base: B, files: 3, commits: 3, facts: 4, reported: true, reviewed: false, reviewId: 7002, round1: "issues", verdict: "changes-requested", open: 12, reviewUrl: url(7002) },
    { sha: H3, base: B, files: 3, commits: 4, facts: 4, reported: true, reviewed: true, reviewId: 7003, round1: "skipped", verdict: "changes-requested", open: 12, reviewUrl: url(7003) },
    { sha: H4, base: B, files: 3, commits: 5, facts: 4, reported: true, reviewed: false },
  ],
  purposes: [{ item: "C1", status: "stated", quote: "adds a limit", source: "body" }],
  qa: [
    q("N1", "necessity", "necessity|N1", ""),
    q("Q1", "existing-reuse-common", "existing-reuse-common|sym|pkg/quota/limit.go|quota.Old", "C1", "S9"),
    q("Q2", "missing-test", "missing-test|sym|pkg/quota/limit.go|quota.Limit", "C1", "S1"),
    q("Q3", "split-function", "split-function|sym|pkg/quota/limit.go|quota.Limit", "C1", "S1"),
    q("Q4", "complexity-coverage", "complexity-coverage|fn|pkg/quota/limit.go|quota.Limit.func1", "C1", "quota.Limit.func1"),
    q("Q5", "purpose", "purpose|item|pkg/quota/limit.go", "C2"),
    q("Q6", "purpose", "purpose|item|pkg/quota/burst.go", "W1"),
    q("Q7", "existing-reuse-common", "existing-reuse-common|item|pkg/quota/burst.go", "W2"),
    q("Q8", "other", "other|sym|pkg/quota/limit.go|quota.Limit", "C1", "S1"),
    q("Q9", "weak-test", "weak-test|fn|pkg/quota/limit.go|quota.Limit:12", "C1", "quota.Limit"),
    q("Q10", "other", "other|item|pkg/quota/burst.go", "W3"),
    q("Q11", "existing-reuse-common", "existing-reuse-common|sym|pkg/quota/burst.go|quota.Burst", "W1", "S2"),
  ],
  findings: [
    { head: H0, id: "Q1", origin: "round1", path: "pkg/quota/limit.go", line: 3, text: "Q1 text", key: "existing-reuse-common|sym|pkg/quota/limit.go|quota.Old", side: "RIGHT", state: "fixed", github: gh(H0, 7000, 9000), history: [{ head: H0, status: "open" }, { head: H1, status: "fixed", reason: "its question is now answered, with no blocking category" }], fixedIn: H1 },
    { head: H1, id: "F1", origin: "round2", path: "pkg/quota/limit.go", line: 9, endLine: 10, text: "The loop drops the error.", key: "correctness|pkg/quota/limit.go|abc", aspect: "correctness", severity: "P1", kind: "behavioral", side: "RIGHT", anchorText: "for {", patchId: "p1", hunk: [0, 1, 1], state: "fixed", github: gh(H1, 7001, 9101), history: [{ head: H1, status: "open" }, { head: H2, status: "open", reason: "not re-checked on this head: round 1 has open issues, so round 2 did not run", carried: true }, { head: H3, status: "fixed", reason: "gone" }], fixedIn: H3 },
    posted("N1", "necessity|N1", { path: null, line: null }),
    posted("Q2", "missing-test|sym|pkg/quota/limit.go|quota.Limit"),
    posted("Q3", "split-function|sym|pkg/quota/limit.go|quota.Limit"),
    posted("Q4", "complexity-coverage|fn|pkg/quota/limit.go|quota.Limit.func1"),
    posted("Q5", "purpose|item|pkg/quota/limit.go"),
    posted("Q6", "purpose|item|pkg/quota/burst.go"),
    posted("Q7", "existing-reuse-common|item|pkg/quota/burst.go", { covers: ["Q11"] }),
    posted("Q8", "other|sym|pkg/quota/limit.go|quota.Limit"),
    posted("Q9", "weak-test|fn|pkg/quota/limit.go|quota.Limit:12"),
    posted("Q10", "other|item|pkg/quota/burst.go"),
    posted("Q11", "existing-reuse-common|sym|pkg/quota/burst.go|quota.Burst"),
    { head: H3, id: "F2", origin: "round2", path: "pkg/quota/burst.go", line: 4, endLine: 4, text: "Say what this is for.", key: "maintainability|pkg/quota/burst.go|def", aspect: "maintainability", severity: "P2", kind: "non-behavioral", side: "RIGHT", state: "open", github: gh(H3, 7003, 9301), history: [{ head: H3, status: "open" }] },
    { head: H3, id: "F3", origin: "round2", path: "pkg/quota/burst.go", line: 8, endLine: 8, side: "RIGHT", text: "A dismissed claim.", state: "withdrawn", history: [{ head: H3, status: "withdrawn" }], key: "security|pkg/quota/burst.go|ghi", aspect: "security" },
  ],
};

/** The 0.21 ledgers `rereview.test.ts` builds: one reviewed head, and F3 with no aspect, key or anchor (with and without its claim). */
const OLD21 = { schema: "graphloom-pr-ledger-v1", heads: [{ sha: hex("a"), reviewed: true }], qa: [], findings: [{ head: hex("a"), id: "F3", origin: "round2", path: "pkg/schema/ttl.go", line: 16, state: "open", body: "The loop that adds 0+1+2 to n has no purpose a reader can find.", github: gh(hex("a"), 9, 55) }] };

/** The ledger the `incremental-round1` scenario's first head leaves (`incremental-rounds.test.ts`): round 1 posted Q1, the per-symbol reuse question, and ended. */
const INCREMENTAL = {
  schema: "graphloom-pr-ledger-v1",
  heads: [{ sha: H1, base: B, files: 1, commits: 1, facts: 0, reported: true, reviewed: false, reviewId: 7001, round1: "issues", verdict: "changes-requested", open: 1, reviewUrl: url(7001) }],
  qa: [q("N1", "necessity", "necessity|N1", ""), q("Q1", "existing-reuse-common", "existing-reuse-common|sym|pkg/quota/limit.go|quota.Limit", "R1", "S1")],
  findings: [{ head: H1, id: "Q1", origin: "round1", path: "pkg/quota/limit.go", line: 6, text: "Q1", key: "existing-reuse-common|sym|pkg/quota/limit.go|quota.Limit", side: "RIGHT", state: "open", github: gh(H1, 7001, 9001), history: [{ head: H1, status: "open" }] }],
};

describe("migrating a v1 ledger (design-pr-review-split §5.4), field by field", () => {
  const m = migrateV1(V1);
  const item = (id: string) => (m.design.items as Array<Record<string, unknown>>).find((x) => x.id === id)!;
  const v1Item = (id: string) => V1.findings.find((x) => x.id === id)! as Record<string, unknown>;

  it("puts every head in the design section, with round 1's outcome and a round-1 post's review id, and the reviewed ones in the review section", () => {
    expect(m.design.schema).toBe(DESIGN_SCHEMA);
    expect(m.design.heads).toEqual([
      { sha: H0, base: B, files: 2, commits: 1, facts: 3, round1: "items", open: 1, reviewId: 7000, reviewUrl: url(7000) },
      { sha: H1, base: B, files: 2, commits: 2, facts: 3, round1: "clean", open: 0 },
      { sha: H2, base: B, files: 3, commits: 3, facts: 4, round1: "items", open: 11, reviewId: 7002, reviewUrl: url(7002) },
      { sha: H3, base: B, files: 3, commits: 4, facts: 4, round1: "clean", open: 11, note: SKIPPED_NOTE },
      { sha: H4, base: B, files: 3, commits: 5, facts: 4 },
    ]);
    expect(m.review!.schema).toBe(REVIEW_SCHEMA);
    expect(m.review!.heads).toEqual([
      { sha: H1, base: B, context: { source: "design-review", head: H1 }, round1: { head: H1, open: 0 }, reviewId: 7001, reviewUrl: url(7001), verdict: "changes-requested", open: 1, leads: { given: 0, raised: 0 } },
      { sha: H3, base: B, context: { source: "prelude" }, round1: null, reviewId: 7003, reviewUrl: url(7003), verdict: "changes-requested", open: 12, leads: { given: 0, raised: 0 } },
    ]);
  });

  it("moves the Q&A and the purposes to the design section, keying a high-level existing-reuse-common question as existing-feature", () => {
    expect(m.design.purposes).toEqual(V1.purposes);
    expect(m.design.qa).toEqual(V1.qa.map((x) => (x.id === "Q7" ? { ...x, key: "existing-feature|item|pkg/quota/burst.go" } : x)));
  });

  it("keeps N1 and the round-1 items round 1 still asks (open, fixed), and closes the open ones of moved types as moved or superseded, with a reason", () => {
    expect((m.design.items as Array<{ id: string }>).map((x) => x.id)).toEqual(["Q1", "N1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10", "Q11"]);
    // Unchanged: a fixed item (even of a moved type), N1, a purpose and an `other` about a high-level change.
    for (const id of ["Q1", "N1", "Q6", "Q10"]) expect(item(id)).toEqual(v1Item(id));
    // The high-level reuse question stays open under its v2 key.
    expect(item("Q7")).toEqual({ ...v1Item("Q7"), key: "existing-feature|item|pkg/quota/burst.go" });
    // The detail questions, and the per-symbol reuse question, are the PR review's leads now.
    for (const id of ["Q2", "Q3", "Q4", "Q9", "Q11"]) expect(item(id)).toEqual({ ...v1Item(id), state: "moved", reason: MOVED_REASON });
    // A purpose about a change item that is not a high-level change, and an `other` about a symbol.
    for (const id of ["Q5", "Q8"]) expect(item(id)).toEqual({ ...v1Item(id), state: "superseded", reason: SUPERSEDED_REASON });
  });

  it("moves the F<n> findings to the review section unchanged, whatever their state", () => {
    expect(m.review!.findings).toEqual(V1.findings.filter((f) => f.id.startsWith("F")));
  });

  it("migrates the 0.21 ledgers rereview.test.ts builds: no round 1 recorded, a reviewed head, and F3 as it was", () => {
    for (const v1 of [OLD21, { ...OLD21, findings: [{ ...OLD21.findings[0]!, body: undefined }] }]) {
      const o = migrateV1(v1);
      expect(o.design).toEqual({ schema: DESIGN_SCHEMA, heads: [{ sha: hex("a") }], purposes: [], qa: [], items: [] });
      expect(o.review).toEqual({ schema: REVIEW_SCHEMA, heads: [{ sha: hex("a"), context: { source: "design-review", head: hex("a") }, round1: { head: hex("a"), open: 0 }, leads: { given: 0, raised: 0 } }], findings: v1.findings });
    }
  });

  it("migrates the incremental-round1 scenario's first head: its per-symbol reuse issue is moved, and no review section is made", () => {
    const o = migrateV1(INCREMENTAL);
    expect(o.design.heads).toEqual([{ sha: H1, base: B, files: 1, commits: 1, facts: 0, round1: "items", open: 1, reviewId: 7001, reviewUrl: url(7001) }]);
    expect(o.design.items).toEqual([{ ...INCREMENTAL.findings[0], state: "moved", reason: MOVED_REASON }]);
    expect(o.review).toBeUndefined();
  });

  it("gives the registry a later head continues from: ids number on, and a moved or superseded item is neither re-checked nor counted", () => {
    const r = registryOf(V1);
    expect(r).toMatchObject({ nextQ: 12, nextF: 4, heads: [H0, H1, H2, H3, H4] });
    expect(r.items.filter((x) => x.status === "open").map((x) => x.id)).toEqual(["N1", "Q6", "Q7", "Q10", "F2"]);
    expect(r.items.filter((x) => x.status === "moved").map((x) => x.id)).toEqual(["Q2", "Q3", "Q4", "Q9", "Q11"]);
    expect(r.items.filter((x) => x.status === "superseded").map((x) => x.id)).toEqual(["Q5", "Q8"]);
    // The same registry from the two sections, as a v2 ledger holds them.
    expect(registryOf({ schema: "graphloom-pr-ledger-v2", design: m.design, review: m.review })).toEqual(r);
  });

  it("is a function of what Fetch reads: the registry the extract keeps migrates as the whole ledger does, but for the answers the extract leaves out", () => {
    const extract = { schema: V1.schema, heads: V1.heads, qa: V1.qa.map(({ answer: _a, history: _h, ...rest }) => rest), findings: V1.findings };
    const e = migrateV1(extract);
    expect(e.review).toEqual(m.review);
    expect({ ...e.design, qa: undefined, purposes: undefined }).toEqual({ ...m.design, qa: undefined, purposes: undefined });
  });
});

describe("the Git ids a migration names before it writes", () => {
  it("are the ids git gives the same blobs and trees", async () => {
    const dirs: string[] = [];
    const repo = await new LedgerRepo().init(dirs, "pr-review-ids-");
    try {
      const text = "漢字 😀 {\"a\":1}\n";
      await writeFile(path.join(repo.dir, ".git", "blob"), text);
      expect(blobId(text)).toBe(await repo.git("hash-object", path.join(repo.dir, ".git", "blob")));
      const sha = await commitLedger(repo.dir, { "a.json": "1", "ledger.json": "2", "z/x": "3", "ledger.md": "4" });
      const sub = await repo.git("rev-parse", `${sha}:z`);
      expect(treeId([{ name: "x", id: blobId("3") }])).toBe(sub);
      expect(treeId([{ name: "ledger.md", id: blobId("4") }, { name: "z", id: sub, tree: true }, { name: "a.json", id: blobId("1") }, { name: "ledger.json", id: blobId("2") }])).toBe(await repo.git("rev-parse", `${sha}^{tree}`));
    } finally {
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    }
  });
});

describe("writing a section, against a real repository (design-pr-review-split §5.2)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const TOP = topLedgerJson(LEDGER_PULL);
  const DESIGN = { schema: DESIGN_SCHEMA, heads: [{ sha: H1, round1: "clean", open: 0 }], purposes: [], qa: [], items: [] };
  const REVIEW = { schema: REVIEW_SCHEMA, heads: [], findings: [{ id: "F1", state: "open" }] };

  async function repoWithWorktree(): Promise<LedgerRepo> {
    const repo = await new LedgerRepo().init(dirs, "pr-review-sections-");
    await mkdir(path.join(repo.dir, ".graphloom/review"), { recursive: true });
    for (const [name, text] of Object.entries({ "qa.json": '{"qa":1}', "report.json": '{"report":1}', "necessity.json": '{"necessity":1}' })) await writeFile(path.join(repo.dir, ".graphloom/review", name), text);
    return repo;
  }
  /** What a run's Fetch reads of the ledger now, and the write its Answers stage makes from that read. */
  async function answersWrite(repo: LedgerRepo, tag = "mine"): Promise<{ evidence: EvidenceRecord[]; commands: { parts: EnvironmentCommand[]; write: EnvironmentCommand } }> {
    const { evidence } = await repo.reads();
    const read = ledgerRead(evidence)!;
    const prior = priorState(evidence, oldValue(read.ledger));
    const baselines = readBaselines(read.ledger, prior, PR)!;
    const json = JSON.stringify({ schema: DESIGN_SCHEMA, heads: [{ sha: PR.head }], tag, items: prior.state === "read" ? prior.value.design?.items ?? [] : [] });
    return { evidence, commands: ledgerWriteCommands(PR, oldValue(read.ledger), baselines.design, json, `# ${tag}\n`, migrationOf(prior, PR)) };
  }
  const run = async (repo: LedgerRepo, c: { parts: EnvironmentCommand[]; write: EnvironmentCommand }) => {
    for (const p of c.parts) await repo.exec(p.argv);
    return repo.exec(c.write.argv);
  };
  const fails = async (p: Promise<unknown>): Promise<{ code: number; stderr: string }> => {
    try {
      await p;
    } catch (err) {
      return err as { code: number; stderr: string };
    }
    throw new Error("the command succeeded");
  };

  it("migrates a v1 commit on the first write: the top-level ledger.json, its own design section, and the review section the migration builds", async () => {
    const repo = await repoWithWorktree();
    const v1 = await commitLedger(repo.dir, { "ledger.json": JSON.stringify(V1), "ledger.md": "# v1\n", "qa.json": '{"old":"qa"}', "report.json": '{"old":"report"}', "necessity.json": '{"old":"n1"}' });
    const { evidence, commands } = await answersWrite(repo);
    const w = writtenLedger(commands.write.argv)!;
    expect(w).toMatchObject({ old: v1, section: "design", migration: { mode: "v1+review" } });
    const out = await run(repo, commands);
    const record = parseSectionRecord(out.stdout)!;
    const now = await repo.git("rev-parse", LEDGER_REF);
    expect(record).toMatchObject({ advanced: now, cur: v1 });
    expect(await repo.git("rev-parse", `${now}^`)).toBe(v1);
    const files = await ledgerFiles(repo.dir);
    expect(Object.keys(files).sort()).toEqual(["design/ledger.json", "design/ledger.md", "design/necessity.json", "design/qa.json", "design/report.json", "ledger.json", "review/ledger.json", "review/ledger.md"]);
    expect(files["ledger.json"]).toBe(TOP);
    expect(files["design/qa.json"]).toBe('{"qa":1}');
    // The review section is the migration of what Fetch read (the extract), and its subtree is the one the plugin names before writing.
    const prior = priorState(evidence, v1);
    expect(prior).toMatchObject({ state: "read", layout: "v1" });
    const extract = (prior as { v1: unknown }).v1;
    expect(JSON.parse(files["review/ledger.json"]!)).toEqual(migrateV1(extract).review);
    expect(files["review/ledger.md"]).toBe(reviewMarkdown(LEDGER_PULL));
    const listing = ledgerRead(evidence)!.ledger as unknown as { entries: Map<string, string> };
    const trees = migratedTrees(extract, PR, listing.entries);
    expect(record.sections.review).toBe(trees.review);
    expect(await repo.git("rev-parse", `${now}:review`)).toBe(trees.review);
    // The migrated design subtree (the baseline) is what git makes of the migrated ledger.json beside the v1 commit's own files.
    const design = await commitLedger(repo.dir, { "design/ledger.json": trees.json.design, "design/ledger.md": migratedDesignMarkdown(LEDGER_PULL), "design/qa.json": '{"old":"qa"}', "design/report.json": '{"old":"report"}', "design/necessity.json": '{"old":"n1"}' });
    expect(await repo.git("rev-parse", `${design}:design`)).toBe(trees.design);
    expect(w.baseline).toBe(trees.design);
  });

  it("carries the other section when it advanced between Fetch and the write, and never changes the top-level ledger.json", async () => {
    const repo = await repoWithWorktree();
    await v2Ledger(repo.dir, { design: DESIGN, review: REVIEW });
    const { commands } = await answersWrite(repo);
    // Another run (the PR review) advances the review section after this run's Fetch read the ledger.
    const other = await commitLedger(repo.dir, { ...(await ledgerFiles(repo.dir)), "review/ledger.json": JSON.stringify({ ...REVIEW, findings: [{ id: "F1" }, { id: "F2" }] }) });
    const out = await run(repo, commands);
    const now = await repo.git("rev-parse", LEDGER_REF);
    expect(parseSectionRecord(out.stdout)).toMatchObject({ advanced: now, cur: other });
    expect(await repo.git("rev-parse", `${now}^`)).toBe(other);
    expect(await repo.git("rev-parse", `${now}:review`)).toBe(await repo.git("rev-parse", `${other}:review`));
    expect(JSON.parse(await repo.git("show", `${now}:design/ledger.json`))).toMatchObject({ tag: "mine" });
    expect(await repo.git("show", `${now}:ledger.json`)).toBe(TOP);
  });

  it("stops \"ledger moved\" when its own section advanced between Fetch and the write, leaving the ref where the other run put it", async () => {
    const repo = await repoWithWorktree();
    await v2Ledger(repo.dir, { design: DESIGN, review: REVIEW });
    const { commands } = await answersWrite(repo);
    const other = await commitLedger(repo.dir, { ...(await ledgerFiles(repo.dir)), "design/ledger.json": JSON.stringify({ ...DESIGN, heads: [] }) });
    const err = await fails(run(repo, commands));
    expect(err.code).toBe(LEDGER_MOVED);
    expect(err.stderr).toContain("ledger moved: its design section");
    expect(await repo.git("rev-parse", LEDGER_REF)).toBe(other);
    // The same for a ledger created after Fetch read it absent, and for a v1 ledger another 0.26 run advanced.
    const fresh = await repoWithWorktree();
    const fromAbsent = await answersWrite(fresh);
    await v2Ledger(fresh.dir, { design: DESIGN });
    expect((await fails(run(fresh, fromAbsent.commands))).code).toBe(LEDGER_MOVED);
    const old = await repoWithWorktree();
    await commitLedger(old.dir, { "ledger.json": JSON.stringify(V1), "ledger.md": "#\n", "qa.json": "{}", "report.json": "{}" });
    const fromV1 = await answersWrite(old);
    const advanced = await commitLedger(old.dir, { "ledger.json": JSON.stringify({ ...V1, heads: [] }), "ledger.md": "#\n", "qa.json": "{}", "report.json": "{}" });
    expect((await fails(run(old, fromV1.commands))).stderr).toContain("a v1 ledger other than");
    expect(await old.git("rev-parse", LEDGER_REF)).toBe(advanced);
  });

  it("builds a run's second write (Publish's ledger-published) on its own first write, also when the other section moved in between", async () => {
    const repo = await repoWithWorktree();
    await v2Ledger(repo.dir, { design: DESIGN, review: REVIEW });
    const top = await repo.git("rev-parse", `${LEDGER_REF}:ledger.json`);
    const fetched = await repo.git("rev-parse", `${LEDGER_REF}:review`);
    const { commands } = await answersWrite(repo);
    const first = parseSectionRecord((await run(repo, commands)).stdout)!;
    // Another run advances the review section between this run's two writes.
    const other = await commitLedger(repo.dir, { ...(await ledgerFiles(repo.dir)), "review/ledger.json": JSON.stringify({ ...REVIEW, findings: [] }) });
    const issue: Round1Issue = { id: "Q1", key: "purpose|item|x", kinds: ["needs-author"], status: "needs author", body: "Why?", anchored: false };
    const plan = planReview({ pull: PR, head: PR.head, nonce: "n", round1: { schema: ROUND1_SCHEMA, head: PR.head, necessity: "necessary", issues: [issue] } });
    const patch = ledgerPatch({ head: PR.head, base: B }, plan, { reviewId: 77, url: null, how: "created" }, new Map());
    const { partCommands } = await import("../src/parts.js");
    for (const p of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", JSON.stringify(patch))) await repo.exec(p.argv);
    const published = ledgerPublishedCommand(PR, patch, { design: first.sections.design!, review: fetched }, process.execPath);
    const out = await repo.exec(published.argv);
    const now = await repo.git("rev-parse", LEDGER_REF);
    expect(parseSectionRecord(out.stdout)).toMatchObject({ advanced: now, cur: other });
    expect(await repo.git("rev-parse", `${now}:review`)).toBe(await repo.git("rev-parse", `${other}:review`));
    expect(JSON.parse(await repo.git("show", `${now}:design/ledger.json`))).toMatchObject({ tag: "mine", heads: [{ sha: PR.head, round1: "items", open: 1, reviewId: 77 }], items: [{ id: "Q1", state: "open" }] });
    expect(await repo.git("rev-parse", `${now}:ledger.json`)).toBe(top);
    // A round-2 post writes the review section too: from the review section Fetch read, which moved, so it stops "ledger moved".
    const plan2 = planReview({ pull: PR, head: PR.head, nonce: "n", round1: { schema: ROUND1_SCHEMA, head: PR.head, necessity: "necessary", issues: [] }, draft: { comments: [], summary: "" } as never });
    const patch2 = ledgerPatch({ head: PR.head, base: B }, plan2, { reviewId: 78, url: null, how: "created" }, new Map());
    for (const p of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", JSON.stringify(patch2))) await repo.exec(p.argv);
    const design = await repo.git("rev-parse", `${now}:design`);
    const err = await fails(repo.exec(ledgerPublishedCommand(PR, patch2, { design, review: fetched }, process.execPath).argv));
    expect(err.code).toBe(LEDGER_MOVED);
    expect(err.stderr).toContain("its review section");
  });

  /** A `git` on PATH that moves the ledger ref before the first `n` update-refs a write makes (another run winning the race), then runs git. */
  async function racingGit(repo: LedgerRepo, n: number): Promise<Record<string, string>> {
    const bin = path.join(repo.dir, ".git", "racing-bin");
    await mkdir(bin, { recursive: true });
    const real = (await repo.exec(["sh", "-c", "command -v git"])).stdout.trim();
    const script = [
      "#!/bin/sh",
      'if [ "$1" = -c ] && [ "$5" = update-ref ]; then',
      '  k=$(cat "$RACE_COUNT" 2>/dev/null || echo 0)',
      '  if [ "$k" -lt "$RACE_TIMES" ]; then',
      '    echo $((k + 1)) > "$RACE_COUNT"',
      '    cur=$("$REAL_GIT" rev-parse "$RACE_REF")',
      // The other run rewrites the review section only.
      '    blob=$(printf \'{"race":%s}\' "$k" | "$REAL_GIT" hash-object -w --stdin)',
      '    sub=$(printf \'100644 blob %s\\tledger.json\\n\' "$blob" | "$REAL_GIT" mktree)',
      '    tree=$({ "$REAL_GIT" ls-tree "$cur" | grep -v "	review$"; printf \'040000 tree %s\\treview\\n\' "$sub"; } | "$REAL_GIT" mktree)',
      '    new=$("$REAL_GIT" commit-tree "$tree" -p "$cur" -m race)',
      '    "$REAL_GIT" update-ref "$RACE_REF" "$new"',
      "  fi",
      "fi",
      'exec "$REAL_GIT" "$@"',
      "",
    ].join("\n");
    await writeFile(path.join(bin, "git"), script);
    await chmod(path.join(bin, "git"), 0o755);
    return { PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_GIT: real, RACE_REF: LEDGER_REF, RACE_TIMES: String(n), RACE_COUNT: path.join(repo.dir, ".git", "race-count") };
  }

  it("starts again from the ref's new value when it loses the update-ref race, at most three times, then stops \"ledger moved\"", async () => {
    const repo = await repoWithWorktree();
    await v2Ledger(repo.dir, { design: DESIGN, review: REVIEW });
    const { commands } = await answersWrite(repo);
    const env = await racingGit(repo, 3);
    const out = await repo.exec(commands.write.argv, env);
    const now = await repo.git("rev-parse", LEDGER_REF);
    const raced = await repo.git("rev-parse", `${now}^`);
    // Three races lost, the fourth attempt wins: on top of the last racer, whose review section it carries.
    expect(parseSectionRecord(out.stdout)).toMatchObject({ advanced: now, cur: raced });
    expect(await repo.git("show", `${now}:review/ledger.json`)).toBe('{"race":2}');
    expect(await repo.git("log", "--format=%s", "-5", LEDGER_REF)).toBe(["pr-review apache/skywalking-banyandb#7 at 555555555555: report and Q&A", "race", "race", "race", "a v2 ledger"].join("\n"));
    expect(await repo.git("show", `${now}:ledger.json`)).toBe(TOP);
    // A fourth lost race is one too many.
    const again = await repoWithWorktree();
    await v2Ledger(again.dir, { design: DESIGN, review: REVIEW });
    const second = await answersWrite(again);
    const err = await fails(again.exec(second.commands.write.argv, await racingGit(again, 4)));
    expect(err.code).toBe(LEDGER_MOVED);
    expect(err.stderr).toContain("lost 4 races");
  });
});

describe("reading each section file in parts (design-pr-review-split §5.2)", () => {
  it("reads a design and a review section each past one command report, from the one commit Fetch read, and joins each against its digest", async () => {
    const dirs: string[] = [];
    try {
      const repo = await new LedgerRepo().init(dirs, "pr-review-parts-");
      const text = (i: number): string => `${i} ${"漢字かな한글".repeat(30)} ${"😀".repeat(20)} ${"x".repeat(400)}`;
      const items = Array.from({ length: 150 }, (_, i) => ({ id: `Q${i + 1}`, origin: "round1", state: "open", key: `purpose|item|p${i}`, text: text(i), history: [] }));
      const findings = Array.from({ length: 150 }, (_, i) => ({ id: `F${i + 1}`, origin: "round2", state: "open", key: `k${i}`, text: text(i), history: [] }));
      const qa = Array.from({ length: 150 }, (_, i) => ({ id: `Q${i + 1}`, type: "purpose", key: `purpose|item|p${i}`, symbol: null, item: "W1", status: "answered", answer: "a".repeat(300), state: "open", history: [] }));
      const sha = await v2Ledger(repo.dir, { design: { schema: DESIGN_SCHEMA, heads: [{ sha: H1 }], purposes: [], qa, items }, review: { schema: REVIEW_SCHEMA, heads: [{ sha: H1 }], findings } });
      const { reads, evidence } = await repo.reads();
      const parts = (name: string) => Object.keys(reads).filter((id) => id === name || new RegExp(`^${name}-\\d+$`).test(id));
      expect(parts("ledger-prior")).toEqual(["ledger-prior"]);
      expect(parts("ledger-prior-design").length).toBeGreaterThan(1);
      expect(parts("ledger-prior-review").length).toBeGreaterThan(1);
      for (const t of Object.values(reads)) expect(Buffer.byteLength(t, "utf8")).toBeLessThan(65_536);
      const state = priorState(evidence, sha);
      expect(state).toMatchObject({ state: "read", layout: "v2" });
      const value = (state as unknown as { value: { design: { items: typeof items; qa: Array<Record<string, unknown>> }; review: { findings: typeof findings } } }).value;
      expect(value.design.items.map((x) => x.text)).toEqual(items.map((x) => x.text));
      expect(value.review.findings.map((x) => x.text)).toEqual(findings.map((x) => x.text));
      // The registry keeps the questions' ids and keys, not their answers.
      expect(value.design.qa[0]).toEqual({ id: "Q1", type: "purpose", key: "purpose|item|p0", symbol: null, item: "W1", status: "answered", state: "open" });
      expect(registryOf(value)).toMatchObject({ nextQ: 151, nextF: 151, heads: [H1] });
      // A part of one section's read is never joined into another's.
      const designPart = evidence.findIndex((e) => (e.payload as { command: { id: string } }).command.id === "ledger-prior-design-1");
      const reviewPart = evidence.find((e) => (e.payload as { command: { id: string } }).command.id === "ledger-prior-review-1")!;
      const swapped = evidence.map((e, i) => (i === designPart ? { ...e, payload: { command: { ...(e.payload as { command: object }).command, stdoutTail: (reviewPart.payload as { command: { stdoutTail: string } }).command.stdoutTail } } } : e)) as EvidenceRecord[];
      expect(priorState(swapped, sha)).toMatchObject({ state: "unreadable", reason: expect.stringContaining("design/ledger.json") });
    } finally {
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    }
  });
});

describe("the validators recompute a migrated tree (design-pr-review-split §5.4)", () => {
  // A run on a 0.26 ledger with V1's heads and round-2 findings (its questions left out, so this scenario's canned answers keep their ids): Fetch reads it, and the Answers stage's write migrates it.
  const LEDGER = { ...V1, qa: [], findings: V1.findings.filter((f) => f.id.startsWith("F")) };
  const V1_SHA = hex("c");
  const sim = simulate({
    scenario: scenarioWith("answer-finds-existing-helper", (s) => withLedger(s, { reads: { "ledger-read": `present ${V1_SHA}\n`, "ledger-prior": priorChunkText(JSON.stringify(LEDGER), 0) } })),
  });
  const upto = sim.evidence.findIndex((e) => (e.payload as { command?: { id?: string } }).command?.id === "ledger-write");
  const evaluate = (evidence: EvidenceRecord[]) => answersComplete.evaluate({ requirementId: "answers-complete", statement: "", evidence: candidateEvidence(evidence.slice(0, upto + 1), "d1"), candidateDigest: "d1", config: BANYANDB });
  const extract = { schema: LEDGER.schema, heads: LEDGER.heads, qa: [], findings: LEDGER.findings };
  const migrated = migrateV1(extract).review!;
  const reviewTree = treeId([{ name: "ledger.json", id: blobId(JSON.stringify(migrated)) }, { name: "ledger.md", id: blobId(reviewMarkdown(LEDGER_PULL)) }]);
  const record = (review: string): string => `advanced ${hex("e")}\ncur ${V1_SHA}\ndesign ${hex("d")}\nreview ${review}\n`;
  const change = (id: string, f: (c: { argv: string[]; stdoutTail: string }) => object) =>
    sim.evidence.map((e) => {
      const c = (e.payload as { command?: { id: string; argv: string[]; stdoutTail: string } }).command;
      return c?.id === id ? ({ ...e, payload: { ...(e.payload as object), command: { ...c, ...f(c) } } } as EvidenceRecord) : e;
    });

  it("writes the migrated review section first, and the write names the migration", () => {
    expect(upto, JSON.stringify(sim.final).slice(0, 800)).toBeGreaterThan(0);
    const write = sim.jobs.find((j) => j.instruction.startsWith("Advance the pull"))!;
    expect(writtenLedger((write.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv)).toMatchObject({ old: V1_SHA, migration: { mode: "v1+review" } });
    expect(sim.jobs.flatMap((j) => ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id)).filter((id) => id.startsWith("ledger-review-"))).toEqual(["ledger-review-json-p1", "ledger-review-md-p1"]);
  });

  it("passes when the write swapped from the v1 commit and its review subtree is the migrated one, and fails on another subtree", () => {
    expect(evaluate(change("ledger-write", () => ({ stdoutTail: record(reviewTree) })))).toMatchObject({ status: "passed" });
    expect(evaluate(change("ledger-write", () => ({ stdoutTail: record(hex("9")) })))).toMatchObject({ status: "failed", reason: expect.stringContaining("not the migrated one") });
  });

  it("fails when the migrated review section written is not the migration of the v1 ledger Fetch read", () => {
    const tampered = change("ledger-review-json-p1", (c) => ({ argv: c.argv.map((a) => a.replace('"F2"', '"F9"')) }));
    expect(evaluate(tampered)).toMatchObject({ status: "failed" });
  });
});
