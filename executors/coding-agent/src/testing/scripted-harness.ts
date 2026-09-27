import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolCallResult } from "@graphloom/sdk";
import type { CodingHarness, CodingRunResult, CodingSessionOptions } from "../harness.js";

/**
 * One scripted agent action. Steps come from the job input
 * (`harnessOptions.steps`), so tests drive the agent through the graph.
 */
export type ScriptedStep =
  | { model: true }
  | { tool: string; id: string; input?: unknown }
  | { write: { path: string; content: string } }
  | { wait: "abort" }
  | { sleep: number }
  | { fail: string };

export interface ScriptedOutput {
  toolResults: Array<{ id: string; tool: string; result: ToolCallResult }>;
  wrote: string[];
  modelCalls: number;
  /** The assignment this turn received, including any continuation notice. */
  assignment: string;
  /** Assignments of the earlier turns in a continued session. */
  priorAssignments: string[];
}

/** What the scripted harness saves in the session directory. */
interface Transcript {
  sessionRef: string;
  turns: Array<{ assignment: string; steps: ScriptedStep[] }>;
}

const SESSION_REF = /^scripted-[a-z0-9]{8}$/;

async function restore(options: CodingSessionOptions): Promise<Transcript | undefined> {
  if (options.resume === undefined) return undefined;
  if (!SESSION_REF.test(options.resume)) throw new Error(`malformed session ref ${options.resume}`);
  if (options.sessionDir === undefined) throw new Error("no session directory to restore from");
  let raw: string;
  try {
    raw = await readFile(path.join(options.sessionDir, `${options.resume}.json`), "utf8");
  } catch {
    throw new Error(`no transcript for ${options.resume}`);
  }
  return JSON.parse(raw) as Transcript;
}

/** Replace the transcript whole, so a crash mid-write leaves the previous turn restorable. */
async function saveTranscript(dir: string, transcript: Transcript): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${transcript.sessionRef}.json`);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(transcript, null, 2), "utf8");
  await rename(tmp, target);
}

/** A harness that performs scripted steps instead of calling a model. */
export function createScriptedHarness(): CodingHarness {
  return {
    name: "scripted",
    resumable: true,
    async createSession(options: CodingSessionOptions) {
      const transcript: Transcript = (await restore(options)) ?? {
        sessionRef: `scripted-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        turns: [],
      };
      return {
        async run(request) {
          const steps = (options.options?.steps ?? []) as ScriptedStep[];
          const out: ScriptedOutput = {
            toolResults: [],
            wrote: [],
            modelCalls: 0,
            assignment: request.assignment,
            priorAssignments: transcript.turns.map((t) => t.assignment),
          };
          const result = await perform(steps, out, options);
          if (options.sessionDir === undefined) return result;
          transcript.turns.push({ assignment: request.assignment, steps });
          await saveTranscript(options.sessionDir, transcript);
          return { ...result, sessionRef: transcript.sessionRef };
        },
      };
    },
  };
}

async function perform(steps: ScriptedStep[], out: ScriptedOutput, options: CodingSessionOptions): Promise<CodingRunResult> {
  for (const step of steps) {
    if (options.signal?.aborted) return { status: "failed", summary: "aborted", output: out };
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
    } else if ("sleep" in step) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, step.sleep);
        options.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    } else {
      throw new Error(step.fail);
    }
  }
  return { status: "completed", summary: `scripted agent ran ${steps.length} steps`, output: out };
}

/** Default export for `GRAPHLOOM_CODING_HARNESS` pointing at this module. */
export const harness = createScriptedHarness();

/** Absolute path of this module, for binding the scripted harness in tests. */
export const scriptedHarnessModule = new URL(import.meta.url).pathname;
