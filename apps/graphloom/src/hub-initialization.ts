// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { HubLaunch, HubObservation, HubSubmission } from "@graphloom/sdk";
import { parseTaskYaml } from "@graphloom/controller";
import { boundedText } from "./hub-input.js";

/** Missing state authorizes replay only before the controller's durable execution marker. */
export async function observeInitialization(stateDir: string, submission: HubSubmission, launch: HubLaunch): Promise<HubObservation> {
  const base = { protocolVersion: 1 as const, observedAt: new Date().toISOString(), stateRevision: 0, progressRevision: 0, status: "initialization-failed" };
  try {
    const directory = path.dirname(path.dirname(path.dirname(submission.input.taskFile)));
    if (stateDir !== path.join(directory, "runs", submission.runId) || submission.launch?.id !== launch.id || submission.generation !== launch.generation || launch.phase !== "granted" || launch.mode !== "initial") throw new Error("missing state has no matching initial launch");
    const stat = await lstat(stateDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat && !stat.isDirectory()) throw new Error("initialization state directory is not a real directory");
    const entries = stat ? await readdir(stateDir, { withFileTypes: true }) : [];
    if (entries.some((entry) => entry.name === "state.json")) throw new Error("run state exists; use the owning controller observation");
    if (entries.some((entry) => entry.name === "managed-execution-started.json")) throw new Error("run execution may already have started; missing state requires recovery");
    const bound = entries.find((entry) => entry.name === "managed-run.json");
    let intakeDigest = submission.contentDigest;
    if (!bound) {
      if (entries.length) throw new Error("unbound initialization directory contains unexpected artifacts");
      const worktree = await lstat(path.join(submission.input.repoPath, "graphloom", submission.runId)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (worktree) throw new Error("unbound initialization has an existing worktree");
    } else {
      if (!bound.isFile()) throw new Error("managed binding is not a regular file");
      const binding = JSON.parse(await boundedText(path.join(stateDir, bound.name), 16_384)) as Record<string, unknown>;
      if (binding.protocolVersion !== 1 || binding.initializationProtocol !== 1) throw new Error("managed binding lacks safe initialization provenance");
      if (binding.hubStateDir !== directory || binding.hubId !== submission.hubId || binding.submissionId !== submission.id || binding.runId !== submission.runId ||
          !Number.isSafeInteger(binding.generation) || Number(binding.generation) < 1 || Number(binding.generation) > launch.generation ||
          binding.generation === launch.generation && binding.launchId !== launch.id) throw new Error("managed initialization binding does not match its launch");
      if (typeof binding.intakeDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.intakeDigest)) throw new Error("managed initialization intake identity is missing");
      intakeDigest = binding.intakeDigest;
      // A task with no `repo:` runs in a private repository the controller makes inside the state directory.
      const ownsRepository = await boundedText(submission.input.taskFile, 256 * 1024).then((text) => parseTaskYaml(text).repo === undefined, () => false);
      for (const entry of entries) {
        if (ownsRepository && entry.name === "repository" && entry.isDirectory()) continue;
        // A crash inside createPrivateRepository leaves its building directory; the replay removes it before building again.
        if (ownsRepository && entry.name === "repository.creating" && entry.isDirectory()) continue;
        if (entry.name === "artifacts" && entry.isDirectory() && (await readdir(path.join(stateDir, entry.name))).length === 0) continue;
        if (entry.isFile() && (["managed-run.json", "run.owner.json"].includes(entry.name) || /^state\.\d+\.[a-f0-9-]{36}\.tmp$/.test(entry.name))) continue;
        throw new Error(`initialization contains an unexpected artifact: ${entry.name}`);
      }
    }
    const fingerprint = createHash("sha256").update(`initialization:${submission.id}:${intakeDigest}`).digest("hex");
    return { ...base, continuation: { kind: "automatic", cause: "initialization-failed", fingerprint, stateRevision: 0 } };
  } catch (error) {
    return { ...base, continuation: { kind: "terminal", cause: "initialization-failed" }, blocker: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
  }
}
