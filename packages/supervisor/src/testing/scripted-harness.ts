// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Scripted harness sessions for the conformance suite (tests only; not built
 * into dist). A script is the agent's successive answers, shared by every
 * session the harness opens, played through the harness's own decision
 * protocol: GraphLoom tool calls for a `tools` harness (Pi), a JSON final
 * message for a `reply` harness (the CLI harnesses).
 */
import { ACTION_SPEC_KEYS, type CaseFinding, type GraphDecision } from "@graphloom/sdk";
import type {
  HarnessCapabilities,
  HarnessPromptOptions,
  HarnessSession,
  HarnessSessionRole,
  SupervisorBinding,
  SupervisorHarness,
  SupervisorModelRef,
} from "../harness.js";
import { createSupervisorHost } from "../host.js";
import type { InvestigationStep } from "../investigation.js";
import { SupervisorProviderError, type ProviderFailure } from "../provider-failure.js";
import type { InspectRequest } from "../reply.js";

/** What the agent observably did with its own tools before a reply (reply harnesses record these). */
export interface ScriptedObservation {
  tool: string;
  input: unknown;
  output: unknown;
  exitCode?: number;
}

/** One answer of the scripted agent. */
export type ScriptStep = (
  | { decide: GraphDecision; findings?: CaseFinding[] }
  | { inspect: InspectRequest[] }
  | { switchModel: { provider: string; modelId: string; reason: string } }
  /** A final message as it is, e.g. something that is not a decision. */
  | { text: string }
  /** No visible reply (a thinking-only turn). */
  | { empty: true }
  /** A reply the provider failed, as the harness classifies it. */
  | { fail: ProviderFailure }
  /** The prompt goes silent and times out. */
  | { timeout: true }
) & { observe?: ScriptedObservation[] };

export type DecisionMode = "tools" | "reply";

export interface ScriptLog {
  /** Every prompt sent, with the session it went to. */
  prompts: Array<{ session: string; text: string }>;
  /** The model each session was opened on, in order, with its role. */
  opened: Array<{ session: string; model: string; role: HarnessSessionRole }>;
  /** In-session model switches. */
  setModel: Array<{ session: string; model: string }>;
  granted: Array<{ session: string; root: string }>;
  revoked: string[];
  closed: string[];
  compactions: number;
  /** Tool names a `tools` session called, in order. */
  toolCalls: string[];
}

export interface ScriptedHarnessOptions {
  name: string;
  capabilities: HarnessCapabilities;
  mode: DecisionMode;
  script: ScriptStep[];
}

export interface ScriptedHarness {
  log: ScriptLog;
  /** Open a session the way the harness does (for callers that build a host from a first session). */
  open(model: SupervisorModelRef, role?: HarnessSessionRole): Promise<HarnessSession>;
  /** Script steps not yet played. */
  remaining(): number;
}

function modelName(m: { provider: string; modelId: string }): string {
  return `${m.provider}/${m.modelId}`;
}

/** The scripted sessions of one harness and the log of what the host did with them. */
export function scriptedSessions(options: ScriptedHarnessOptions): ScriptedHarness {
  const queue = [...options.script];
  const log: ScriptLog = { prompts: [], opened: [], setModel: [], granted: [], revoked: [], closed: [], compactions: 0, toolCalls: [] };
  let opened = 0;

  async function open(model: SupervisorModelRef, role: HarnessSessionRole = "decide"): Promise<HarnessSession> {
    opened += 1;
    const id = `${options.name}-session-${opened}`;
    log.opened.push({ session: id, model: modelName(model), role });
    let provider = model.provider;
    let modelId = model.modelId;
    let turns = 0;
    let failure: ProviderFailure | undefined;
    const steps: InvestigationStep[] = [];
    const record = (observe: ScriptedObservation[] | undefined) => {
      if (options.mode !== "reply") return;
      for (const o of observe ?? []) {
        steps.push({
          id: `inv-${steps.length + 1}`,
          harness: options.name,
          kind: o.tool === "Bash" ? "command" : "tool",
          tool: o.tool,
          input: o.input,
          output: o.output,
          ...(o.exitCode !== undefined ? { exitCode: o.exitCode } : {}),
          at: "2026-10-27T00:00:00.000Z",
        });
        // Each tool result goes back to the model: one more provider call.
        turns += 1;
      }
    };
    const next = (): ScriptStep => {
      const step = queue.shift();
      if (step === undefined) throw new Error(`${options.name}: script exhausted`);
      return step;
    };
    const callTool = async (prompt: HarnessPromptOptions | undefined, name: string, params: Record<string, unknown>) => {
      const tool = prompt?.tools?.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`${options.name}: tool ${name} was not offered`);
      log.toolCalls.push(name);
      const execute = tool.execute as unknown as (id: string, p: Record<string, unknown>, s?: AbortSignal) => Promise<{ terminate?: boolean; content?: Array<{ text?: string }> }>;
      return execute(`call-${log.toolCalls.length}`, params, prompt?.signal);
    };

    /** A `tools` prompt: tool turns until a tool ends it, a final message, or a failure. */
    const toolsPrompt = async (prompt: HarnessPromptOptions | undefined): Promise<string> => {
      let promptTurns = 0;
      for (;;) {
        if (prompt?.done?.() === true) return "";
        const cap = prompt?.maxTurns === undefined ? undefined : prompt.maxTurns - Math.max(0, prompt.reservedTurns?.() ?? 0);
        if (cap !== undefined && promptTurns >= cap) throw new Error(`supervisor prompt exceeded its ${cap}-turn allowance`);
        promptTurns += 1;
        turns += 1;
        const step = next();
        if ("timeout" in step) throw new SupervisorProviderError({ failureClass: "timeout", message: "no output for 1s" });
        if ("fail" in step) {
          failure = step.fail;
          return "";
        }
        if ("empty" in step) {
          failure = { failureClass: "empty", message: "the reply had no tool call or text" };
          return "";
        }
        if ("text" in step) return step.text;
        if ("inspect" in step) {
          for (const r of step.inspect) await callTool(prompt, r.tool, r.args);
          continue;
        }
        if ("switchModel" in step) {
          await callTool(prompt, "switch_model", step.switchModel);
          return "";
        }
        for (const finding of step.findings ?? []) await callTool(prompt, "record_finding", finding as unknown as Record<string, unknown>);
        const key = ACTION_SPEC_KEYS[step.decide.action.type]!;
        const result = await callTool(prompt, step.decide.action.type, {
          reason: step.decide.reason,
          [key]: (step.decide.action as unknown as Record<string, unknown>)[key],
          ...(step.decide.evidence !== undefined ? { evidence: step.decide.evidence } : {}),
        });
        if (result.terminate === true) return "";
        // A rejected call goes back to the model, which answers in its next turn.
      }
    };

    /** A `reply` prompt: one final message, after any observed tool use. */
    const replyPrompt = async (): Promise<string> => {
      turns += 1;
      const step = next();
      record(step.observe);
      if ("timeout" in step) throw new SupervisorProviderError({ failureClass: "timeout", message: "no output for 1s" });
      if ("fail" in step) {
        failure = step.fail;
        return "";
      }
      if ("empty" in step) return "";
      if ("text" in step) return step.text;
      if ("inspect" in step) return JSON.stringify({ inspect: step.inspect });
      if ("switchModel" in step) return JSON.stringify({ switch_model: step.switchModel });
      return [
        "Investigated; deciding.",
        "```json",
        JSON.stringify({ ...step.decide, ...(step.findings !== undefined ? { findings: step.findings } : {}) }),
        "```",
      ].join("\n");
    };

    const session: HarnessSession = {
      get provider() {
        return provider;
      },
      get modelId() {
        return modelId;
      },
      sessionId: id,
      sessionFile: `/scripted/${id}.jsonl`,
      async prompt(text, prompt) {
        log.prompts.push({ session: id, text });
        failure = undefined;
        if (prompt?.signal?.aborted) throw new Error("supervisor prompt aborted");
        return options.mode === "tools" ? toolsPrompt(prompt) : replyPrompt();
      },
      drainTurnCount() {
        const n = turns;
        turns = 0;
        return n;
      },
      peekTurnCount() {
        return turns;
      },
      lastReplyFailure() {
        return failure;
      },
      async setModel(ref) {
        log.setModel.push({ session: id, model: modelName(ref) });
        provider = ref.provider;
        modelId = ref.modelId;
      },
      async grantCandidateCoding(root) {
        log.granted.push({ session: id, root });
      },
      async revokeCandidateCoding() {
        log.revoked.push(id);
      },
      investigation() {
        return steps.map((s) => ({ ...s }));
      },
      async close() {
        log.closed.push(id);
      },
      ...(options.capabilities.compaction
        ? {
            async compact() {
              log.compactions += 1;
              turns += 2;
            },
          }
        : {}),
    };
    return session;
  }

  return { log, open, remaining: () => queue.length };
}

/** A whole scripted harness (for a harness that has no other implementation yet, such as the fake CLI). */
export function scriptedHarness(
  options: ScriptedHarnessOptions & { configuredModels: SupervisorModelRef[]; transientRetryBaseMs?: number },
): ScriptedHarness & { harness: SupervisorHarness } {
  const sessions = scriptedSessions(options);
  const harness: SupervisorHarness = {
    name: options.name,
    capabilities: options.capabilities,
    probe: async () => ({ ok: true }),
    openSession: ({ model, role }) => sessions.open(model, role),
    async restore(binding: SupervisorBinding) {
      const bound = options.configuredModels.find((m) => m.provider === binding.provider && m.modelId === binding.modelId);
      return createSupervisorHost({
        harness,
        session: await sessions.open(bound ?? { provider: binding.provider, modelId: binding.modelId }),
        logicalSessionId: binding.sessionId,
        configuredModels: options.configuredModels,
        initialSwitchJournal: binding.switchJournal,
        ...(options.transientRetryBaseMs !== undefined ? { transientRetryBaseMs: options.transientRetryBaseMs } : {}),
      });
    },
  };
  return { ...sessions, harness };
}
