// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** How often, at most, a harness copies a growing session into its session directory during a run. */
export const SESSION_SAVE_INTERVAL_MS = 2_000;

/**
 * Saves a session while its run is still going: `poke` on activity schedules
 * `save` (the first at once, then at most every `intervalMs`, one at a time),
 * and the first save that reports the session restorable calls `saved`.
 * `close` stops scheduling and waits for a save in progress, so the run's
 * final save never races an early one.
 */
export function sessionSaver(save: () => Promise<boolean>, saved: () => void, intervalMs = SESSION_SAVE_INTERVAL_MS) {
  let chain: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let last = Number.NEGATIVE_INFINITY;
  let closed = false;
  let reported = false;
  const run = () => {
    timer = undefined;
    last = Date.now();
    chain = chain
      .then(save)
      .then((ok) => {
        if (ok && !closed && !reported) {
          reported = true;
          saved();
        }
      })
      // An early save is best effort: the run's final save reports its own failure.
      .catch(() => undefined);
  };
  return {
    poke(): void {
      if (closed || timer !== undefined) return;
      timer = setTimeout(run, Math.max(0, last + intervalMs - Date.now()));
    },
    async close(): Promise<void> {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      await chain;
    },
  };
}

/**
 * The complete JSONL records of a transcript another process may still be
 * appending to: a last line cut off mid-write is dropped, so the copy stays
 * restorable.
 */
export function completeJsonl(text: string): string {
  const end = text.lastIndexOf("\n");
  const tail = text.slice(end + 1);
  if (tail.trim() === "") return text;
  try {
    JSON.parse(tail);
    return text;
  } catch {
    return text.slice(0, end + 1);
  }
}

/** Write `contents` to `target` through a private temporary file, so a reader never sees a partial file. */
export async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}
