// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { activeRepairValidators, reconcileRepairJournal } from "./repair-lifecycle.js";
import type { DurableRunState } from "./state.js";

function stateWith(partial: Partial<DurableRunState>): DurableRunState {
  return { activeVersion: "hello@0.1.0", ...partial } as DurableRunState;
}

const candidate = {
  artifactId: "repair-a",
  candidateRoot: "/state/repairs/repair-a/candidate",
  baseDigest: "b",
  baseActiveVersion: "hello@0.1.0",
  target: "validator" as const,
  reason: "r",
  createdAt: "t",
};

describe("repair journal reconciliation", () => {
  it("aborts an uncommitted activation intent and rejects abandoned attempts", () => {
    const next = reconcileRepairJournal(
      stateWith({
        activationIntent: {
          artifactId: "repair-a",
          fromVersion: "hello@0.1.0",
          toVersion: "hello@repair-a",
          generation: 3,
          at: "t",
          status: "intent",
        },
        repairCandidates: [{ ...candidate, status: "qualifying" }],
      }),
    );
    expect(next.activationIntent?.status).toBe("aborted");
    expect(next.repairCandidates?.[0]?.status).toBe("rejected");
    expect(next.repairCandidates?.[0]?.rejectionReason).toMatch(/abandoned/);
  });

  it("rebinds validators for the active repaired candidate", () => {
    const state = stateWith({
      activeVersion: "hello@repair-repair-a",
      repairCandidates: [{ ...candidate, status: "activated" }],
    });
    const fixed = { evaluate: () => ({ status: "passed" as const, reason: "ok" }) };
    const roots: string[] = [];
    const ok = activeRepairValidators(state, {
      patchAuthor: { sessionId: "s", patch: async () => ({ summary: "" }) },
      reviewer: { sessionId: "r", review: async () => ({ approved: true, reason: "" }) },
      preflight: async () => ({ ok: true, summary: "" }),
      materializeValidators: (root) => {
        roots.push(root);
        return { "exact-greeting": fixed };
      },
    });
    expect(ok).toEqual({ ok: true, validators: { "exact-greeting": fixed } });
    expect(roots).toEqual([candidate.candidateRoot]);
    expect(activeRepairValidators(state, undefined).ok).toBe(false);
  });
});
