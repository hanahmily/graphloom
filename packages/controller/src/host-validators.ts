// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { isEvidenceUnavailable } from "@graphloom/sdk";
import type {
  ValidationInput,
  ValidationResult,
} from "@graphloom/sdk";
import type { ChildObservation, PluginHost } from "@graphloom/plugin-host";
import { hydratedInput } from "./evidence.js";

/** Sync SDK validators or async host-backed evaluators. */
export interface ControllerValidator {
  /** True: the validator's host reads externalized evidence itself, so inputs go to it as recorded. */
  readsExternalizedEvidence?: boolean;
  evaluate(input: ValidationInput): ValidationResult | Promise<ValidationResult>;
}

export interface HostValidatorContext {
  runId: string;
  /** The run's state directory, where externalized evidence lives. */
  stateDir: string;
  /** Always read the live revision — never capture a stale snapshot. */
  getStateRevision: () => number;
}

/**
 * Host crash/timeout/malformed during evaluate — must be contained by the
 * controller loop (recovery or concrete stop), not thrown out of `run`.
 */
export class HostObservationError extends Error {
  readonly code: ChildObservation["code"];

  constructor(code: ChildObservation["code"], message: string) {
    super(message);
    this.name = "HostObservationError";
    this.code = code;
  }
}

/**
 * Validators that evaluate via the plugin host (child process), never by
 * importing bundle code into the controller.
 * `getHost` is re-read each call so a post-crash host replacement is used.
 */
export function createHostValidators(
  getHost: () => PluginHost,
  validatorIds: string[],
  ctxBase: HostValidatorContext,
): Record<string, ControllerValidator> {
  const initial = getHost();
  if (!initial.evaluate) {
    throw new Error("plugin host does not support evaluate");
  }
  const out: Record<string, ControllerValidator> = {};
  let seq = 0;
  for (const validatorId of validatorIds) {
    out[validatorId] = {
      readsExternalizedEvidence: true,
      async evaluate(input: ValidationInput): Promise<ValidationResult> {
        const host = getHost();
        if (!host.evaluate) {
          throw new HostObservationError(
            "internal",
            `validator ${validatorId}: evaluate unavailable after host replacement`,
          );
        }
        seq += 1;
        // A host that reads externalized parts itself gets them as recorded; any other gets them hydrated here.
        let sent = input;
        try {
          if (host.hydratesEvidence !== true) sent = hydratedInput(ctxBase.stateDir, input);
        } catch (err) {
          if (!isEvidenceUnavailable(err)) throw err;
          throw new HostObservationError("evidence_unavailable", `validator ${validatorId} host error: ${err instanceof Error ? err.message : String(err)}`);
        }
        const result = await host.evaluate(
          {
            runId: ctxBase.runId,
            operationId: `eval-${validatorId}-${seq}`,
            expectedStateRevision: ctxBase.getStateRevision(),
          },
          validatorId,
          sent,
        );
        if (!result.ok) {
          throw new HostObservationError(
            result.observation.code,
            `validator ${validatorId} host error: ${result.observation.code}: ${result.observation.message}`,
          );
        }
        return result.value;
      },
    };
  }
  return out;
}
