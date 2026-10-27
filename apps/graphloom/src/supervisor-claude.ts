// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Claude Code supervisor harness as the CLI composes it for a run
 * (design-supervisor-harnesses.md §6.1): transcripts and scratch under
 * `<stateDir>/supervisor/claude-code`, the run worktree as its read-only
 * working directory, and every process under bwrap through the runner's
 * `confineWorker`, writable only in its scratch directory, Claude Code's own
 * config dir, and a granted repair candidate.
 */
import os from "node:os";
import path from "node:path";
import { loadRunState } from "@graphloom/controller";
import { confineWorker, confinementUnsupported } from "@graphloom/runner";
import {
  CLAUDE_CODE_HARNESS,
  CLAUDE_DEFAULT_MODEL,
  createClaudeSupervisorHarness,
  type ClaudeConfinement,
  type ClaudeSupervisorHarness,
  type SupervisorModelRef,
} from "@graphloom/supervisor";

/** `supervisor.json`'s `claude` section. */
export interface ClaudeSupervisorConfig {
  /** Claude Code executable. Default `claude`. */
  command?: string;
  /** Claude Code's config dir (its login). Default `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  configDir?: string;
  /** Model aliases or names, the initial one first (`default` is Claude Code's own default). */
  models: SupervisorModelRef[];
  /** Extra environment variable names Claude Code may see. */
  passEnv?: string[];
}

/** Shared prompt limits of `supervisor.json`. */
export interface SupervisorLimits {
  promptTimeoutMs?: number;
  promptTotalTimeoutMs?: number;
  quotaRetryMs?: number;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return value;
}

/** A `claude.models` entry: `"opus"`, `"claude-code/opus"`, or `{ modelId, thinkingLevel? }`. */
function claudeModel(entry: unknown, what: string): SupervisorModelRef {
  if (typeof entry === "string") {
    const id = entry.startsWith(`${CLAUDE_CODE_HARNESS}/`) ? entry.slice(CLAUDE_CODE_HARNESS.length + 1) : entry;
    return { provider: CLAUDE_CODE_HARNESS, modelId: nonEmpty(id, what) };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${what} must be a model name or {modelId, thinkingLevel?}`);
  const obj = entry as Record<string, unknown>;
  if (obj.provider !== undefined && obj.provider !== CLAUDE_CODE_HARNESS) throw new Error(`${what}: provider must be ${CLAUDE_CODE_HARNESS}`);
  const ref: SupervisorModelRef = { provider: CLAUDE_CODE_HARNESS, modelId: nonEmpty(obj.modelId, `${what}: modelId`) };
  if (obj.thinkingLevel !== undefined) {
    if (typeof obj.thinkingLevel !== "string" || !THINKING_LEVELS.has(obj.thinkingLevel)) {
      throw new Error(`${what}: thinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")}`);
    }
    ref.thinkingLevel = obj.thinkingLevel as NonNullable<SupervisorModelRef["thinkingLevel"]>;
  }
  return ref;
}

/** Parse `supervisor.json`'s `claude` section; credentials are never accepted (§6.2). */
export function parseClaudeSupervisorConfig(value: unknown, source: string): ClaudeSupervisorConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: claude must be an object`);
  const obj = value as Record<string, unknown>;
  for (const secret of ["apiKey", "anthropicApiKey", "token"]) {
    if (secret in obj) throw new Error(`${source}: claude.${secret} is not accepted; the Claude Code supervisor uses your own Claude Code login`);
  }
  const listed = obj.models === undefined ? [CLAUDE_DEFAULT_MODEL] : obj.models;
  if (!Array.isArray(listed) || listed.length === 0) throw new Error(`${source}: claude.models must be a non-empty array of model names`);
  const models: SupervisorModelRef[] = [];
  for (const entry of listed) {
    const ref = claudeModel(entry, `${source}: claude.models entry`);
    if (!models.some((m) => m.modelId === ref.modelId)) models.push(ref);
  }
  const config: ClaudeSupervisorConfig = { models };
  if (obj.command !== undefined) config.command = nonEmpty(obj.command, `${source}: claude.command`);
  if (obj.configDir !== undefined) config.configDir = expandHome(nonEmpty(obj.configDir, `${source}: claude.configDir`));
  if (obj.passEnv !== undefined) {
    if (!Array.isArray(obj.passEnv) || !obj.passEnv.every((n) => typeof n === "string" && n !== "")) {
      throw new Error(`${source}: claude.passEnv must be an array of environment variable names`);
    }
    if (obj.passEnv.includes("ANTHROPIC_API_KEY")) throw new Error(`${source}: claude.passEnv cannot include ANTHROPIC_API_KEY`);
    config.passEnv = [...(obj.passEnv as string[])];
  }
  return config;
}

/**
 * The runner's bwrap confinement as the harness's launch: the whole
 * filesystem read-only except the launch scope's writable paths and the
 * scratch directory, with temp and caches redirected into the scratch.
 */
export function claudeConfinement(scratchDir: string): ClaudeConfinement {
  return {
    unsupported: confinementUnsupported,
    launch(command, args, env, cwd, scope) {
      const confined = confineWorker({
        command,
        args,
        env,
        cwd,
        scratchDir,
        writable: scope.writable ?? [],
        ...(scope.trustedWritable !== undefined ? { trustedWritable: scope.trustedWritable } : {}),
        ...(scope.readPaths !== undefined ? { readPaths: scope.readPaths } : {}),
        // Claude Code keeps its own login and state, which stay where they are.
        keepUserState: true,
      });
      // The status fd reports a worker pid the runner signals; the driver signals bwrap's own process group instead.
      const at = confined.args.indexOf("--json-status-fd");
      const args2 = at >= 0 ? [...confined.args.slice(0, at), ...confined.args.slice(at + 2)] : confined.args;
      return { command: confined.command, args: args2, env: confined.env };
    },
  };
}

/** Where a run's Claude Code supervisor keeps its transcript copies, and its scratch directory. */
export function claudeSupervisorDirs(stateDir: string): { sessionDir: string; scratchDir: string } {
  const sessionDir = path.join(stateDir, "supervisor", CLAUDE_CODE_HARNESS);
  return { sessionDir, scratchDir: path.join(sessionDir, "scratch") };
}

/** The Claude Code harness for one run, confined, reading from the run worktree. */
export async function claudeHarnessFor(
  config: ClaudeSupervisorConfig | undefined,
  limits: SupervisorLimits,
  runId: string,
  stateDir: string,
  options: { sessionDir?: string; scratchDir?: string } = {},
): Promise<ClaudeSupervisorHarness> {
  const dirs = claudeSupervisorDirs(stateDir);
  const scratchDir = options.scratchDir ?? dirs.scratchDir;
  const worktree = await loadRunState(stateDir).then(
    (s) => s.worktreePath,
    () => undefined,
  );
  return createClaudeSupervisorHarness({
    runId,
    sessionDir: options.sessionDir ?? dirs.sessionDir,
    scratchDir,
    ...(worktree !== undefined ? { cwd: worktree } : {}),
    ...(config?.command !== undefined ? { command: config.command } : {}),
    ...(config?.configDir !== undefined ? { configDir: config.configDir } : {}),
    ...(config !== undefined ? { configuredModels: config.models } : {}),
    ...(config?.passEnv !== undefined ? { passEnv: config.passEnv } : {}),
    confinement: claudeConfinement(scratchDir),
    ...(limits.promptTimeoutMs !== undefined ? { promptTimeoutMs: limits.promptTimeoutMs } : {}),
    ...(limits.promptTotalTimeoutMs !== undefined ? { promptTotalTimeoutMs: limits.promptTotalTimeoutMs } : {}),
    ...(limits.quotaRetryMs !== undefined ? { quotaRetryMs: limits.quotaRetryMs } : {}),
  });
}

/** The harness with no run behind it, for `probe()` only (binary, flags, login, bwrap). */
export function claudeProbeHarness(config: ClaudeSupervisorConfig | undefined): ClaudeSupervisorHarness {
  const scratch = path.join(os.tmpdir(), "graphloom-claude-probe");
  return createClaudeSupervisorHarness({
    runId: "probe",
    sessionDir: scratch,
    ...(config?.command !== undefined ? { command: config.command } : {}),
    ...(config?.configDir !== undefined ? { configDir: config.configDir } : {}),
    ...(config !== undefined ? { configuredModels: config.models } : {}),
    confinement: claudeConfinement(scratch),
  });
}
