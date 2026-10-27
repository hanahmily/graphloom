// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import os from "node:os";
import path from "node:path";
import { defaultPiModelRuntime } from "@graphloom/agent-harness/pi";
import {
  bindingHarness,
  PI_HARNESS_CAPABILITIES,
  type HarnessProbe,
  type HarnessSession,
  type HarnessSessionRole,
  type SupervisorBinding,
  type SupervisorHarness,
  type SupervisorHost,
  type SupervisorModelRef,
} from "./harness.js";
import { createSupervisorHost, findConfigured } from "./host.js";
import {
  createPiSupervisorSession,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SUPERVISOR_PROVIDER,
  ensureProviderCredentials,
  isMiniMaxProvider,
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
} from "./pi-session.js";

/** Everything a Pi episode session is opened with except its model. */
export type PiSessionBase = Omit<CreatePiSupervisorSessionOptions, "provider" | "modelId" | "thinkingLevel" | "sessionFile">;

export interface PiHarnessOptions extends PiSessionBase {
  /** Models the operator configured, the initial one first; switches outside this set are refused. */
  configuredModels?: SupervisorModelRef[];
  /** Timeout for one candidate patch episode (see CreateSupervisorHostOptions). */
  patchTimeoutMs?: number;
  /** Operator fallback wait for a quota error with no reset time (see CreateSupervisorHostOptions). */
  quotaRetryMs?: number;
  /** First transient-error backoff (see CreateSupervisorHostOptions). */
  transientRetryBaseMs?: number;
  /**
   * Opens each session in place of a real Pi session (conformance tests and
   * other hosts of scripted sessions). Default: `piEpisodeSessionOpener`.
   */
  sessionOpener?: (model: SupervisorModelRef, role: HarnessSessionRole) => Promise<HarnessSession>;
}

export interface PiHarness extends SupervisorHarness {
  readonly name: "pi";
  /** A new logical supervisor on the first configured model (default MiniMax-M3 on minimax-cn). */
  start(): Promise<SupervisorHost>;
}

/**
 * Opens a new durable Pi session in `sessionDir` on a given model, for one
 * recovery episode. Every session the run's supervisor uses comes from here.
 */
export function piEpisodeSessionOpener(base: PiSessionBase): (model: SupervisorModelRef) => Promise<PiSupervisorSession> {
  // The explicit key is MiniMax's only: after a switch to another provider,
  // later episodes open on that provider's own Pi-stored credential.
  const { apiKey, ...shared } = base;
  return (model) =>
    createPiSupervisorSession({
      ...shared,
      ...(apiKey !== undefined && isMiniMaxProvider(model.provider) ? { apiKey } : {}),
      provider: model.provider,
      modelId: model.modelId,
      ...(model.thinkingLevel !== undefined ? { thinkingLevel: model.thinkingLevel } : {}),
    });
}

/**
 * The Pi supervisor harness: in-process Pi sessions with GraphLoom's
 * admission and inspection tools (design-pi-supervisor.md), one per recovery
 * episode, behind the harness-neutral host.
 */
export function createPiHarness(options: PiHarnessOptions): PiHarness {
  const { configuredModels, patchTimeoutMs, quotaRetryMs, transientRetryBaseMs, sessionOpener, ...base } = options;
  const piOpen = piEpisodeSessionOpener(base);
  const open = sessionOpener ?? ((model: SupervisorModelRef) => piOpen(model));
  const initial = (): SupervisorModelRef =>
    configuredModels?.[0] ?? { provider: DEFAULT_SUPERVISOR_PROVIDER, modelId: DEFAULT_SUPERVISOR_MODEL };
  const hostOptions = {
    ...(patchTimeoutMs !== undefined ? { patchTimeoutMs } : {}),
    ...(quotaRetryMs !== undefined ? { quotaRetryMs } : {}),
    ...(transientRetryBaseMs !== undefined ? { transientRetryBaseMs } : {}),
  };
  const harness: PiHarness = {
    name: "pi",
    capabilities: PI_HARNESS_CAPABILITIES,
    async probe(): Promise<HarnessProbe> {
      // A credential reference and a registered model; no provider call.
      const model = initial();
      const agentDir = base.agentDir ?? path.join(os.homedir(), ".pi", "agent");
      try {
        const modelRuntime = await defaultPiModelRuntime(agentDir);
        await ensureProviderCredentials({
          modelRuntime,
          provider: model.provider,
          agentDir,
          ...(base.apiKey !== undefined && isMiniMaxProvider(model.provider) ? { apiKey: base.apiKey } : {}),
        });
        if (modelRuntime.getModel(model.provider, model.modelId) === undefined) {
          return { ok: false, reason: `Pi model not found: ${model.provider}/${model.modelId}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    openSession: ({ model, role }) => open(model, role),
    async start() {
      const model = initial();
      return createSupervisorHost({
        harness,
        session: await open(model, "decide"),
        configuredModels: configuredModels ?? [model],
        ...hostOptions,
      });
    },
    async restore(binding: SupervisorBinding) {
      const pinned = bindingHarness(binding);
      if (pinned !== "pi") {
        throw new Error(`cannot restore supervisor: the binding is pinned to the ${pinned} harness, not pi`);
      }
      const configured = configuredModels ?? binding.configuredModels ?? configuredModelsFromBinding(binding);
      // The bound model may require a reasoning level other than the "off"
      // default (e.g. a model that rejects thinking disabled); it takes effect
      // when the session is created.
      const session = await open(findConfigured(configured, binding) ?? { provider: binding.provider, modelId: binding.modelId }, "decide");
      return createSupervisorHost({
        harness,
        session,
        logicalSessionId: binding.sessionId,
        configuredModels: configured,
        initialSwitchJournal: binding.switchJournal,
        ...hostOptions,
      });
    },
  };
  return harness;
}

/** Every model a binding names: the bound one and both ends of each journaled switch. */
export function configuredModelsFromBinding(binding: SupervisorBinding): SupervisorModelRef[] {
  const seen = new Map<string, SupervisorModelRef>();
  const add = (ref: SupervisorModelRef) => {
    seen.set(`${ref.provider}/${ref.modelId}`, ref);
  };
  add({ provider: binding.provider, modelId: binding.modelId });
  for (const entry of binding.switchJournal) {
    add(entry.from);
    add(entry.to);
  }
  return [...seen.values()];
}
