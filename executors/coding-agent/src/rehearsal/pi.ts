/**
 * The Pi rehearsal stand-in (docs/design-graph-rehearsal.md §4.1): the real
 * `createPiHarness` runs the session, its tools, `submit_result`'s
 * validation and in-turn correction, and budget reservation — only the
 * model is a faux provider, scripted per request from the active scenario.
 * Loaded in place of `./pi.js` when a rehearsal enables Pi.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type JsonObject } from "@earendil-works/pi-ai";
import {
  adversarialMutationOnly,
  checkAssignmentFidelity,
  mutateAdversarially,
  synthesizeFromSchema,
  synthesizedRepliesOnly,
  type RehearsalReply,
} from "@graphloom/sdk";
import { createPiHarness } from "../pi-harness.js";
import type { CodingHarness, CodingRunResult } from "../harness.js";
import { nextReply, recordAssignment, recordCall, rehearsalHomeDir, requireScenario } from "./scenario.js";

const HARNESS_NAME = "pi";

/** Default export for `GRAPHLOOM_CODING_HARNESS` pointing at this module. */
export const harness: CodingHarness = createPiRehearsalHarness();

export function createPiRehearsalHarness(): CodingHarness {
  const faux = fauxProvider({ provider: "graphloom-rehearsal-pi" });
  // §4.6: never an operator's real ~/.pi/agent. A real rehearsal always sets
  // REHEARSAL_HOME_ENV; this only guards a direct call without one.
  const agentDir = rehearsalHomeDir("pi-agent") ?? path.join(os.tmpdir(), "graphloom-rehearsal-pi-agent");
  const real = createPiHarness({
    provider: faux.provider.id,
    modelId: faux.getModel().id,
    agentDir,
    async createModelRuntime(dir) {
      await mkdir(dir, { recursive: true });
      const runtime = await ModelRuntime.create({
        authPath: path.join(dir, "auth.json"),
        modelsPath: path.join(dir, "models.json"),
      });
      runtime.registerNativeProvider(faux.provider);
      return runtime;
    },
  });
  return {
    name: HARNESS_NAME,
    ...(real.resumable !== undefined ? { resumable: real.resumable } : {}),
    async createSession(options) {
      // Seam guard (§4.2): refuse before touching the real session at all.
      requireScenario(HARNESS_NAME);
      const session = await real.createSession(options);
      return {
        async run(request): Promise<CodingRunResult> {
          const scenario = requireScenario(HARNESS_NAME);
          const contractName = request.resultContract?.name;
          recordAssignment(contractName, request.assignment, HARNESS_NAME, request.resultContract?.knownReferences);
          recordCall({ ...(contractName !== undefined ? { contractName } : {}), ...request.identity });
          const reply =
            (synthesizedRepliesOnly() ? undefined : nextReply(scenario, contractName)) ??
            (request.resultContract !== undefined
              ? { output: synthesizeFromSchema(request.resultContract.schema) }
              : undefined);

          if (reply?.fail !== undefined) {
            faux.setResponses([failureStep(reply.fail)]);
            return session.run(request);
          }
          if (reply?.output !== undefined) {
            const adversarial =
              adversarialMutationOnly() && request.resultContract !== undefined
                ? mutateAdversarially(reply, request.resultContract)
                : undefined;
            const effective = adversarial?.reply ?? reply;
            const violations = checkAssignmentFidelity(request.assignment, effective.output, effective.harnessSupplied);
            if (violations.length > 0) {
              return {
                status: "failed",
                summary: `stand-in refuses: the assignment never asked for ${violations.join(", ")}`,
              };
            }
            for (const effect of effective.effects ?? []) {
              const target = path.join(options.cwd, effect.path);
              await mkdir(path.dirname(target), { recursive: true });
              await writeFile(target, effect.bytes, "utf8");
            }
            if (adversarial?.mutation === "dropped-property") {
              // §4.4/§4.2: proves Pi's own in-turn rejection and re-prompt —
              // the first call is genuinely invalid, and the model (here, the
              // scripted follow-up step) sees the real rejection text and
              // resubmits the original, uncorrupted reply, which succeeds.
              faux.setResponses([
                fauxAssistantMessage(fauxToolCall("submit_result", jsonObject(effective.output)), { stopReason: "toolUse" }),
                () => fauxAssistantMessage(fauxToolCall("submit_result", jsonObject(reply.output)), { stopReason: "toolUse" }),
              ]);
              return session.run(request);
            }
            faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", jsonObject(effective.output)), { stopReason: "toolUse" })]);
            return session.run(request);
          }
          // No contract named and no scripted reply: a plain, harmless turn.
          faux.setResponses([fauxAssistantMessage("rehearsal stand-in: nothing to submit")]);
          return session.run(request);
        },
        ...(session.dispose !== undefined ? { dispose: session.dispose } : {}),
      };
    },
  };
}

/** `reply.output` is parsed scenario JSON or schema-synthesized — always JSON-safe at runtime. */
function jsonObject(value: unknown): JsonObject {
  return (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}) as JsonObject;
}

function failureStep(fail: NonNullable<RehearsalReply["fail"]>): FauxResponseStep {
  if (fail.kind === "no-result") return fauxAssistantMessage("rehearsal stand-in: finishing without submitting a result");
  if (fail.kind === "exit") {
    return () => {
      throw new Error(fail.summary);
    };
  }
  // hang: delay ms, then answer normally — unless the job's own timeout aborts the turn first.
  return (_context, streamOptions) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fauxAssistantMessage("rehearsal stand-in: answered after a scripted delay")), fail.ms);
      streamOptions?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
        },
        { once: true },
      );
    });
}
