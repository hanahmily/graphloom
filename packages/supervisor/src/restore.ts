import path from "node:path";
import {
  createPiSupervisorSession,
  type CreatePiSupervisorSessionOptions,
} from "./pi-session.js";
import {
  createPiSupervisor,
  type ModelSwitchRecord,
  type PiSupervisor,
  type SupervisorBinding,
  type SupervisorModelRef,
} from "./pi-supervisor.js";

export interface RestorePiSupervisorOptions {
  runId: string;
  binding: SupervisorBinding;
  /** Defaults to dirname(binding.sessionFile). */
  sessionDir?: string;
  agentDir?: string;
  apiKey?: string;
  configuredModels?: SupervisorModelRef[];
  promptTimeoutMs?: number;
  systemPrompt?: string;
  cwd?: string;
  /** Controller repairs directory; required for candidate coding grants. */
  repairsDir?: string;
  patchTimeoutMs?: number;
}

/**
 * Reopen a durable Pi supervisor session from a persisted binding and
 * re-apply the recorded provider/model.
 */
export async function restorePiSupervisorFromBinding(
  options: RestorePiSupervisorOptions,
): Promise<PiSupervisor> {
  const { binding } = options;
  if (!binding.sessionFile) {
    throw new Error("cannot restore supervisor: binding has no sessionFile");
  }
  const sessionDir = options.sessionDir ?? path.dirname(binding.sessionFile);

  const sessionOpts: CreatePiSupervisorSessionOptions = {
    runId: options.runId,
    sessionDir,
    sessionFile: binding.sessionFile,
    provider: binding.provider,
    modelId: binding.modelId,
  };
  if (options.agentDir !== undefined) sessionOpts.agentDir = options.agentDir;
  if (options.apiKey !== undefined) sessionOpts.apiKey = options.apiKey;
  if (options.promptTimeoutMs !== undefined) {
    sessionOpts.promptTimeoutMs = options.promptTimeoutMs;
  }
  if (options.systemPrompt !== undefined) sessionOpts.systemPrompt = options.systemPrompt;
  if (options.cwd !== undefined) sessionOpts.cwd = options.cwd;
  if (options.repairsDir !== undefined) sessionOpts.repairsDir = options.repairsDir;

  const session = await createPiSupervisorSession(sessionOpts);

  if (session.provider !== binding.provider || session.modelId !== binding.modelId) {
    await session.setModel({
      provider: binding.provider,
      modelId: binding.modelId,
    });
  }

  const configured =
    options.configuredModels ??
    configuredModelsFromBinding(binding);

  return createPiSupervisor({
    session,
    configuredModels: configured,
    initialSwitchJournal: binding.switchJournal as ModelSwitchRecord[],
    ...(options.patchTimeoutMs !== undefined ? { patchTimeoutMs: options.patchTimeoutMs } : {}),
  });
}

function configuredModelsFromBinding(binding: SupervisorBinding): SupervisorModelRef[] {
  const seen = new Map<string, SupervisorModelRef>();
  const add = (ref: SupervisorModelRef) => {
    seen.set(`${ref.provider}/${ref.modelId}`, ref);
  };
  add({ provider: binding.provider, modelId: binding.modelId });
  for (const entry of binding.switchJournal) {
    add(entry.from);
    add(entry.to);
  }
  return [...seen.values()];
}
