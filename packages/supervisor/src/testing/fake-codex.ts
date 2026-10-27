// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Codex supervisor harness on the fake `codex` CLI
 * (`packages/supervisor/test/fake-codex.mjs`), for tests only: a scratch
 * Codex home and session dir, the fake's step queue and log, and conversion
 * of the conformance suite's scripts into the fake's steps.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Launch } from "@graphloom/agent-harness/launch";
import { createCodexSupervisorHarness, type CodexSupervisorHarness, type CodexSupervisorHarnessOptions } from "../codex-harness.js";
import type { SupervisorModelRef } from "../harness.js";
import type { ProviderFailure } from "../provider-failure.js";
import type { ScriptedObservation, ScriptStep } from "./scripted-harness.js";

export const FAKE_CODEX = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));

/** One item the fake streams (see fake-codex.mjs). */
export type FakeCodexItem =
  | { type: "command_execution"; command: string; output?: string; exitCode?: number; run?: string }
  | { type: "file_change"; path: string; content?: string; kind?: string }
  | ({ type: string } & Record<string, unknown>);

/** One answer of the fake CLI (see fake-codex.mjs). */
export type FakeCodexStep =
  | { observe?: FakeCodexItem[]; text: string }
  | { observe?: FakeCodexItem[]; empty: true }
  | { observe?: FakeCodexItem[]; error: string }
  | { hang: true }
  | { crash: string };

export interface FakeCodexLogEntry {
  argv: string[];
  cwd: string;
  prompt: string;
  threadId: string;
  resumed: boolean;
  apiKey: string | null;
  codexHome: string | null;
}

export interface FakeCodex {
  dir: string;
  codexHome: string;
  sessionDir: string;
  /** The launch that runs the fake in place of `codex`. */
  launch: Launch;
  /** What each process the fake ran received. */
  invocations(): FakeCodexLogEntry[];
  /** Steps not yet taken. */
  remaining(): number;
  /** Replace the queue. */
  queue(steps: FakeCodexStep[]): void;
}

/** A fake CLI with its own Codex home, session dir, and step queue. */
export function fakeCodex(steps: FakeCodexStep[] = []): FakeCodex {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-fake-codex-"));
  const codexHome = path.join(dir, "codex-home");
  const sessionDir = path.join(dir, "state", "supervisor", "codex");
  mkdirSync(codexHome, { recursive: true });
  const queueFile = path.join(dir, "queue.json");
  const logFile = path.join(dir, "log.jsonl");
  writeFileSync(queueFile, JSON.stringify(steps));
  writeFileSync(logFile, "");
  const launch: Launch = (_command, args, env) => ({
    command: process.execPath,
    args: [FAKE_CODEX, ...args],
    env: { ...env, FAKE_CODEX_QUEUE: queueFile, FAKE_CODEX_LOG: logFile },
  });
  return {
    dir,
    codexHome,
    sessionDir,
    launch,
    invocations: () =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as FakeCodexLogEntry),
    remaining: () => (JSON.parse(readFileSync(queueFile, "utf8")) as unknown[]).length,
    queue: (next) => writeFileSync(queueFile, JSON.stringify(next)),
  };
}

/** Failure text Codex reports that the harness classifies as `failure`'s class. */
export function codexFailureText(failure: ProviderFailure): string {
  switch (failure.failureClass) {
    case "quota":
      return failure.retryAt !== undefined
        ? `You've hit your usage limit. Your limit resets at ${failure.retryAt}`
        : "You've hit your usage limit. Upgrade to Pro, or try again later.";
    case "transient":
      return "stream disconnected before completion: 503 Service Unavailable";
    case "overflow":
      return "Your input exceeds the context window of this model. Please adjust your input and try again.";
    case "auth":
      return "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";
    default:
      return failure.message;
  }
}

/** A scripted observation as the item Codex would run for it: a read is a shell command (Codex has no read tool). */
export function codexItemFor(o: ScriptedObservation): FakeCodexItem {
  const input = (o.input ?? {}) as Record<string, unknown>;
  const output = typeof o.output === "string" ? o.output : JSON.stringify(o.output ?? "");
  if (o.tool === "Bash") return { type: "command_execution", command: String(input.command ?? ""), output, exitCode: o.exitCode ?? 0 };
  if (o.tool === "Read") return { type: "command_execution", command: `cat ${String(input.file_path ?? "")}`, output, exitCode: 0 };
  if (o.tool === "Write" || o.tool === "Edit") return { type: "file_change", path: String(input.file_path ?? ""), kind: o.tool === "Write" ? "add" : "update" };
  return { type: "mcp_tool_call", server: "scripted", tool: o.tool, arguments: o.input, result: o.output };
}

/** How the conformance suite's scripted observation shows in the Codex harness's steps. */
export function codexObservedAs(o: ScriptedObservation): { tool: string; exitCode?: number } {
  const item = codexItemFor(o);
  if (item.type === "command_execution") return { tool: "command_execution", exitCode: (item as { exitCode?: number }).exitCode ?? 0 };
  if (item.type === "mcp_tool_call") return { tool: `mcp:scripted/${o.tool}` };
  return { tool: item.type };
}

/** A conformance script step as the fake CLI's answer. */
export function fakeCodexStepFor(step: ScriptStep): FakeCodexStep {
  const observe = step.observe?.map(codexItemFor);
  const withObserve = observe !== undefined ? { observe } : {};
  if ("timeout" in step) return { hang: true };
  if ("fail" in step) return { ...withObserve, error: codexFailureText(step.fail) };
  if ("empty" in step) return { ...withObserve, empty: true };
  if ("text" in step) return { ...withObserve, text: step.text };
  if ("inspect" in step) return { ...withObserve, text: JSON.stringify({ inspect: step.inspect }) };
  if ("switchModel" in step) return { ...withObserve, text: JSON.stringify({ switch_model: step.switchModel }) };
  return {
    ...withObserve,
    text: ["Investigated; deciding.", "```json", JSON.stringify({ ...step.decide, ...(step.findings !== undefined ? { findings: step.findings } : {}) }), "```"].join("\n"),
  };
}

/** A Codex harness on a fake CLI, unconfined, with short watchdogs. */
export function fakeCodexHarness(
  fake: FakeCodex,
  options: Partial<CodexSupervisorHarnessOptions> & { configuredModels?: SupervisorModelRef[] } = {},
): CodexSupervisorHarness {
  return createCodexSupervisorHarness({
    runId: "run-fake",
    sessionDir: fake.sessionDir,
    codexHome: fake.codexHome,
    allowUnconfined: true,
    confinement: { launch: fake.launch, unsupported: async () => undefined },
    promptTimeoutMs: 3_000,
    killGraceMs: 500,
    readHelp: async () => execFileSync(process.execPath, [FAKE_CODEX, "exec", "--help"], { encoding: "utf8" }),
    loggedIn: async () => true,
    ...options,
  });
}
