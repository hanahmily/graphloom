import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_ACTIVE_BUDGET_MS } from "./intake.js";
import type { DurableRunState } from "./state.js";

const CHECKPOINT_FILE = "active-time.json";
/** How often a running controller checkpoints the time it has left; a crash loses at most this much. */
export const ACTIVE_CHECKPOINT_MS = 1_000;

export interface ActiveClock {
  /** Milliseconds left; never increases. */
  remaining(): number;
  /** Stop checkpointing, after writing a final checkpoint. */
  close(): Promise<void>;
}

/**
 * Run down the run's active-time budget while this controller runs it.
 * Elapsed time is monotonic, so clock adjustments neither add nor remove
 * time. The clock starts from the lower of the saved budget and the last
 * checkpoint, so time a crashed controller spent is not given back, while
 * time the run spent stopped is never charged.
 */
export async function startActiveClock(state: DurableRunState): Promise<ActiveClock> {
  const checkpoint = await readCheckpoint(state.stateDir);
  const allowance = Math.min(state.budgets.activeMs ?? DEFAULT_ACTIVE_BUDGET_MS, checkpoint ?? Infinity);
  const startedAt = performance.now();
  const remaining = () => Math.max(0, Math.floor(allowance - (performance.now() - startedAt)));
  let writing: Promise<void> = Promise.resolve();
  const checkpointNow = () => {
    writing = writing.then(() => writeCheckpoint(state.stateDir, remaining())).catch(() => undefined);
    return writing;
  };
  const timer = setInterval(() => void checkpointNow(), ACTIVE_CHECKPOINT_MS);
  timer.unref();
  await checkpointNow();
  return {
    remaining,
    async close() {
      clearInterval(timer);
      await checkpointNow();
    },
  };
}

async function readCheckpoint(stateDir: string): Promise<number | undefined> {
  try {
    const { remainingMs } = JSON.parse(await readFile(path.join(stateDir, CHECKPOINT_FILE), "utf8")) as { remainingMs?: unknown };
    return typeof remainingMs === "number" && remainingMs >= 0 ? remainingMs : undefined;
  } catch {
    return undefined;
  }
}

async function writeCheckpoint(stateDir: string, remainingMs: number): Promise<void> {
  const temporary = path.join(stateDir, `.${CHECKPOINT_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ remainingMs }), "utf8");
    await rename(temporary, path.join(stateDir, CHECKPOINT_FILE));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
