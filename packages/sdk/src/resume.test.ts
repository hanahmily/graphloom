// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { assertGraphAction, assertRunView, executorFailureOf, failuresSinceResume, isStaleFailure, type EvidenceRecord, type RunView } from "./index.js";

const failure = (ref: string, generation: number | undefined): EvidenceRecord => ({
  ref,
  kind: "other",
  ...(generation !== undefined ? { generation } : {}),
  payload: { executorFailure: { operationId: `op-${ref}`, stageId: "write", attempt: 1, executor: null, status: "failed", summary: "agent finished without a result" } },
});
const command = (ref: string, generation: number, exitCode: number): EvidenceRecord => ({ ref, kind: "command", generation, payload: { command: { id: "deliver", exitCode } } });
const resumedAt = (generation: number): Pick<RunView, "resume"> => ({
  resume: { generation, at: "2026-10-19T00:00:00.000Z", pluginUpdated: false, previousStopReason: "delivery failed", previousStopRetryable: true },
});

describe("a resume retries what failed", () => {
  it("counts nothing as stale in a run never resumed", () => {
    expect(isStaleFailure(failure("a", 1), {})).toBe(false);
    expect(failuresSinceResume([failure("a", 1), failure("b", 2)], {}).map((r) => r.ref)).toEqual(["a", "b"]);
  });

  it("treats a failure from before the latest resume as stale, and one since it as current", () => {
    const view = resumedAt(3);
    expect(isStaleFailure(failure("a", 2), view)).toBe(true);
    expect(isStaleFailure(failure("b", 3), view)).toBe(false);
    expect(isStaleFailure(failure("c", 4), view)).toBe(false);
    // A record without a generation is the oldest there is.
    expect(isStaleFailure(failure("d", undefined), view)).toBe(true);
    expect(failuresSinceResume([failure("a", 2), failure("b", 3), failure("c", 4)], view).map((r) => r.ref)).toEqual(["b", "c"]);
  });

  it("reads the controller's job failures by default, and a plugin's own failures with a predicate", () => {
    const evidence = [command("ok", 3, 0), command("old", 2, 1), command("new", 3, 1), failure("job", 3)];
    expect(failuresSinceResume(evidence, resumedAt(3)).map((r) => r.ref)).toEqual(["job"]);
    const failedCommand = (r: EvidenceRecord) => r.kind === "command" && (r.payload as { command: { exitCode: number } }).command.exitCode !== 0;
    expect(failuresSinceResume(evidence, resumedAt(3), failedCommand).map((r) => r.ref)).toEqual(["new"]);
    expect(executorFailureOf(failure("job", 3))).toMatchObject({ stageId: "write", status: "failed" });
    expect(executorFailureOf(command("ok", 3, 0))).toBeUndefined();
  });

  it("checks the resume view and a stop's retryable flag on the wire", () => {
    const view = { runId: "r", task: {}, current: {}, receipts: [], evidence: [], outstanding: [], budgets: {}, validatorBindings: [], generation: 3, stateRevision: 1, activeVersion: "g@1" };
    expect(assertRunView({ ...view, ...resumedAt(3) }).resume?.generation).toBe(3);
    expect(() => assertRunView({ ...view, resume: { generation: 3, at: "t" } })).toThrow(/resume.pluginUpdated/);
    expect(assertGraphAction({ type: "stop", stop: { reason: "r", blocker: "b", retryable: false } })).toBeDefined();
    expect(() => assertGraphAction({ type: "stop", stop: { reason: "r", blocker: "b", retryable: "no" } })).toThrow(/stop.retryable/);
  });
});
