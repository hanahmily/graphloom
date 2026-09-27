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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  resolveMiniMaxCredential,
  type MiniMaxCredentialSource,
} from "./credentials.js";
import {
  assertAdmittedCandidateRoot,
  createCandidateCodingTools,
} from "./candidate-tools.js";

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
  /**
   * Controller repairs directory (`<stateDir>/repairs`). Candidate coding grants
   * are only accepted for snapshots issued under it.
   */
  repairsDir?: string;
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
   * Send a prompt and wait until idle. Returns the final turn's assistant text
   * only (no thinking / tool internals). Times out if the session does not settle.
   * With `maxTurns`, a turn beyond the cap is aborted before its provider request
   * and the prompt rejects. `tools` are active for this prompt only.
   */
  prompt(
    text: string,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxTurns?: number; tools?: ToolDefinition[] },
  ): Promise<string>;
  /** Provider turns (model calls) started since the last drain, including tool turns. */
  drainTurnCount?(): number;
  /**
   * Switch the active model on this logical session.
   * Caller must ensure the target is operator-configured and idle.
   */
  setModel(ref: { provider: string; modelId: string }): Promise<void>;
  /**
   * Enable Pi's full coding toolset, rooted at a controller-issued QualifyRepair
   * candidate root. Session identity must not change across repair rounds.
   */
  grantCandidateCoding?(candidateRoot: string): Promise<void>;
  revokeCandidateCoding?(): Promise<void>;
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

  return wrapPiAgentSession({
    session,
    modelRuntime,
    runId: options.runId,
    provider,
    modelId,
    agentDir,
    credentialSource,
    promptTimeoutMs,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.repairsDir !== undefined ? { repairsDir: options.repairsDir } : {}),
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

/** @internal Exported for tests that drive a real AgentSession on a faux provider. */
export function wrapPiAgentSession(args: {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  runId: string;
  provider: string;
  modelId: string;
  agentDir: string;
  credentialSource: MiniMaxCredentialSource;
  promptTimeoutMs: number;
  apiKey?: string;
  repairsDir?: string;
}): PiSupervisorSession {
  const { session, modelRuntime, agentDir, promptTimeoutMs } = args;
  let closed = false;
  let provider = args.provider;
  let modelId = args.modelId;
  let codingRoot: string | undefined;
  let turns = 0;

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
      if (!(await settleIdle(session))) {
        throw new Error("cannot switch model: session still active after abort");
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
      // An earlier abort may not have settled; never overlap provider requests.
      if (!(await settleIdle(session))) {
        throw new Error(STILL_ACTIVE);
      }
      const timeoutMs = promptOptions?.timeoutMs ?? promptTimeoutMs;
      const maxTurns = promptOptions?.maxTurns;
      let promptTurns = 0;
      let turnCapHit = false;
      let collected: string[] = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") {
          // Pi awaits listeners before streaming, so aborting here cancels the
          // turn before its provider request is sent.
          if (maxTurns !== undefined && promptTurns >= maxTurns) {
            turnCapHit = true;
            void session.abort().catch(() => undefined);
            return;
          }
          promptTurns += 1;
          turns += 1;
          // Tool-using prompts span several turns; keep only the final reply.
          collected = [];
        } else if (
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
      }, timeoutMs);
      const onOuterAbort = () => {
        void session.abort().catch(() => undefined);
      };
      promptOptions?.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (promptOptions?.tools !== undefined) setSessionTools(session, promptOptions.tools);

      try {
        if (promptOptions?.signal?.aborted) {
          throw new Error("supervisor prompt aborted");
        }
        await session.prompt(text);
        const idleDeadline = Date.now() + timeoutMs;
        while (!session.isIdle && Date.now() < idleDeadline) {
          await sleep(25);
        }
        if (promptOptions?.signal?.aborted) {
          throw new Error(
            (await settleIdle(session)) ? "supervisor prompt aborted" : `supervisor prompt aborted; ${STILL_ACTIVE}`,
          );
        }
        if (turnCapHit) {
          throw new Error(`supervisor prompt exceeded its ${maxTurns}-turn allowance`);
        }
        if (timedOut || !session.isIdle) {
          const settled = await settleIdle(session);
          throw new Error(
            `supervisor prompt timed out after ${timeoutMs}ms` + (settled ? "" : `; ${STILL_ACTIVE}`),
          );
        }
        return collected.join("").trim();
      } finally {
        clearTimeout(timeout);
        promptOptions?.signal?.removeEventListener("abort", onOuterAbort);
        unsubscribe();
        if (promptOptions?.tools !== undefined) {
          setSessionTools(session, codingRoot !== undefined ? createCandidateCodingTools(codingRoot) : []);
        }
      }
    },
    drainTurnCount() {
      const n = turns;
      turns = 0;
      return n;
    },
    async grantCandidateCoding(candidateRoot: string) {
      if (closed) {
        throw new Error("supervisor session is closed");
      }
      const root = await assertAdmittedCandidateRoot(args.repairsDir, candidateRoot);
      codingRoot = root;
      setSessionTools(session, createCandidateCodingTools(root));
    },
    async revokeCandidateCoding() {
      codingRoot = undefined;
      setSessionTools(session, []);
    },
    async close() {
      if (closed) return;
      closed = true;
      codingRoot = undefined;
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

/** Pi AgentSession internals needed to swap candidate-scoped coding tools. */
interface MutableToolSession {
  _customTools: ToolDefinition[];
  _allowedToolNames: Set<string> | undefined;
  _refreshToolRegistry: (options?: { activeToolNames?: string[] }) => void;
  setActiveToolsByName: (toolNames: string[]) => void;
}

function asMutableToolSession(session: AgentSession): MutableToolSession {
  return session as unknown as MutableToolSession;
}

/**
 * Make exactly `tools` active: candidate coding tools, admission tools for a
 * decision turn, or none. The allowlist names only these tools, so Pi's
 * built-ins (including bash) are active only while candidate coding is granted.
 */
function setSessionTools(session: AgentSession, tools: ToolDefinition[]): void {
  const host = asMutableToolSession(session);
  const names = tools.map((t) => t.name);
  host._allowedToolNames = new Set(names);
  host._customTools = tools;
  host._refreshToolRegistry({ activeToolNames: names });
  host.setActiveToolsByName(names);
}

const STILL_ACTIVE = "supervisor session still active after abort; refusing to reuse it";

/** Abort any active request and wait briefly for idle; false if it never settled. */
async function settleIdle(session: AgentSession): Promise<boolean> {
  if (session.isIdle) return true;
  await session.abort().catch(() => undefined);
  const settleDeadline = Date.now() + 5_000;
  while (!session.isIdle && Date.now() < settleDeadline) {
    await sleep(25);
  }
  return session.isIdle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
