// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Rehearsal submissions on the run hub (docs/design-run-hub.md §12): a
 * submission whose captured input carries rehearsal settings runs, inside its
 * own managed launch, on `graphloom rehearse`'s stand-ins. This module holds
 * what the hub service and the managed launch share about them: where a
 * submission's rehearsal scratch lives, the stand-in variables a launch must
 * never inherit, the settings' wire form, and the recorded verdict.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { managedObservation, type DurableRunState, type RehearsalReport } from "@graphloom/controller";
import { REHEARSAL_GITHUB_TOKEN_ENV, REHEARSAL_ONLY_ENV, type HubRehearsal, type HubRehearsalVerdict } from "@graphloom/sdk";
import { writePrivateJsonOrText } from "./hub-input.js";

/** `<hub directory>/rehearsals/<runId>`: a rehearsal submission's scenario, stand-in home, launchers and verdict. */
export function hubRehearsalRoot(hubDirectory: string, runId: string): string {
  return path.join(hubDirectory, "rehearsals", runId);
}
/** The compact verdict the hub shows; the full rehearsal report sits beside it in `report.json`. */
export const HUB_VERDICT_FILE = "verdict.json";
export const HUB_REPORT_FILE = "report.json";

/**
 * The variables only a rehearsal's stand-ins read. A rehearsal launch sets them
 * in its own process; every other launch drops any it inherited, so a real run
 * never answers from a scenario.
 */
export const STAND_IN_VARIABLES: readonly string[] = [...REHEARSAL_ONLY_ENV, REHEARSAL_GITHUB_TOKEN_ENV];

/**
 * Removes the stand-in variables from `env` (by default this process's); returns
 * the names it removed. A rehearsal launch keeps the operator's rehearsal GitHub
 * token, which its online reads use.
 */
export function dropStandInVariables(env: NodeJS.ProcessEnv = process.env, options: { keepRehearsalToken?: boolean } = {}): string[] {
  const removed = STAND_IN_VARIABLES.filter((name) => env[name] !== undefined && !(options.keepRehearsalToken === true && name === REHEARSAL_GITHUB_TOKEN_ENV));
  for (const name of removed) delete env[name];
  return removed;
}

/** The settings as `graphloom rehearse` flags, in a fixed order. */
export function rehearsalArgs(settings: HubRehearsal): string[] {
  return [
    ...(settings.scenario !== undefined ? ["--scenario", settings.scenario] : []),
    ...(settings.commands !== undefined ? ["--commands", settings.commands] : []),
    ...(settings.offline === true ? ["--offline"] : []),
  ];
}

/** The settings a client sent, checked as the scheduler checks them; only what was given is kept. */
export function parseRehearsalSettings(value: unknown): HubRehearsal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("rehearsal must be an object of rehearsal settings");
  const settings: HubRehearsal = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "scenario" && typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item)) settings.scenario = item;
    else if (key === "commands" && (item === "stub" || item === "run")) settings.commands = item;
    else if (key === "offline" && typeof item === "boolean") { if (item) settings.offline = true; }
    else throw new Error(`unknown or invalid rehearsal setting ${key}`);
  }
  return settings;
}

/**
 * Records the verdict of a rehearsal submission's run, once: after the first
 * launch whose run stopped for its own reasons (succeeded, failed, or a stop
 * that needs the operator, such as an approval). A launch the hub or the
 * operator interrupted (a pause, a scheduling yield, a crash) leaves the
 * verdict pending; a later launch continuing a recorded rehearsal keeps it.
 */
export async function recordHubVerdict(rehearsalRoot: string, report: RehearsalReport, state: DurableRunState, launchId: string): Promise<HubRehearsalVerdict | undefined> {
  const existing = await readVerdictFile(path.join(rehearsalRoot, HUB_VERDICT_FILE));
  if (existing !== undefined) return existing;
  const continuation = managedObservation(state).continuation;
  if (continuation?.kind === "automatic" || (continuation?.kind === "operator" && continuation.cause === "operator-stop")) return undefined;
  const verdict: HubRehearsalVerdict = {
    verdict: report.verdict,
    boundaries: Object.fromEntries(Object.entries(report.boundaries).map(([boundary, result]) => [boundary, result.status])),
    ...(report.blocker !== undefined ? { blocker: { boundary: report.blocker.boundary, reason: report.blocker.reason.slice(0, 1024) } } : {}),
    convergence: report.convergence.met,
    runStatus: state.status,
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason.slice(0, 512) } : {}),
    launchId,
    evaluatedAt: new Date().toISOString(),
  };
  await writePrivateJsonOrText(path.join(rehearsalRoot, HUB_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  await writePrivateJsonOrText(path.join(rehearsalRoot, HUB_VERDICT_FILE), `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

/** A rehearsal submission's recorded verdict, or undefined while none is (or when it cannot be read). */
export async function readHubVerdict(hubDirectory: string, runId: string): Promise<HubRehearsalVerdict | undefined> {
  return readVerdictFile(path.join(hubRehearsalRoot(hubDirectory, runId), HUB_VERDICT_FILE));
}

async function readVerdictFile(file: string): Promise<HubRehearsalVerdict | undefined> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { return undefined; }
  if (Buffer.byteLength(text) > 16 * 1024) return undefined;
  try {
    const value = JSON.parse(text) as HubRehearsalVerdict;
    return ["ready", "not-ready", "inconclusive"].includes(value.verdict) && typeof value.boundaries === "object" ? value : undefined;
  } catch { return undefined; }
}

/** One line for `hub list` and the overview panel: the settings and the verdict, or that it is pending. */
export function rehearsalLine(settings: HubRehearsal, verdict: HubRehearsalVerdict | undefined): string {
  const failed = verdict === undefined ? [] : Object.entries(verdict.boundaries).filter(([, status]) => status !== "passed").map(([boundary, status]) => `${boundary} ${status}`);
  return [
    `scenario ${settings.scenario ?? "happy"}`,
    `commands ${settings.commands ?? "stub"}`,
    ...(settings.offline === true ? ["offline"] : []),
    verdict === undefined
      ? "verdict pending"
      : `verdict ${verdict.verdict}${failed.length ? ` (${failed.join(", ")})` : ""}${verdict.blocker !== undefined ? `: ${verdict.blocker.boundary} ${verdict.blocker.reason.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  ].join(" · ");
}
