// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  createPiSupervisorSession,
  isMiniMaxProvider,
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
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
  /** Inactivity limit of one prompt (see CreatePiSupervisorSessionOptions). */
  promptTimeoutMs?: number;
  /** Record raw provider streams (see CreatePiSupervisorSessionOptions). */
  rawStreamCapture?: boolean;
  /** Total cap of one prompt (see CreatePiSupervisorSessionOptions). */
  promptTotalTimeoutMs?: number;
  systemPrompt?: string;
  cwd?: string;
  /** Controller repairs directory; required for candidate coding grants. */
  repairsDir?: string;
  patchTimeoutMs?: number;
  /** Operator fallback wait for a quota error with no reset time (see CreatePiSupervisorOptions). */
  quotaRetryMs?: number;
}

/**
 * Restore the run's logical Pi supervisor from a persisted binding, on the
 * recorded provider/model. The earlier transcript is never reopened: the
 * first episode after a restart starts a fresh session with no prior chat,
 * like every episode, and learns what earlier episodes established from the
 * controller's case file. Each later episode opens its own session too.
 */
export async function restorePiSupervisorFromBinding(
  options: RestorePiSupervisorOptions,
): Promise<PiSupervisor> {
  const { binding } = options;
  const sessionDir =
    options.sessionDir ?? (binding.sessionFile !== undefined ? path.dirname(binding.sessionFile) : undefined);
  if (sessionDir === undefined) {
    throw new Error("cannot restore supervisor: binding has no sessionFile and no sessionDir was given");
  }

  const configured =
    options.configuredModels ??
    binding.configuredModels ??
    configuredModelsFromBinding(binding);
  const openSession = piEpisodeSessionOpener({
    runId: options.runId,
    sessionDir,
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.promptTimeoutMs !== undefined ? { promptTimeoutMs: options.promptTimeoutMs } : {}),
    ...(options.promptTotalTimeoutMs !== undefined ? { promptTotalTimeoutMs: options.promptTotalTimeoutMs } : {}),
    ...(options.rawStreamCapture !== undefined ? { rawStreamCapture: options.rawStreamCapture } : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.repairsDir !== undefined ? { repairsDir: options.repairsDir } : {}),
  });
  // The bound model may require a reasoning level other than the "off" default
  // (e.g. a model that rejects thinking disabled); it takes effect when the
  // session is created.
  const session = await openSession(
    findConfigured(configured, binding) ?? { provider: binding.provider, modelId: binding.modelId },
  );

  return createPiSupervisor({
    session,
    openSession,
    logicalSessionId: binding.sessionId,
    configuredModels: configured,
    initialSwitchJournal: binding.switchJournal as ModelSwitchRecord[],
    ...(options.patchTimeoutMs !== undefined ? { patchTimeoutMs: options.patchTimeoutMs } : {}),
    ...(options.quotaRetryMs !== undefined ? { quotaRetryMs: options.quotaRetryMs } : {}),
  });
}

/**
 * Opens a new durable Pi session in `sessionDir` on a given model, for one
 * recovery episode. Every session the run's supervisor uses comes from here.
 */
export function piEpisodeSessionOpener(
  base: Omit<CreatePiSupervisorSessionOptions, "provider" | "modelId" | "thinkingLevel" | "sessionFile">,
): (model: SupervisorModelRef) => Promise<PiSupervisorSession> {
  // The explicit key is MiniMax's only: after a switch to another provider,
  // later episodes open on that provider's own Pi-stored credential.
  const { apiKey, ...shared } = base;
  return (model) =>
    createPiSupervisorSession({
      ...shared,
      ...(apiKey !== undefined && isMiniMaxProvider(model.provider) ? { apiKey } : {}),
      provider: model.provider,
      modelId: model.modelId,
      ...(model.thinkingLevel !== undefined ? { thinkingLevel: model.thinkingLevel } : {}),
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
