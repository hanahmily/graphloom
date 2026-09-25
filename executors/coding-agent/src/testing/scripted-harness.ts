import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolCallResult } from "@graphloom/sdk";
import type { CodingHarness, CodingSessionOptions } from "../harness.js";

/**
 * One scripted agent action. Steps come from the job input
 * (`harnessOptions.steps`), so tests drive the agent through the graph.
 */
export type ScriptedStep =
  | { model: true }
  | { tool: string; id: string; input?: unknown }
  | { write: { path: string; content: string } }
  | { wait: "abort" }
  | { fail: string };

export interface ScriptedOutput {
  toolResults: Array<{ id: string; tool: string; result: ToolCallResult }>;
  wrote: string[];
  modelCalls: number;
}

/** A harness that performs scripted steps instead of calling a model. */
export function createScriptedHarness(): CodingHarness {
  return {
    name: "scripted",
    async createSession(options: CodingSessionOptions) {
      return {
        async run() {
          const steps = (options.options?.steps ?? []) as ScriptedStep[];
          const out: ScriptedOutput = { toolResults: [], wrote: [], modelCalls: 0 };
          for (const step of steps) {
            if ("model" in step) {
              if (!(await options.reserveModelCall())) {
                return { status: "failed", summary: "model request budget exhausted", output: out };
              }
              out.modelCalls += 1;
            } else if ("tool" in step) {
              const tool = options.tools.find((t) => t.name === step.tool);
              if (!tool) return { status: "failed", summary: `tool ${step.tool} is not available`, output: out };
              out.toolResults.push({ id: step.id, tool: step.tool, result: await tool.call(step.id, step.input ?? {}) });
            } else if ("write" in step) {
              const target = path.join(options.cwd, step.write.path);
              await mkdir(path.dirname(target), { recursive: true });
              await writeFile(target, step.write.content, "utf8");
              out.wrote.push(step.write.path);
            } else if ("wait" in step) {
              await new Promise<void>((resolve) => {
                if (options.signal?.aborted) resolve();
                options.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              return { status: "failed", summary: "aborted", output: out };
            } else {
              throw new Error(step.fail);
            }
          }
          return { status: "completed", summary: `scripted agent ran ${steps.length} steps`, output: out };
        },
      };
    },
  };
}

/** Default export for `GRAPHLOOM_CODING_HARNESS` pointing at this module. */
export const harness = createScriptedHarness();

/** Absolute path of this module, for binding the scripted harness in tests. */
export const scriptedHarnessModule = new URL(import.meta.url).pathname;
