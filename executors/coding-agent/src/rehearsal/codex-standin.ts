#!/usr/bin/env node
/**
 * The Codex rehearsal stand-in (docs/design-graph-rehearsal.md §4.1): spawned
 * in place of the real `codex` binary by the unmodified `createCodexHarness`
 * adapter (`../codex-harness.js`), which only ever chooses what command to
 * run. This script speaks just enough of `codex exec --json`'s wire protocol
 * to satisfy that adapter — NDJSON progress on stdout, the result written to
 * the `--output-last-message` file — answering from the active rehearsal
 * scenario instead of a real model.
 *
 * Unlike the in-process Pi stand-in, there is no shared memory with the
 * process that spawned this one: the contract name travels via
 * `JOB_CONTRACT_ENV` (set by `codex-harness.ts` on this process's own
 * environment, invisible to a real `codex`), and the scenario/cursor/
 * assignment files travel via `REHEARSAL_SCENARIO_ENV`, read the same way
 * the Pi stand-in reads it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  adversarialMutationOnly,
  checkAssignmentFidelity,
  mutateAdversarially,
  synthesizeFromSchema,
  synthesizedRepliesOnly,
  type RehearsalReply,
} from "@graphloom/sdk";
import { JOB_CONTRACT_ENV, JOB_IDENTITY_ENV, type JobIdentity } from "../harness.js";
import { nextReply, recordAssignment, recordCall, requireScenario } from "./scenario.js";

const HARNESS_NAME = "codex";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // A graph's environment declaration (docs/design-graph-rehearsal.md §4.6)
  // may probe `codex --version`/`codex login status` before ever dispatching
  // a turn; a stand-in answers as an installed, logged-in Codex would,
  // without needing a scenario (it is not impersonating a turn here).
  if (argv[0] !== "exec") {
    process.stdout.write("graphloom-rehearsal-codex-standin 0.0.0\n");
    return;
  }

  // Seam guard (§4.2): refuse before parsing the rest of argv or touching the worktree.
  const scenario = requireScenario(HARNESS_NAME);

  const cwd = flag(argv, "--cd") ?? process.cwd();
  const lastMessageFile = flag(argv, "--output-last-message");
  const schemaFile = flag(argv, "--output-schema");
  const contractName = process.env[JOB_CONTRACT_ENV];
  const identityRaw = process.env[JOB_IDENTITY_ENV];
  const identity = identityRaw !== undefined ? (JSON.parse(identityRaw) as JobIdentity) : undefined;
  const prompt = await readStdin();
  if (contractName !== undefined) recordAssignment(contractName, prompt, HARNESS_NAME);
  recordCall({ ...(contractName !== undefined ? { contractName } : {}), ...identity });

  const schema = schemaFile !== undefined ? (JSON.parse(await readFile(schemaFile, "utf8")) as Record<string, unknown>) : undefined;
  let reply = synthesizedRepliesOnly() ? undefined : nextReply(scenario, contractName);
  if (reply === undefined && contractName !== undefined && schema !== undefined) {
    reply = { output: synthesizeFromSchema(schema) };
  }

  if (reply?.fail !== undefined) {
    await emitFailure(reply.fail);
    return;
  }
  if (reply?.output !== undefined) {
    // §4.4: Codex has no further turn to correct an invalid submission in —
    // the mutated reply fails client-side validation (codex-harness.ts) as
    // a named contract_violation, same as a real model's own mistake would.
    const adversarial =
      adversarialMutationOnly() && schema !== undefined ? mutateAdversarially(reply, { schema }) : undefined;
    const effective = adversarial?.reply ?? reply;
    const violations = checkAssignmentFidelity(prompt, effective.output, effective.harnessSupplied);
    if (violations.length > 0) {
      emit({ type: "turn.failed", error: { message: `stand-in refuses: the assignment never asked for ${violations.join(", ")}` } });
      process.exitCode = 1;
      return;
    }
    for (const effect of effective.effects ?? []) {
      const target = path.join(cwd, effect.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, effect.bytes, "utf8");
    }
    if (lastMessageFile !== undefined) await writeFile(lastMessageFile, JSON.stringify(effective.output), "utf8");
    completeTurn();
    return;
  }
  // No contract named and no scripted reply: a plain, harmless turn.
  if (lastMessageFile !== undefined) await writeFile(lastMessageFile, "rehearsal stand-in: nothing to submit", "utf8");
  completeTurn();
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function completeTurn(): void {
  emit({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 200, cache_write_input_tokens: 0 } });
}

/** Mirrors the real `no-result`/`exit`/`hang` paths the real harness's watchdog and parser distinguish by. */
async function emitFailure(fail: NonNullable<RehearsalReply["fail"]>): Promise<void> {
  if (fail.kind === "no-result") {
    // Leaves the last-message file unwritten: the harness reads "" and fails with "no result".
    completeTurn();
    return;
  }
  if (fail.kind === "exit") {
    emit({ type: "turn.failed", error: { message: fail.summary } });
    process.exitCode = 1;
    return;
  }
  // hang: outlive the harness's own response-timeout watchdog, which SIGTERMs this process;
  // if that never fires (a generous or disabled timeout), answer late with nothing submitted.
  await new Promise((resolve) => setTimeout(resolve, fail.ms));
  completeTurn();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
