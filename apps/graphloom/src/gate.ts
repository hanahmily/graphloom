// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The gate in `run` (docs/design-graph-rehearsal.md §3.5): `graphloom run`
 * performs L0 (`check`) then L1-quick (`rehearse` with stubbed commands)
 * before a live run is intaken, keyed by a fingerprint of everything that
 * would change their verdict — bundle digests, the runner config, the
 * environment checks' own output, the protocol version, B2's capability
 * probe, the GraphLoom product version, and the built-in executors' digests
 * (docs/design-release.md §5.1), so a result cached by one installed version
 * is not reused by another. A `ready` report at a matching fingerprint is reused so a second
 * run on an unchanged machine pays nothing. `not-ready` stops before any
 * provider call; `inconclusive` proceeds but is recorded; `--skip-rehearsal`
 * overrides and is recorded the same way, so `inspect` shows whether (and
 * how) a run was gated.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultStateRoot, intakeTask, type RehearsalReport } from "@graphloom/controller";
import { PROTOCOL_VERSION, stableHash } from "@graphloom/sdk";
import { digestExecutorSource, packageRootOf } from "@graphloom/runner";
import { codingAgentExecutorPackage } from "@graphloom/executor-coding-agent";
import { commandExecutorPackage } from "@graphloom/executor-command";
import { githubExecutorPackage } from "@graphloom/executor-github";
import { installRoot, versionInfo } from "./version.js";
import { check, rehearse, type CheckReport } from "./rehearsal.js";
import { loadRunnerConfig } from "./runner-config.js";

export type GateVerdict = "ready" | "not-ready" | "inconclusive" | "skipped";

export interface GateResult {
  fingerprint: string;
  verdict: GateVerdict;
  notes: string[];
  /**
   * The L0 check (when it alone decided `not-ready`, before L1 ever ran) or
   * the L1-quick rehearsal report this verdict came from. Absent when
   * skipped or when a cached `ready` report was reused without rerunning
   * anything. `not-ready` prints this in place of the run's own report,
   * since nothing was intaken.
   */
  report?: CheckReport | RehearsalReport;
}

export interface GateOptions {
  stateRoot?: string;
  /** `--skip-rehearsal`: nothing runs, fingerprint stays empty, recorded as `skipped` for `inspect`. */
  skip?: boolean;
  /** The product version the fingerprint names (tests); defaults to this installation's. */
  productVersion?: string;
}

/** The digest of each built-in executor package this installation serves, by package name. */
export async function builtinExecutorDigests(): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const pkg of [codingAgentExecutorPackage, commandExecutorPackage, githubExecutorPackage]) {
    digests[pkg.name] = await digestExecutorSource(packageRootOf(pkg.entryModule));
  }
  return digests;
}

function cachePath(stateRoot: string, fingerprintValue: string): string {
  return path.join(stateRoot, "rehearsals", fingerprintValue, "report.json");
}

async function readCachedReady(file: string): Promise<{ notes: string[] } | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { verdict?: string; notes?: string[] };
    return raw.verdict === "ready" ? { notes: raw.notes ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

/** Caching is an optimization, not a requirement: a write failure (e.g. a read-only state root) must not fail an otherwise-ready gate. */
async function writeCachedReady(file: string, notes: string[]): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ verdict: "ready", notes }, null, 2), "utf8");
  } catch {
    // best effort
  }
}

function rehearsalNotes(report: RehearsalReport): string[] {
  const notes: string[] = [];
  if (report.blocker !== undefined) {
    notes.push(`${report.blocker.boundary}: ${report.blocker.reason}`);
  }
  for (const [boundary, result] of Object.entries(report.boundaries)) {
    if (result.status !== "passed") {
      notes.push(`${boundary} ${result.status}${result.notes.length > 0 ? `: ${result.notes.join("; ")}` : ""}`);
    }
  }
  if (!report.convergence.met) {
    notes.push(`convergence not met: expected ${JSON.stringify(report.convergence.expected)}`);
  }
  return notes;
}

/**
 * L0+L1-quick, run and cached under `taskPath`'s own state root (or the
 * caller's, matching what a live run would use). Skips everything when
 * `options.skip` is set, recording that choice rather than hiding it.
 */
export async function runGate(taskPath: string, options: GateOptions = {}): Promise<GateResult> {
  if (options.skip === true) {
    return { fingerprint: "", verdict: "skipped", notes: ["--skip-rehearsal: L0/L1 were not run"] };
  }

  const intake = await intakeTask(taskPath);
  const stateRoot = options.stateRoot ?? defaultStateRoot(intake.repoPath);
  const runnerConfig = await loadRunnerConfig().catch(() => undefined);
  const checkReport = await check(taskPath);

  const fingerprintValue = stableHash({
    protocolVersion: PROTOCOL_VERSION,
    // A result cached by one GraphLoom is not reused by another (docs/design-release.md §5.1).
    productVersion: options.productVersion ?? versionInfo(installRoot()).version,
    executors: await builtinExecutorDigests(),
    bundle: { manifestDigest: intake.bundle.manifestDigest, entryDigest: intake.bundle.entryDigest },
    // Rehearsal runs the graph's own request text verbatim, against the
    // pinned repository revision: two tasks sharing a bundle/config/
    // environment but a different request or checkout can converge
    // differently, so a cached "ready" must not cross either boundary.
    repoPath: intake.repoPath,
    pinnedHead: intake.pinnedHead,
    request: intake.task.request,
    // The task config changes what the graph describes and decides.
    ...(intake.config !== undefined ? { taskConfig: intake.config.sha256 } : {}),
    runnerConfig,
    environmentOutputs: checkReport.environmentOutputs,
    helpText: checkReport.capabilities?.helpText ?? {},
  });
  const file = cachePath(stateRoot, fingerprintValue);

  const cached = await readCachedReady(file);
  if (cached !== undefined) {
    return { fingerprint: fingerprintValue, verdict: "ready", notes: [...cached.notes, `reused cached rehearsal at ${fingerprintValue}`] };
  }

  if (!checkReport.ok) {
    return { fingerprint: fingerprintValue, verdict: "not-ready", notes: checkReport.problems, report: checkReport };
  }

  const rehearsalReport = await rehearse(taskPath, { commands: "stub" });
  const notes = rehearsalNotes(rehearsalReport);
  if (rehearsalReport.verdict === "ready") await writeCachedReady(file, notes);
  return { fingerprint: fingerprintValue, verdict: rehearsalReport.verdict, notes, report: rehearsalReport };
}
