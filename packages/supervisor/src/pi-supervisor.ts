// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Pi supervisor as it was named before the harness-neutral host: a
 * `createSupervisorHost` over the Pi harness, given its sessions directly.
 * Kept so callers and tests that build a Pi supervisor from sessions need no
 * change; new code builds the host from a harness (`createPiHarness`).
 */
import { PI_HARNESS_CAPABILITIES, type SupervisorBinding, type SupervisorHarness, type SupervisorHost, type SupervisorModelRef } from "./harness.js";
import { createSupervisorHost, type CreateSupervisorHostOptions } from "./host.js";
import type { PiSupervisorSession } from "./pi-session.js";

export {
  buildInspectResultPrompt,
  buildReaskPrompt,
  buildRecoveryPrompt,
  buildRejectionPrompt,
  buildRepairPrompt,
  findConfigured,
  nextConfiguredModel,
  type ModelSwitchRecord,
  type SupervisorBinding,
  type SupervisorModelRef,
} from "./host.js";

export type PiSupervisorSessionPort = PiSupervisorSession;

/** A Pi-backed supervisor host. */
export type PiSupervisor = SupervisorHost;

export interface CreatePiSupervisorOptions extends Omit<CreateSupervisorHostOptions, "harness" | "session"> {
  /** The first episode's session; it may not have been prompted yet. */
  session: PiSupervisorSessionPort;
  /**
   * Open a fresh session on `model` for a new recovery episode. Each episode
   * then starts with no earlier chat: its memory of past episodes is the
   * controller's case file in the prompt. Omitted (tests, hosts that cannot
   * open sessions), every episode shares `session`.
   */
  openSession?: (model: SupervisorModelRef) => Promise<PiSupervisorSessionPort>;
}

/**
 * Pi-backed recovery supervisor: the supervisor host over a Pi harness whose
 * sessions come from `openSession` (see createSupervisorHost).
 */
export function createPiSupervisor(options: CreatePiSupervisorOptions): PiSupervisor {
  const { session, openSession, ...rest } = options;
  const harness: SupervisorHarness = {
    name: "pi",
    capabilities: PI_HARNESS_CAPABILITIES,
    probe: async () => ({ ok: true }),
    ...(openSession !== undefined ? { openSession: ({ model }) => openSession(model) } : {}),
    restore: async (binding: SupervisorBinding) => {
      if (openSession === undefined) throw new Error("this Pi supervisor cannot open sessions to restore from a binding");
      return createPiSupervisor({
        ...rest,
        session: await openSession(findBound(rest.configuredModels ?? binding.configuredModels, binding)),
        openSession,
        logicalSessionId: binding.sessionId,
        initialSwitchJournal: binding.switchJournal,
      });
    },
  };
  return createSupervisorHost({ ...rest, harness, session });
}

function findBound(configured: SupervisorModelRef[] | undefined, binding: SupervisorBinding): SupervisorModelRef {
  return (
    configured?.find((m) => m.provider === binding.provider && m.modelId === binding.modelId) ?? {
      provider: binding.provider,
      modelId: binding.modelId,
    }
  );
}
