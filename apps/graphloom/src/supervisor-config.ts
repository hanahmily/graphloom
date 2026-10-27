// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pinnedSupervisorHarness, type DurableRunState, type ResumeRequest, type RunRequest, type SupervisorFactory, type SupervisorPinRequest } from "@graphloom/controller";
import type { SupervisorPreference } from "@graphloom/sdk";
import {
  bindingHarness,
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  createPiHarness,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SUPERVISOR_PROVIDER,
  restorePiSupervisorFromBinding,
  SUPERVISOR_HARNESS_NAMES,
  type HarnessProbe,
  type HarnessStartOptions,
  type PiHarness,
  type SupervisorHarnessName,
  type SupervisorModelRef,
  type ThinkingLevel,
} from "@graphloom/supervisor";
import { claudeHarnessFor, claudeProbeHarness, parseClaudeSupervisorConfig, type ClaudeSupervisorConfig } from "./supervisor-claude.js";
import { codexHarnessFor, codexProbeHarness, parseCodexSupervisorConfig, type CodexSupervisorConfig } from "./supervisor-codex.js";
import { harnessRepairDeps } from "./repair-config.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Operator-owned supervisor settings. The Pi model is any `<provider>/<modelId>`
 * in Pi's registry: a provider Pi ships (anthropic, openai, google, deepseek,
 * moonshotai, minimax-cn, ...) or a custom one in the agent dir's models.json.
 * Credentials never live here: Pi resolves them from its agent dir (auth.json,
 * models.json) or the provider's environment variable.
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
   * time (a 429 without Retry-After, or MiniMax's `(2056)`, gives none). Still bounded by the run's
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
  /** The Codex harness's settings (`codex` section). */
  codex?: CodexSupervisorConfig;
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
 * section per harness (`pi`, `claude`, `codex`). Secrets are refused for
 * every harness.
 */
export function parseSupervisorConfig(value: unknown, source = "supervisor config"): SupervisorConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${source}: expected an object`);
  const obj = value as Record<string, unknown>;
  if (!PER_HARNESS_KEYS.some((k) => k in obj)) return parsePiConfig(obj, source);
  if ("apiKey" in obj) throw new Error(`${source}: apiKey is not accepted; store credentials with Pi or in the provider's environment variable`);
  const shared = Object.fromEntries(SHARED_KEYS.filter((k) => k in obj).map((k) => [k, obj[k]]));
  if (obj.pi !== undefined && (typeof obj.pi !== "object" || obj.pi === null || Array.isArray(obj.pi))) throw new Error(`${source}: pi must be an object`);
  // Without a pi section the Pi fields carry Pi's defaults, but pi is not enabled.
  const pi = parsePiConfig({ provider: DEFAULT_SUPERVISOR_PROVIDER, modelId: DEFAULT_SUPERVISOR_MODEL, ...((obj.pi as Record<string, unknown> | undefined) ?? {}), ...shared }, `${source}: pi`);
  const claude = obj.claude !== undefined ? parseClaudeSupervisorConfig(obj.claude, source) : undefined;
  const codex = obj.codex !== undefined ? parseCodexSupervisorConfig(obj.codex, source) : undefined;
  const configured: SupervisorHarnessName[] = SUPERVISOR_HARNESS_NAMES.filter((h) =>
    h === "pi" ? obj.pi !== undefined : h === CLAUDE_CODE_HARNESS ? claude !== undefined : codex !== undefined,
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
  if (codex !== undefined) config.codex = codex;
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
export function piSupervisorFactory(config: SupervisorConfig): SupervisorFactory {
  return async ({ runId, stateDir, continueSession }) => piHarnessFor(config, runId, stateDir).start(startOptions(continueSession));
}

/** A harness's start on a run whose pin moved to it: the same logical session and switch journal (§7.4). */
function startOptions(continueSession: Parameters<SupervisorFactory>[0]["continueSession"]): HarnessStartOptions {
  return continueSession !== undefined ? { logicalSessionId: continueSession.sessionId, switchJournal: continueSession.switchJournal } : {};
}

/** The harnesses `config` enables, in the operator's order (the flat Pi form: `pi`). */
export function enabledSupervisorHarnesses(config: SupervisorConfig): SupervisorHarnessName[] {
  return config.harnesses ?? ["pi"];
}

/** How a run's supervisor harness was chosen (design-supervisor-harnesses.md §7.3). */
export interface SupervisorSelection {
  harness: SupervisorHarnessName;
  source: "flag" | "operator" | "plugin" | "fallback";
  reason: string;
}

/** What selection resolved: a harness, or why there is none, and the plugin's model hints that were ignored. */
export interface SupervisorSelectionOutcome {
  selection?: SupervisorSelection;
  /** Why the run has no supervisor (no enabled harness is available). */
  none?: string;
  /** Plugin model hints the operator did not configure, so they are ignored (§7.2), and other notes for `check`. */
  warnings: string[];
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
  if (harness === CODEX_HARNESS) return codexProbeHarness(config.codex).probe();
  return { ok: false, reason: `the ${harness} supervisor harness is not available in this GraphLoom` };
}

const isHarnessName = (h: string): h is SupervisorHarnessName => (SUPERVISOR_HARNESS_NAMES as readonly string[]).includes(h);

/**
 * The run's supervisor harness (design-supervisor-harnesses.md §7.3), from
 * probes already taken; the one function `run`, `resume`, `check`, and
 * `doctor --task` share. The first rule that applies wins:
 *
 * 1. `flag` (`run`/`resume --supervisor`), then 2. the operator's `select`:
 *    each must be enabled and available, or the run is refused (a throw).
 * 3. The plugin's `harnesses`, in its order: the first the operator enabled
 *    that is available.
 * 4. None of them: with the plugin's `required`, the run is refused; else the
 *    first enabled harness available in the operator's order, with the reason.
 * 5. No harness available: no supervisor (`none`).
 *
 * The flat Pi form enables Pi alone and keeps it unprobed, as before
 * harnesses: `probe` is asked about it only for a `--supervisor pi`.
 */
export function resolveSupervisorSelection(
  config: SupervisorConfig,
  probe: (harness: SupervisorHarnessName) => HarnessProbe,
  options: { flag?: string; preference?: SupervisorPreference } = {},
): SupervisorSelectionOutcome {
  const enabled = enabledSupervisorHarnesses(config);
  const flat = config.harnesses === undefined;
  const available = (h: SupervisorHarnessName): HarnessProbe => (flat && h === "pi" ? { ok: true } : probe(h));
  const preference = options.preference;
  const warnings = preference !== undefined ? ignoredModelHints(config, preference) : [];
  const required = (name: string, what: string, source: SupervisorSelection["source"]): SupervisorSelectionOutcome => {
    if (!(enabled as string[]).includes(name)) {
      throw new Error(`supervisor: ${what} ${name} is not enabled in the operator's supervisor config (enabled: ${enabled.join(", ")})`);
    }
    const probed = probe(name as SupervisorHarnessName);
    if (!probed.ok) throw new Error(`supervisor: ${what} ${name} is not available: ${probed.reason}`);
    return { selection: { harness: name as SupervisorHarnessName, source, reason: `${what} ${name}` }, warnings };
  };
  if (options.flag !== undefined) return required(options.flag, "--supervisor", "flag");
  if (config.select !== undefined) return required(config.select, "select", "operator");
  let passed = "";
  if (preference !== undefined) {
    const skipped: string[] = [];
    for (const h of preference.harnesses) {
      if (!isHarnessName(h)) {
        skipped.push(`${h}: not a harness this GraphLoom runs`);
        continue;
      }
      if (!(enabled as string[]).includes(h)) {
        skipped.push(`${h}: not enabled by the operator`);
        continue;
      }
      const probed = available(h);
      if (probed.ok) {
        const order = preference.harnesses.join(", ");
        return {
          selection: { harness: h, source: "plugin", reason: `the plugin's preference (${order}): ${h}${skipped.length > 0 ? ` (${skipped.join("; ")})` : ""}` },
          warnings,
        };
      }
      skipped.push(`${h}: ${probed.reason}`);
    }
    const usable = enabled.filter((h) => available(h).ok);
    if (preference.required === true) {
      throw new Error(`supervisor: plugin requires one of ${preference.harnesses.join(", ")}; enabled and available: ${usable.length > 0 ? usable.join(", ") : "none"} (${skipped.join("; ")})`);
    }
    passed = `none of the plugin's harnesses (${preference.harnesses.join(", ")}) is enabled and available (${skipped.join("; ")}), so the operator's order applies: `;
  }
  if (flat) return { selection: { harness: "pi", source: preference !== undefined ? "fallback" : "operator", reason: `${passed}the operator's Pi supervisor config` }, warnings };
  const unavailable: string[] = [];
  for (const harness of enabled) {
    const probed = available(harness);
    if (probed.ok) {
      return {
        selection: {
          harness,
          source: "fallback",
          reason: `${passed}${unavailable.length === 0 ? `the first enabled harness, ${harness}` : `${harness}, the first enabled harness available (${unavailable.join("; ")})`}`,
        },
        warnings,
      };
    }
    unavailable.push(`${harness}: ${probed.reason}`);
  }
  return { none: `no enabled harness is available (${unavailable.join("; ")})`, warnings };
}

/**
 * The run's supervisor harness, probing every harness `config` enables (and
 * the flag's) first: `resolveSupervisorSelection` on those probes.
 * Undefined when no harness is available.
 */
export async function selectSupervisorHarness(
  config: SupervisorConfig,
  options: { flag?: string; preference?: SupervisorPreference; probe?: (harness: SupervisorHarnessName) => Promise<HarnessProbe>; onNone?: (why: string) => void } = {},
): Promise<SupervisorSelection | undefined> {
  const outcome = await supervisorSelectionOutcome(config, options);
  if (outcome.selection === undefined) {
    (options.onNone ?? ((why: string) => console.error(`supervisor: ${why}, so this run has no supervisor`)))(outcome.none ?? "no harness is available");
  }
  return outcome.selection;
}

/** `resolveSupervisorSelection` after probing what it may ask about; throws as it does. */
export async function supervisorSelectionOutcome(
  config: SupervisorConfig,
  options: { flag?: string; preference?: SupervisorPreference; probe?: (harness: SupervisorHarnessName) => Promise<HarnessProbe> } = {},
): Promise<SupervisorSelectionOutcome> {
  const probe = options.probe ?? ((h: SupervisorHarnessName) => probeSupervisorHarness(config, h));
  const enabled = enabledSupervisorHarnesses(config);
  // A flag or select decides alone, and is probed even in the flat Pi form; otherwise every enabled harness may be asked about.
  const named = options.flag ?? config.select;
  const wanted = new Set<SupervisorHarnessName>(
    named !== undefined ? (enabled as string[]).filter((h) => h === named) as SupervisorHarnessName[] : config.harnesses === undefined ? [] : enabled,
  );
  const probes = new Map<SupervisorHarnessName, HarnessProbe>();
  await Promise.all(
    [...wanted].map(async (h) => {
      probes.set(h, await probe(h).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) })));
    }),
  );
  const flag = options.flag;
  return resolveSupervisorSelection(config, (h) => probes.get(h) ?? { ok: false, reason: "not probed" }, {
    ...(flag !== undefined ? { flag } : {}),
    ...(options.preference !== undefined ? { preference: options.preference } : {}),
  });
}

/** A plugin model hint for `harness`, as that harness's config names its models. */
function hintRef(harness: SupervisorHarnessName, hint: string): { provider?: string; modelId: string } {
  if (harness === "pi") {
    const slash = hint.indexOf("/");
    return slash > 0 ? { provider: hint.slice(0, slash), modelId: hint.slice(slash + 1) } : { modelId: hint };
  }
  return { modelId: hint.startsWith(`${harness}/`) ? hint.slice(harness.length + 1) : hint };
}

/** The models the operator configured for `harness`, in order (the parser's defaults when its section is absent). */
export function harnessModels(config: SupervisorConfig, harness: SupervisorHarnessName): SupervisorModelRef[] {
  if (harness === "pi") return config.models;
  if (harness === CLAUDE_CODE_HARNESS) return (config.claude ?? parseClaudeSupervisorConfig({}, "supervisor config")).models;
  return (config.codex ?? parseCodexSupervisorConfig({}, "supervisor config")).models;
}

const sameModel = (ref: SupervisorModelRef, hint: { provider?: string; modelId: string }): boolean =>
  ref.modelId === hint.modelId && (hint.provider === undefined || ref.provider === hint.provider);

/** The plugin's model hints the operator has not configured (for enabled harnesses only), each ignored. */
export function ignoredModelHints(config: SupervisorConfig, preference: SupervisorPreference): string[] {
  const enabled = enabledSupervisorHarnesses(config);
  const ignored: string[] = [];
  for (const [harness, hints] of Object.entries(preference.models ?? {})) {
    if (!isHarnessName(harness) || !enabled.includes(harness)) continue;
    const models = harnessModels(config, harness);
    for (const hint of hints ?? []) {
      if (!models.some((m) => sameModel(m, hintRef(harness, hint)))) {
        ignored.push(`the plugin's ${harness} model hint ${hint} is not among the operator's ${harness} models (${models.map((m) => (harness === "pi" ? `${m.provider}/${m.modelId}` : m.modelId)).join(", ")}), so it is ignored`);
      }
    }
  }
  return ignored;
}

/**
 * `config` with `harness`'s models reordered by the plugin's hints (§7.2):
 * each hint the operator configured moves to the front, in the hint order;
 * an unconfigured hint is ignored. The first model is the initial one.
 */
export function withModelHints(config: SupervisorConfig, harness: SupervisorHarnessName, preference: SupervisorPreference | undefined): SupervisorConfig {
  const hints = preference?.models?.[harness];
  if (hints === undefined || hints.length === 0) return config;
  const models = harnessModels(config, harness);
  const first: SupervisorModelRef[] = [];
  for (const hint of hints) {
    const found = models.find((m) => sameModel(m, hintRef(harness, hint)));
    if (found !== undefined && !first.includes(found)) first.push(found);
  }
  if (first.length === 0) return config;
  const ordered = [...first, ...models.filter((m) => !first.includes(m))];
  if (harness === "pi") {
    const head = ordered[0]!;
    const next: SupervisorConfig = { ...config, provider: head.provider, modelId: head.modelId, models: ordered };
    if (head.thinkingLevel !== undefined) next.thinkingLevel = head.thinkingLevel;
    else delete next.thinkingLevel;
    return next;
  }
  if (harness === CLAUDE_CODE_HARNESS) return { ...config, claude: { ...(config.claude ?? parseClaudeSupervisorConfig({}, "supervisor config")), models: ordered } };
  return { ...config, codex: { ...(config.codex ?? parseCodexSupervisorConfig({}, "supervisor config")), models: ordered } };
}

/** What `resume` runs its supervisor on, and the pin it asks the controller to record. */
export interface ResumeSupervisorPlan {
  /** The harness the run's supervisor and its repair reviewer run on; undefined: none (no config, nothing pinned). */
  harness?: SupervisorHarnessName;
  /** The operator's config with the plugin's model hints for `harness` applied. */
  config?: SupervisorConfig;
  pin?: SupervisorPinRequest;
}

/**
 * The supervisor of a resuming run (§7.4). The run's pin holds: its
 * `supervisorSelection`, or, for a run started before selection existed,
 * the harness its binding recorded at the first recovery episode (recorded
 * now as a selection with source `binding`). A pinned harness the operator no
 * longer enables, or that is not available, refuses the resume: nothing falls
 * back. `--supervisor <harness>` moves the pin, as a transition. A run that
 * nothing pinned (its supervisor never ran before selection existed) is
 * pinned now, by the same selection `run` makes, from the preference the run
 * was described with.
 */
export async function resumeSupervisorPlan(
  config: SupervisorConfig | undefined,
  state: Pick<DurableRunState, "supervisorSelection" | "supervisorBinding" | "definition">,
  options: { flag?: string; reason?: string; probe?: (harness: SupervisorHarnessName) => Promise<HarnessProbe> } = {},
): Promise<ResumeSupervisorPlan> {
  const pinned = pinnedSupervisorHarness(state);
  const preference = state.supervisorSelection?.preference ?? state.definition.supervisor;
  const legacy: SupervisorPinRequest | undefined =
    pinned !== undefined && state.supervisorSelection === undefined
      ? { selection: { harness: pinned, source: "binding", reason: `pinned at the run's first recovery episode, ${pinned} (a run started before supervisor selection)` } }
      : undefined;
  const probe = options.probe ?? ((h: SupervisorHarnessName) => probeSupervisorHarness(config!, h));
  if (options.flag !== undefined) {
    if (config === undefined) {
      throw new Error(`--supervisor ${options.flag} needs an operator supervisor config that enables it ($GRAPHLOOM_SUPERVISOR_CONFIG or ~/.config/graphloom/supervisor.json)`);
    }
    const chosen = (await supervisorSelectionOutcome(config, { flag: options.flag, probe })).selection!;
    const harness = chosen.harness;
    const hinted = withModelHints(config, harness, preference);
    if (pinned === undefined) {
      return { harness, config: hinted, pin: { selection: { harness, source: "flag", reason: `resume --supervisor ${harness}, for a run nothing had pinned` } } };
    }
    if (pinned === harness) return { harness, config: hinted, ...(legacy !== undefined ? { pin: legacy } : {}) };
    return { harness, config: hinted, pin: { transition: { from: pinned, to: harness, reason: options.reason ?? "the operator's resume --supervisor" } } };
  }
  if (pinned !== undefined) {
    if (!isHarnessName(pinned)) throw new Error(`this run's supervisor is pinned to the ${pinned} harness, which this GraphLoom cannot run; resume with --supervisor <harness>`);
    if (config === undefined) return { ...(legacy !== undefined ? { pin: legacy } : {}), ...(state.supervisorBinding?.sessionFile !== undefined ? { harness: pinned } : {}) };
    const enabled = enabledSupervisorHarnesses(config);
    if (!enabled.includes(pinned)) {
      throw new Error(`supervisor harness pin mismatch: this run's supervisor is pinned to ${pinned}, which the operator's supervisor config does not enable (enabled: ${enabled.join(", ")}); enable it again, or resume with --supervisor <harness>`);
    }
    if (!(config.harnesses === undefined && pinned === "pi")) {
      const probed = await probe(pinned).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
      if (!probed.ok) throw new Error(`supervisor harness pin mismatch: this run's supervisor is pinned to ${pinned}, which is not available here: ${probed.reason}; resume with --supervisor <harness>`);
    }
    return { harness: pinned, config: withModelHints(config, pinned, preference), ...(legacy !== undefined ? { pin: legacy } : {}) };
  }
  if (config === undefined) return {};
  const outcome = await supervisorSelectionOutcome(config, { probe, ...(preference !== undefined ? { preference } : {}) });
  if (outcome.selection === undefined) {
    console.error(`supervisor: ${outcome.none ?? "no harness is available"}, so this run has no supervisor`);
    return {};
  }
  const { harness, source, reason } = outcome.selection;
  return { harness, config: withModelHints(config, harness, preference), pin: { selection: { harness, source, reason: `pinned at resume: ${reason}` } } };
}

/**
 * The run's supervisor for `controller.run`'s `selectSupervisor`: the
 * selection on the plugin's preference, its factory, and the repair hooks on
 * the same harness (§7.5). A refusal throws, which refuses the run.
 */
export function supervisorChooser(
  config: SupervisorConfig,
  options: { flag?: string; bundlePath: () => Promise<string>; probe?: (harness: SupervisorHarnessName) => Promise<HarnessProbe>; onSelected?: (selection: SupervisorSelection, warnings: string[]) => void },
): NonNullable<RunRequest["selectSupervisor"]> {
  return async (preference) => {
    const outcome = await supervisorSelectionOutcome(config, {
      ...(options.flag !== undefined ? { flag: options.flag } : {}),
      ...(preference !== undefined ? { preference } : {}),
      ...(options.probe !== undefined ? { probe: options.probe } : {}),
    });
    if (outcome.selection === undefined) {
      console.error(`supervisor: ${outcome.none ?? "no harness is available"}, so this run has no supervisor`);
      return undefined;
    }
    const { selection } = outcome;
    options.onSelected?.(selection, outcome.warnings);
    const hinted = withModelHints(config, selection.harness, preference);
    return {
      selection,
      supervisorFactory: supervisorFactoryFor(hinted, selection.harness),
      repair: harnessRepairDeps(selection.harness, hinted, await options.bundlePath()),
    };
  };
}

/** A fresh supervisor on `harness` for a new run. */
export function supervisorFactoryFor(config: SupervisorConfig, harness: SupervisorHarnessName): SupervisorFactory {
  if (harness === "pi") return piSupervisorFactory(config);
  if (harness === CLAUDE_CODE_HARNESS) {
    return async ({ runId, stateDir, continueSession }) => (await claudeHarnessFor(config.claude, config, runId, stateDir)).start(startOptions(continueSession));
  }
  if (harness === CODEX_HARNESS) {
    return async ({ runId, stateDir, continueSession }) => (await codexHarnessFor(config.codex, config, runId, stateDir)).start(startOptions(continueSession));
  }
  throw new Error(`the ${harness} supervisor harness is not available in this GraphLoom`);
}

/**
 * Restore the run's logical supervisor on the harness its binding is pinned
 * to (a binding without one was recorded by Pi), on its bound model, with the
 * operator's current model list. The first episode after resume starts a
 * fresh session; earlier transcripts stay on disk but are never reopened.
 * Without an operator config a Pi binding restores on Pi's defaults, with its
 * credential from the environment or Pi's own store, as before harnesses, and
 * a Claude Code or Codex binding on that CLI's defaults. A per-harness config that
 * no longer enables the pinned harness, or a pinned CLI harness that is not
 * available, stops the resume: nothing falls back to another harness (§7.4).
 */
export function supervisorRestore(config: SupervisorConfig | undefined): NonNullable<ResumeRequest["restoreSupervisor"]> {
  return async (binding, { runId, stateDir }) => {
    const harness = bindingHarness(binding);
    const enabled = config !== undefined ? enabledSupervisorHarnesses(config) : undefined;
    if (enabled !== undefined && !(enabled as string[]).includes(harness)) {
      throw new Error(
        `supervisor harness pin mismatch: this run's supervisor is pinned to the ${harness} harness, which the operator's supervisor config does not enable (enabled: ${enabled.join(", ")}); enable it again, or resume with --supervisor <harness>`,
      );
    }
    if (harness === CLAUDE_CODE_HARNESS) {
      const claude = await claudeHarnessFor(config?.claude, config ?? {}, runId, stateDir);
      const available = await claude.probe();
      if (!available.ok) {
        throw new Error(`supervisor harness pin mismatch: this run's supervisor is pinned to ${harness}, which is not available here: ${available.reason}; resume with --supervisor <harness>`);
      }
      return claude.restore({ ...binding, sessionFile: binding.sessionFile, harness });
    }
    if (harness === CODEX_HARNESS) {
      const codex = await codexHarnessFor(config?.codex, config ?? {}, runId, stateDir);
      const available = await codex.probe();
      if (!available.ok) {
        throw new Error(`supervisor harness pin mismatch: this run's supervisor is pinned to ${harness}, which is not available here: ${available.reason}; resume with --supervisor <harness>`);
      }
      return codex.restore({ ...binding, sessionFile: binding.sessionFile, harness });
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
