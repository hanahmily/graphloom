// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { ledgerReadCommand } from "../src/kit/commands.js";
import { priorChunkText, priorShowCommand } from "../src/kit/ledger.js";
import { LEDGER_V2 } from "../src/kit/ledgerv2.js";
import type { PullRequest } from "../src/kit/request.js";
import type { Draft } from "../src/draft.js";
import { reviewLedgerWrite } from "../src/reviewledger.js";

const pr: PullRequest = { mode: "review", owner: "apache", repo: "skywalking-banyandb", number: 7, head: "0123456789abcdef0123456789abcdef01234567" };
const draft = { head: pr.head, context: { source: "prelude" }, round1: null, leads: { given: 0, raised: 0 }, comments: [] } as unknown as Draft;
let n = 0;
const run = (id: string, argv: string[], stdout: string): EvidenceRecord => ({ ref: `e${(n += 1)}`, kind: "command", candidateDigest: "d", generation: 1, payload: { command: { id, argv, exitCode: 0, stdoutTail: stdout, stderrTail: "" } } }) as EvidenceRecord;
const read = (listing: string): EvidenceRecord => {
  const c = ledgerReadCommand(pr.owner, pr.repo, pr.number);
  return run(c.id, c.argv, listing);
};
/** The reads of a v2 ledger commit `sha` whose sections are `design` and `review` (absent when undefined). */
function ledgerAt(sha: string, trees: { design?: string; review?: string }): EvidenceRecord[] {
  const listing = [`100644 blob ${"1".repeat(40)}\tledger.json`, ...(trees.design !== undefined ? [`040000 tree ${trees.design}\tdesign`] : []), ...(trees.review !== undefined ? [`040000 tree ${trees.review}\treview`] : []), `present ${sha}`].join("\n");
  const section = (path: "design" | "review", doc: unknown): EvidenceRecord => {
    const c = priorShowCommand(sha, process.execPath, 0, path);
    return run(c.id, c.argv, doc === undefined ? "graphloom-prior-absent\n" : priorChunkText(JSON.stringify(doc), 0));
  };
  const root = priorShowCommand(sha, process.execPath, 0, "root");
  return [
    read(listing),
    run(root.id, root.argv, priorChunkText(JSON.stringify({ schema: LEDGER_V2, qa: [], findings: [] }), 0)),
    section("design", trees.design !== undefined ? { schema: "pr-design-review-ledger-v1", heads: [], qa: [], findings: [], items: [] } : undefined),
    section("review", trees.review !== undefined ? { schema: "pr-review-ledger-v1", heads: [], qa: [], findings: [{ id: "F1" }] } : undefined),
  ];
}

describe("a review section write re-read after \"ledger moved\"", () => {
  it("is stale when another PR review advanced the review section after Fetch: the draft's ids number from a section that moved", () => {
    const evidence = [...ledgerAt("a".repeat(40), { design: "d".repeat(40) }), ...ledgerAt("b".repeat(40), { design: "d".repeat(40), review: "e".repeat(40) })];
    const w = reviewLedgerWrite(evidence, pr, draft);
    expect(w.state).toBe("stale");
  });

  it("writes again when only the design section moved: the review section is carried over as the ref holds the design one", () => {
    const evidence = [...ledgerAt("a".repeat(40), { design: "d".repeat(40), review: "e".repeat(40) }), ...ledgerAt("b".repeat(40), { design: "f".repeat(40), review: "e".repeat(40) })];
    const w = reviewLedgerWrite(evidence, pr, draft);
    expect(w.state).toBe("ready");
    expect(w.state === "ready" ? [w.old, w.baseline] : []).toEqual(["b".repeat(40), "e".repeat(40)]);
  });
});
