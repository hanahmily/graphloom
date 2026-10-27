// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir } from "node:fs/promises";
import { captureRawStream } from "./raw-stream.js";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defaultPiModelRuntime, isolatedResourceLoader } from "@graphloom/agent-harness/pi";
import type { HarnessPromptOptions, HarnessSession, ThinkingLevel } from "./harness.js";
import {
  resolveMiniMaxCredential,
  type MiniMaxCredentialSource,
} from "./credentials.js";
import {
  assertAdmittedCandidateRoot,
  createCandidateCodingTools,
} from "./candidate-tools.js";
import { classifyAssistantMessage, SupervisorProviderError, type ProviderFailure } from "./provider-failure.js";

/** Default initial supervisor model (design-pi-supervisor.md). */
export const DEFAULT_SUPERVISOR_PROVIDER = "minimax-cn";
export const DEFAULT_SUPERVISOR_MODEL = "MiniMax-M3";

/**
 * Default inactivity limit of one prompt: how long the session may go without
 * any Pi event (a streamed text or thinking delta, a tool call, a turn) before
 * the prompt is aborted as a provider timeout. Thinking models can take a while
 * to their first token, so this is generous; a model that is still streaming
 * is never cut off by it.
 */
export const DEFAULT_PROMPT_INACTIVITY_MS = 120_000;
/** Default total cap of one prompt, a backstop for a reply that streams forever. */
export const DEFAULT_PROMPT_TOTAL_TIMEOUT_MS = 900_000;

export type { ThinkingLevel } from "./harness.js";

export function isMiniMaxProvider(provider: string): boolean {
  return provider === "minimax-cn" || provider === "minimax";
}

/** A model as Pi's registry returns it. */
type RegistryModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * Providers whose thinking blocks carry an empty signature (`signature: ""`)
 * and accept them back. Without `compat.allowEmptySignature`, Pi's
 * anthropic-messages request builder replays such a block as a plain `text`
 * block of the assistant turn, so the model reads its own private reasoning
 * as something it said.
 */
export function emitsEmptyThinkingSignatures(provider: string): boolean {
  return isMiniMaxProvider(provider);
}

/**
 * The model a supervisor session runs on: the registry's entry, with the
 * provider compat flags the supervisor needs. A copy, so the registry's own
 * object (shared by whatever else resolves that model) is never mutated.
 */
export function supervisorSessionModel<M extends RegistryModel>(model: M): M {
  if (!emitsEmptyThinkingSignatures(model.provider)) return model;
  const compat = (model as unknown as { compat?: Record<string, unknown> }).compat;
  if (compat?.allowEmptySignature === true) return model;
  return { ...model, compat: { ...compat, allowEmptySignature: true } } as M;
}

export interface CreatePiSupervisorSessionOptions {
  /** Run id for logging / durable binding. */
  runId: string;
  /**
   * Directory for this run's durable Pi transcripts, one file per episode
   * session; kept for the operator, never reopened by GraphLoom itself.
   */
  sessionDir: string;
  /** Existing Pi session file to restore; omit to start a new durable session. */
  sessionFile?: string;
  /** Pi provider id. Default: minimax-cn */
  provider?: string;
  /** Model id. Default: MiniMax-M3 */
  modelId?: string;
  /**
   * Reasoning level for the initial model. Default: "off", since the supervisor
   * keeps decisions concise and must not expose chain-of-thought. Some models
   * (e.g. ones requiring adaptive thinking) reject "off" outright; set this to
   * whatever that model requires.
   */
  thinkingLevel?: ThinkingLevel;
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
  /**
   * Record every provider request and its raw response under
   * `<sessionDir>/raw/<sessionId>.raw.jsonl` (see raw-stream.ts). Off by
   * default; request headers, which carry credentials, are never written.
   */
  rawStreamCapture?: boolean;
  /**
   * Inactivity limit of a single prompt (ms): the prompt is aborted as a
   * provider timeout once no Pi event (stream delta, tool call, turn) has
   * arrived for this long. Time a local tool spends executing does not count.
   * Also the default deadline of a standalone compaction. Default 120_000.
   */
  promptTimeoutMs?: number;
  /**
   * Total cap of a single prompt (ms), however steadily it streams; a backstop
   * behind the inactivity limit. Default 900_000.
   */
  promptTotalTimeoutMs?: number;
  /**
   * Controller repairs directory (`<stateDir>/repairs`). Candidate coding grants
   * are only accepted for snapshots issued under it.
   */
  repairsDir?: string;
}

/** The Pi harness's episode session: a HarnessSession with Pi's own accounting and tools. */
export interface PiSupervisorSession extends HarnessSession {
  readonly runId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly sessionId: string;
  /** Durable Pi transcript path (undefined only if the SDK did not persist). */
  readonly sessionFile: string | undefined;
  readonly credentialSource: MiniMaxCredentialSource;
  /**
   * Send a prompt and wait until idle. Returns the final turn's assistant text
   * only (no thinking / tool internals). Rejects with a `timeout`
   * SupervisorProviderError when no session event arrives for the inactivity
   * limit, or when the prompt outlasts its total cap (`timeoutMs`, default the
   * session's total cap). With `maxTurns`, a turn beyond the cap is aborted before its provider request
   * and the prompt rejects. `tools` are active for this prompt only. With
   * `done`, a turn that would start once `done()` is true is aborted before its
   * provider request and the prompt resolves normally: the caller already has
   * what it asked for (an admitted proposal), so that turn is neither sent nor
   * charged, and it is no failure or timeout.
   */
  prompt(text: string, options?: HarnessPromptOptions): Promise<string>;
  /** Provider turns (model calls) started since the last drain, including tool turns. */
  drainTurnCount?(): number;
  /** Non-destructive count of provider turns started and not yet drained. */
  peekTurnCount?(): number;
  /**
   * Why the last prompt's final assistant message carries no usable reply,
   * classified from the provider's own stopReason and errorMessage; undefined
   * when it carried a tool call or text, or when no reply was recorded.
   */
  lastReplyFailure?(): ProviderFailure | undefined;
  /**
   * Take the last prompt out of the model's context so the identical prompt
   * can be sent again: its user message and its reply are omitted through
   * Pi's own context-edit mechanism (the transcript keeps them, the model no
   * longer sees them). Only for a prompt answered in one turn, whose reply is
   * still the session's latest message; a prompt that ran tool turns first
   * cannot be resent without repeating them. Returns whether it was omitted.
   */
  omitLastExchange?(): boolean;
  /**
   * Compact the session's history now (overflow recovery). Its provider
   * requests are charged to the turn count like any other model call.
   * `signal` (the run's Stop) and the deadline (default: the prompt timeout)
   * abort the summarization and reject.
   */
  compact?(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /**
   * Switch the active model on this logical session, and its reasoning level
   * (default "off" when the target does not specify one, even if the previous
   * model ran with thinking enabled).
   * Caller must ensure the target is operator-configured and idle.
   */
  setModel(ref: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }): Promise<void>;
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
 * Create one Pi AgentSession; the supervisor opens one per recovery episode.
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
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_INACTIVITY_MS;
  const promptTotalTimeoutMs = options.promptTotalTimeoutMs ?? DEFAULT_PROMPT_TOTAL_TIMEOUT_MS;
  const sessionDir = path.resolve(options.sessionDir);
  await mkdir(sessionDir, { recursive: true });

  const modelRuntime = await defaultPiModelRuntime(agentDir);

  const credentialSource = await applyProviderCredentials({
    modelRuntime,
    provider,
    agentDir,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });

  const registered = modelRuntime.getModel(provider, modelId);
  if (!registered) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }
  const model = supervisorSessionModel(registered);

  const settingsManager = SettingsManager.inMemory({
    // A guard only: each recovery episode gets its own session seeded with a
    // bounded prompt, so a normal run never comes near the context window.
    // An unusually long episode (many rejected proposals, a long patch) is
    // compacted rather than left to hard-fail on its next prompt.
    compaction: { enabled: true },
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

  const resourceLoader = isolatedResourceLoader(systemPrompt);

  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRuntime,
    resourceLoader,
    noTools: "all",
    tools: [],
    sessionManager,
    settingsManager,
  });
  if (options.rawStreamCapture === true) captureRawStream(session, path.join(sessionDir, "raw"));

  return wrapPiAgentSession({
    session,
    modelRuntime,
    runId: options.runId,
    provider,
    modelId,
    agentDir,
    credentialSource,
    promptTimeoutMs,
    promptTotalTimeoutMs,
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
  /** Inactivity limit of one prompt (see CreatePiSupervisorSessionOptions.promptTimeoutMs). */
  promptTimeoutMs: number;
  /** Total cap of one prompt. Default DEFAULT_PROMPT_TOTAL_TIMEOUT_MS. */
  promptTotalTimeoutMs?: number;
  apiKey?: string;
  repairsDir?: string;
}): PiSupervisorSession {
  const { session, modelRuntime, agentDir, promptTimeoutMs } = args;
  const promptTotalTimeoutMs = args.promptTotalTimeoutMs ?? DEFAULT_PROMPT_TOTAL_TIMEOUT_MS;
  let closed = false;
  let provider = args.provider;
  let modelId = args.modelId;
  let codingRoot: string | undefined;
  let turns = 0;
  let lastReply: ProviderFailure | undefined;
  /** The last completed prompt's own user message and single reply, while it can still be omitted. */
  let lastExchange: { user: unknown; reply: unknown } | undefined;

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
      if (!(await settleIdle(session, settleTimeoutMs(promptTimeoutMs)))) {
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
      await session.setModel(supervisorSessionModel(model), { persist: false });
      // Reset every switch, even to the session's own current level: a prior
      // model may have required thinking enabled, and the new one may reject
      // it just as strictly as this one rejected "off".
      session.setThinkingLevel(ref.thinkingLevel ?? "off", { persist: false });
      provider = ref.provider;
      modelId = ref.modelId;
    },
    async prompt(text, promptOptions) {
      if (closed) {
        throw new Error("supervisor session is closed");
      }
      // An earlier abort may not have settled; never overlap provider requests.
      if (!(await settleIdle(session, settleTimeoutMs(promptTimeoutMs)))) {
        throw new Error(STILL_ACTIVE);
      }
      const totalMs = promptOptions?.timeoutMs ?? promptTotalTimeoutMs;
      const inactivityMs = promptTimeoutMs;
      const baseMaxTurns = promptOptions?.maxTurns;
      const reserved = () => Math.max(0, promptOptions?.reservedTurns?.() ?? 0);
      // The cap as it stands now: a reviewer's calls during this prompt count against it.
      const turnCap = () => (baseMaxTurns === undefined ? undefined : baseMaxTurns - reserved());
      let promptTurns = 0;
      let turnCapHit = false;
      let endedDone = false;
      let collected: string[] = [];
      let lastAssistant: Parameters<typeof classifyAssistantMessage>[0] | undefined;
      let promptUser: unknown;
      lastReply = undefined;
      lastExchange = undefined;

      // Two limits, neither of which cuts off a model that is still producing
      // output: inactivity (no session event for `inactivityMs`, re-armed by
      // every event, paused while a local tool runs) and a total cap.
      let timedOut: string | undefined;
      let toolsRunning = 0;
      let inactivity: ReturnType<typeof setTimeout> | undefined;
      const expire = (why: string) => {
        if (timedOut !== undefined) return;
        timedOut = why;
        clearTimeout(inactivity);
        session.abortCompaction();
        void session.abort().catch(() => undefined);
      };
      const armInactivity = () => {
        clearTimeout(inactivity);
        inactivity =
          timedOut === undefined && toolsRunning === 0
            ? setTimeout(() => expire(`no output for ${seconds(inactivityMs)}`), inactivityMs)
            : undefined;
      };

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") toolsRunning += 1;
        else if (event.type === "tool_execution_end") toolsRunning = Math.max(0, toolsRunning - 1);
        armInactivity();
        if (event.type === "message_end" && event.message.role === "assistant") {
          lastAssistant = event.message;
        } else if (event.type === "message_end" && event.message.role === "user") {
          promptUser ??= event.message;
        } else if (event.type === "compaction_start") {
          // Compaction (manual or Pi's own) makes summarization requests outside
          // turn_start, so charge them here. Pi emits this synchronously after
          // arming its abort controller and before any request, so aborting
          // here sends nothing.
          const compactionCap = turnCap();
          if (compactionCap !== undefined && promptTurns + COMPACTION_PROVIDER_CALLS > compactionCap) {
            session.abortCompaction();
            return;
          }
          promptTurns += COMPACTION_PROVIDER_CALLS;
          turns += COMPACTION_PROVIDER_CALLS;
        } else if (event.type === "turn_start") {
          // Pi awaits listeners before streaming, so aborting here cancels the
          // turn before its provider request is sent. Pi ends a tool batch on
          // its own only when every result in it terminates, so a batch that
          // pairs record_finding with an admitted action would otherwise go
          // back to the model for a reply nobody reads.
          if (endedDone || promptOptions?.done?.() === true) {
            endedDone = true;
            void session.abort().catch(() => undefined);
            return;
          }
          const cap = turnCap();
          if (cap !== undefined && promptTurns >= cap) {
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

      armInactivity();
      const total = setTimeout(() => expire(`no complete reply within ${seconds(totalMs)}`), totalMs);
      const onOuterAbort = () => {
        void session.abort().catch(() => undefined);
      };
      promptOptions?.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (promptOptions?.tools !== undefined) setSessionTools(session, promptOptions.tools);

      try {
        if (promptOptions?.signal?.aborted) {
          throw new Error("supervisor prompt aborted");
        }
        await compactBeforePrompt(session, text);
        // A timeout during that compaction must not still send the prompt.
        if (timedOut === undefined) {
          try {
            await session.prompt(text);
          } catch (err) {
            // However Pi surfaces the abort a limit caused, it is that timeout
            // (or the done() end, which is no failure).
            if (timedOut === undefined && !endedDone) throw err;
          }
        }
        // Follow-up work may keep the session busy after prompt() returns;
        // the same two limits bound it.
        while (!session.isIdle && timedOut === undefined && promptOptions?.signal?.aborted !== true) {
          await sleep(25);
        }
        if (promptOptions?.signal?.aborted) {
          throw new Error(
            (await settleIdle(session, settleTimeoutMs(promptTimeoutMs))) ? "supervisor prompt aborted" : `supervisor prompt aborted; ${STILL_ACTIVE}`,
          );
        }
        if (endedDone) {
          // The abort that ended the turn is ours; let it settle so the next
          // prompt finds the session idle, and report the reply already read.
          if (!(await settleIdle(session, settleTimeoutMs(promptTimeoutMs)))) throw new Error(STILL_ACTIVE);
          return collected.join("").trim();
        }
        if (turnCapHit) {
          throw new Error(`supervisor prompt exceeded its ${turnCap() ?? baseMaxTurns}-turn allowance`);
        }
        if (timedOut !== undefined || !session.isIdle) {
          const settled = await settleIdle(session, settleTimeoutMs(promptTimeoutMs));
          throw new SupervisorProviderError({
            failureClass: "timeout",
            message: (timedOut ?? "the session did not settle") + (settled ? "" : `; ${STILL_ACTIVE}`),
          });
        }
        const contextWindow = session.model?.contextWindow;
        lastReply =
          lastAssistant !== undefined
            ? classifyAssistantMessage(lastAssistant, contextWindow !== undefined ? { contextWindow } : {})
            : undefined;
        if (promptTurns === 1 && promptUser !== undefined && lastAssistant !== undefined) {
          lastExchange = { user: promptUser, reply: lastAssistant };
        }
        return collected.join("").trim();
      } finally {
        clearTimeout(total);
        clearTimeout(inactivity);
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
    peekTurnCount() {
      return turns;
    },
    lastReplyFailure() {
      return lastReply;
    },
    omitLastExchange() {
      const exchange = lastExchange;
      lastExchange = undefined;
      if (closed || exchange === undefined || !session.isIdle) return false;
      const messages = session.messages;
      if (messages.at(-1) !== exchange.reply) return false;
      try {
        asRecoverableSession(session)._omitRecoveryAttempt(exchange.reply, [exchange.user]);
      } catch {
        return false;
      }
      lastReply = undefined;
      return !session.messages.includes(exchange.reply as never) && !session.messages.includes(exchange.user as never);
    },
    async compact(compactOptions) {
      if (closed) {
        throw new Error("supervisor session is closed");
      }
      const signal = compactOptions?.signal;
      if (signal?.aborted) throw new Error("supervisor compaction aborted");
      if (!(await settleIdle(session, settleTimeoutMs(promptTimeoutMs)))) {
        throw new Error(STILL_ACTIVE);
      }
      const timeoutMs = compactOptions?.timeoutMs ?? promptTimeoutMs;
      // Charged before the request: a compaction that fails still spent its calls.
      turns += COMPACTION_PROVIDER_CALLS;
      // Stop and the deadline both cancel Pi's summarization request; the
      // race also releases the caller when a provider ignores the abort.
      let cancel: (reason: Error) => void = () => undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = reject;
      });
      const stop = (reason: Error) => {
        session.abortCompaction();
        cancel(reason);
      };
      const onAbort = () => stop(new Error("supervisor compaction aborted"));
      const timer = setTimeout(() => stop(new Error(`supervisor compaction timed out after ${timeoutMs}ms`)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([session.compact(), cancelled]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
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
 * Pi AgentSession's own omission of a failed attempt (what its auto-retry
 * uses): appends a durable `context_edit` that hides each message from the
 * model's context while the raw transcript keeps it, then refreshes state.
 */
interface RecoverableSession {
  _omitRecoveryAttempt(message: unknown, toolResults?: unknown[]): void;
}

function asRecoverableSession(session: AgentSession): RecoverableSession {
  return session as unknown as RecoverableSession;
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

/**
 * Provider requests one compaction may make: a history summary plus, when the
 * cut splits a turn, a summary of that turn's prefix. Charged as the upper
 * bound, since an undercount would break the finite budget.
 */
const COMPACTION_PROVIDER_CALLS = 2;
/** Fraction of the model's context window a prompt may fill before the session is compacted first. */
const PROACTIVE_COMPACTION_FRACTION = 0.7;
/** Pessimistic characters per token, so a large prompt is never underestimated. */
const CHARS_PER_TOKEN = 3;

/**
 * Pi compacts on its own only after a response reports usage or after a
 * provider overflow error, and the overflow retry resends the same oversized
 * prompt. A long recovery session whose next prompt (a large run view) tips
 * it past the window therefore hard-fails, so compact before sending when
 * the known context plus this prompt would cross the fraction above.
 */
export async function compactBeforePrompt(session: AgentSession, text: string): Promise<void> {
  const usage = session.getContextUsage();
  if (usage?.tokens == null || !(usage.contextWindow > 0)) return;
  const projected = usage.tokens + Math.ceil(text.length / CHARS_PER_TOKEN);
  if (projected <= usage.contextWindow * PROACTIVE_COMPACTION_FRACTION) return;
  // A compaction refused by the turn allowance, or one that fails, still lets
  // the prompt go out: the provider's own overflow error is then the failure
  // the caller sees, not a compaction error that hides it.
  await session.compact().catch(() => undefined);
}

const STILL_ACTIVE = "supervisor session still active after abort; refusing to reuse it";

/** Abort any active request and wait briefly for idle; false if it never settled. */
async function settleIdle(session: AgentSession, timeoutMs: number): Promise<boolean> {
  if (session.isIdle) return true;
  await session.abort().catch(() => undefined);
  const settleDeadline = Date.now() + timeoutMs;
  while (!session.isIdle && Date.now() < settleDeadline) {
    await sleep(25);
  }
  return session.isIdle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seconds(ms: number): string {
  return ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

/** The settle wait honors the configured prompt timeout, capped at the 5s default. */
function settleTimeoutMs(promptTimeoutMs: number): number {
  return Math.max(0, Math.min(5_000, promptTimeoutMs));
}
