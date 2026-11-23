// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The command executor's input bounds (`graphloom.command/run`, executors/command/src/run.ts), as the graph plans
 * against them (design §6.8). A command over one is rejected before it runs and leaves no run behind, so a graph that
 * plans from its evidence would plan the same command again, forever: every command the graph builds is checked here
 * first, and a job is never dispatched with one over a bound (`commandJobProblem`). The executor declares the same
 * numbers as its input shape; a test holds these equal to its own validator.
 */
import { BUILTIN_COMMAND_EXECUTOR_ID, jsonSchemaProblem, MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type JobSpec, type RunView } from "@graphloom/sdk";

/** Commands one job may hold. */
export const MAX_JOB_COMMANDS = 16;
/** Strings one command's argv may hold, the program included. */
export const MAX_ARGV = 64;
/** Characters (UTF-16 units) one argv string may hold. */
export const MAX_ARG_CHARS = 4_096;
/** A command id. */
export const COMMAND_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Bytes of a job's serialized input left for what is not a command (env, flags), so a packed job still fits. */
export const JOB_INPUT_RESERVE_BYTES = 8_192;
/** The longest path the graph passes to a command as one argument: well under `MAX_ARG_CHARS`, so a rename's two paths fit too. */
export const MAX_PATH_ARG_CHARS = 1_024;

/** Why one command is over the executor's bounds, or undefined when it is within them. */
export function commandProblem(c: EnvironmentCommand): string | undefined {
  if (!COMMAND_ID_PATTERN.test(c.id)) return `${c.id}: the id must match ${COMMAND_ID_PATTERN.source}`;
  if (c.argv.length === 0 || c.argv.length > MAX_ARGV) return `${c.id}: the argv holds ${c.argv.length} strings; the command executor takes 1-${MAX_ARGV}`;
  const long = c.argv.findIndex((a) => a.length > MAX_ARG_CHARS);
  if (long >= 0) return `${c.id}: argv[${long}] is ${c.argv[long]!.length} characters; the command executor takes at most ${MAX_ARG_CHARS}`;
  if (c.argv[0] === "") return `${c.id}: the program is empty`;
  const bytes = inputBytes([c]);
  if (bytes > MAX_EXECUTOR_INPUT_BYTES - JOB_INPUT_RESERVE_BYTES) return `${c.id}: the command alone is ${bytes} bytes once serialized, more than a job's input carries`;
  return undefined;
}

export const commandFits = (c: EnvironmentCommand): boolean => commandProblem(c) === undefined;

const inputBytes = (commands: readonly EnvironmentCommand[]): number => Buffer.byteLength(JSON.stringify({ commands }), "utf8");

/** The longest prefix of `commands` one job carries: at most `MAX_JOB_COMMANDS`, within the input's bytes. Every command is assumed to fit alone (`commandFits`). */
export function fitJob(commands: readonly EnvironmentCommand[]): EnvironmentCommand[] {
  const out: EnvironmentCommand[] = [];
  for (const c of commands) {
    if (out.length >= MAX_JOB_COMMANDS) break;
    if (out.length > 0 && inputBytes([...out, c]) > MAX_EXECUTOR_INPUT_BYTES - JOB_INPUT_RESERVE_BYTES) break;
    out.push(c);
  }
  return out;
}

/**
 * Why a job the graph is about to dispatch would be rejected by the command executor before it runs, or undefined when
 * it would not (or is not a built-in command job). It checks the kit's bounds, the input's serialized size, and the
 * input shape the executor declares in the run view when there is one.
 */
export function commandJobProblem(job: JobSpec, view?: Pick<RunView, "executors">): string | undefined {
  if (job.kind !== "command" || (job.executor !== undefined && job.executor.id !== BUILTIN_COMMAND_EXECUTOR_ID)) return undefined;
  const input = job.input as { commands?: unknown } | undefined;
  if (input === undefined || input === null || !Array.isArray(input.commands)) return undefined;
  const commands = input.commands as EnvironmentCommand[];
  if (commands.length === 0 || commands.length > MAX_JOB_COMMANDS) return `the job holds ${commands.length} commands; the command executor takes 1-${MAX_JOB_COMMANDS}`;
  for (const c of commands) {
    const problem = commandProblem(c);
    if (problem !== undefined) return problem;
  }
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (bytes > MAX_EXECUTOR_INPUT_BYTES) return `the job's input is ${bytes} bytes once serialized; an executor input carries at most ${MAX_EXECUTOR_INPUT_BYTES}`;
  const shape = view?.executors?.find((e) => e.id === BUILTIN_COMMAND_EXECUTOR_ID)?.inputShape;
  return shape !== undefined ? jsonSchemaProblem(shape.schema, input) : undefined;
}
