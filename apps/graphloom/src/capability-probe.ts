// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * B2's capability probe (docs/design-graph-rehearsal.md §3.1): each enabled
 * spawned-CLI harness (Claude Code, Codex; Pi is in-process, nothing to
 * probe) answers `--help` with every flag its adapter actually passes it —
 * asked of the binary, not read from a version — so a stale binary that
 * silently lacks a feature is a defect found here, for free, before any
 * dispatch ever needs it. A binary whose `--help` cannot be read at all is
 * `unverified`, never a pass; one that answers but is missing a flag is a
 * real defect (`failed`).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoundaryResult } from "@graphloom/controller";
import { CLAUDE_BIN_ENV, CLAUDE_CODE_ADAPTER_FLAGS, CODEX_ADAPTER_FLAGS, CODEX_BIN_ENV } from "@graphloom/executor-coding-agent";
import { enabledHarnesses, type RunnerConfig } from "./runner-config.js";

const execFileAsync = promisify(execFile);
const HELP_TIMEOUT_MS = 10_000;

async function helpText(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: HELP_TIMEOUT_MS });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Flag-shaped tokens in `--help` text: `--model-provider` must not satisfy a
 * required `--model` (a substring check would let it, since one flag can be a
 * prefix of another's name), so each declared flag is matched as a complete
 * token, not a substring of the raw text.
 */
function helpFlagTokens(help: string): Set<string> {
  return new Set(help.match(/--?[a-zA-Z][a-zA-Z0-9-]*/g) ?? []);
}

function missingFlags(help: string, flags: readonly string[]): string[] {
  const tokens = helpFlagTokens(help);
  return flags.filter((flag) => !tokens.has(flag));
}

/**
 * B2's own `BoundaryResult` plus the raw `--help` text read from each
 * configured spawned-CLI harness, keyed by harness name. The gate in `run`
 * (docs/design-graph-rehearsal.md §3.5) folds this into its fingerprint: a
 * binary upgrade that changes what the adapter can ask for re-rehearses.
 */
export interface CapabilityProbeResult extends BoundaryResult {
  helpText: Record<string, string>;
}

/** The `--help` invocation and adapter flags of each spawned-CLI harness. */
export const HARNESS_HELP: Readonly<Record<"claude-code" | "codex", { args: readonly string[]; flags: readonly string[] }>> = {
  "claude-code": { args: ["--help"], flags: CLAUDE_CODE_ADAPTER_FLAGS },
  codex: { args: ["exec", "--help"], flags: CODEX_ADAPTER_FLAGS },
};

/** One spawned-CLI harness's probe: its `--help` names every flag its adapter passes it. */
export async function probeHarnessCommand(
  harness: "claude-code" | "codex",
  command: string,
): Promise<{ status: "passed" | "failed" | "unverified"; notes: string[]; help?: string }> {
  const { args, flags } = HARNESS_HELP[harness];
  const help = await helpText(command, [...args]);
  if (help === undefined) return { status: "unverified", notes: [`${harness}: ${command} ${args.join(" ")} could not be read`] };
  const missing = missingFlags(help, flags);
  if (missing.length > 0) return { status: "failed", notes: [`${harness}: ${command} ${args.join(" ")} does not mention ${missing.join(", ")}`], help };
  return { status: "passed", notes: [], help };
}

/** B2: every enabled spawned-CLI harness's own --help names every flag its adapter passes it. */
export async function probeHarnessCapabilities(config: RunnerConfig | undefined): Promise<CapabilityProbeResult> {
  if (config === undefined) return { status: "unverified", notes: [NO_RUNNER_NOTE], helpText: {} };
  const harnesses = enabledHarnesses(config);
  const notes: string[] = [];
  const texts: Record<string, string> = {};
  let unverified = false;
  let failed = false;

  const check = async (name: "claude-code" | "codex", command: string) => {
    const result = await probeHarnessCommand(name, command);
    if (result.help !== undefined) texts[name] = result.help;
    notes.push(...result.notes);
    if (result.status === "unverified") unverified = true;
    if (result.status === "failed") failed = true;
  };

  if (harnesses.includes("claude-code")) {
    await check("claude-code", config.claude?.command ?? (process.env[CLAUDE_BIN_ENV] || "claude"));
  }
  if (harnesses.includes("codex")) {
    await check("codex", config.codex?.command ?? (process.env[CODEX_BIN_ENV] || "codex"));
  }
  // Pi is an in-process SDK integration, not a spawned CLI: no `--help` to ask.

  if (failed) return { status: "failed", notes, helpText: texts };
  if (unverified) return { status: "unverified", notes, helpText: texts };
  return { status: "passed", notes, helpText: texts };
}

/** What check and rehearse report without a runner config (docs/design-release.md §4.5). */
export const NO_RUNNER_NOTE = "no runner configured; run graphloom setup (graphloom setup --yes in scripts), or point GRAPHLOOM_RUNNER_CONFIG at a runner config";
