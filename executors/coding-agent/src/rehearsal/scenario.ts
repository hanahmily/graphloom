// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Re-exports the shared rehearsal stand-in client (docs/design-graph-rehearsal.md
 * §4.1/§4.2), now in `@graphloom/sdk` so the command executor's own quick-mode
 * stand-in can share it too — the env var names and the cursor files' shape
 * are a cross-process invariant between whichever process wrote the scenario
 * (`rehearse`) and whichever reads it, so it lives once, not per package.
 */
export type { RecordedAssignment, RecordedCall } from "@graphloom/sdk";
export {
  nextReply,
  readCallLog,
  readRecordedAssignment,
  recordAssignment,
  recordCall,
  rehearsalHomeDir,
  REHEARSAL_HOME_ENV,
  REHEARSAL_SCENARIO_ENV,
  requireScenario,
  resetRehearsalScenarioCache,
} from "@graphloom/sdk";
