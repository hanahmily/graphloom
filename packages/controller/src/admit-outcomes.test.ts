// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitValidation, type AdmissionValidator } from "./admit.js";
import type { DurableRunState } from "./state.js";

/**
 * What admission reports per requirement, and when it stops evaluating (#119):
 * a dry-run validation is only as honest as the outcomes real admission returns.
 */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function stateWith(independent: boolean): Promise<DurableRunState> {
  // Not a git checkout: the live candidate digest is then simply absent.
  const worktreePath = await mkdtemp(path.join(os.tmpdir(), "gl-admit-"));
  dirs.push(worktreePath);
  return {
    generation: 1,
    stateRevision: 4,
    receiptSeq: 0,
    receipts: [],
    evidence: [{ ref: "ev-1", kind: "other", generation: 1 }],
    current: { stageId: "s", attempt: 1 },
    worktreePath,
    intake: { pinnedHead: "HEAD" },
    validatorBindings: [],
    definition: {
      stages: [{ id: "s", name: "S", requirementIds: ["a", "b", "c"] }],
      requirements: ["a", "b", "c"].map((id) => ({ id, statement: id, evidenceSchema: "x" })),
      defaultValidators: [
        { requirementId: "a", validatorId: "gate-a", version: "1" },
        { requirementId: "b", validatorId: "gate-b", version: "1", ...(independent ? { independence: "separate-reviewer" } : {}) },
        { requirementId: "c", validatorId: "gate-c", version: "1" },
      ],
    },
  } as unknown as DurableRunState;
}

const passing = (log: string[], name: string): AdmissionValidator => ({
  evaluate() {
    log.push(name);
    return { status: "passed", reason: `${name} ok` };
  },
});

describe("admitValidation outcomes", () => {
  it("keeps what the earlier validators reported when a separate-reviewer precondition then fails", async () => {
    const calls: string[] = [];
    const result = await admitValidation(await stateWith(true), { stageId: "s" }, {
      "gate-a": passing(calls, "a"),
      "gate-b": passing(calls, "b"),
      "gate-c": passing(calls, "c"),
    });
    expect(result).toMatchObject({ accepted: false, evaluated: false, reason: "missing review evidence for separate-reviewer requirement" });
    expect(result.requirements).toEqual([{ requirementId: "a", status: "passed", reason: "a ok" }]);
    expect(calls).toEqual(["a"]);
  });

  it("does not start another validator once the caller has stopped waiting", async () => {
    const stop = new AbortController();
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first: AdmissionValidator = {
      async evaluate() {
        calls.push("a");
        await held;
        return { status: "passed", reason: "a ok" };
      },
    };
    const running = admitValidation(await stateWith(false), { stageId: "s" }, { "gate-a": first, "gate-b": passing(calls, "b"), "gate-c": passing(calls, "c") }, stop.signal);
    // Abort while the first validator is still running, then let it finish.
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    release();
    await expect(running).rejects.toThrow(/validation stopped/);
    expect(calls).toEqual(["a"]);
  });
});
