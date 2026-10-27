// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Codex supervisor harness as the CLI composes it for a run
 * (design-supervisor-harnesses.md §6.1): rollout copies and scratch under
 * `<stateDir>/supervisor/codex`, the run worktree as its read-only working
 * directory, and every process under bwrap through the runner's
 * `confineWorker` (the same launch as Claude Code's), writable only in its
 * scratch directory, Codex's own home, and a granted repair candidate. Codex
 * runs with `--sandbox danger-full-access`: bwrap is the limit.
 */
import os from "node:os";
import path from "node:path";
import { loadRunState } from "@graphloom/controller";
import {
  CODEX_API_KEY_ENV,
  CODEX_DEFAULT_MODEL,
  CODEX_HARNESS,
  createCodexSupervisorHarness,
  type CodexSupervisorHarness,
  type SupervisorModelRef,
} from "@graphloom/supervisor";
import { claudeConfinement, type SupervisorLimits } from "./supervisor-claude.js";

/** `supervisor.json`'s `codex` section. */
export interface CodexSupervisorConfig {
  /** Codex executable. Default `codex`. */
  command?: string;
  /** Codex's home (its login and rollouts). Default `CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Model names, the initial one first (`default` is Codex's own default model). */
  models: SupervisorModelRef[];
  /** Extra environment variable names Codex may see. */
  passEnv?: string[];
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return value;
}

/** A `codex.models` entry: `"gpt-5-codex"`, `"codex/gpt-5-codex"`, or `{ modelId, thinkingLevel? }`. */
function codexModel(entry: unknown, what: string): SupervisorModelRef {
  if (typeof entry === "string") {
    const id = entry.startsWith(`${CODEX_HARNESS}/`) ? entry.slice(CODEX_HARNESS.length + 1) : entry;
    return { provider: CODEX_HARNESS, modelId: nonEmpty(id, what) };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${what} must be a model name or {modelId, thinkingLevel?}`);
  const obj = entry as Record<string, unknown>;
  if (obj.provider !== undefined && obj.provider !== CODEX_HARNESS) throw new Error(`${what}: provider must be ${CODEX_HARNESS}`);
  const ref: SupervisorModelRef = { provider: CODEX_HARNESS, modelId: nonEmpty(obj.modelId, `${what}: modelId`) };
  if (obj.thinkingLevel !== undefined) {
    if (typeof obj.thinkingLevel !== "string" || !THINKING_LEVELS.has(obj.thinkingLevel)) {
      throw new Error(`${what}: thinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")}`);
    }
    ref.thinkingLevel = obj.thinkingLevel as NonNullable<SupervisorModelRef["thinkingLevel"]>;
  }
  return ref;
}

/** Parse `supervisor.json`'s `codex` section; credentials are never accepted (§6.2). */
export function parseCodexSupervisorConfig(value: unknown, source: string): CodexSupervisorConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: codex must be an object`);
  const obj = value as Record<string, unknown>;
  for (const secret of ["apiKey", "openaiApiKey", "token"]) {
    if (secret in obj) throw new Error(`${source}: codex.${secret} is not accepted; the Codex supervisor uses your own Codex login (codex login); OpenAI by API key is the Pi supervisor's route`);
  }
  const listed = obj.models === undefined ? [CODEX_DEFAULT_MODEL] : obj.models;
  if (!Array.isArray(listed) || listed.length === 0) throw new Error(`${source}: codex.models must be a non-empty array of model names`);
  const models: SupervisorModelRef[] = [];
  for (const entry of listed) {
    const ref = codexModel(entry, `${source}: codex.models entry`);
    if (!models.some((m) => m.modelId === ref.modelId)) models.push(ref);
  }
  const config: CodexSupervisorConfig = { models };
  if (obj.command !== undefined) config.command = nonEmpty(obj.command, `${source}: codex.command`);
  if (obj.codexHome !== undefined) config.codexHome = expandHome(nonEmpty(obj.codexHome, `${source}: codex.codexHome`));
  if (obj.passEnv !== undefined) {
    if (!Array.isArray(obj.passEnv) || !obj.passEnv.every((n) => typeof n === "string" && n !== "")) {
      throw new Error(`${source}: codex.passEnv must be an array of environment variable names`);
    }
    const key = (obj.passEnv as string[]).find((n) => CODEX_API_KEY_ENV.includes(n));
    if (key !== undefined) throw new Error(`${source}: codex.passEnv cannot include ${key}`);
    config.passEnv = [...(obj.passEnv as string[])];
  }
  return config;
}

/** Where a run's Codex supervisor keeps its rollout copies and session records, and its scratch directory. */
export function codexSupervisorDirs(stateDir: string): { sessionDir: string; scratchDir: string } {
  const sessionDir = path.join(stateDir, "supervisor", CODEX_HARNESS);
  return { sessionDir, scratchDir: path.join(sessionDir, "scratch") };
}

/** The Codex harness for one run, confined, reading from the run worktree. */
export async function codexHarnessFor(
  config: CodexSupervisorConfig | undefined,
  limits: SupervisorLimits,
  runId: string,
  stateDir: string,
  options: { sessionDir?: string; scratchDir?: string } = {},
): Promise<CodexSupervisorHarness> {
  const dirs = codexSupervisorDirs(stateDir);
  const scratchDir = options.scratchDir ?? dirs.scratchDir;
  const worktree = await loadRunState(stateDir).then(
    (s) => s.worktreePath,
    () => undefined,
  );
  return createCodexSupervisorHarness({
    runId,
    sessionDir: options.sessionDir ?? dirs.sessionDir,
    scratchDir,
    ...(worktree !== undefined ? { cwd: worktree } : {}),
    ...(config?.command !== undefined ? { command: config.command } : {}),
    ...(config?.codexHome !== undefined ? { codexHome: config.codexHome } : {}),
    ...(config !== undefined ? { configuredModels: config.models } : {}),
    ...(config?.passEnv !== undefined ? { passEnv: config.passEnv } : {}),
    // The same bwrap launch as Claude Code's: the whole filesystem read-only, no private /tmp.
    confinement: claudeConfinement(scratchDir),
    ...(limits.promptTimeoutMs !== undefined ? { promptTimeoutMs: limits.promptTimeoutMs } : {}),
    ...(limits.promptTotalTimeoutMs !== undefined ? { promptTotalTimeoutMs: limits.promptTotalTimeoutMs } : {}),
    ...(limits.quotaRetryMs !== undefined ? { quotaRetryMs: limits.quotaRetryMs } : {}),
  });
}

/** The harness with no run behind it, for `probe()` only (binary, flags, login, bwrap). */
export function codexProbeHarness(config: CodexSupervisorConfig | undefined): CodexSupervisorHarness {
  const scratch = path.join(os.tmpdir(), "graphloom-codex-probe");
  return createCodexSupervisorHarness({
    runId: "probe",
    sessionDir: scratch,
    ...(config?.command !== undefined ? { command: config.command } : {}),
    ...(config?.codexHome !== undefined ? { codexHome: config.codexHome } : {}),
    ...(config !== undefined ? { configuredModels: config.models } : {}),
    confinement: claudeConfinement(scratch),
  });
}
