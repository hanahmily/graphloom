// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { completeJsonl, sessionSaver, writeAtomic } from "../session/capture.js";
import { readScanned } from "../session/files.js";

const SESSION_REF = /^codex-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Where Codex keeps a thread's rollout under its home: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. */
const ROLLOUT_PATH = /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[0-9A-Za-z.:_-]+\.jsonl$/;

/** What a saved Codex session ran under; a resume under another model would pass its turns off as continuity. */
export interface CodexSessionSettings {
  model: string | null;
}

/** The Codex thread a session continues, once Codex has named it. */
export interface CodexThread {
  threadId?: string;
  /** Its rollout file, relative to the Codex home, once found. */
  rollout?: string;
  /** True once Codex has recorded the thread, so the next run resumes it. */
  started: boolean;
}

export interface CodexSessionStore {
  /** The Codex home, where Codex keeps its rollouts under `sessions/`. */
  home: string;
  /** The caller's directory for saved copies of the session, when it may be continued later. */
  sessionDir?: string;
  settings: CodexSessionSettings;
}

export function codexSessionRef(threadId: string): string {
  return `codex-${threadId}`;
}

/** A new thread, or the one `resume` names restored into the Codex home; never a fresh one in its place. */
export async function openCodexThread(store: CodexSessionStore, resume: string | undefined): Promise<CodexThread> {
  const { home, sessionDir, settings } = store;
  if (resume === undefined) return { started: false };
  const ref = resume;
  const threadId = SESSION_REF.exec(ref)?.[1];
  if (threadId === undefined) throw new Error(`malformed session ref ${ref}`);
  if (sessionDir === undefined) throw new Error("no session directory to restore from");
  const [meta, rollout] = await Promise.all([
    readFile(path.join(sessionDir, `${ref}.json`), "utf8").catch(() => undefined),
    readFile(path.join(sessionDir, `${ref}.jsonl`), "utf8").catch(() => undefined),
  ]);
  if (meta === undefined || rollout === undefined) throw new Error(`no saved session for ${ref}`);
  if (rollout.trim() === "") throw new Error(`saved session ${ref} is empty`);
  let recorded: { rollout?: unknown; model?: unknown };
  try {
    recorded = JSON.parse(meta) as typeof recorded;
    for (const line of rollout.split("\n")) if (line.trim() !== "") JSON.parse(line);
  } catch {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  const { rollout: file, model } = recorded ?? {};
  if (typeof file !== "string" || !ROLLOUT_PATH.test(file) || !file.endsWith(`-${threadId}.jsonl`) || (model !== null && typeof model !== "string")) {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  if (model !== settings.model) {
    const describe = (m: string | null) => (m === null ? "Codex's default model" : `model ${m}`);
    throw new Error(`saved session ${ref} ran on ${describe(model)}; this job asks for ${describe(settings.model)}`);
  }
  // The saved copy is authoritative: Codex resumes the thread from this file.
  await writeAtomic(path.join(home, file), rollout);
  return { threadId, rollout: file, started: true };
}

/**
 * Runs one turn of `thread` and keeps its rollout: copied into the session
 * directory while the turn goes (`turn` calls `onActivity` on each event),
 * so a turn killed before it returns still leaves a resumable session, then
 * saved once more when it ends. `onSessionSaved` hears the first save that
 * is restorable. `resumed`: the thread was restored from the session
 * directory, so a failed final save leaves that copy in place. Reports the
 * `sessionRef` when the final save succeeded.
 */
export async function captureCodexTurn<T>(
  store: CodexSessionStore,
  thread: CodexThread,
  opts: { resumed: boolean; onSessionSaved?: (sessionRef: string) => void },
  turn: (onActivity: (() => void) | undefined) => Promise<T>,
): Promise<{ value: T; sessionRef?: string }> {
  const { home, sessionDir, settings } = store;
  const spawnedAt = new Date();
  // Codex appends to the rollout as the turn goes; a copy kept in the
  // session directory during the run leaves a resumable session even
  // if the job is killed before the final save below.
  let copied = false;
  const early =
    sessionDir !== undefined
      ? sessionSaver(
          async () => (copied = (await saveRollout(home, sessionDir, thread, settings, spawnedAt, false)) || copied),
          () => opts.onSessionSaved?.(codexSessionRef(thread.threadId!)),
        )
      : undefined;
  let value: T;
  try {
    value = await turn(early !== undefined ? () => early.poke() : undefined);
  } finally {
    await early?.close();
  }
  if (sessionDir === undefined) return { value };
  if (!(await saveRollout(home, sessionDir, thread, settings, spawnedAt, true))) {
    // What it copied during the run is no longer what Codex holds, so no unreported session is left behind.
    if (copied && !opts.resumed && thread.threadId !== undefined) {
      const ref = codexSessionRef(thread.threadId);
      await rm(path.join(sessionDir, `${ref}.jsonl`), { force: true });
      await rm(path.join(sessionDir, `${ref}.json`), { force: true });
    }
    return { value };
  }
  // A later run of this session (a transient retry) resumes the thread instead of starting another.
  thread.started = true;
  return { value, sessionRef: codexSessionRef(thread.threadId!) };
}

/**
 * Copy the thread's rollout into the caller's session directory; false
 * until Codex has named the thread and written its rollout. Codex may still
 * be appending (an early save during the run), so only complete records are
 * copied. `final` also searches the whole session store for the rollout.
 */
async function saveRollout(
  home: string,
  sessionDir: string,
  thread: CodexThread,
  settings: CodexSessionSettings,
  spawnedAt: Date,
  final: boolean,
): Promise<boolean> {
  if (thread.threadId === undefined) return false;
  if (thread.rollout === undefined) {
    const found = await findRollout(home, thread.threadId, [spawnedAt, new Date()], final);
    if (found === undefined) return false;
    thread.rollout = found;
  }
  const file = path.join(home, thread.rollout);
  // Only a regular file Codex wrote, never a link out of its store.
  const info = await lstat(file, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return false;
  const rollout = completeJsonl((await readScanned(file, info)).toString("utf8"));
  if (rollout.trim() === "") return false;
  const ref = codexSessionRef(thread.threadId);
  // The settings first: a rollout in the session directory is restorable once it lands.
  await writeAtomic(path.join(sessionDir, `${ref}.json`), JSON.stringify({ rollout: thread.rollout, ...settings }));
  await writeAtomic(path.join(sessionDir, `${ref}.jsonl`), rollout);
  return true;
}

/**
 * The rollout Codex keeps for `threadId`, relative to its home: looked up in
 * the day directories of `times` (local and UTC), and, with `everywhere`, in
 * every day directory of the store.
 */
export async function findRollout(home: string, threadId: string, times: Date[], everywhere: boolean): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = new Set<string>();
  for (const t of times) {
    days.add(`${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`);
    days.add(`${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`);
  }
  const inDay = async (day: string): Promise<string | undefined> => {
    const names = await readdir(path.join(home, "sessions", day)).catch(() => [] as string[]);
    const name = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    const rel = name !== undefined ? `sessions/${day}/${name}` : undefined;
    return rel !== undefined && ROLLOUT_PATH.test(rel) ? rel : undefined;
  };
  for (const day of days) {
    const found = await inDay(day);
    if (found !== undefined) return found;
  }
  if (!everywhere) return undefined;
  const sessions = path.join(home, "sessions");
  for (const year of await readdir(sessions).catch(() => [] as string[])) {
    for (const month of await readdir(path.join(sessions, year)).catch(() => [] as string[])) {
      for (const day of await readdir(path.join(sessions, year, month)).catch(() => [] as string[])) {
        const key = `${year}/${month}/${day}`;
        if (days.has(key)) continue;
        const found = await inDay(key);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}
