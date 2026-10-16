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
        return { ok: true, value: options.config !== undefined ? plugin.describe(options.config) : plugin.describe() };
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
        return { ok: true, value: plugin.advance(withConfig(view, options.config)) };
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

/** The view with the run's config attached; unchanged when the run has none. */
function withConfig(view: RunView, config: unknown): RunView {
  return config !== undefined ? { ...view, config } : view;
}

/** Convenience: scripted GraphPlugin behind the in-process host. */
export function createScriptedPluginHost(
  script: ScriptedGraphOptions,
  options: InProcessPluginHostOptions,
): PluginHost {
  return createInProcessPluginHost(createScriptedGraph(script), options);
}
