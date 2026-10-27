// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The run's supervisor harness pin (design-supervisor-harnesses.md §7.4).
 * The composition root resolves which harness runs; the controller records
 * that choice at intake, keeps it across resumes, and records an operator's
 * `resume --supervisor` move as a transition with evidence. The plugin's
 * preference is stored as given and never read here.
 */
import { bindingHarness } from "@graphloom/supervisor";
import { newEvidenceRef } from "./admit.js";
import type { DurableRunState, SupervisorSelectionRecord, SupervisorTransitionRecord } from "./state.js";

/** A selection the composition root made: which harness, by which rule, and why. */
export interface SupervisorSelectionChoice {
  harness: string;
  source: string;
  reason: string;
}

/** What `resume` asks of the pin (`ResumeRequest.supervisorPin`). */
export interface SupervisorPinRequest {
  /** Recorded when the run has no selection yet: a run started before selection existed, or one that had no supervisor. */
  selection?: SupervisorSelectionChoice;
  /** `resume --supervisor <to>`: refused unless `from` is the run's current pin. */
  transition?: { from: string; to: string; reason: string };
}

/**
 * The harness the run's supervisor is pinned to: its selection, or, for a run
 * started before selection existed, the harness its binding recorded at the
 * first recovery episode. Undefined when nothing pinned it yet.
 */
export function pinnedSupervisorHarness(state: Pick<DurableRunState, "supervisorSelection" | "supervisorBinding">): string | undefined {
  if (state.supervisorSelection !== undefined) return state.supervisorSelection.harness;
  const binding = state.supervisorBinding;
  return binding?.sessionFile !== undefined ? bindingHarness(binding) : undefined;
}

/** The selection record intake pins, with the graph's preference as given. */
export function selectionRecord(
  choice: SupervisorSelectionChoice,
  state: Pick<DurableRunState, "generation" | "definition">,
): SupervisorSelectionRecord {
  return {
    harness: choice.harness,
    source: choice.source,
    reason: choice.reason,
    ...(state.definition.supervisor !== undefined ? { preference: structuredClone(state.definition.supervisor) } : {}),
    generation: state.generation,
    at: new Date().toISOString(),
  };
}

/**
 * Apply `resume`'s pin request: record a selection for a run that has none,
 * or move the pin to another harness. A move keeps the logical session, its
 * budgets, case file, and episode records; it records a transition, a
 * `supervisorUpdate` evidence record, and the new selection (source `flag`).
 */
export function applySupervisorPin(state: DurableRunState, pin: SupervisorPinRequest | undefined): DurableRunState {
  if (pin === undefined) return state;
  const current = pinnedSupervisorHarness(state);
  if (pin.transition !== undefined) {
    const { from, to, reason } = pin.transition;
    if (current !== from) {
      throw new Error(`supervisor transition ${from} -> ${to} refused: the run's supervisor is pinned to ${current ?? "no harness"}`);
    }
    if (to === from) return state;
    const at = new Date().toISOString();
    const evidenceRef = newEvidenceRef(state);
    const transition: SupervisorTransitionRecord = { from, to, reason, generation: state.generation, at, evidenceRef };
    const preference = state.supervisorSelection?.preference ?? state.definition.supervisor;
    return {
      ...state,
      supervisorSelection: {
        harness: to,
        source: "flag",
        reason: `resume --supervisor ${to} (from ${from}): ${reason}`,
        ...(preference !== undefined ? { preference: structuredClone(preference) } : {}),
        generation: state.generation,
        at,
      },
      supervisorTransitions: [...(state.supervisorTransitions ?? []), transition],
      evidence: [
        ...state.evidence,
        { ref: evidenceRef, kind: "other", generation: state.generation, payload: { supervisorUpdate: { from, to, reason } } },
      ],
      stateRevision: state.stateRevision + 1,
    };
  }
  if (pin.selection !== undefined && state.supervisorSelection === undefined) {
    if (current !== undefined && current !== pin.selection.harness) {
      throw new Error(`supervisor selection ${pin.selection.harness} refused: the run's supervisor is pinned to ${current}`);
    }
    return { ...state, supervisorSelection: selectionRecord(pin.selection, state) };
  }
  return state;
}

/**
 * Whether the run's binding names another harness than its pin: the pin
 * moved (`resume --supervisor`) since the binding was last written, so the
 * supervisor continues its logical session on the new harness rather than
 * restoring the old one.
 */
export function supervisorMoved(state: Pick<DurableRunState, "supervisorSelection" | "supervisorBinding">): boolean {
  const binding = state.supervisorBinding;
  const pinned = state.supervisorSelection?.harness;
  return binding?.sessionFile !== undefined && pinned !== undefined && bindingHarness(binding) !== pinned;
}
