/**
 * The command executor's rehearsal stand-in (docs/design-graph-rehearsal.md
 * §3.2, §4.1): quick mode's default. Loaded in place of `../executors.js`,
 * it serves the same `graphloom.command/run` executor id with the same input
 * validation as the real one, but answers each command from the active
 * scenario instead of actually spawning it — `make test-ci` and friends
 * dominate wall time, so a rehearsal skips them by default. `--commands run`
 * (full mode) uses the real executor module instead; this one never runs.
 *
 * Checkout preparation (which commit, which paths) stays entirely the
 * controller's own job, upstream of any executor; this stand-in only ever
 * sees `CommandInput`, the same as the real one, and never needs to know
 * about checkouts at all.
 */
import { defineExecutor, nextCommandOutcome, requireScenario, type ExecutorContext, type ExecutorDefinition } from "@graphloom/sdk";
import { COMMAND_INPUT_SHAPE, commandInputProblem, commandSucceeded, isCommandInput, COMMAND_RUN_ID, type CommandInput, type CommandOutcome } from "../run.js";

const STAND_IN_NAME = "command";

export function createCommandRehearsalExecutor(): ExecutorDefinition<CommandInput> {
  return defineExecutor<CommandInput, unknown>({
    id: COMMAND_RUN_ID,
    version: "1",
    effect: "write",
    inputSchema: isCommandInput,
    inputProblem: commandInputProblem,
    inputShape: COMMAND_INPUT_SHAPE,
    async execute(input, ctx: ExecutorContext) {
      // Seam guard (§4.2): refuse before touching anything else.
      const scenario = requireScenario(STAND_IN_NAME);
      const outcomes: CommandOutcome[] = [];
      for (const spec of input.commands) {
        if (ctx.signal?.aborted) break;
        const stubbed = nextCommandOutcome(scenario, spec.id);
        const outcome: CommandOutcome = {
          id: spec.id,
          argv: spec.argv,
          exitCode: stubbed?.exitCode ?? 0,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: 0,
          stdoutTail: stubbed?.stdout ?? "",
          stderrTail: stubbed?.stderr ?? "",
        };
        outcomes.push(outcome);
        if (!commandSucceeded(outcome) && input.continueOnFailure !== true) break;
      }
      const failed = outcomes.filter((o) => !commandSucceeded(o));
      const skipped = input.commands.length - outcomes.length;
      return {
        status: "ok",
        summary:
          failed.length === 0 && skipped === 0
            ? `${outcomes.length} command(s) succeeded (stand-in)`
            : `${failed.map((o) => `${o.id} exited ${o.exitCode}`).join("; ")}${skipped > 0 ? `; ${skipped} not run` : ""}`,
        evidence: outcomes.map((command) => ({ kind: "command" as const, payload: { command } })),
      };
    },
  });
}

export const executors = [createCommandRehearsalExecutor()];
