// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { completeJsonl, writeAtomic } from "../session/capture.js";
import { readScanned } from "../session/files.js";
import { codexSessionRef, findRollout } from "./session.js";

const SESSION_REF = /^codex-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const ROLLOUT_PATH = /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[0-9A-Za-z.:_-]+\.jsonl$/;
const MAX_READ_ROLLOUT_BYTES = 256 * 1024 * 1024;

/** A Codex thread's rollout copied under a new thread id in Codex's own store. */
export interface CodexFork {
  parentRef: string;
  parentThread: string;
  forkThread: string;
  forkRef: string;
  /** The copy's rollout path, relative to the Codex home. */
  rollout: string;
  settings: { model: string | null };
  parentTranscript: string;
}

/**
 * Restore the saved session `parentRef` as a new thread: the saved rollout is copied to
 * `sessions/<today>/rollout-<time>-<new thread>.jsonl` with the thread id in its `session_meta` record
 * replaced, then `codex resume <new thread>` finds it. The recorded thread's own rollout is never written.
 */
export async function restoreCodexFork(args: { home: string; savedDir: string; parentRef: string; now?: Date; forkThread?: string }): Promise<CodexFork> {
  const { home, savedDir, parentRef } = args;
  const parentThread = SESSION_REF.exec(parentRef)?.[1];
  if (parentThread === undefined) throw new Error(`malformed session ref ${parentRef}`);
  const [meta, rollout] = await Promise.all([
    readFile(path.join(savedDir, `${parentRef}.json`), "utf8").catch(() => undefined),
    readFile(path.join(savedDir, `${parentRef}.jsonl`), "utf8").catch(() => undefined),
  ]);
  if (meta === undefined || rollout === undefined) throw new Error(`no saved session for ${parentRef}`);
  if (rollout.trim() === "") throw new Error(`saved session ${parentRef} is empty`);
  let recorded: { rollout?: unknown; model?: unknown };
  const lines = rollout.split("\n");
  try {
    recorded = JSON.parse(meta) as typeof recorded;
    for (const line of lines) if (line.trim() !== "") JSON.parse(line);
  } catch {
    throw new Error(`saved session ${parentRef} is corrupt`);
  }
  const { rollout: file, model } = recorded ?? {};
  if (typeof file !== "string" || !ROLLOUT_PATH.test(file) || !file.endsWith(`-${parentThread}.jsonl`) || (model !== null && typeof model !== "string")) {
    throw new Error(`saved session ${parentRef} is corrupt`);
  }
  const forkThread = args.forkThread ?? randomUUID();
  const first = lines.findIndex((l) => l.trim() !== "");
  let head: { type?: unknown; payload?: { id?: unknown } & Record<string, unknown> };
  try {
    head = JSON.parse(lines[first]!) as typeof head;
  } catch {
    throw new Error(`saved session ${parentRef} is corrupt`);
  }
  if (head.type !== "session_meta" || head.payload === undefined || head.payload.id !== parentThread) {
    throw new Error(`saved session ${parentRef} does not start with its own session_meta record`);
  }
  lines[first] = JSON.stringify({ ...head, payload: { ...head.payload, id: forkThread } });
  const now = args.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const rel = `sessions/${day}/rollout-${stamp}-${forkThread}.jsonl`;
  await writeAtomic(path.join(home, rel), lines.join("\n"));
  return { parentRef, parentThread, forkThread, forkRef: codexSessionRef(forkThread), rollout: rel, settings: { model: model as string | null }, parentTranscript: rollout };
}

export interface CapturedCodexFork {
  ref: string;
  transcript: string;
  bytes: number;
  stored: boolean;
}

/**
 * Read the fork's rollout by the thread id chosen before launch and, within `maxBytes`, save it into
 * `targetDir` as a self-contained session. Undefined when no rollout exists under that thread id.
 */
export async function captureCodexFork(args: { home: string; fork: CodexFork; targetDir: string; maxBytes: number }): Promise<CapturedCodexFork | undefined> {
  const { home, fork, targetDir } = args;
  const rel = ROLLOUT_PATH.test(fork.rollout) ? ((await lstat(path.join(home, fork.rollout)).catch(() => undefined)) !== undefined ? fork.rollout : undefined) : undefined;
  const found = rel ?? (await findRollout(home, fork.forkThread, [new Date()], true));
  if (found === undefined) return undefined;
  const file = path.join(home, found);
  const info = await lstat(file, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  if (info.size > BigInt(MAX_READ_ROLLOUT_BYTES)) throw new Error(`the fork's rollout is ${info.size} bytes, more than GraphLoom reads`);
  const transcript = completeJsonl((await readScanned(file, info)).toString("utf8"));
  if (transcript.trim() === "") return undefined;
  const bytes = Buffer.byteLength(transcript, "utf8");
  if (bytes > args.maxBytes) return { ref: fork.forkRef, transcript, bytes, stored: false };
  await writeAtomic(path.join(targetDir, `${fork.forkRef}.json`), JSON.stringify({ rollout: found, ...fork.settings }));
  await writeAtomic(path.join(targetDir, `${fork.forkRef}.jsonl`), transcript);
  return { ref: fork.forkRef, transcript, bytes, stored: true };
}
