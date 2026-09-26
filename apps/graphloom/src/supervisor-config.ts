import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResumeRequest, RunRequest } from "@graphloom/controller";
import {
  createPiSupervisor,
  createPiSupervisorSession,
  restorePiSupervisorFromBinding,
  type ModelRef,
} from "@graphloom/supervisor";

/**
 * Operator-owned supervisor settings. Credentials never live here: Pi resolves
 * them from its agent dir or the provider's environment variable.
 */
export interface SupervisorConfig {
  provider: string;
  modelId: string;
  /** Every model the supervisor may switch to, including the initial one. */
  models: ModelRef[];
  agentDir?: string;
  promptTimeoutMs?: number;
}

export function supervisorConfigPath(env: NodeJS.ProcessEnv = process.env): { file: string; explicit: boolean } {
  const explicit = env.GRAPHLOOM_SUPERVISOR_CONFIG;
  if (explicit !== undefined && explicit !== "") return { file: path.resolve(explicit), explicit: true };
  return { file: path.join(os.homedir(), ".config", "graphloom", "supervisor.json"), explicit: false };
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
  const listed = obj.models === undefined ? [] : obj.models;
  if (!Array.isArray(listed)) throw new Error(`${source}: models must be an array of "provider/model" strings`);
  const models: ModelRef[] = [{ provider, modelId }];
  for (const entry of listed) {
    const ref = parseModelRef(requireString(entry, `${source}: models entry`));
    if (!models.some((m) => m.provider === ref.provider && m.modelId === ref.modelId)) models.push(ref);
  }
  const config: SupervisorConfig = { provider, modelId, models };
  if (obj.agentDir !== undefined) config.agentDir = expandHome(requireString(obj.agentDir, `${source}: agentDir`));
  if (obj.promptTimeoutMs !== undefined) {
    if (typeof obj.promptTimeoutMs !== "number" || !(obj.promptTimeoutMs > 0)) {
      throw new Error(`${source}: promptTimeoutMs must be a positive number`);
    }
    config.promptTimeoutMs = obj.promptTimeoutMs;
  }
  return config;
}

/** `provider/model`; the model id may itself contain slashes. */
export function parseModelRef(text: string): ModelRef {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`expected provider/model, got "${text}"`);
  }
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

/** A fresh Pi supervisor whose transcript lives in the run's state directory. */
export function piSupervisorFactory(config: SupervisorConfig): NonNullable<RunRequest["supervisorFactory"]> {
  return async ({ runId, stateDir }) => {
    const session = await createPiSupervisorSession({
      runId,
      sessionDir: path.join(stateDir, "supervisor"),
      provider: config.provider,
      modelId: config.modelId,
      repairsDir: path.join(stateDir, "repairs"),
      ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
      ...(config.promptTimeoutMs !== undefined ? { promptTimeoutMs: config.promptTimeoutMs } : {}),
    });
    return createPiSupervisor({ session, configuredModels: config.models });
  };
}

/** Reopen the run's own Pi session; the operator's current model list applies. */
export function piSupervisorRestore(config: SupervisorConfig): NonNullable<ResumeRequest["restoreSupervisor"]> {
  return async (binding, { runId, stateDir }) =>
    restorePiSupervisorFromBinding({
      runId,
      binding: {
        sessionId: binding.sessionId,
        sessionFile: binding.sessionFile,
        provider: binding.provider,
        modelId: binding.modelId,
        switchJournal: binding.switchJournal,
      },
      configuredModels: config.models,
      repairsDir: path.join(stateDir, "repairs"),
      ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
      ...(config.promptTimeoutMs !== undefined ? { promptTimeoutMs: config.promptTimeoutMs } : {}),
    });
}

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return value;
}
