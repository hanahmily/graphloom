// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Where the reviewers' tests run (design §8.2): the sandbox the profile and the evidence of Fetch's image checks describe.
 * The graph (to dispatch a run) and the `findings-proven` validator (to recompute the proof) read one answer here. A language
 * the sandbox cannot run says why, and the finding is `unproven (sandbox unavailable)`: no test ever runs outside the sandbox.
 */
import type { DockerConfinement, EnvironmentCommand, EvidenceRecord, JobSpec } from "@graphloom/sdk";
import { coverageConfinement, dockerRefusal, languageReadiness, type CoveragePlan } from "./coverage.js";
import { commandRuns } from "./evidence.js";
import type { Profile } from "./profile.js";
import { reproLanguage, REPRO_ID_PREFIX, reproCommand, type ReproRunSpec } from "./repro.js";
import type { ReproEnv, ReproPlan } from "./review.js";

/** The tests that ran in `evidence` (each finding has one command, so each counts once): they count against the head's time budget. */
export const reproRunsIn = (evidence: readonly EvidenceRecord[]): number => new Set(commandRuns(evidence).filter((r) => r.command.id.startsWith(REPRO_ID_PREFIX)).map((r) => r.command.id)).size;

/** What a test's job may spend on the profile's sandboxed setup when it has to run it (nothing kept it on this head yet): on top of the test's own cap. */
export const REPRO_SETUP_MS = 15 * 60_000;
/** The test's two runs (each `go test`'s timeout plus 30 seconds) and the report, beside the setup, in the job's wall clock. */
const REPRO_RUNS_MARGIN_MS = 2 * 60_000;

/** The wall clock of a test's container: the finding's cap and a margin, plus the setup's allowance when the profile has a setup; never above the sandbox's own. */
export function reproWallClockMs(sandboxWallClockMs: number, perFindingMs: number, setup: boolean): number {
  return Math.min(sandboxWallClockMs, perFindingMs + 3 * 60_000 + (setup ? REPRO_SETUP_MS : 0));
}

/** The seconds the setup may take in a test's job: the wall clock less the test's runs, at least half a minute. */
export function reproSetupSeconds(wallClockMs: number, perFindingMs: number): number {
  return Math.max(30, Math.floor((wallClockMs - perFindingMs - REPRO_RUNS_MARGIN_MS) / 1000));
}

/** The sandbox plan for a test of the cited file, from the evidence of the image checks; a Go plan carries the profile's sandboxed setup, as coverage runs it. */
export function reproPlanFor(evidence: readonly EvidenceRecord[], profile: Pick<Profile, "metrics" | "review">, path: string): ReproPlan | { reason: string } {
  const language = reproLanguage(path);
  if (language === undefined) return { reason: `no way to run a test for ${path}` };
  const ready = languageReadiness(evidence, profile, language);
  if ("probe" in ready) return { reason: "the sandbox image was not checked" };
  if ("reason" in ready) return { reason: ready.reason };
  const setup = language === "go" ? ready.sandbox.setup : [];
  if (setup.length === 0) return { language, workspace: language === "go" ? "." : "auto", image: ready.image, setup: [] };
  const cap = profile.review.repro.perFindingMs;
  return { language, workspace: ".", image: ready.image, setup, setupSeconds: reproSetupSeconds(reproWallClockMs(ready.sandbox.wallClockMs, cap, true), cap) };
}

/** The environment the sweep reads: the profile's settings, the runs of the earlier aspects, the plans and the sandbox's refusals. */
export function reproEnv(evidence: readonly EvidenceRecord[], profile: Pick<Profile, "metrics" | "review">, used: number): ReproEnv {
  return {
    config: profile.review.repro,
    used,
    plan: (path) => reproPlanFor(evidence, profile, path),
    refusedSince: (ref) => dockerRefusal(evidence, evidence.findIndex((e) => e.ref === ref)),
  };
}

/** The job that runs one finding's test: one command in the Docker sandbox over a checkout of the head (design §8.2), as the coverage job runs. */
export function reproJob(stageId: string, evidence: readonly EvidenceRecord[], profile: Pick<Profile, "metrics" | "review">, run: ReproRunSpec, pluginRoot: string): JobSpec | { problem: string } {
  const ready = languageReadiness(evidence, profile, run.language);
  if (!("ready" in ready)) return { problem: "reason" in ready ? ready.reason : "the sandbox image was not checked" };
  const cap = profile.review.repro.perFindingMs;
  const wallClockMs = reproWallClockMs(ready.sandbox.wallClockMs, cap, (run.setup ?? []).length > 0);
  const command = reproCommand(run, pluginRoot, wallClockMs);
  if (command === undefined) return { problem: `the test of ${run.finding} does not fit one command` };
  const plan: CoveragePlan = { language: run.language, sandbox: { ...ready.sandbox, wallClockMs }, commands: [], cache: ready.cache, mounts: ready.mounts };
  const confinement: DockerConfinement = coverageConfinement(plan, pluginRoot);
  const commands: EnvironmentCommand[] = [command];
  const setup = (run.setup ?? []).map((s) => s.id);
  const after = setup.length > 0 ? `, after the profile's sandboxed setup (${setup.join(", ")}), copied from the run's scratch when coverage or an earlier test of this head already ran it` : "";
  return {
    stageId,
    kind: "command",
    purpose: "diagnostic",
    readOnly: true,
    instruction: `Run the reviewer's test of ${run.finding} (${run.language === "go" ? "Go" : "TypeScript"}) twice against the head, in the Docker sandbox (no network, read-only dependency cache, a checkout of the head; the test is never written into it)${after}`,
    input: { commands, continueOnFailure: true },
    checkout: { from: "candidate" },
    confinement,
    timeoutMs: wallClockMs + 120_000,
  };
}
