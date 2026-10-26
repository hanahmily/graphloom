// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { completeJsonl, sessionSaver, writeAtomic } from "../session/capture.js";
import { copyFiles, filesUnder, readScanned } from "../session/files.js";
import { costState, type ClaudeTotals } from "./usage.js";

const SESSION_REF = /^claude-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const PROJECT_DIR = /^[A-Za-z0-9._-]+$/;

/** One Claude Code session a caller runs turns in. */
export interface ClaudeSession {
  sessionId: string;
  ref: string;
  /** True once the Claude Code session exists, so the next run resumes it. */
  started: boolean;
  /** Session totals Claude Code restores when it resumes, from the transcript's last `cost-state` record. */
  baseline?: ClaudeTotals;
}

/** Settings a resumed session must share with the one that recorded its earlier turns. */
export interface ClaudeSessionSettings {
  model: string | null;
  systemPromptSha256: string;
}

export interface ClaudeSessionStore {
  /** Claude Code's config dir, where it keeps its own transcripts under `projects/`. */
  configDir: string;
  /** The caller's directory for saved copies of the session, when it may be continued later. */
  sessionDir?: string;
  settings: ClaudeSessionSettings;
}

function describeModel(model: string | null): string {
  return model === null ? "Claude Code's default model" : `model ${model}`;
}

/** A new session, or the one `resume` names restored into Claude Code's store; never a fresh one in its place. */
export async function openClaudeSession(store: ClaudeSessionStore, resume: string | undefined): Promise<ClaudeSession> {
  const { configDir, sessionDir, settings } = store;
  if (resume === undefined) {
    const sessionId = randomUUID();
    return { sessionId, ref: `claude-${sessionId}`, started: false };
  }
  const ref = resume;
  const sessionId = SESSION_REF.exec(ref)?.[1];
  if (sessionId === undefined) throw new Error(`malformed session ref ${ref}`);
  if (sessionDir === undefined) throw new Error("no session directory to restore from");
  const [meta, transcript] = await Promise.all([
    readFile(path.join(sessionDir, `${ref}.json`), "utf8").catch(() => undefined),
    readFile(path.join(sessionDir, `${ref}.jsonl`), "utf8").catch(() => undefined),
  ]);
  if (meta === undefined || transcript === undefined) throw new Error(`no saved session for ${ref}`);
  if (transcript.trim() === "") throw new Error(`saved session ${ref} is empty`);
  let recorded: { project?: unknown; model?: unknown; systemPromptSha256?: unknown };
  try {
    recorded = JSON.parse(meta) as typeof recorded;
    for (const line of transcript.split("\n")) if (line.trim() !== "") JSON.parse(line);
  } catch {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  const { project, model, systemPromptSha256 } = recorded ?? {};
  if (
    typeof project !== "string" ||
    !PROJECT_DIR.test(project) ||
    project === "." ||
    project === ".." ||
    (model !== null && typeof model !== "string") ||
    typeof systemPromptSha256 !== "string"
  ) {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  // Claude Code resumes under any settings; earlier turns reasoned under others would pass as continuity.
  if (model !== settings.model) {
    throw new Error(`saved session ${ref} ran on ${describeModel(model)}; this job asks for ${describeModel(settings.model)}`);
  }
  if (systemPromptSha256 !== settings.systemPromptSha256) {
    throw new Error(`saved session ${ref} ran with a different system prompt`);
  }
  const savedSide = path.join(sessionDir, ref);
  const side = await filesUnder(savedSide);
  if (side?.other) throw new Error(`saved session ${ref} is corrupt`);
  await writeAtomic(path.join(configDir, "projects", project, `${sessionId}.jsonl`), transcript);
  // The saved copy is authoritative for the side files too, so none of the store's own survive.
  const storeSide = path.join(configDir, "projects", project, sessionId);
  await rm(storeSide, { recursive: true, force: true });
  if (side !== undefined) await copyFiles(savedSide, side.files, storeSide);
  const baseline = costState(transcript);
  return { sessionId, ref, started: true, ...(baseline !== undefined ? { baseline } : {}) };
}

/**
 * Runs one turn of `session` and keeps its transcript: copied into the
 * session directory while the turn goes (`turn` calls `onActivity` on each
 * event), so a turn killed before it returns still leaves a resumable
 * session, then saved once more when it ends. `onSessionSaved` hears the
 * first save that is restorable. `resumed`: the session was restored from
 * the session directory, so a failed final save leaves that copy in place.
 * Reports the `sessionRef` when the final save succeeded.
 */
export async function captureClaudeTurn<T>(
  store: ClaudeSessionStore,
  session: ClaudeSession,
  opts: { resumed: boolean; onSessionSaved?: (sessionRef: string) => void },
  turn: (onActivity: (() => void) | undefined) => Promise<T>,
): Promise<{ value: T; sessionRef?: string }> {
  const { configDir, sessionDir, settings } = store;
  // Claude Code appends to its transcript as the turn goes; a copy kept
  // in the session directory during the run leaves a resumable session
  // even if the job is killed before the final save below.
  let copied = false;
  const early =
    sessionDir !== undefined
      ? sessionSaver(
          async () => (copied = (await saveTranscript(configDir, sessionDir, session, settings, false)) || copied),
          () => opts.onSessionSaved?.(session.ref),
        )
      : undefined;
  let value: T;
  try {
    value = await turn(early !== undefined ? () => early.poke() : undefined);
  } finally {
    await early?.close();
  }
  if (sessionDir === undefined) {
    // Claude Code rejects a reused --session-id, so a later run of this
    // session (a transient retry) must resume the transcript it wrote.
    // Its usage totals are cumulative, so the resumed run's are measured from this point.
    const transcript = await localTranscript(configDir, session.sessionId);
    if (transcript !== undefined) {
      session.started = true;
      const baseline = costState(transcript);
      if (baseline !== undefined) session.baseline = baseline;
    }
    return { value };
  }
  if (!(await saveTranscript(configDir, sessionDir, session, settings, true))) {
    // What it copied during the run is no longer what Claude Code holds (the transcript went, or is no longer its own file).
    if (copied && !opts.resumed) await dropSaved(sessionDir, session.ref);
    return { value };
  }
  session.started = true;
  return { value, sessionRef: session.ref };
}

/** The transcript Claude Code wrote for this session, when it wrote one. */
async function localTranscript(configDir: string, sessionId: string): Promise<string | undefined> {
  const projects = path.join(configDir, "projects");
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    if (!PROJECT_DIR.test(project)) continue;
    const file = path.join(projects, project, `${sessionId}.jsonl`);
    const info = await lstat(file, { bigint: true }).catch(() => undefined);
    if (info?.isFile()) return (await readScanned(file, info)).toString("utf8");
  }
  return undefined;
}

/**
 * Copy Claude Code's transcript into the caller's session directory;
 * false when it has written none yet. Claude Code may still be appending
 * (an early save during the run), so only complete records are copied.
 * `final`: the run is over, so the transcript's usage totals become the
 * baseline a later run of this session is measured from.
 */
async function saveTranscript(
  configDir: string,
  sessionDir: string,
  saved: ClaudeSession,
  settings: ClaudeSessionSettings,
  final: boolean,
): Promise<boolean> {
  const projects = path.join(configDir, "projects");
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const project of dirs) {
    if (!PROJECT_DIR.test(project) || !(await lstat(path.join(projects, project)).catch(() => undefined))?.isDirectory()) continue;
    const file = path.join(projects, project, `${saved.sessionId}.jsonl`);
    const info = await lstat(file, { bigint: true }).catch(() => undefined);
    if (!info?.isFile()) continue;
    const transcript = completeJsonl((await readScanned(file, info)).toString("utf8"));
    // A resume refuses an empty transcript, so an early save waits for the first record.
    if (transcript.trim() === "") return false;
    await saveSide(path.join(projects, project, saved.sessionId), path.join(sessionDir, saved.ref));
    // The settings first: a transcript in the session directory is restorable once it lands.
    await writeAtomic(path.join(sessionDir, `${saved.ref}.json`), JSON.stringify({ project, ...settings }));
    await writeAtomic(path.join(sessionDir, `${saved.ref}.jsonl`), transcript);
    if (final) {
      const baseline = costState(transcript);
      if (baseline !== undefined) saved.baseline = baseline;
    }
    return true;
  }
  return false;
}

/**
 * Mirror the session's side directory (subagent transcripts, which a resumed
 * session needs to continue a subagent, and tool output spilled to files) into
 * `target`, replacing what was there. Only regular files are session state.
 */
async function saveSide(source: string, target: string): Promise<void> {
  const side = await filesUnder(source);
  if (side === undefined) {
    await rm(target, { recursive: true, force: true });
    return;
  }
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await copyFiles(source, side.files, tmp);
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Remove a session saved during a run whose final save failed, so no unreported session is left behind. */
async function dropSaved(sessionDir: string, ref: string): Promise<void> {
  await rm(path.join(sessionDir, `${ref}.jsonl`), { force: true });
  await rm(path.join(sessionDir, `${ref}.json`), { force: true });
  await rm(path.join(sessionDir, ref), { recursive: true, force: true });
}
