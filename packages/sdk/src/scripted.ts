// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { GraphDecision, GraphDefinition, GraphPlugin, RunView } from "./types.js";

export type ScriptedAdvance =
  | GraphDecision
  | ((view: RunView, index: number) => GraphDecision);

export interface ScriptedGraphOptions {
  definition: GraphDefinition;
  /** Decisions returned in order for successive advance calls. */
  advances: ScriptedAdvance[];
}

/**
 * In-process GraphPlugin that returns canned decisions for host-loop tests.
 * Throws when advance is called more times than scripted.
 */
export function createScriptedGraph(options: ScriptedGraphOptions): GraphPlugin {
  let index = 0;
  const { definition, advances } = options;

  return {
    describe(): GraphDefinition {
      return structuredClone(definition);
    },
    advance(view: RunView): GraphDecision {
      if (index >= advances.length) {
        throw new Error(
          `scripted graph exhausted: advance called ${index + 1} times, only ${advances.length} scripted`,
        );
      }
      const step = advances[index];
      if (step === undefined) {
        throw new Error(`scripted graph missing step at index ${index}`);
      }
      const current = index;
      index += 1;
      if (typeof step === "function") {
        return step(view, current);
      }
      return structuredClone(step);
    },
  };
}
