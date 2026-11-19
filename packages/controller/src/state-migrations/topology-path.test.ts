// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Format 2 -> 3 (docs/design-graph-topology.md §11.3, §12 item 12): runs of
 * hello, issue-fix and pr-review stopped mid-run migrate to the live path the
 * design derives, keep every protected record, and their graph's next action
 * is admissible from that path as it was from the list.
 */
import { describe, expect, it } from "vitest";
import type { GraphDefinition, Receipt, RunView } from "@graphloom/sdk";
import type { DurableRunState } from "../state.js";
import { forwardRefusal, livePath, reentryRefusal } from "../traversal.js";
import { migrateStateFiles, migrationPath, STATE_FORMATS } from "./index.js";
import { topologyPathMigrator } from "./topology-path.js";

function chain(graphId: string, ids: string[]): GraphDefinition {
  return {
    graphId,
    version: "1.0.0",
    stages: ids.map((id) => ({ id, name: id, requirementIds: [`${id}-done`] })),
    requirements: ids.map((id) => ({ id: `${id}-done`, statement: `${id} is done`, evidenceSchema: "node-v1" })),
    defaultValidators: ids.map((id) => ({ requirementId: `${id}-done`, validatorId: "node", version: "1" })),
  };
}

const receipt = (stageId: string, i: number, valid = true): Receipt => ({
  id: `rcpt-${i}`,
  stageId,
  requirementId: `${stageId}-done`,
  validatorBinding: { requirementId: `${stageId}-done`, validatorId: "node", version: "1" },
  candidateFingerprint: "fp",
  evidenceRefs: [],
  valid,
  acceptedIdentity: {},
});

/** A format 2 `state.json`: the fields a stopped run of format 2 holds that the migration reads, with no path. */
function formatTwo(definition: GraphDefinition, fields: Partial<DurableRunState>): string {
  return JSON.stringify({
    runId: "r",
    status: "stopped",
    stateFormat: 2,
    generation: 3,
    stateRevision: 40,
    mode: "normal",
    evidence: [],
    outstanding: [],
    definition,
    validatorBindings: [],
    ...fields,
  });
}

function migrate(text: string): DurableRunState {
  const steps = migrationPath(2, STATE_FORMATS);
  expect(steps.map((s) => `${s.from}-${s.to}`)).toEqual(["2-3"]);
  // Throws when the step changes a receipt, a record, the step set or a requirement statement.
  const migrated = migrateStateFiles({ "state.json": text }, steps, STATE_FORMATS);
  return JSON.parse(migrated.files["state.json"]!) as DurableRunState;
}

/** The shipped graphs' stage selection: the first stage with a missing receipt or an open attempt. */
function firstOpen(state: DurableRunState): string | undefined {
  const view = { receipts: state.receipts, openAttempt: state.openAttempt } as Pick<RunView, "receipts" | "openAttempt">;
  return state.definition.stages.find(
    (s) => !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) || view.openAttempt?.[s.id] === true,
  )?.id;
}

const pathOf = (state: DurableRunState) => livePath(state).map((v) => `${v.stageId}#${v.attempt}:${v.entered}`);

describe("format 2 -> 3: the live path from the stored state", () => {
  it("hello stopped after a Review → Write reentry: the prefix through Review, Write open on attempt 2", () => {
    const hello = chain("hello", ["write", "review"]);
    const state = migrate(
      formatTwo(hello, {
        current: { stageId: "write", attempt: 2 },
        stageAttempts: { write: 2, review: 1 },
        receipts: [receipt("write", 1), receipt("review", 2, false)],
        openAttempt: { write: true },
      }),
    );
    expect(pathOf(state)).toEqual(["write#2:migrated", "review#1:migrated"]);
    // Before: the graph works on Write again (it is open), then on Review, and may send Review back to Write.
    expect(firstOpen(state)).toBe("write");
    expect(forwardRefusal(state, "write")).toBeUndefined();
    expect(forwardRefusal(state, "review")).toBeUndefined();
    expect(reentryRefusal(state, "write")).toBeUndefined();
  });

  it("issue-fix with `current` on Fix, earlier than Review's receipts: the prefix through Review", () => {
    const issueFix = chain("issue-fix", ["fix", "review"]);
    const state = migrate(
      formatTwo(issueFix, {
        current: { stageId: "fix", attempt: 3 },
        stageAttempts: { fix: 3, review: 2 },
        receipts: [receipt("fix", 1, false), receipt("fix", 2), receipt("review", 3)],
      }),
    );
    expect(pathOf(state)).toEqual(["fix#3:migrated", "review#2:migrated"]);
    // Before: every stage complete, the graph delivers with jobs on either stage, or sends Review's findings back to Fix.
    expect(firstOpen(state)).toBeUndefined();
    expect(forwardRefusal(state, "fix")).toBeUndefined();
    expect(forwardRefusal(state, "review")).toBeUndefined();
    expect(reentryRefusal(state, "fix")).toBeUndefined();
  });

  it("pr-review stopped after a supervisor reentry of Report: the prefix through Draft, and Publish one forward move away", () => {
    const prReview = chain("pr-review", ["fetch", "report", "review", "draft", "publish"]);
    const state = migrate(
      formatTwo(prReview, {
        current: { stageId: "report", attempt: 2 },
        stageAttempts: { fetch: 1, report: 2, review: 1, draft: 1 },
        receipts: [receipt("fetch", 1), receipt("report", 2), receipt("review", 3), receipt("draft", 4)],
        openAttempt: { report: true },
      }),
    );
    expect(pathOf(state)).toEqual(["fetch#1:migrated", "report#2:migrated", "review#1:migrated", "draft#1:migrated"]);
    // Before: the graph validates Report (open), then acts for Publish.
    expect(firstOpen(state)).toBe("report");
    expect(forwardRefusal(state, "report")).toBeUndefined();
    expect(forwardRefusal(state, "publish")).toBeUndefined();
  });

  it("a run that never left its first stage starts its path there", () => {
    const state = migrate(formatTwo(chain("hello", ["write", "review"]), { current: { stageId: "write", attempt: 1 }, receipts: [] }));
    expect(pathOf(state)).toEqual(["write#1:migrated"]);
    expect(state.sideVisit).toBeUndefined();
  });

  it("changes no existing field and leaves a state that already has a path as it is", () => {
    const text = formatTwo(chain("hello", ["write", "review"]), { current: { stageId: "review", attempt: 1 }, receipts: [receipt("write", 1)] });
    const out = JSON.parse(topologyPathMigrator.migrate({ "state.json": text })["state.json"]!) as Record<string, unknown>;
    const { path: _path, visits: _visits, ...rest } = out;
    expect(rest).toEqual(JSON.parse(text));
    const again = topologyPathMigrator.migrate({ "state.json": JSON.stringify(out) });
    expect(JSON.parse(again["state.json"]!)).toEqual(out);
  });
});
