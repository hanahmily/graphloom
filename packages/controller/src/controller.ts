import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  type GraphDefinition,
  type GraphPlugin,
  type Validator,
} from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import { createInProcessPluginHost, type PluginHost } from "@graphloom/plugin-host";
import { admitValidation } from "./admit.js";
import { intakeTask, type IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import {
  bumpGeneration,
  ensureArtifactDir,
  initialState,
  runNormalLoop,
  toRunView,
} from "./loop.js";
import { loadRunState, saveRunState, type DurableRunState, type RunStatus } from "./state.js";
import {
  assertWorktreeMatches,
  createRunWorktree,
  listDirtyPaths,
} from "./worktree.js";

export interface RunRequest {
  taskPath: string;
  /**
   * Scripted/CI seam: wrapped in an in-process PluginHost.
   * Child-process loading of the pinned bundle is ticket #26.
   */
  plugin: GraphPlugin;
  /** Optional pre-built host; when set, `plugin` is ignored for advance/describe. */
  host?: PluginHost;
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
    deps: Pick<RunRequest, "plugin" | "host" | "runner" | "validators">,
  ): Promise<RunReport>;
  inspect(stateDir: string): Promise<DurableRunState>;
}

export function createController(): Controller {
  return {
    async run(request: RunRequest): Promise<RunReport> {
      const intake = await intakeTask(request.taskPath);
      const host =
        request.host ??
        createInProcessPluginHost(request.plugin, {
          activeVersion: `${intake.bundle.graphId}@${intake.bundle.version}`,
          generation: 1,
        });

      const described = await host.describe({
        runId: "intake",
        operationId: "describe",
        expectedStateRevision: 0,
      });
      if (!described.ok) {
        throw new Error(`plugin describe failed: ${described.observation.message}`);
      }
      const definition = described.value;
      assertDefinitionMatchesPin(definition, intake);

      const sourceDirtyBefore = await listDirtyPaths(intake.repoPath);
      const runId = assertSafeRunId(request.runId ?? randomUUID().slice(0, 12));
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

      try {
        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators: request.validators,
        });
      } finally {
        await host.close().catch(() => undefined);
      }

      const sourceDirtyAfter = await listDirtyPaths(intake.repoPath);
      return toReport(state, sourceDirtyAfter);
    },

    async continueAfterRestart(stateDir, deps): Promise<RunReport> {
      let state = await loadRunState(stateDir);
      if (state.status !== "running") {
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      }

      try {
        await assertWorktreeMatches(
          state.intake.repoPath,
          state.worktreePath,
          state.worktreeBranch,
          state.intake.pinnedHead,
        );
      } catch (err) {
        state = {
          ...state,
          status: "stopped",
          stopReason: "worktree mismatch",
          blocker: err instanceof Error ? err.message : String(err),
        };
        await saveRunState(state);
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      }

      const host =
        deps.host ??
        createInProcessPluginHost(deps.plugin, {
          activeVersion: state.activeVersion,
          generation: state.generation,
        });

      // Restart fences prior generation so stale evidence cannot Accept.
      state = bumpGeneration(state);
      await saveRunState(state);
      try {
        state = await runNormalLoop(state, {
          host,
          runner: deps.runner,
          validators: deps.validators,
        });
      } finally {
        await host.close().catch(() => undefined);
      }
      return toReport(state, await listDirtyPaths(state.intake.repoPath));
    },

    async inspect(stateDir: string): Promise<DurableRunState> {
      return loadRunState(stateDir);
    },
  };
}

function assertDefinitionMatchesPin(definition: GraphDefinition, intake: IntakePin): void {
  if (definition.graphId !== intake.bundle.graphId) {
    throw new Error(
      `plugin graphId ${definition.graphId} != pinned bundle ${intake.bundle.graphId}`,
    );
  }
  if (definition.version !== intake.bundle.version) {
    throw new Error(
      `plugin version ${definition.version} != pinned bundle ${intake.bundle.version}`,
    );
  }
  if (intake.bundle.sdkProtocol !== PROTOCOL_VERSION) {
    throw new Error(`pinned sdkProtocol ${intake.bundle.sdkProtocol} != ${PROTOCOL_VERSION}`);
  }
  const pinnedReqs = (intake.bundle as { digests?: unknown }).digests;
  void pinnedReqs;
  // Requirement statements from manifest (when present) must match describe().
  const manifestReqs = (
    JSON.parse(intake.bundle.manifestRaw) as {
      requirements?: Array<{ id: string; statement: string; evidenceSchema: string }>;
    }
  ).requirements;
  if (manifestReqs) {
    if (manifestReqs.length !== definition.requirements.length) {
      throw new Error("plugin requirements length != manifest");
    }
    for (const req of manifestReqs) {
      const live = definition.requirements.find((r) => r.id === req.id);
      if (!live || live.statement !== req.statement || live.evidenceSchema !== req.evidenceSchema) {
        throw new Error(`requirement mismatch for ${req.id}`);
      }
    }
  }
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
export { assertSafeRunId, assertSafeGraphId } from "./ids.js";

/** Test helper: attempt Validate using only current-generation evidence. */
export async function tryAdmit(
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
