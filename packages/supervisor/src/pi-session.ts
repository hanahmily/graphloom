import { mkdir } from "node:fs/promises";
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

export function isMiniMaxProvider(provider: string): boolean {
  return provider === "minimax-cn" || provider === "minimax";
}

export interface CreatePiSupervisorSessionOptions {
  /** Run id for logging / durable binding. */
  runId: string;
  /**
   * Directory for this run's durable Pi transcript.
   * Required so restart can reopen the same logical session.
   */
  sessionDir: string;
  /** Existing Pi session file to restore; omit to start a new durable session. */
  sessionFile?: string;
  /** Pi provider id. Default: minimax-cn */
  provider?: string;
  /** Model id. Default: MiniMax-M3 */
  modelId?: string;
  /** Absolute Pi agent dir (auth.json / models.json). Default: ~/.pi/agent */
  agentDir?: string;
  /**
   * Explicit MiniMax API key (MiniMax providers only).
   * Otherwise env or Pi-stored credential for that provider.
   */
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
  /** Durable Pi transcript path (undefined only if the SDK did not persist). */
  readonly sessionFile: string | undefined;
  readonly credentialSource: MiniMaxCredentialSource;
  /**
   * Send a prompt and wait until idle. Returns assistant text only
   * (no thinking / tool internals). Times out if the session does not settle.
   */
  prompt(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  /**
   * Switch the active model on this logical session.
   * Caller must ensure the target is operator-configured and idle.
   */
  setModel(ref: { provider: string; modelId: string }): Promise<void>;
  /** Dispose the Pi session and release resources. */
  close(): Promise<void>;
}

/**
 * Create one Pi AgentSession for the run-wide supervisor.
 * Uses MiniMax by default; credentials never appear in prompts or activity.
 * The raw AgentSession stays private — only mediated prompt/close are exposed.
 */
export async function createPiSupervisorSession(
  options: CreatePiSupervisorSessionOptions,
): Promise<PiSupervisorSession> {
  const provider = options.provider ?? DEFAULT_SUPERVISOR_PROVIDER;
  const modelId = options.modelId ?? DEFAULT_SUPERVISOR_MODEL;
  const agentDir = options.agentDir ?? path.join(os.homedir(), ".pi", "agent");
  const cwd = options.cwd ?? process.cwd();
  const promptTimeoutMs = options.promptTimeoutMs ?? 60_000;
  const sessionDir = path.resolve(options.sessionDir);
  await mkdir(sessionDir, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });

  const credentialSource = await applyProviderCredentials({
    modelRuntime,
    provider,
    agentDir,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });

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

  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    noTools: "all",
    tools: [],
    sessionManager,
    settingsManager,
  });

  return wrapSession({
    session,
    modelRuntime,
    runId: options.runId,
    provider,
    modelId,
    agentDir,
    credentialSource,
    promptTimeoutMs,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });
}

/** Ensure the target provider has usable credentials before setModel. */
export async function ensureProviderCredentials(args: {
  modelRuntime: ModelRuntime;
  provider: string;
  agentDir: string;
  apiKey?: string;
}): Promise<MiniMaxCredentialSource> {
  return applyProviderCredentials(args);
}

async function applyProviderCredentials(args: {
  modelRuntime: ModelRuntime;
  provider: string;
  agentDir: string;
  apiKey?: string;
}): Promise<MiniMaxCredentialSource> {
  const { modelRuntime, provider, agentDir } = args;

  if (isMiniMaxProvider(provider)) {
    const credential = resolveMiniMaxCredential({
      ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
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
    return credential.source;
  }

  if (args.apiKey !== undefined) {
    throw new Error(
      `apiKey option is MiniMax-only; cannot inject MiniMax credentials into provider ${provider}`,
    );
  }
  // Do not resolve or apply MiniMax env keys to other providers.
  const auth = await modelRuntime.getAuth(provider);
  if (!auth) {
    throw new Error(
      `credential unavailable for provider ${provider}: configure Pi auth under ${agentDir}`,
    );
  }
  return "pi-stored";
}

function wrapSession(args: {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  runId: string;
  provider: string;
  modelId: string;
  agentDir: string;
  credentialSource: MiniMaxCredentialSource;
  promptTimeoutMs: number;
  apiKey?: string;
}): PiSupervisorSession {
  const { session, modelRuntime, agentDir, promptTimeoutMs } = args;
  let closed = false;
  let provider = args.provider;
  let modelId = args.modelId;

  return {
    runId: args.runId,
    get provider() {
      return provider;
    },
    get modelId() {
      return modelId;
    },
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    credentialSource: args.credentialSource,
    async setModel(ref) {
      if (closed) {
        throw new Error("supervisor session is closed");
      }
      if (!session.isIdle) {
        await session.abort().catch(() => undefined);
        const settleDeadline = Date.now() + 5_000;
        while (!session.isIdle && Date.now() < settleDeadline) {
          await sleep(25);
        }
        if (!session.isIdle) {
          throw new Error("cannot switch model: session still active after abort");
        }
      }
      // Validate/prepare target credentials before mutating the active model.
      await ensureProviderCredentials({
        modelRuntime,
        provider: ref.provider,
        agentDir,
        ...(args.apiKey !== undefined && isMiniMaxProvider(ref.provider)
          ? { apiKey: args.apiKey }
          : {}),
      });
      const model = modelRuntime.getModel(ref.provider, ref.modelId);
      if (!model) {
        throw new Error(`Pi model not found: ${ref.provider}/${ref.modelId}`);
      }
      await session.setModel(model, { persist: false });
      provider = ref.provider;
      modelId = ref.modelId;
    },
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

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
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
        if (timedOut || !session.isIdle) {
          await session.abort().catch(() => undefined);
          // Brief settle after abort so callers do not observe a still-busy session.
          const settleDeadline = Date.now() + 5_000;
          while (!session.isIdle && Date.now() < settleDeadline) {
            await sleep(25);
          }
          throw new Error(
            `supervisor prompt timed out after ${promptTimeoutMs}ms (session still active)`,
          );
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
