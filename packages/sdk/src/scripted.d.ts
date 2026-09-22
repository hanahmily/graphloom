import type { GraphDecision, GraphDefinition, GraphPlugin, RunView } from "./types.js";
export type ScriptedAdvance = GraphDecision | ((view: RunView, index: number) => GraphDecision);
export interface ScriptedGraphOptions {
    definition: GraphDefinition;
    /** Decisions returned in order for successive advance calls. */
    advances: ScriptedAdvance[];
}
/**
 * In-process GraphPlugin that returns canned decisions for host-loop tests.
 * Throws when advance is called more times than scripted.
 */
export declare function createScriptedGraph(options: ScriptedGraphOptions): GraphPlugin;
//# sourceMappingURL=scripted.d.ts.map