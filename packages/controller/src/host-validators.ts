import type {
  ValidationInput,
  ValidationResult,
} from "@graphloom/sdk";
import type { ChildObservation, PluginHost } from "@graphloom/plugin-host";

/** Sync SDK validators or async host-backed evaluators. */
export interface ControllerValidator {
  evaluate(input: ValidationInput): ValidationResult | Promise<ValidationResult>;
}

export interface HostValidatorContext {
  runId: string;
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
      async evaluate(input: ValidationInput): Promise<ValidationResult> {
        const host = getHost();
        if (!host.evaluate) {
          throw new HostObservationError(
            "internal",
            `validator ${validatorId}: evaluate unavailable after host replacement`,
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
