// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRunState, resolveStateDir, type ResumeRequest, type RunRequest } from "@graphloom/controller";
import {
  bindingHarness,
  CLAUDE_CODE_HARNESS,
  createPiHarness,
  restorePiSupervisorFromBinding,
  SUPERVISOR_HARNESS_NAMES,
  type HarnessProbe,
  type PiHarness,
  type SupervisorHarnessName,
  type SupervisorModelRef,
  type ThinkingLevel,
} from "@graphloom/supervisor";
import { claudeHarnessFor, claudeProbeHarness, parseClaudeSupervisorConfig, type ClaudeSupervisorConfig } from "./supervisor-claude.js";

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
  /**
   * The enabled supervisor harnesses in the operator's fallback order
   * (design-supervisor-harnesses.md §7.2); an unlisted harness is forbidden.
   * Absent (the flat Pi form): only `pi`.
   */
  harnesses?: SupervisorHarnessName[];
  /** The harness every run uses, overriding the fallback order. */
  select?: SupervisorHarnessName;
  /** The Claude Code harness's settings (`claude` section). */
  claude?: ClaudeSupervisorConfig;
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

/** Keys of the per-harness form; a file with none of them is the flat Pi form. */
const PER_HARNESS_KEYS = ["harnesses", "select", "pi", "claude", "codex"];
/** Settings every harness shares, at the top level of the per-harness form. */
const SHARED_KEYS = ["promptTimeoutMs", "promptTotalTimeoutMs", "quotaRetryMs"];

/**
 * Parse `supervisor.json`: the flat Pi form, or the per-harness form
 * (design-supervisor-harnesses.md §7.2) with `harnesses`, `select`, and a
 * section per harness (`pi`, `claude`; a `codex` section is kept for later
 * and enables nothing yet). Secrets are refused for every harness.
 */
export function parseSupervisorConfig(value: unknown, source = "supervisor config"): SupervisorConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${source}: expected an object`);
  const obj = value as Record<string, unknown>;
  if (!PER_HARNESS_KEYS.some((k) => k in obj)) return parsePiConfig(obj, source);
  if ("apiKey" in obj) throw new Error(`${source}: apiKey is not accepted; store credentials with Pi or in the provider's environment variable`);
  const shared = Object.fromEntries(SHARED_KEYS.filter((k) => k in obj).map((k) => [k, obj[k]]));
  if (obj.pi !== undefined && (typeof obj.pi !== "object" || obj.pi === null || Array.isArray(obj.pi))) throw new Error(`${source}: pi must be an object`);
  // Without a pi section the Pi fields carry Pi's defaults, but pi is not enabled.
  const pi = parsePiConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", ...((obj.pi as Record<string, unknown> | undefined) ?? {}), ...shared }, `${source}: pi`);
  const claude = obj.claude !== undefined ? parseClaudeSupervisorConfig(obj.claude, source) : undefined;
  const configured: SupervisorHarnessName[] = SUPERVISOR_HARNESS_NAMES.filter((h) =>
    h === "pi" ? obj.pi !== undefined : h === CLAUDE_CODE_HARNESS ? claude !== undefined : obj.codex !== undefined,
  );
  let harnesses = configured;
  if (obj.harnesses !== undefined) {
    if (!Array.isArray(obj.harnesses) || obj.harnesses.length === 0) throw new Error(`${source}: harnesses must be a non-empty array of ${SUPERVISOR_HARNESS_NAMES.join(", ")}`);
    harnesses = [];
    for (const h of obj.harnesses) {
      if (typeof h !== "string" || !(SUPERVISOR_HARNESS_NAMES as readonly string[]).includes(h)) {
        throw new Error(`${source}: harnesses entry ${JSON.stringify(h)} is not one of ${SUPERVISOR_HARNESS_NAMES.join(", ")}`);
      }
      if (!harnesses.includes(h as SupervisorHarnessName)) harnesses.push(h as SupervisorHarnessName);
    }
  }
  const config: SupervisorConfig = { ...pi, harnesses };
  if (claude !== undefined) config.claude = claude;
  if (obj.select !== undefined) {
    if (typeof obj.select !== "string" || !(harnesses as string[]).includes(obj.select)) {
      throw new Error(`${source}: select must be one of the enabled harnesses (${harnesses.join(", ")})`);
    }
    config.select = obj.select as SupervisorHarnessName;
  }
  return config;
}

/** The flat Pi form (also the `pi` section of the per-harness form). */
function parsePiConfig(obj: Record<string, unknown>, source: string): Omit<SupervisorConfig, "harnesses"> {
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
  const config: Omit<SupervisorConfig, "harnesses"> = { provider, modelId, models };
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

/** The harnesses `config` enables, in the operator's order (the flat Pi form: `pi`). */
export function enabledSupervisorHarnesses(config: SupervisorConfig): SupervisorHarnessName[] {
  return config.harnesses ?? ["pi"];
}

/** How a run's supervisor harness was chosen (§7.3; the plugin's preference comes with S5). */
export interface SupervisorSelection {
  harness: SupervisorHarnessName;
  source: "flag" | "operator" | "fallback";
  reason: string;
}

/** Whether `harness` can run here, with no provider call (§7.3 "available"). */
export async function probeSupervisorHarness(config: SupervisorConfig, harness: SupervisorHarnessName): Promise<HarnessProbe> {
  if (harness === "pi") {
    return createPiHarness({
      runId: "probe",
      sessionDir: path.join(os.tmpdir(), "graphloom-pi-probe"),
      configuredModels: config.models,
      ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
    }).probe();
  }
  if (harness === CLAUDE_CODE_HARNESS) return claudeProbeHarness(config.claude).probe();
  return { ok: false, reason: `the ${harness} supervisor harness is not available in this GraphLoom yet` };
}

/**
 * The run's supervisor harness (design-supervisor-harnesses.md §7.3): the
 * `--supervisor` flag, then `select`, each of which must be enabled and
 * available or the run is refused; otherwise the first enabled harness that
 * is available, in the operator's order. The flat Pi form keeps Pi unprobed,
 * as before harnesses. Undefined when no harness is available.
 */
export async function selectSupervisorHarness(
  config: SupervisorConfig,
  options: { flag?: string; probe?: (harness: SupervisorHarnessName) => Promise<HarnessProbe> } = {},
): Promise<SupervisorSelection | undefined> {
  const enabled = enabledSupervisorHarnesses(config);
  const probe = options.probe ?? ((h: SupervisorHarnessName) => probeSupervisorHarness(config, h));
  const required = async (name: string, what: string, source: SupervisorSelection["source"]): Promise<SupervisorSelection> => {
    if (!(enabled as string[]).includes(name)) {
      throw new Error(`supervisor: ${what} ${name} is not enabled in the operator's supervisor config (enabled: ${enabled.join(", ")})`);
    }
    const available = await probe(name as SupervisorHarnessName);
    if (!available.ok) throw new Error(`supervisor: ${what} ${name} is not available: ${available.reason}`);
    return { harness: name as SupervisorHarnessName, source, reason: `${what} ${name}` };
  };
  if (options.flag !== undefined) return required(options.flag, "--supervisor", "flag");
  if (config.select !== undefined) return required(config.select, "select", "operator");
  if (config.harnesses === undefined) return { harness: "pi", source: "operator", reason: "the operator's Pi supervisor config" };
  const unavailable: string[] = [];
  for (const harness of enabled) {
    const available = await probe(harness);
    if (available.ok) {
      return {
        harness,
        source: "fallback",
        reason: unavailable.length === 0 ? `the first enabled harness, ${harness}` : `${harness}, the first enabled harness available (${unavailable.join("; ")})`,
      };
    }
    unavailable.push(`${harness}: ${available.reason}`);
  }
  console.error(`supervisor: no enabled harness is available, so this run has no supervisor (${unavailable.join("; ")})`);
  return undefined;
}

/**
 * The harness a resuming run's supervisor runs on: the one its binding is
 * pinned to, or, for a run whose supervisor never ran, the selection
 * `selectSupervisorHarness` makes now.
 */
export async function resumeSupervisorHarness(
  config: SupervisorConfig,
  runRef: string,
  stateRoot: string | undefined,
): Promise<SupervisorHarnessName | undefined> {
  const state = await loadRunState(await resolveStateDir(runRef, stateRoot));
  const binding = state.supervisorBinding;
  if (binding?.sessionFile !== undefined) {
    const pinned = bindingHarness(binding);
    return (SUPERVISOR_HARNESS_NAMES as readonly string[]).includes(pinned) ? (pinned as SupervisorHarnessName) : undefined;
  }
  return (await selectSupervisorHarness(config))?.harness;
}

/** A fresh supervisor on `harness` for a new run. */
export function supervisorFactoryFor(config: SupervisorConfig, harness: SupervisorHarnessName): NonNullable<RunRequest["supervisorFactory"]> {
  if (harness === "pi") return piSupervisorFactory(config);
  if (harness === CLAUDE_CODE_HARNESS) {
    return async ({ runId, stateDir }) => (await claudeHarnessFor(config.claude, config, runId, stateDir)).start();
  }
  throw new Error(`the ${harness} supervisor harness is not available in this GraphLoom yet`);
}

/**
 * Restore the run's logical supervisor on the harness its binding is pinned
 * to (a binding without one was recorded by Pi), on its bound model, with the
 * operator's current model list. The first episode after resume starts a
 * fresh session; earlier transcripts stay on disk but are never reopened.
 * Without an operator config a Pi binding restores on Pi's defaults, with its
 * credential from the environment or Pi's own store, as before harnesses, and
 * a Claude Code binding on Claude Code's defaults. A per-harness config that
 * no longer enables the pinned harness, or a pinned CLI harness that is not
 * available, stops the resume: nothing falls back to another harness (§7.4).
 */
export function supervisorRestore(config: SupervisorConfig | undefined): NonNullable<ResumeRequest["restoreSupervisor"]> {
  return async (binding, { runId, stateDir }) => {
    const harness = bindingHarness(binding);
    const enabled = config !== undefined ? enabledSupervisorHarnesses(config) : undefined;
    if (enabled !== undefined && !(enabled as string[]).includes(harness)) {
      throw new Error(
        `supervisor harness pin mismatch: this run's supervisor is pinned to the ${harness} harness, which the operator's supervisor config does not enable (enabled: ${enabled.join(", ")}); enable it again to resume`,
      );
    }
    if (harness === CLAUDE_CODE_HARNESS) {
      const claude = await claudeHarnessFor(config?.claude, config ?? {}, runId, stateDir);
      const available = await claude.probe();
      if (!available.ok) {
        throw new Error(`supervisor harness pin mismatch: this run's supervisor is pinned to ${harness}, which is not available here: ${available.reason}`);
      }
      return claude.restore({ ...binding, sessionFile: binding.sessionFile, harness });
    }
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
