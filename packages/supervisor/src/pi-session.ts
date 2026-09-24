import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  resolveMiniMaxCredential,
  type MiniMaxCredentialSource,
} from "./credentials.js";

/** Default initial supervisor model (design-pi-supervisor.md). */
export const DEFAULT_SUPERVISOR_PROVIDER = "minimax-cn";
export const DEFAULT_SUPERVISOR_MODEL = "MiniMax-M3";

export interface CreatePiSupervisorSessionOptions {
  /** Run id for logging / future durable binding. */
  runId: string;
  /** Pi provider id. Default: minimax-cn */
  provider?: string;
  /** Model id. Default: MiniMax-M3 */
  modelId?: string;
  /** Absolute Pi agent dir (auth.json / models.json). Default: ~/.pi/agent */
  agentDir?: string;
  /** Explicit MiniMax API key; otherwise env or Pi-stored credential. */
  apiKey?: string;
  /** Working directory for the session (does not grant filesystem tools). */
  cwd?: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Abort / settle timeout for a single prompt (ms). Default 60_000. */
  promptTimeoutMs?: number;
}

export interface PiSupervisorSession {
  readonly runId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly credentialSource: MiniMaxCredentialSource;
  /** Underlying Pi session — do not use filesystem tools; GraphLoom owns authority. */
  readonly session: AgentSession;
  /**
   * Send a prompt and wait until idle. Returns assistant text only
   * (no thinking / tool internals).
   */
  prompt(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  /** Dispose the Pi session and release resources. */
  close(): Promise<void>;
}

/**
 * Create one Pi AgentSession for the run-wide supervisor.
 * Uses MiniMax by default; credentials never appear in prompts or activity.
 */
export async function createPiSupervisorSession(
  options: CreatePiSupervisorSessionOptions,
): Promise<PiSupervisorSession> {
  const provider = options.provider ?? DEFAULT_SUPERVISOR_PROVIDER;
  const modelId = options.modelId ?? DEFAULT_SUPERVISOR_MODEL;
  const agentDir = options.agentDir ?? path.join(os.homedir(), ".pi", "agent");
  const cwd = options.cwd ?? process.cwd();
  const promptTimeoutMs = options.promptTimeoutMs ?? 60_000;

  const credential = resolveMiniMaxCredential({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });

  if (credential.apiKey !== undefined) {
    await modelRuntime.setRuntimeApiKey(provider, credential.apiKey);
  } else {
    const auth = await modelRuntime.getAuth(provider);
    if (!auth) {
      throw new Error(
        `MiniMax credential unavailable for provider ${provider}: set MINIMAX_CN_API_KEY or MINIMAX_API_KEY, or configure Pi auth under ${agentDir}`,
      );
    }
  }

  const model = modelRuntime.getModel(provider, modelId);
  if (!model) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });

  const systemPrompt =
    options.systemPrompt ??
    [
      "You are the GraphLoom run supervisor.",
      "Investigate failures, propose repairs, and drive the graph to completion within pinned steps and budgets.",
      "Do not invent new graph steps or accept requirements yourself.",
      "Be concise; do not expose private chain-of-thought.",
    ].join(" ");

  const resourceLoader = createIsolatedResourceLoader(systemPrompt);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    noTools: "all",
    tools: [],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });

  let closed = false;

  const api: PiSupervisorSession = {
    runId: options.runId,
    provider,
    modelId,
    sessionId: session.sessionId,
    credentialSource: credential.source,
    session,
    async prompt(text, promptOptions) {
      if (closed) {
        throw new Error("supervisor session is closed");
      }
      const collected: string[] = [];
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          collected.push(event.assistantMessageEvent.delta);
        }
      });

      const timeout = setTimeout(() => {
        void session.abort().catch(() => undefined);
      }, promptTimeoutMs);
      const onOuterAbort = () => {
        void session.abort().catch(() => undefined);
      };
      promptOptions?.signal?.addEventListener("abort", onOuterAbort, { once: true });

      try {
        if (promptOptions?.signal?.aborted) {
          throw new Error("supervisor prompt aborted");
        }
        await session.prompt(text);
        const idleDeadline = Date.now() + promptTimeoutMs;
        while (!session.isIdle && Date.now() < idleDeadline) {
          await sleep(25);
        }
        if (promptOptions?.signal?.aborted) {
          throw new Error("supervisor prompt aborted");
        }
        return collected.join("").trim();
      } finally {
        clearTimeout(timeout);
        promptOptions?.signal?.removeEventListener("abort", onOuterAbort);
        unsubscribe();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!session.isIdle) {
        await session.abort().catch(() => undefined);
      }
      session.dispose();
    },
  };

  return api;
}

function createIsolatedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
