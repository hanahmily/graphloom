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

/**
 * Validators that evaluate via the plugin host (child process), never by
 * importing bundle code into the controller.
 */
export function createHostValidators(
  host: PluginHost,
  validatorIds: string[],
  ctxBase: { runId: string; stateRevision: number },
): Record<string, ControllerValidator> {
  if (!host.evaluate) {
    throw new Error("plugin host does not support evaluate");
  }
  const evaluate = host.evaluate.bind(host);
  const out: Record<string, ControllerValidator> = {};
  let seq = 0;
  for (const validatorId of validatorIds) {
    out[validatorId] = {
      async evaluate(input: ValidationInput): Promise<ValidationResult> {
        seq += 1;
        const result = await evaluate(
          {
            runId: ctxBase.runId,
            operationId: `eval-${validatorId}-${seq}`,
            expectedStateRevision: ctxBase.stateRevision,
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
