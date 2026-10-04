#!/usr/bin/env node
/**
 * The Claude Code rehearsal stand-in (docs/design-graph-rehearsal.md §4.1):
 * spawned in place of the real `claude` binary by the unmodified
 * `createClaudeCodeHarness` adapter (`../claude-harness.js`), which only ever
 * chooses what command to run. This script speaks just enough of the
 * stream-json control protocol (NDJSON over stdin/stdout) to satisfy that
 * adapter — the `initialize` handshake, the one `user` turn it sends, and a
 * final `result` event — answering from the active rehearsal scenario
 * instead of a real model. It never requests a tool (effects are applied to
 * the worktree directly, as Pi's and Codex's stand-ins do), so it never has
 * to implement the `can_use_tool` permission exchange for real.
 *
 * The contract name travels via `JOB_CONTRACT_ENV` (set by `claude-harness.ts`
 * on this process's own environment, invisible to a real `claude`), since the
 * wire protocol itself only ever carries the schema, inlined into `--json-schema`,
 * never its name.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
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

const HARNESS_NAME = "claude-code";

interface Incoming {
  type?: string;
  request_id?: unknown;
  request?: { subtype?: unknown };
  message?: { content?: unknown };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // A graph's environment declaration (docs/design-graph-rehearsal.md §4.6)
  // may probe `claude --version`/`claude auth status` before ever dispatching
  // a turn (recognizable by the absence of -p, the headless-turn flag); a
  // stand-in answers as an installed, logged-in Claude Code would, without
  // needing a scenario (it is not impersonating a turn here).
  if (!argv.includes("-p")) {
    process.stdout.write("graphloom-rehearsal-claude-standin 0.0.0 (Claude Code)\n");
    return;
  }

  // Seam guard (§4.2): refuse before reading a single line of the protocol.
  const scenario = requireScenario(HARNESS_NAME);
  const contractName = process.env[JOB_CONTRACT_ENV];
  const identityRaw = process.env[JOB_IDENTITY_ENV];
  const identity = identityRaw !== undefined ? (JSON.parse(identityRaw) as JobIdentity) : undefined;

  let interrupted = false;
  let onInterrupt: (() => void) | undefined;
  const interruptedSignal = new Promise<void>((resolve) => {
    onInterrupt = resolve;
  });
  let onPrompt: ((text: string) => void) | undefined;
  const promptReceived = new Promise<string>((resolve) => {
    onPrompt = resolve;
  });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let event: Incoming;
    try {
      event = JSON.parse(line) as Incoming;
    } catch {
      return;
    }
    if (event === null || typeof event !== "object") return;
    if (event.type === "control_request" && typeof event.request_id === "string") {
      if (event.request?.subtype === "interrupt") {
        interrupted = true;
        onInterrupt?.();
      }
      // Every control request this stand-in can receive (initialize, interrupt, a
      // can_use_tool it never actually triggers) gets the same plain success ack.
      send({ type: "control_response", response: { request_id: event.request_id, subtype: "success", response: {} } });
      return;
    }
    if (event.type === "user" && typeof event.message?.content === "string") onPrompt?.(event.message.content);
  });

  const prompt = await Promise.race([promptReceived, interruptedSignal.then(() => undefined)]);
  rl.close();
  if (prompt === undefined) return; // interrupted before the turn even started

  // Confirms the prompt was read, the way the real CLI does under --replay-user-messages.
  send({ type: "user", isReplay: true, message: { role: "user", content: prompt } });
  if (contractName !== undefined) recordAssignment(contractName, prompt, HARNESS_NAME);
  recordCall({ ...(contractName !== undefined ? { contractName } : {}), ...identity });

  // Claude's schema travels inline on the CLI (--json-schema <wrapped>), not a file.
  const wrapped = flag(process.argv.slice(2), "--json-schema");
  const schema = wrapped !== undefined ? (JSON.parse(wrapped) as { properties?: { result?: Record<string, unknown> } }) : undefined;
  let reply = synthesizedRepliesOnly() ? undefined : nextReply(scenario, contractName);
  if (reply === undefined && contractName !== undefined && schema?.properties?.result !== undefined) {
    reply = { output: synthesizeFromSchema(schema.properties.result) };
  }
  if (reply?.fail !== undefined) {
    await settleFailure(reply.fail, interruptedSignal, () => interrupted);
    return;
  }
  if (reply?.output !== undefined) {
    // §4.4: Claude has no further turn to correct an invalid submission in —
    // the mutated reply fails client-side validation (claude-harness.ts) as
    // a named contract_violation, same as a real model's own mistake would.
    const adversarial =
      adversarialMutationOnly() && schema?.properties?.result !== undefined
        ? mutateAdversarially(reply, { schema: schema.properties.result })
        : undefined;
    const effective = adversarial?.reply ?? reply;
    const violations = checkAssignmentFidelity(prompt, effective.output, effective.harnessSupplied);
    if (violations.length > 0) {
      sendResult({ isError: true, result: `stand-in refuses: the assignment never asked for ${violations.join(", ")}` });
      return;
    }
    for (const effect of effective.effects ?? []) {
      const target = path.join(process.cwd(), effect.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, effect.bytes, "utf8");
    }
    sendResult({
      isError: false,
      result: "rehearsal stand-in submitted a result",
      structuredOutput: contractName !== undefined ? { result: effective.output } : undefined,
    });
    return;
  }
  // No contract named and no scripted reply: a plain, harmless turn.
  sendResult({ isError: false, result: "rehearsal stand-in: nothing to submit" });
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(args: { isError: boolean; result: string; structuredOutput?: unknown }): void {
  send({
    type: "result",
    subtype: args.isError ? "error_during_execution" : "success",
    is_error: args.isError,
    result: args.result,
    ...(args.structuredOutput !== undefined ? { structured_output: args.structuredOutput } : {}),
    usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

/** Mirrors the real `no-result`/`exit`/`hang` paths the real harness's parser and watchdog distinguish by. */
async function settleFailure(
  fail: NonNullable<RehearsalReply["fail"]>,
  interruptedSignal: Promise<void>,
  isInterrupted: () => boolean,
): Promise<void> {
  if (fail.kind === "no-result") {
    sendResult({ isError: false, result: "rehearsal stand-in: nothing to submit" });
    return;
  }
  if (fail.kind === "exit") {
    sendResult({ isError: true, result: fail.summary });
    return;
  }
  // hang: outlive the harness's own startup/response-timeout watchdog, which interrupts (then
  // SIGTERMs) this process; if that never fires, answer late with nothing submitted.
  await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, fail.ms)), interruptedSignal]);
  if (!isInterrupted()) sendResult({ isError: false, result: "rehearsal stand-in: nothing to submit" });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
