// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Claude Code supervisor harness on the fake `claude` CLI
 * (`packages/supervisor/test/fake-claude.mjs`), for tests only: a scratch
 * Claude Code config dir and session dir, the fake's step queue and log, and
 * conversion of the conformance suite's scripts into the fake's steps.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Launch } from "@graphloom/agent-harness/launch";
import { createClaudeSupervisorHarness, type ClaudeSupervisorHarness, type ClaudeSupervisorHarnessOptions } from "../claude-harness.js";
import type { HarnessSession, SupervisorModelRef } from "../harness.js";
import type { ProviderFailure } from "../provider-failure.js";
import type { ScriptLog, ScriptStep } from "./scripted-harness.js";

export const FAKE_CLAUDE = fileURLToPath(new URL("../../test/fake-claude.mjs", import.meta.url));

/** One native tool call the fake streams (see fake-claude.mjs). */
export interface FakeObservation {
  tool: string;
  input: unknown;
  output?: unknown;
  exitCode?: number;
  ask?: boolean;
  run?: string;
}

/** One answer of the fake CLI (see fake-claude.mjs). */
export type FakeStep =
  | { observe?: FakeObservation[]; text: string }
  | { observe?: FakeObservation[]; empty: true }
  | { observe?: FakeObservation[]; error: string }
  | { hang: true }
  | { crash: string };

export interface FakeClaudeLogEntry {
  argv: string[];
  cwd: string;
  prompt: string;
  sessionId: string;
  resumed: boolean;
  apiKey: string | null;
  configDir: string;
}

export interface FakeClaude {
  dir: string;
  configDir: string;
  sessionDir: string;
  /** The launch that runs the fake in place of `claude`. */
  launch: Launch;
  /** What each process the fake ran received. */
  invocations(): FakeClaudeLogEntry[];
  /** Steps not yet taken. */
  remaining(): number;
  /** Replace the queue. */
  queue(steps: FakeStep[]): void;
}

/** A fake CLI with its own config dir, session dir, and step queue. */
export function fakeClaude(steps: FakeStep[] = []): FakeClaude {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-fake-claude-"));
  const configDir = path.join(dir, "claude-config");
  const sessionDir = path.join(dir, "state", "supervisor", "claude-code");
  mkdirSync(configDir, { recursive: true });
  const queueFile = path.join(dir, "queue.json");
  const logFile = path.join(dir, "log.jsonl");
  writeFileSync(queueFile, JSON.stringify(steps));
  writeFileSync(logFile, "");
  const launch: Launch = (_command, args, env) => ({
    command: process.execPath,
    args: [FAKE_CLAUDE, ...args],
    env: { ...env, FAKE_CLAUDE_QUEUE: queueFile, FAKE_CLAUDE_LOG: logFile },
  });
  return {
    dir,
    configDir,
    sessionDir,
    launch,
    invocations: () =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as FakeClaudeLogEntry),
    remaining: () => (JSON.parse(readFileSync(queueFile, "utf8")) as unknown[]).length,
    queue: (next) => writeFileSync(queueFile, JSON.stringify(next)),
  };
}

/** Failure text Claude Code reports that the harness classifies as `failure`'s class. */
export function claudeFailureText(failure: ProviderFailure): string {
  switch (failure.failureClass) {
    case "quota":
      return failure.retryAt !== undefined ? `You've hit your session limit · resets ${failure.retryAt}` : "You've hit your usage limit";
    case "transient":
      return `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;
    case "overflow":
      return "Prompt is too long";
    case "auth":
      return "Not logged in · Please run /login";
    default:
      return failure.message;
  }
}

/** A conformance script step as the fake CLI's answer. */
export function fakeStepFor(step: ScriptStep): FakeStep {
  const observe = step.observe?.map((o) => ({ tool: o.tool, input: o.input, output: o.output, ...(o.exitCode !== undefined ? { exitCode: o.exitCode } : {}) }));
  const withObserve = observe !== undefined ? { observe } : {};
  if ("timeout" in step) return { hang: true };
  if ("fail" in step) return { ...withObserve, error: claudeFailureText(step.fail) };
  if ("empty" in step) return { ...withObserve, empty: true };
  if ("text" in step) return { ...withObserve, text: step.text };
  if ("inspect" in step) return { ...withObserve, text: JSON.stringify({ inspect: step.inspect }) };
  if ("switchModel" in step) return { ...withObserve, text: JSON.stringify({ switch_model: step.switchModel }) };
  return {
    ...withObserve,
    text: ["Investigated; deciding.", "```json", JSON.stringify({ ...step.decide, ...(step.findings !== undefined ? { findings: step.findings } : {}) }), "```"].join("\n"),
  };
}

/** Records what the host did with each session, in the conformance suite's log shape. */
export function loggingSessions(log: ScriptLog): NonNullable<ClaudeSupervisorHarnessOptions["observeSession"]> {
  let opened = 0;
  return (session, { model, role }) => {
    opened += 1;
    const id = `claude-session-${opened}`;
    log.opened.push({ session: id, model: `${model.provider}/${model.modelId}`, role });
    const wrapped: HarnessSession = {
      ...session,
      provider: session.provider,
      modelId: session.modelId,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      prompt(text, options) {
        log.prompts.push({ session: id, text });
        return session.prompt(text, options);
      },
      async setModel(ref) {
        log.setModel.push({ session: id, model: `${ref.provider}/${ref.modelId}` });
        return session.setModel(ref);
      },
      ...(session.grantCandidateCoding !== undefined
        ? {
            async grantCandidateCoding(root: string) {
              log.granted.push({ session: id, root });
              return session.grantCandidateCoding!(root);
            },
            async revokeCandidateCoding() {
              log.revoked.push(id);
              return session.revokeCandidateCoding?.();
            },
          }
        : {}),
      async close() {
        log.closed.push(id);
        return session.close();
      },
    };
    return wrapped;
  };
}

/** A Claude Code harness on a fake CLI, unconfined, with short watchdogs. */
export function fakeClaudeHarness(
  fake: FakeClaude,
  options: Partial<ClaudeSupervisorHarnessOptions> & { configuredModels?: SupervisorModelRef[] } = {},
): ClaudeSupervisorHarness {
  return createClaudeSupervisorHarness({
    runId: "run-fake",
    sessionDir: fake.sessionDir,
    configDir: fake.configDir,
    allowUnconfined: true,
    confinement: { launch: fake.launch, unsupported: async () => undefined },
    promptTimeoutMs: 3_000,
    killGraceMs: 500,
    interruptGraceMs: 300,
    readHelp: async () => {
      const { execFileSync } = await import("node:child_process");
      return execFileSync(process.execPath, [FAKE_CLAUDE, "--help"], { encoding: "utf8" });
    },
    loggedIn: async () => true,
    ...options,
  });
}
