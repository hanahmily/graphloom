// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResumeRequest, RunRequest } from "@graphloom/controller";
import {
  bindingHarness,
  createPiHarness,
  restorePiSupervisorFromBinding,
  type PiHarness,
  type SupervisorModelRef,
  type ThinkingLevel,
} from "@graphloom/supervisor";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Operator-owned supervisor settings. Credentials never live here: Pi resolves
 * them from its agent dir or the provider's environment variable.
 */
export interface SupervisorConfig {
  provider: string;
  modelId: string;
  /** Reasoning level for `provider`/`modelId`; omit for the "off" default. */
  thinkingLevel?: ThinkingLevel;
  /** Every model the supervisor may switch to, including the initial one. */
  models: SupervisorModelRef[];
  agentDir?: string;
  /**
   * Inactivity limit of one supervisor prompt: it is aborted as a provider
   * timeout once no output (stream delta, tool call, turn) has arrived for
   * this long. A model that is still streaming is never cut off by it.
   * Default 120000 (DEFAULT_PROMPT_INACTIVITY_MS).
   */
  promptTimeoutMs?: number;
  /**
   * Total cap of one supervisor prompt however steadily it streams, a
   * backstop behind `promptTimeoutMs`. Default 900000 (DEFAULT_PROMPT_TOTAL_TIMEOUT_MS).
   */
  promptTotalTimeoutMs?: number;
  /**
   * Record every supervisor provider request and its raw response under
   * `<stateDir>/supervisor/raw/` (one JSON line per request; request headers,
   * which carry credentials, are never written). Off by default; turn it on to
   * see where a model's output went when its recorded message lacks it.
   */
  rawStreamCapture?: boolean;
  /**
   * Fixed wait before retrying a provider quota error that states no reset
   * time (MiniMax's 429 `(2056)` gives none). Still bounded by the run's
   * `waitMs` budget and the per-turn wait limit. Omitted: such errors stop.
   */
  quotaRetryMs?: number;
}

export function supervisorConfigPath(env: NodeJS.ProcessEnv = process.env): { file: string; explicit: boolean } {
  const explicit = env.GRAPHLOOM_SUPERVISOR_CONFIG;
  if (explicit !== undefined && explicit !== "") return { file: path.resolve(explicit), explicit: true };
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return { file: path.join(home, ".config", "graphloom", "supervisor.json"), explicit: false };
}

/** Without a config file (at the default path) runs have no supervisor. */
export async function loadSupervisorConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupervisorConfig | undefined> {
  const { file, explicit } = supervisorConfigPath(env);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return undefined;
    throw new Error(`cannot read supervisor config ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSupervisorConfig(JSON.parse(raw) as unknown, file);
}

export function parseSupervisorConfig(value: unknown, source = "supervisor config"): SupervisorConfig {
  if (typeof value !== "object" || value === null) throw new Error(`${source}: expected an object`);
  const obj = value as Record<string, unknown>;
  if ("apiKey" in obj) {
    throw new Error(`${source}: apiKey is not accepted; store credentials with Pi or in the provider's environment variable`);
  }
  const provider = requireString(obj.provider, `${source}: provider`);
  const modelId = requireString(obj.modelId, `${source}: modelId`);
  const thinkingLevel =
    obj.thinkingLevel !== undefined ? parseThinkingLevel(obj.thinkingLevel, `${source}: thinkingLevel`) : undefined;
  const listed = obj.models === undefined ? [] : obj.models;
  if (!Array.isArray(listed)) {
    throw new Error(`${source}: models must be an array of "provider/model" strings or {provider, modelId, thinkingLevel?} objects`);
  }
  const models: SupervisorModelRef[] = [{ provider, modelId, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }];
  for (const entry of listed) {
    const ref = parseModelRefEntry(entry, `${source}: models entry`);
    if (!models.some((m) => m.provider === ref.provider && m.modelId === ref.modelId)) models.push(ref);
  }
  const config: SupervisorConfig = { provider, modelId, models };
  if (thinkingLevel !== undefined) config.thinkingLevel = thinkingLevel;
  if (obj.agentDir !== undefined) config.agentDir = expandHome(requireString(obj.agentDir, `${source}: agentDir`));
  if (obj.promptTimeoutMs !== undefined) {
    if (typeof obj.promptTimeoutMs !== "number" || !(obj.promptTimeoutMs > 0)) {
      throw new Error(`${source}: promptTimeoutMs must be a positive number`);
    }
    config.promptTimeoutMs = obj.promptTimeoutMs;
  }
  if (obj.rawStreamCapture !== undefined) {
    if (typeof obj.rawStreamCapture !== "boolean") throw new Error(`${source}: rawStreamCapture must be a boolean`);
    config.rawStreamCapture = obj.rawStreamCapture;
  }
  if (obj.promptTotalTimeoutMs !== undefined) {
    if (typeof obj.promptTotalTimeoutMs !== "number" || !Number.isFinite(obj.promptTotalTimeoutMs) || !(obj.promptTotalTimeoutMs > 0)) {
      throw new Error(`${source}: promptTotalTimeoutMs must be a positive number`);
    }
    config.promptTotalTimeoutMs = obj.promptTotalTimeoutMs;
  }
  if (obj.quotaRetryMs !== undefined) {
    if (typeof obj.quotaRetryMs !== "number" || !Number.isFinite(obj.quotaRetryMs) || !(obj.quotaRetryMs > 0)) {
      throw new Error(`${source}: quotaRetryMs must be a positive number`);
    }
    config.quotaRetryMs = obj.quotaRetryMs;
  }
  return config;
}

/** `provider/model`; the model id may itself contain slashes. */
export function parseModelRef(text: string): SupervisorModelRef {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`expected provider/model, got "${text}"`);
  }
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

/** A `models` array entry: a plain "provider/model" string, or an object naming its own thinkingLevel. */
function parseModelRefEntry(entry: unknown, what: string): SupervisorModelRef {
  if (typeof entry === "string") return parseModelRef(entry);
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${what} must be a "provider/model" string or {provider, modelId, thinkingLevel?} object`);
  }
  const obj = entry as Record<string, unknown>;
  const ref = parseModelRef(`${requireString(obj.provider, `${what}: provider`)}/${requireString(obj.modelId, `${what}: modelId`)}`);
  if (obj.thinkingLevel !== undefined) ref.thinkingLevel = parseThinkingLevel(obj.thinkingLevel, `${what}: thinkingLevel`);
  return ref;
}

function parseThinkingLevel(value: unknown, what: string): ThinkingLevel {
  const text = requireString(value, what);
  if (!(THINKING_LEVELS as readonly string[]).includes(text)) {
    throw new Error(`${what} must be one of ${THINKING_LEVELS.join(", ")}, got "${text}"`);
  }
  return text as ThinkingLevel;
}

/** The Pi harness for one run, its transcripts in the run's state directory. */
function piHarnessFor(config: SupervisorConfig, runId: string, stateDir: string): PiHarness {
  return createPiHarness({
    runId,
    sessionDir: path.join(stateDir, "supervisor"),
    repairsDir: path.join(stateDir, "repairs"),
    configuredModels: config.models,
    ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
    ...(config.promptTimeoutMs !== undefined ? { promptTimeoutMs: config.promptTimeoutMs } : {}),
    ...(config.promptTotalTimeoutMs !== undefined ? { promptTotalTimeoutMs: config.promptTotalTimeoutMs } : {}),
    ...(config.rawStreamCapture === true ? { rawStreamCapture: true } : {}),
    ...(config.quotaRetryMs !== undefined ? { quotaRetryMs: config.quotaRetryMs } : {}),
  });
}

/**
 * A fresh Pi supervisor whose transcripts live in the run's state directory,
 * one Pi session per recovery episode.
 */
export function piSupervisorFactory(config: SupervisorConfig): NonNullable<RunRequest["supervisorFactory"]> {
  return async ({ runId, stateDir }) => piHarnessFor(config, runId, stateDir).start();
}

/**
 * Restore the run's logical supervisor on the harness its binding is pinned
 * to (a binding without one was recorded by Pi), on its bound model, with the
 * operator's current model list. The first episode after resume starts a
 * fresh session; earlier transcripts stay on disk but are never reopened.
 * Without an operator config a Pi binding restores on Pi's defaults, with its
 * credential from the environment or Pi's own store, as before harnesses.
 */
export function supervisorRestore(config: SupervisorConfig | undefined): NonNullable<ResumeRequest["restoreSupervisor"]> {
  return async (binding, { runId, stateDir }) => {
    const harness = bindingHarness(binding);
    if (harness !== "pi") {
      throw new Error(`this run's supervisor is pinned to the ${harness} harness, which this GraphLoom cannot run`);
    }
    const restored = { ...binding, sessionFile: binding.sessionFile, harness };
    if (config === undefined) {
      return restorePiSupervisorFromBinding({
        runId,
        binding: restored,
        ...(binding.sessionFile !== undefined ? { sessionDir: path.dirname(binding.sessionFile) } : {}),
        repairsDir: path.join(stateDir, "repairs"),
      });
    }
    // The operator's current models take precedence over those the binding recorded.
    return piHarnessFor(config, runId, stateDir).restore(restored);
  };
}

/** The Pi restore with the operator's config (see supervisorRestore). */
export function piSupervisorRestore(config: SupervisorConfig): NonNullable<ResumeRequest["restoreSupervisor"]> {
  return supervisorRestore(config);
}

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return value;
}
