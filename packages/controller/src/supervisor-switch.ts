// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRef, Supervisor } from "@graphloom/supervisor";
import { withDirectoryLock } from "./lock.js";
import { noteOutcome } from "./settlement.js";
import { saveRunState, type DurableRunState } from "./state.js";

const SWITCH_REQUEST = "supervisor-switch.json";
const SWITCH_LOCK = "supervisor-switch.lock";

export interface ModelSwitchOrder extends ModelRef {
  reason: string;
}

/** An operator request as read from disk; `id` names this instance of the file. */
export interface PendingSwitchRequest extends ModelSwitchOrder {
  id: string;
}

/**
 * Durable operator request, applied before the run's next supervisor prompt.
 * Written atomically so the owner never reads a partial file; a newer request
 * replaces an unapplied older one.
 */
export async function writeSwitchRequest(stateDir: string, order: ModelSwitchOrder): Promise<void> {
  await withDirectoryLock(stateDir, SWITCH_LOCK, async () => {
    const target = path.join(stateDir, SWITCH_REQUEST);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...order, id: randomUUID(), requestedAt: new Date().toISOString() }), "utf8");
    await rename(tmp, target);
  });
}

export async function readSwitchRequest(stateDir: string): Promise<PendingSwitchRequest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(stateDir, SWITCH_REQUEST), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<PendingSwitchRequest>;
  if (typeof parsed.provider !== "string" || typeof parsed.modelId !== "string") {
    throw new Error(`malformed ${SWITCH_REQUEST}: provider and modelId are required`);
  }
  return {
    id: typeof parsed.id === "string" ? parsed.id : "",
    provider: parsed.provider,
    modelId: parsed.modelId,
    reason: typeof parsed.reason === "string" ? parsed.reason : "operator request",
  };
}

/**
 * Remove the request the owner consumed. A request written after it was read
 * has a different id and stays for the next prompt. Without an id (a malformed
 * file), the file is removed unconditionally.
 */
export async function clearSwitchRequest(stateDir: string, id?: string): Promise<void> {
  await withDirectoryLock(stateDir, SWITCH_LOCK, async () => {
    if (id !== undefined) {
      const current = await readSwitchRequest(stateDir).catch(() => undefined);
      if (current?.id !== id) return;
    }
    await unlink(path.join(stateDir, SWITCH_REQUEST)).catch(() => undefined);
  });
}

/**
 * Switch the supervisor's model with the intent journaled durably first, so a
 * crash before commit is reconciled on resume instead of guessed. A refused or
 * failed switch keeps the current model; it never falls back to another one.
 */
export async function applyModelSwitch(
  state: DurableRunState,
  supervisor: Supervisor,
  order: ModelSwitchOrder,
  origin: "supervisor" | "operator",
  afterIntent?: () => Promise<void>,
): Promise<DurableRunState> {
  const target = `${order.provider}/${order.modelId}`;
  const binding = state.supervisorBinding ?? readBinding(supervisor);
  const refused = async (why: string, current: string) => {
    await afterIntent?.();
    return noteOutcome(state, `${origin} model switch to ${target} refused: ${why}; continuing on ${current}`);
  };
  if (binding === undefined) {
    // Without a durable binding there is nowhere to journal the intent, so a
    // crash after the model changed could not be reconciled.
    return refused("the supervisor has no durable session binding", "the current model");
  }
  const current = `${binding.provider}/${binding.modelId}`;
  if (!supervisor.switchModel) {
    return refused("the supervisor cannot switch models", current);
  }

  const record = {
    at: new Date().toISOString(),
    from: { provider: binding.provider, modelId: binding.modelId },
    to: { provider: order.provider, modelId: order.modelId },
    reason: order.reason,
    status: "intent" as const,
  };
  state = { ...state, supervisorBinding: { ...binding, switchJournal: [...binding.switchJournal, record] } };
  await saveRunState(state);
  await afterIntent?.();

  let failure: string | undefined;
  try {
    await supervisor.switchModel({ provider: order.provider, modelId: order.modelId, reason: order.reason });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  // A supervisor with a binding journals every switch, refused ones included.
  const after = readBinding(supervisor);
  if (after !== undefined) {
    state = { ...state, supervisorBinding: after };
  } else {
    state = {
      ...state,
      supervisorBinding: {
        ...binding,
        switchJournal: [
          ...binding.switchJournal,
          failure === undefined ? { ...record, status: "committed" as const } : { ...record, status: "failed" as const, error: failure },
        ],
      },
    };
  }

  return noteOutcome(
    state,
    failure === undefined
      ? `${origin} switched the supervisor model to ${target}`
      : `${origin} model switch to ${target} failed: ${failure}; continuing on ${current}`,
  );
}

export function readBinding(supervisor: Supervisor): DurableRunState["supervisorBinding"] | undefined {
  const withBinding = supervisor as Supervisor & {
    binding?: DurableRunState["supervisorBinding"];
  };
  const b = withBinding.binding;
  if (!b) return undefined;
  return {
    sessionId: b.sessionId,
    ...(b.sessionFile !== undefined ? { sessionFile: b.sessionFile } : {}),
    provider: b.provider,
    modelId: b.modelId,
    switchJournal: structuredClone(b.switchJournal),
    ...(b.configuredModels !== undefined ? { configuredModels: structuredClone(b.configuredModels) } : {}),
  };
}
