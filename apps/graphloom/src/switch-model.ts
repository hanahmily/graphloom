// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom switch-model`'s target (design-supervisor-harnesses.md §4.4):
 * a model of the harness the run's supervisor is pinned to, from the
 * operator's models for that harness. A model on another harness is refused,
 * and the refusal points to `resume --supervisor`.
 */
import { pinnedSupervisorHarness, type DurableRunState } from "@graphloom/controller";
import { bindingHarness, CLAUDE_CODE_HARNESS, CODEX_HARNESS, type SupervisorModelRef } from "@graphloom/supervisor";
import { harnessModels, parseModelRef, type SupervisorConfig } from "./supervisor-config.js";

const CLI_HARNESSES: readonly string[] = [CLAUDE_CODE_HARNESS, CODEX_HARNESS];

/**
 * The model `text` names for the run: `provider/model` for Pi;
 * `claude-code/<name>` or `codex/<name>`, or the bare name when the run is
 * pinned to that CLI harness. Checked against the operator's models for the
 * pinned harness when a supervisor config exists.
 */
export function switchModelTarget(
  text: string,
  config: SupervisorConfig | undefined,
  state: Pick<DurableRunState, "supervisorSelection" | "supervisorBinding" | "runId">,
): SupervisorModelRef {
  const pinned = pinnedSupervisorHarness(state) ?? (state.supervisorBinding !== undefined ? bindingHarness(state.supervisorBinding) : undefined);
  const prefix = CLI_HARNESSES.find((h) => text.startsWith(`${h}/`));
  let target: SupervisorModelRef;
  if (prefix !== undefined) target = { provider: prefix, modelId: text.slice(prefix.length + 1) };
  else if (pinned !== undefined && CLI_HARNESSES.includes(pinned) && !text.includes("/")) target = { provider: pinned, modelId: text };
  else target = parseModelRef(text);
  if (target.modelId === "") throw new Error(`expected a model name after ${prefix}/`);
  const targetHarness = CLI_HARNESSES.includes(target.provider) ? target.provider : "pi";
  if (pinned !== undefined && targetHarness !== pinned) {
    throw new Error(
      `${text} is a ${targetHarness} model, but run ${state.runId}'s supervisor is pinned to ${pinned}; switch-model takes a model of the pinned harness. To move the run to ${targetHarness}, stop it and run graphloom resume ${state.runId} --supervisor ${targetHarness}`,
    );
  }
  if (config !== undefined) {
    const models = harnessModels(config, targetHarness as Parameters<typeof harnessModels>[1]);
    const found = models.find((m) => m.provider === target.provider && m.modelId === target.modelId);
    if (found === undefined) {
      const names = models.map((m) => `${m.provider}/${m.modelId}`).join(", ");
      throw new Error(`${text} is not among the operator's ${targetHarness} supervisor models (${names})`);
    }
    return { provider: found.provider, modelId: found.modelId };
  }
  return target;
}
