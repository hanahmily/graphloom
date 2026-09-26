import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRef, Supervisor } from "@graphloom/supervisor";
import { noteOutcome } from "./settlement.js";
import { saveRunState, type DurableRunState } from "./state.js";

const SWITCH_REQUEST = "supervisor-switch.json";

export interface ModelSwitchOrder extends ModelRef {
  reason: string;
}

/** Durable operator request, applied before the run's next supervisor prompt. */
export async function writeSwitchRequest(stateDir: string, order: ModelSwitchOrder): Promise<void> {
  await writeFile(
    path.join(stateDir, SWITCH_REQUEST),
    JSON.stringify({ ...order, requestedAt: new Date().toISOString() }),
    "utf8",
  );
}

export async function readSwitchRequest(stateDir: string): Promise<ModelSwitchOrder | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(stateDir, SWITCH_REQUEST), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<ModelSwitchOrder>;
  if (typeof parsed.provider !== "string" || typeof parsed.modelId !== "string") {
    throw new Error(`malformed ${SWITCH_REQUEST}: provider and modelId are required`);
  }
  return {
    provider: parsed.provider,
    modelId: parsed.modelId,
    reason: typeof parsed.reason === "string" ? parsed.reason : "operator request",
  };
}

export async function clearSwitchRequest(stateDir: string): Promise<void> {
  await unlink(path.join(stateDir, SWITCH_REQUEST)).catch(() => undefined);
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
  const current = binding !== undefined ? `${binding.provider}/${binding.modelId}` : "the current model";
  if (!supervisor.switchModel) {
    await afterIntent?.();
    return noteOutcome(state, `${origin} model switch to ${target} refused: the supervisor cannot switch models; continuing on ${current}`);
  }

  const record = {
    at: new Date().toISOString(),
    from: binding !== undefined ? { provider: binding.provider, modelId: binding.modelId } : { provider: "", modelId: "" },
    to: { provider: order.provider, modelId: order.modelId },
    reason: order.reason,
    status: "intent" as const,
  };
  if (binding !== undefined) {
    state = { ...state, supervisorBinding: { ...binding, switchJournal: [...binding.switchJournal, record] } };
    await saveRunState(state);
  }
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
  } else if (binding !== undefined) {
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
