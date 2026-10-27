// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { bindingHarness, type ModelSwitchRecord, type SupervisorBinding, type SupervisorHost, type SupervisorModelRef } from "./harness.js";
import { CLAUDE_CODE_HARNESS, claudeSessionsOpened, type ClaudeSessionOpened } from "./claude-harness.js";
import { createPiHarness } from "./pi-harness.js";

export { piEpisodeSessionOpener } from "./pi-harness.js";

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
  /** Operator fallback wait for a quota error with no reset time (see CreateSupervisorHostOptions). */
  quotaRetryMs?: number;
}

/**
 * Restore the run's logical Pi supervisor from a persisted binding, on the
 * recorded provider/model. The earlier transcript is never reopened: the
 * first episode after a restart starts a fresh session with no prior chat,
 * like every episode, and learns what earlier episodes established from the
 * controller's case file. Each later episode opens its own session too.
 * A binding without `harness` was recorded by a Pi supervisor; one naming
 * another harness is refused.
 */
export async function restorePiSupervisorFromBinding(options: RestorePiSupervisorOptions): Promise<SupervisorHost> {
  const { binding } = options;
  const harness = bindingHarness(binding);
  if (harness !== "pi") {
    throw new Error(`cannot restore supervisor: the binding is pinned to the ${harness} harness, not pi`);
  }
  const sessionDir =
    options.sessionDir ?? (binding.sessionFile !== undefined ? path.dirname(binding.sessionFile) : undefined);
  if (sessionDir === undefined) {
    throw new Error("cannot restore supervisor: binding has no sessionFile and no sessionDir was given");
  }
  return createPiHarness({
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
    ...(options.configuredModels !== undefined ? { configuredModels: options.configuredModels } : {}),
    ...(options.patchTimeoutMs !== undefined ? { patchTimeoutMs: options.patchTimeoutMs } : {}),
    ...(options.quotaRetryMs !== undefined ? { quotaRetryMs: options.quotaRetryMs } : {}),
  }).restore(binding);
}

/**
 * Settle switch intents left by a crash between journaling and commit, from
 * the bound harness's own record of the switch. Pi appends a `model_change`
 * entry to the session file when a switch takes effect; an intent whose
 * target matches the file's last model change is committed. Claude Code
 * switches by opening a fresh session on the target, whose record
 * (`<ref>.json` beside the transcript copies) names its model and opening
 * time (§4.4); an intent is committed when a session on its target opened at
 * or after the intent was journaled, so a session an earlier turn opened on
 * that model (a model_retry) is no evidence. Any other intent failed and the
 * run stays on its `from` model. A harness that keeps no such record settles
 * every intent as failed. The session itself is never replaced.
 */
export async function reconcileSupervisorBinding(binding: SupervisorBinding): Promise<SupervisorBinding> {
  if (!binding.switchJournal.some((r) => r.status === "intent")) return binding;
  const harness = bindingHarness(binding);
  const last = harness === "pi" ? await lastModelChange(binding.sessionFile) : undefined;
  const opened: ClaudeSessionOpened[] =
    harness === CLAUDE_CODE_HARNESS && binding.sessionFile !== undefined ? await claudeSessionsOpened(path.dirname(binding.sessionFile)) : [];
  const took = (record: ModelSwitchRecord): boolean =>
    harness === "pi"
      ? last !== undefined && sameModel(last, record.to)
      : opened.some((s) => s.openedAt >= Date.parse(record.at) && sameModel(s.model, record.to));
  let model: SupervisorModelRef = { provider: binding.provider, modelId: binding.modelId };
  const switchJournal = binding.switchJournal.map((record) => {
    if (record.status !== "intent") return record;
    if (took(record)) {
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

async function lastModelChange(sessionFile: string | undefined): Promise<SupervisorModelRef | undefined> {
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
