import type {
  ValidationInput,
  ValidationResult,
} from "@graphloom/sdk";
import type { PluginHost } from "@graphloom/plugin-host";
import { AdmissionError } from "./admit.js";

/** Controller-side validator: may evaluate remotely via the plugin host. */
export interface ControllerValidator {
  evaluate(input: ValidationInput): ValidationResult | Promise<ValidationResult>;
}

export interface HostValidatorContext {
  runId: string;
  /** Always read the live revision — never capture a stale snapshot. */
  getStateRevision: () => number;
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
      async evaluate(input: ValidationInput): Promise<ValidationResult> {
        const host = getHost();
        if (!host.evaluate) {
          throw new AdmissionError(
            `validator ${validatorId} host error: evaluate unavailable after host replacement`,
          );
        }
        seq += 1;
        const result = await host.evaluate(
          {
            runId: ctxBase.runId,
            operationId: `eval-${validatorId}-${seq}`,
            expectedStateRevision: ctxBase.getStateRevision(),
          },
          validatorId,
          input,
        );
        if (!result.ok) {
          throw new AdmissionError(
            `validator ${validatorId} host error: ${result.observation.code}: ${result.observation.message}`,
          );
        }
        return result.value;
      },
    };
  }
  return out;
}
