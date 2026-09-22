import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphPlugin, Validator } from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import { admitValidation } from "./admit.js";
import { intakeTask, type IntakePin } from "./intake.js";
import {
  bumpGeneration,
  ensureArtifactDir,
  initialState,
  runNormalLoop,
  toRunView,
} from "./loop.js";
import { loadRunState, saveRunState, type DurableRunState, type RunStatus } from "./state.js";
import { createRunWorktree, listDirtyPaths } from "./worktree.js";

export interface RunRequest {
  taskPath: string;
  plugin: GraphPlugin;
  runner: Runner;
  validators: Record<string, Validator>;
  /** Directory for durable run state (default: <repo>/graphloom-state). */
  stateRoot?: string;
  runId?: string;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  stopReason?: string;
  blocker?: string;
  receipts: DurableRunState["receipts"];
  evidence: DurableRunState["evidence"];
  generation: number;
  worktreePath: string;
  pinnedHead: string;
  bundlePath: string;
  sourceDirtyBefore: string[];
  sourceDirtyAfter: string[];
  stateDir: string;
}

export interface Controller {
  run(request: RunRequest): Promise<RunReport>;
  /** Load persisted state, bump generation (simulating restart freshness), continue. */
  continueAfterRestart(
    stateDir: string,
    deps: Pick<RunRequest, "plugin" | "runner" | "validators">,
  ): Promise<RunReport>;
  inspect(stateDir: string): Promise<DurableRunState>;
}

export function createController(): Controller {
  return {
    async run(request: RunRequest): Promise<RunReport> {
      const intake = await intakeTask(request.taskPath);
      const definition = request.plugin.describe();
      if (definition.graphId !== intake.bundle.graphId) {
        throw new Error(
          `plugin graphId ${definition.graphId} != pinned bundle ${intake.bundle.graphId}`,
        );
      }

      const sourceDirtyBefore = await listDirtyPaths(intake.repoPath);
      const runId = request.runId ?? randomUUID().slice(0, 12);
      const stateRoot = request.stateRoot ?? path.join(intake.repoPath, "graphloom-state");
      const { worktreePath, branchName } = await createRunWorktree(
        intake.repoPath,
        runId,
        intake.pinnedHead,
      );

      let state = initialState({
        runId,
        intake,
        definition,
        worktreePath,
        worktreeBranch: branchName,
        stateRoot,
        sourceDirtyBefore,
      });
      await ensureArtifactDir(state);
      await saveRunState(state);

      state = await runNormalLoop(state, {
        plugin: request.plugin,
        runner: request.runner,
        validators: request.validators,
      });

      const sourceDirtyAfter = await listDirtyPaths(intake.repoPath);
      return toReport(state, sourceDirtyAfter);
    },

    async continueAfterRestart(stateDir, deps): Promise<RunReport> {
      let state = await loadRunState(stateDir);
      if (state.status !== "running") {
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      }
      // Restart fences prior generation so stale evidence cannot Accept.
      state = bumpGeneration(state);
      await saveRunState(state);
      state = await runNormalLoop(state, deps);
      return toReport(state, await listDirtyPaths(state.intake.repoPath));
    },

    async inspect(stateDir: string): Promise<DurableRunState> {
      return loadRunState(stateDir);
    },
  };
}

function toReport(state: DurableRunState, sourceDirtyAfter: string[]): RunReport {
  const report: RunReport = {
    runId: state.runId,
    status: state.status,
    receipts: state.receipts,
    evidence: state.evidence,
    generation: state.generation,
    worktreePath: state.worktreePath,
    pinnedHead: state.intake.pinnedHead,
    bundlePath: state.intake.bundle.bundlePath,
    sourceDirtyBefore: state.sourceDirtyBefore,
    sourceDirtyAfter,
    stateDir: state.stateDir,
  };
  if (state.stopReason !== undefined) {
    report.stopReason = state.stopReason;
  }
  if (state.blocker !== undefined) {
    report.blocker = state.blocker;
  }
  return report;
}

export { intakeTask, parseTaskYaml, resolveUnderBase, IntakeError } from "./intake.js";
export { admitValidation, freshEvidence } from "./admit.js";
export { toRunView, bumpGeneration } from "./loop.js";
export { loadRunState, saveRunState } from "./state.js";
export type { DurableRunState, RunStatus } from "./state.js";
export type { IntakePin } from "./intake.js";

/** Test helper: attempt Validate using only current-generation evidence. */
export function tryAdmit(
  state: DurableRunState,
  stageId: string,
  validators: Record<string, Validator>,
) {
  return admitValidation(state, { stageId }, validators);
}

/** Test helper: write a sidecar file beside the source repo without touching worktree. */
export async function writeSourceSidecar(repoPath: string, name: string, body: string): Promise<void> {
  await writeFile(path.join(repoPath, name), body, "utf8");
}
