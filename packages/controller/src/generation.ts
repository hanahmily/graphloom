import type { DurableRunState } from "./state.js";

/** Fence evidence freshness and record a version-history entry. */
export function bumpGeneration(
  state: DurableRunState,
  reason = "generation fence",
): DurableRunState {
  const { workspaceRevision: _wr, ...rest } = state;
  void _wr;
  const generation = state.generation + 1;
  return {
    ...rest,
    generation,
    stateRevision: state.stateRevision + 1,
    versionHistory: [
      ...(state.versionHistory ?? []),
      {
        activeVersion: state.activeVersion,
        generation,
        reason,
        at: new Date().toISOString(),
      },
    ],
  };
}
