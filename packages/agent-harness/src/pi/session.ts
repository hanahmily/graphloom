// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const SESSION_REF = /^pi-[0-9a-f]{12}$/;

/** What a saved session ran under; a resume under other settings would pass their turns off as continuity. */
export interface PiSessionSettings {
  provider: string;
  modelId: string;
  systemPromptSha256: string;
}

/** A Pi session manager, with the file it persists to when the session is saved in a session directory. */
export type PiSavedSession =
  | { manager: SessionManager; ref: string; file: string }
  | { manager: SessionManager; ref?: undefined; file?: undefined };

/** The settings record kept next to a Pi session file. */
export function piSettingsFile(sessionFile: string): string {
  return sessionFile.replace(/\.jsonl$/, ".json");
}

/** Write the settings record of the session saved at `sessionFile`, atomically. */
export async function writePiSettings(sessionFile: string, settings: PiSessionSettings): Promise<void> {
  const target = piSettingsFile(sessionFile);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(settings), "utf8");
  await rename(tmp, target);
}

/**
 * A session manager for a new session (in memory without `sessionDir`, else
 * persisted there), or the session `resume` names restored from `sessionDir`.
 * A restore fails rather than start a fresh session in its place.
 */
export function openPiSessionManager(
  opts: { cwd: string; sessionDir?: string; resume?: string },
  settings: PiSessionSettings,
): PiSavedSession {
  if (opts.resume === undefined) {
    if (opts.sessionDir === undefined) return { manager: SessionManager.inMemory(opts.cwd) };
    const ref = `pi-${randomBytes(6).toString("hex")}`;
    const file = path.join(opts.sessionDir, `${ref}.jsonl`);
    return { manager: SessionManager.open(file, opts.sessionDir, opts.cwd), ref, file };
  }
  const ref = opts.resume;
  if (!SESSION_REF.test(ref)) throw new Error(`malformed session ref ${ref}`);
  if (opts.sessionDir === undefined) throw new Error("no session directory to restore from");
  const file = path.join(opts.sessionDir, `${ref}.jsonl`);
  // Pi opens a missing file as a new session and rewrites an empty one, so check first.
  if (!existsSync(file)) throw new Error(`no saved session for ${ref}`);
  if (statSync(file).size === 0) throw new Error(`saved session ${ref} is empty`);
  let manager: SessionManager;
  try {
    manager = SessionManager.open(file, opts.sessionDir, opts.cwd);
  } catch {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  if (manager.buildSessionContext().messages.length === 0) throw new Error(`saved session ${ref} has no turns`);
  let recorded: Partial<Record<keyof PiSessionSettings, unknown>> | null;
  try {
    recorded = JSON.parse(readFileSync(piSettingsFile(file), "utf8")) as typeof recorded;
  } catch {
    recorded = null;
  }
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) {
    throw new Error(`saved session ${ref} has no readable settings record`);
  }
  if (recorded.provider !== settings.provider || recorded.modelId !== settings.modelId) {
    throw new Error(
      `saved session ${ref} ran on ${String(recorded.provider)}/${String(recorded.modelId)}; this job asks for ${settings.provider}/${settings.modelId}`,
    );
  }
  if (recorded.systemPromptSha256 !== settings.systemPromptSha256) {
    throw new Error(`saved session ${ref} ran with a different system prompt`);
  }
  return { manager, ref, file };
}

/**
 * Reports a saved session once its file exists: Pi appends each message to
 * the session file as it ends, so once the file exists (after the first
 * assistant message) the session is restorable. `watch` reports at once if
 * it already is, then on each of the agent's events; it reports only once
 * over every turn of the session.
 */
export function piSessionReporter(saved: PiSavedSession, onSessionSaved: ((sessionRef: string) => void) | undefined) {
  let reported = false;
  const report = () => {
    if (saved.ref === undefined || reported || !existsSync(saved.file)) return;
    reported = true;
    onSessionSaved?.(saved.ref);
  };
  return {
    /** Starts watching `agent`; the returned function stops. */
    watch(agent: { subscribe(listener: () => void): () => void }): (() => void) | undefined {
      const unsubscribe = saved.ref !== undefined && onSessionSaved !== undefined ? agent.subscribe(report) : undefined;
      report();
      return unsubscribe;
    },
  };
}
