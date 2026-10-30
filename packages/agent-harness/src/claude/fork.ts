// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { completeJsonl, writeAtomic } from "../session/capture.js";
import { copyFiles, filesUnder, readScanned } from "../session/files.js";

const SESSION_REF = /^claude-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const PROJECT_DIR = /^[A-Za-z0-9._-]+$/;

/** The most a transcript read for capture may be (larger than any stored one, so the digest and the extract still exist). */
export const MAX_READ_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/** A Claude Code session restored into Claude Code's own store, and the id its fork will have. */
export interface ClaudeFork {
  parentRef: string;
  parentId: string;
  forkId: string;
  forkRef: string;
  project: string;
  /** What the parent ran under, carried to the fork's saved copy so a later job can resume it. */
  settings: { model: string | null; effort?: string; systemPromptSha256: string };
  /** The parent's saved transcript, as restored. */
  parentTranscript: string;
}

/**
 * Restore the saved session `parentRef` (a job's, or an earlier conversation's) from `savedDir` into the
 * Claude Code config dir, as `openClaudeSession` does, and choose the id the fork will be written under.
 * The saved copy is only read. A copy that is missing or corrupt is refused, never replaced by a fresh session.
 */
export async function restoreClaudeFork(args: { configDir: string; savedDir: string; parentRef: string; forkId?: string }): Promise<ClaudeFork> {
  const { configDir, savedDir, parentRef } = args;
  const parentId = SESSION_REF.exec(parentRef)?.[1];
  if (parentId === undefined) throw new Error(`malformed session ref ${parentRef}`);
  const [meta, transcript] = await Promise.all([
    readFile(path.join(savedDir, `${parentRef}.json`), "utf8").catch(() => undefined),
    readFile(path.join(savedDir, `${parentRef}.jsonl`), "utf8").catch(() => undefined),
  ]);
  if (meta === undefined || transcript === undefined) throw new Error(`no saved session for ${parentRef}`);
  if (transcript.trim() === "") throw new Error(`saved session ${parentRef} is empty`);
  let recorded: { project?: unknown; model?: unknown; effort?: unknown; systemPromptSha256?: unknown };
  try {
    recorded = JSON.parse(meta) as typeof recorded;
    for (const line of transcript.split("\n")) if (line.trim() !== "") JSON.parse(line);
  } catch {
    throw new Error(`saved session ${parentRef} is corrupt`);
  }
  const { project, model, effort, systemPromptSha256 } = recorded ?? {};
  if (
    typeof project !== "string" ||
    !PROJECT_DIR.test(project) ||
    project === "." ||
    project === ".." ||
    (model !== null && typeof model !== "string") ||
    (effort !== undefined && typeof effort !== "string") ||
    typeof systemPromptSha256 !== "string"
  ) {
    throw new Error(`saved session ${parentRef} is corrupt`);
  }
  const savedSide = path.join(savedDir, parentRef);
  const side = await filesUnder(savedSide);
  if (side?.other) throw new Error(`saved session ${parentRef} is corrupt`);
  await writeAtomic(path.join(configDir, "projects", project, `${parentId}.jsonl`), transcript);
  const storeSide = path.join(configDir, "projects", project, parentId);
  await rm(storeSide, { recursive: true, force: true });
  if (side !== undefined) await copyFiles(savedSide, side.files, storeSide);
  const forkId = args.forkId ?? randomUUID();
  return { parentRef, parentId, forkId, forkRef: `claude-${forkId}`, project, settings: { model: model as string | null, ...(effort !== undefined ? { effort: effort as string } : {}), systemPromptSha256 }, parentTranscript: transcript };
}

/** What a fork left in Claude Code's store, copied into a directory for the caller to keep. */
export interface CapturedClaudeFork {
  ref: string;
  /** The whole transcript as read (complete records only), kept even when it was too large to store. */
  transcript: string;
  bytes: number;
  /** Whether the saved copy was written; false when `bytes` exceeded `maxBytes`. */
  stored: boolean;
}

/**
 * Read the fork's transcript from the store by the id chosen before launch (`<fork id>.jsonl`, in whichever
 * project directory Claude Code wrote it) and, within `maxBytes`, save it as a self-contained session into
 * `targetDir` (`<ref>.json`, `<ref>.jsonl` and the side directory). Undefined when no transcript exists under
 * that id: nothing is guessed at.
 */
export async function captureClaudeFork(args: { configDir: string; fork: ClaudeFork; targetDir: string; maxBytes: number }): Promise<CapturedClaudeFork | undefined> {
  const { configDir, fork, targetDir } = args;
  const projects = path.join(configDir, "projects");
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    if (!PROJECT_DIR.test(project)) continue;
    const file = path.join(projects, project, `${fork.forkId}.jsonl`);
    const info = await lstat(file, { bigint: true }).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > BigInt(MAX_READ_TRANSCRIPT_BYTES)) throw new Error(`the fork's transcript is ${info.size} bytes, more than GraphLoom reads`);
    const transcript = completeJsonl((await readScanned(file, info)).toString("utf8"));
    if (transcript.trim() === "") return undefined;
    const bytes = Buffer.byteLength(transcript, "utf8");
    if (bytes > args.maxBytes) return { ref: fork.forkRef, transcript, bytes, stored: false };
    const sideSource = path.join(projects, project, fork.forkId);
    const side = await filesUnder(sideSource);
    await writeAtomic(path.join(targetDir, `${fork.forkRef}.json`), JSON.stringify({ project, ...fork.settings }));
    await writeAtomic(path.join(targetDir, `${fork.forkRef}.jsonl`), transcript);
    if (side !== undefined && !side.other) await copyFiles(sideSource, side.files, path.join(targetDir, fork.forkRef));
    return { ref: fork.forkRef, transcript, bytes, stored: true };
  }
  return undefined;
}
