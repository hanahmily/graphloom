import type { GraphDecision, GraphDefinition, GraphPlugin, RunView } from "@graphloom/sdk";
import { createScriptedGraph, type ScriptedGraphOptions } from "@graphloom/sdk";
import type {
  CallContext,
  HostResult,
  InProcessPluginHostOptions,
  PluginHost,
} from "./types.js";

/** In-process host for scripted/CI paths — no child process. */
export function createInProcessPluginHost(
  plugin: GraphPlugin,
  options: InProcessPluginHostOptions,
): PluginHost {
  const generation = options.generation ?? 1;
  let closed = false;

  return {
    activeVersion: options.activeVersion,
    generation,
    async describe(_ctx: CallContext): Promise<HostResult<GraphDefinition>> {
      if (closed) {
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "crash",
            message: "in-process host is closed",
          },
        };
      }
      try {
        return { ok: true, value: plugin.describe() };
      } catch (err) {
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "crash",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    async advance(_ctx: CallContext, view: RunView): Promise<HostResult<GraphDecision>> {
      if (closed) {
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "crash",
            message: "in-process host is closed",
          },
        };
      }
      try {
        return { ok: true, value: plugin.advance(view) };
      } catch (err) {
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "crash",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

/** Convenience: scripted GraphPlugin behind the in-process host. */
export function createScriptedPluginHost(
  script: ScriptedGraphOptions,
  options: InProcessPluginHostOptions,
): PluginHost {
  return createInProcessPluginHost(createScriptedGraph(script), options);
}
