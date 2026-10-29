// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyApproval, approvalRefusal, type OperatorApprovalPayload } from "./approvals.js";
import { decideResume } from "./stop-class.js";
import type { DurableRunState } from "./state.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function stateWith(approvals: unknown[], over: Partial<DurableRunState> = {}): Promise<DurableRunState> {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "gl-approval-"));
  dirs.push(worktree);
  return {
    runId: "r1",
    status: "stopped",
    generation: 3,
    evidence: [],
    evidenceSeq: 0,
    stateRevision: 7,
    worktreePath: worktree,
    definition: { graphId: "g", version: "1", approvals },
    ...over,
  } as unknown as DurableRunState;
}

describe("approval decisions", () => {
  it("refuses an undeclared id, an unavailable approval (a decline still records), a finished run and a run that has not stopped", async () => {
    const state = await stateWith([{ id: "review-layer", unavailable: "no review stage in 0.1" }, { id: "publish" }]);
    const ask = (over: Partial<Parameters<typeof approvalRefusal>[1]>, s = state) => approvalRefusal(s, { approvalId: "review-layer", decision: "approve", ...over });
    expect(ask({ approvalId: "nope" })).toBe('graph g declares no approval "nope"; it declares review-layer, publish');
    expect(ask({})).toBe("no review stage in 0.1");
    expect(ask({ decision: "decline" })).toBeUndefined();
    expect(ask({ approvalId: "publish" })).toBeUndefined();
    expect(ask({ decision: "decline", reason: "x".repeat(1001) })).toMatch(/1001 characters/);
    expect(ask({}, { ...state, status: "succeeded" } as DurableRunState)).toBe("run r1 has succeeded; there is nothing left to approve");
    expect(ask({ approvalId: "publish" }, { ...state, status: "running" } as DurableRunState)).toMatch(/is running; approve an approval when it has stopped/);
    expect(approvalRefusal(await stateWith([]), { approvalId: "x", decision: "approve" })).toBe("graph g declares no approvals");
  });

  it("records operator-approval evidence at the run's generation, with the declared files' digests", async () => {
    const state = await stateWith([{ id: "publish", files: ["review/draft.md"] }]);
    await mkdir(path.join(state.worktreePath, "review"));
    await writeFile(path.join(state.worktreePath, "review", "draft.md"), "the draft\n");
    const next = await applyApproval(state, { approvalId: "publish", decision: "approve", operator: "maintainer" });
    expect(next.stateRevision).toBe(8);
    const evidence = next.evidence.at(-1)!;
    expect(evidence).toMatchObject({ kind: "other", generation: 3 });
    expect(evidence.payload as OperatorApprovalPayload).toMatchObject({
      type: "operator-approval",
      approvalId: "publish",
      decision: "approve",
      operator: "maintainer",
      generation: 3,
      files: [{ path: "review/draft.md", sha256: createHash("sha256").update("the draft\n").digest("hex"), bytes: 10 }],
    });
    // A decline pins nothing, and carries the reason.
    const declined = await applyApproval(state, { approvalId: "publish", decision: "decline", reason: "not today" });
    expect(declined.evidence.at(-1)!.payload).toMatchObject({ decision: "decline", reason: "not today", files: [], operator: "operator" });
  });

  it("refuses a declared file that is missing, not a regular file, a link out of the worktree, or past 256 KiB together", async () => {
    const state = await stateWith([{ id: "p", files: ["a.md"] }]);
    await expect(applyApproval(state, { approvalId: "p", decision: "approve" })).rejects.toThrow(/does not exist/);
    const outside = await mkdtemp(path.join(os.tmpdir(), "gl-outside-"));
    dirs.push(outside);
    await writeFile(path.join(outside, "secret"), "s");
    await symlink(path.join(outside, "secret"), path.join(state.worktreePath, "a.md"));
    await expect(applyApproval(state, { approvalId: "p", decision: "approve" })).rejects.toThrow(/not a regular file/);
    const big = await stateWith([{ id: "p", files: ["a", "b"] }]);
    await writeFile(path.join(big.worktreePath, "a"), "x".repeat(200 * 1024));
    await writeFile(path.join(big.worktreePath, "b"), "x".repeat(100 * 1024));
    await expect(applyApproval(big, { approvalId: "p", decision: "approve" })).rejects.toThrow(/more than 262144 bytes together/);
  });

  it("counts as something that changed since a final stop, so the stopped run runs again", async () => {
    const mark = { activeVersion: "g@1", manifestDigest: "m", entryDigest: "e", budgets: {} as never };
    const state = { status: "stopped", stopReason: "report ready", stopClass: { by: "graph", retryable: false, reason: "report ready" }, stopMark: mark } as unknown as DurableRunState;
    expect(decideResume(state, { pluginUpdated: false, mark })).toMatchObject({ run: false });
    expect(decideResume(state, { pluginUpdated: false, mark, approval: "the operator recorded a decline of review-layer" })).toMatchObject({ run: true, lifted: "the operator recorded a decline of review-layer" });
  });
});
