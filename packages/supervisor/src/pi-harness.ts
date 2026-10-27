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
  type HarnessStartOptions,
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
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
} from "./pi-session.js";

/** Everything a Pi episode session is opened with except its model. */
export type PiSessionBase = Omit<CreatePiSupervisorSessionOptions, "provider" | "modelId" | "thinkingLevel" | "sessionFile">;

/**
 * `apiKey` (inherited) is the explicit key of the first configured model's
 * provider; `apiKeys` (inherited) names explicit keys of any other provider.
 * Without one, each provider's own Pi credential is used.
 */
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
  /** A new logical supervisor on the first configured model (DEFAULT_SUPERVISOR_PROVIDER/MODEL when none is configured), or one continuing another harness's (§7.4). */
  start(options?: HarnessStartOptions): Promise<SupervisorHost>;
}

/**
 * Opens a new durable Pi session in `sessionDir` on a given model, for one
 * recovery episode. Every session the run's supervisor uses comes from here.
 */
export function piEpisodeSessionOpener(
  base: PiSessionBase,
  /** The provider `base.apiKey` belongs to. Default: DEFAULT_SUPERVISOR_PROVIDER. */
  keyProvider: string = DEFAULT_SUPERVISOR_PROVIDER,
): (model: SupervisorModelRef) => Promise<PiSupervisorSession> {
  // Each explicit key belongs to one provider: an episode on another provider
  // (after a switch) opens on that provider's own key, never this one.
  const { apiKey: _apiKey, apiKeys: _apiKeys, ...shared } = base;
  const keys = explicitKeys(base, keyProvider);
  return (model) =>
    createPiSupervisorSession({
      ...shared,
      ...(Object.keys(keys).length > 0 ? { apiKeys: keys } : {}),
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
  const initial = (): SupervisorModelRef =>
    configuredModels?.[0] ?? { provider: DEFAULT_SUPERVISOR_PROVIDER, modelId: DEFAULT_SUPERVISOR_MODEL };
  const keys = explicitKeys(base, initial().provider);
  const piOpen = piEpisodeSessionOpener(base, initial().provider);
  const open = sessionOpener ?? ((model: SupervisorModelRef) => piOpen(model));
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
          ...(keys[model.provider] !== undefined ? { apiKey: keys[model.provider] } : {}),
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
    async start(options: HarnessStartOptions = {}) {
      const model = initial();
      return createSupervisorHost({
        harness,
        session: await open(model, "decide"),
        configuredModels: configuredModels ?? [model],
        ...(options.logicalSessionId !== undefined ? { logicalSessionId: options.logicalSessionId } : {}),
        ...(options.switchJournal !== undefined ? { initialSwitchJournal: options.switchJournal } : {}),
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

/** Explicit keys by provider: `apiKeys`, plus `apiKey` for `keyProvider`. */
function explicitKeys(base: Pick<PiSessionBase, "apiKey" | "apiKeys">, keyProvider: string): Record<string, string> {
  return { ...(base.apiKeys ?? {}), ...(base.apiKey !== undefined ? { [keyProvider]: base.apiKey } : {}) };
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
