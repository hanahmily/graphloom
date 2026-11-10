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

/** The sandbox plan for a test of the cited file, from the evidence of the image checks. */
export function reproPlanFor(evidence: readonly EvidenceRecord[], profile: Pick<Profile, "metrics" | "review">, path: string): ReproPlan | { reason: string } {
  const language = reproLanguage(path);
  if (language === undefined) return { reason: `no way to run a test for ${path}` };
  const ready = languageReadiness(evidence, profile, language);
  if ("probe" in ready) return { reason: "the sandbox image was not checked" };
  if ("reason" in ready) return { reason: ready.reason };
  return { language, workspace: language === "go" ? "." : "auto", image: ready.image };
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
  const wallClockMs = Math.min(ready.sandbox.wallClockMs, cap + 3 * 60_000);
  const command = reproCommand(run, pluginRoot, wallClockMs);
  if (command === undefined) return { problem: `the test of ${run.finding} does not fit one command` };
  const plan: CoveragePlan = { language: run.language, sandbox: { ...ready.sandbox, wallClockMs }, commands: [], cache: ready.cache, mounts: ready.mounts };
  const confinement: DockerConfinement = coverageConfinement(plan, pluginRoot);
  const commands: EnvironmentCommand[] = [command];
  return {
    stageId,
    kind: "command",
    purpose: "diagnostic",
    readOnly: true,
    instruction: `Run the reviewer's test of ${run.finding} (${run.language === "go" ? "Go" : "TypeScript"}) twice against the head, in the Docker sandbox (no network, read-only dependency cache, a checkout of the head; the test is never written into it)`,
    input: { commands, continueOnFailure: true },
    checkout: { from: "candidate" },
    confinement,
    timeoutMs: wallClockMs + 120_000,
  };
}
