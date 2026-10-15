import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  createPiSupervisorSession,
  type CreatePiSupervisorSessionOptions,
} from "./pi-session.js";
import {
  createPiSupervisor,
  findConfigured,
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
  /** Operator fallback wait for a quota error with no reset time (see CreatePiSupervisorOptions). */
  quotaRetryMs?: number;
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

  const configured =
    options.configuredModels ??
    binding.configuredModels ??
    configuredModelsFromBinding(binding);
  // The bound model may require a reasoning level other than the "off" default
  // (e.g. a model that rejects thinking disabled); look it up before the
  // session is created, since that is where the level actually takes effect.
  const boundThinkingLevel = findConfigured(configured, binding)?.thinkingLevel;

  const sessionOpts: CreatePiSupervisorSessionOptions = {
    runId: options.runId,
    sessionDir,
    sessionFile: binding.sessionFile,
    provider: binding.provider,
    modelId: binding.modelId,
  };
  if (boundThinkingLevel !== undefined) sessionOpts.thinkingLevel = boundThinkingLevel;
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
      ...(boundThinkingLevel !== undefined ? { thinkingLevel: boundThinkingLevel } : {}),
    });
  }

  return createPiSupervisor({
    session,
    configuredModels: configured,
    initialSwitchJournal: binding.switchJournal as ModelSwitchRecord[],
    ...(options.patchTimeoutMs !== undefined ? { patchTimeoutMs: options.patchTimeoutMs } : {}),
    ...(options.quotaRetryMs !== undefined ? { quotaRetryMs: options.quotaRetryMs } : {}),
  });
}

/**
 * Settle switch intents left by a crash between journaling and commit. Pi
 * appends a `model_change` entry to the session file when a switch takes
 * effect, so an intent whose target matches the file's last model change is
 * committed; any other intent failed and the run stays on its `from` model.
 * The session itself is never replaced.
 */
export async function reconcileSupervisorBinding(
  binding: SupervisorBinding,
): Promise<SupervisorBinding> {
  if (!binding.switchJournal.some((r) => r.status === "intent")) return binding;
  const last = await lastModelChange(binding.sessionFile);
  let model: SupervisorModelRef = { provider: binding.provider, modelId: binding.modelId };
  const switchJournal = binding.switchJournal.map((record) => {
    if (record.status !== "intent") return record;
    if (last !== undefined && sameModel(last, record.to)) {
      model = { ...record.to };
      return { ...record, status: "committed" as const };
    }
    model = { ...record.from };
    return {
      ...record,
      status: "failed" as const,
      error: "switch interrupted before commit; the session did not record the model change",
    };
  });
  return { ...binding, ...model, switchJournal };
}

async function lastModelChange(
  sessionFile: string | undefined,
): Promise<SupervisorModelRef | undefined> {
  if (sessionFile === undefined) return undefined;
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let found: SupervisorModelRef | undefined;
  for (const entry of parseSessionEntries(content)) {
    if (entry.type === "model_change") {
      found = { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return found;
}

function sameModel(a: SupervisorModelRef, b: SupervisorModelRef): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
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
