// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BUDGET_EXHAUSTED, type NativeToolUse } from "../common.js";
import { minimalEnv } from "../process/env.js";

/** Pi's built-in coding tools, all active: the agent runs unrestricted in its working directory. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** A Pi model, as its model runtime resolves it. */
export type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** Pi's own provider registry and auth store, from `agentDir`. */
export async function defaultPiModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
}

/** A resource loader that loads nothing from disk (no extensions, skills, prompts, or AGENTS files): only `systemPrompt`. */
export function isolatedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

/** Pi's bash tool rooted at `root`, whose commands see only the minimal environment plus `passEnv`. */
export function piBashTool(root: string, passEnv: readonly string[]): ToolDefinition {
  // Pi's own bash would hand every command the caller's whole environment.
  return createBashToolDefinition(root, {
    spawnHook: (spawn) => ({ ...spawn, env: minimalEnv(spawn.env, passEnv) }),
  }) as unknown as ToolDefinition;
}

export interface PiAgentOptions {
  cwd: string;
  agentDir: string;
  model: PiModel;
  modelRuntime: ModelRuntime;
  systemPrompt: string;
  /** The bash tool (`piBashTool`), in place of Pi's own. */
  bash: ToolDefinition;
  /** The caller's tools, active next to Pi's built-in ones. */
  tools: ToolDefinition[];
  sessionManager: SessionManager;
  /** Reserve one provider request before each one Pi makes; false refuses it and fails the turn. */
  reserveModelCall(): Promise<boolean>;
}

export interface PiAgent {
  agent: AgentSession;
  /** True once `reserveModelCall` refused a request. */
  budgetRefused(): boolean;
}

/**
 * A Pi agent session with Pi's built-in tools, the caller's tools, and the
 * isolated resource loader; no thinking, compaction, retry, or cache
 * warming. Every provider request is reserved through `reserveModelCall`
 * first.
 */
export async function createPiAgent(opts: PiAgentOptions): Promise<PiAgent> {
  const { session: agent } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    model: opts.model,
    thinkingLevel: "off",
    modelRuntime: opts.modelRuntime,
    resourceLoader: isolatedResourceLoader(opts.systemPrompt),
    noTools: "all",
    tools: [...PI_BUILTIN_TOOLS, ...opts.tools.map((t) => t.name)],
    customTools: [opts.bash, ...opts.tools],
    sessionManager: opts.sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  });
  let budgetRefused = false;
  const stream = agent.agent.streamFunction;
  agent.agent.streamFunction = async (...args: Parameters<typeof stream>) => {
    if (!(await opts.reserveModelCall())) {
      budgetRefused = true;
      throw new Error(BUDGET_EXHAUSTED);
    }
    return stream(...args);
  };
  return { agent, budgetRefused: () => budgetRefused };
}

/** Prompts `agent` with `text` and waits until it is idle; `signal` aborts the agent. A failed request throws. */
export async function promptPiAgent(agent: AgentSession, text: string, signal: AbortSignal | undefined): Promise<void> {
  const onAbort = () => void agent.abort().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(text, { expandPromptTemplates: false });
    await agent.waitForIdle();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface PiAssistantView {
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

export function lastAssistant(messages: readonly unknown[]): PiAssistantView | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown };
    if (m.role === "assistant") return m as PiAssistantView;
  }
  return undefined;
}

/** Visible reply text only; thinking blocks and tool calls stay out of the summary. */
export function assistantText(message: PiAssistantView): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

/** Built-in tool calls in the messages one run added; undefined when the messages are not in a readable shape. */
export function piNativeTools(messages: readonly unknown[] | undefined, from: number, mediated: Set<string>): NativeToolUse[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const used: NativeToolUse[] = [];
  for (const m of messages.slice(from) as { role?: unknown; content?: unknown }[]) {
    if (m === null || typeof m !== "object") return undefined;
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) return undefined;
    for (const block of m.content as { type?: unknown; name?: unknown }[]) {
      if (block?.type !== "toolCall") continue;
      if (typeof block.name !== "string") return undefined;
      if (!mediated.has(block.name)) used.push({ name: block.name });
    }
  }
  return used;
}
