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

/** B2: every enabled spawned-CLI harness's own `--help` names every flag its adapter passes it. */
export async function probeHarnessCapabilities(config: RunnerConfig | undefined): Promise<CapabilityProbeResult> {
  if (config === undefined) return { status: "unverified", notes: ["no runner configured"], helpText: {} };
  const harnesses = enabledHarnesses(config);
  const notes: string[] = [];
  const texts: Record<string, string> = {};
  let unverified = false;
  let failed = false;

  const check = async (name: string, command: string, args: string[], flags: readonly string[]) => {
    const help = await helpText(command, args);
    if (help === undefined) {
      unverified = true;
      notes.push(`${name}: ${command} ${args.join(" ")} could not be read`);
      return;
    }
    texts[name] = help;
    const missing = missingFlags(help, flags);
    if (missing.length > 0) {
      failed = true;
      notes.push(`${name}: ${command} ${args.join(" ")} does not mention ${missing.join(", ")}`);
    }
  };

  if (harnesses.includes("claude-code")) {
    const command = config.claude?.command ?? (process.env[CLAUDE_BIN_ENV] || "claude");
    await check("claude-code", command, ["--help"], CLAUDE_CODE_ADAPTER_FLAGS);
  }
  if (harnesses.includes("codex")) {
    const command = config.codex?.command ?? (process.env[CODEX_BIN_ENV] || "codex");
    await check("codex", command, ["exec", "--help"], CODEX_ADAPTER_FLAGS);
  }
  // Pi is an in-process SDK integration, not a spawned CLI: no `--help` to ask.

  if (failed) return { status: "failed", notes, helpText: texts };
  if (unverified) return { status: "unverified", notes, helpText: texts };
  return { status: "passed", notes, helpText: texts };
}
