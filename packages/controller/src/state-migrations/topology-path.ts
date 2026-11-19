// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Format 2 -> 3: every run carries its live path and visits
 * (docs/design-graph-topology.md §11.3). Format 2 runs walked an ordered
 * stage list, so the migrator derives them from the stored state alone: the
 * live path is the prefix of the list through the furthest stage that has a
 * recorded attempt, any receipt, or is current, each visit `migrated` with
 * the stage's latest attempt; no side visit is open. It changes no existing
 * field, so format 3's protected view is format 2's.
 */
import { derivePath } from "../traversal.js";
import type { DurableRunState } from "../state.js";
import type { StateFiles, StateMigrator } from "./index.js";

export const topologyPathMigrator: StateMigrator = {
  from: 2,
  to: 3,
  migrate(files: Readonly<StateFiles>): StateFiles {
    const state = JSON.parse(files["state.json"] ?? "{}") as DurableRunState;
    if (state.path !== undefined && state.visits !== undefined) return { ...files };
    // Nothing to derive from: a state without stages or a current stage has no path (and no run reads it).
    if (!Array.isArray(state.definition?.stages) || state.definition.stages.length === 0 || state.current === undefined) return { ...files };
    const { path, visits } = derivePath({ ...state, receipts: state.receipts ?? [] });
    return { ...files, "state.json": JSON.stringify({ ...state, path, visits }, null, 2) };
  },
};
