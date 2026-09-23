import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  type BudgetRemaining,
  type GraphDefinition,
  type GraphPlugin,
  type StageAttempt,
  type Validator,
} from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import {
  createChildPluginHost,
  createInProcessPluginHost,
  type PluginHost,
} from "@graphloom/plugin-host";
import { admitValidation } from "./admit.js";
import { loadValidatorsFromBundle, resolveBundleEntry } from "./bundle.js";
import { intakeTask, type IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import {
  bumpGeneration,
  ensureArtifactDir,
  initialState,
  runNormalLoop,
  toRunView,
} from "./loop.js";
import {
  getSession,
  registerSession,
  reapSession,
  unregisterSession,
  type ActiveSession,
} from "./sessions.js";
import {
  loadRunState,
  saveRunState,
  type DurableRunState,
  type RunStatus,
  type VersionRecord,
} from "./state.js";
import {
  assertWorktreeMatches,
  createRunWorktree,
  listDirtyPaths,
} from "./worktree.js";

export interface RunRequest {
  taskPath: string;
  runner: Runner;
  /**
   * Optional validators. When omitted, loaded from the pinned bundle entry.
   */
  validators?: Record<string, Validator>;
  /**
   * Scripted/CI seam: wrapped in an in-process PluginHost.
   * When omitted (and `host` omitted), the controller loads the pinned
   * bundle in an isolated child process.
   */
  plugin?: GraphPlugin;
  /** Optional pre-built host; when set, overrides plugin/child loading. */
  host?: PluginHost;
  /** Directory for durable run state (default: <repo>/graphloom-state). */
  stateRoot?: string;
  runId?: string;
}

export interface ResumeRequest {
  /** Absolute state directory, or runId under stateRoot. */
  runRef: string;
  runner: Runner;
  validators?: Record<string, Validator>;
  plugin?: GraphPlugin;
  host?: PluginHost;
  stateRoot?: string;
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

export interface InspectReport {
  runId: string;
  status: RunStatus;
  mode: "normal" | "recovery";
  stages: Array<{
    id: string;
    name: string;
    requirementIds: string[];
    complete: boolean;
  }>;
  current: StageAttempt;
  evidenceRefs: string[];
  budgets: BudgetRemaining;
  versionHistory: VersionRecord[];
  activeVersion: string;
  generation: number;
  worktreePath: string;
  stateDir: string;
  stopReason?: string;
  blocker?: string;
}

export interface Controller {
  run(request: RunRequest): Promise<RunReport>;
  stop(runRef: string, options?: { stateRoot?: string }): Promise<InspectReport>;
  resume(request: ResumeRequest): Promise<RunReport>;
  inspect(runRef: string, options?: { stateRoot?: string }): Promise<InspectReport>;
  /** @deprecated Prefer resume(); retained for #25 tests. */
  continueAfterRestart(
    stateDir: string,
    deps: Pick<RunRequest, "plugin" | "host" | "runner" | "validators">,
  ): Promise<RunReport>;
}

export function createController(): Controller {
  return {
    async run(request: RunRequest): Promise<RunReport> {
      const intake = await intakeTask(request.taskPath);
      const runId = assertSafeRunId(request.runId ?? randomUUID().slice(0, 12));
      const stateRoot = request.stateRoot ?? path.join(intake.repoPath, "graphloom-state");
      const activeVersion = `${intake.bundle.graphId}@${intake.bundle.version}`;

      const host = await openHost({
        intake,
        activeVersion,
        generation: 1,
        ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
        ...(request.host !== undefined ? { host: request.host } : {}),
      });

      const session: ActiveSession = {
        runId,
        stateDir: path.join(stateRoot, runId),
        host,
        stopRequested: false,
      };
      registerSession(session);

      try {
        const described = await host.describe({
          runId,
          operationId: "describe",
          expectedStateRevision: 0,
        });
        if (!described.ok) {
          throw new Error(`plugin describe failed: ${described.observation.message}`);
        }
        const definition = described.value;
        assertDefinitionMatchesPin(definition, intake);

        const validators =
          request.validators ??
          (await loadValidatorsFromBundle(
            intake,
            definition.defaultValidators.map((b) => b.validatorId),
          ));

        const sourceDirtyBefore = await listDirtyPaths(intake.repoPath);
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
        session.stateDir = state.stateDir;
        registerSession(session);
        await ensureArtifactDir(state);
        await saveRunState(state);

        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators,
          shouldStop: () => session.stopRequested,
        });

        const sourceDirtyAfter = await listDirtyPaths(intake.repoPath);
        return toReport(state, sourceDirtyAfter);
      } finally {
        await reapSession(session);
      }
    },

    async stop(runRef, options): Promise<InspectReport> {
      const stateDir = await resolveStateDir(runRef, options?.stateRoot);
      const session = getSession(stateDir) ?? getSession(runRef);
      if (session) {
        session.stopRequested = true;
        await session.host.close().catch(() => undefined);
      }

      let state = await loadRunState(stateDir);
      if (state.status === "running") {
        state = bumpGeneration(
          {
            ...state,
            status: "stopped",
            stopReason: "operator stop",
            blocker: "stop requested",
          },
          "operator stop",
        );
        await saveRunState(state);
      }
      if (session) {
        unregisterSession(session);
      }
      return toInspect(state);
    },

    async resume(request: ResumeRequest): Promise<RunReport> {
      const stateDir = await resolveStateDir(request.runRef, request.stateRoot);
      let state = await loadRunState(stateDir);

      if (state.status === "succeeded" || state.status === "failed") {
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

      // Fence prior generation so late child/job results cannot apply.
      state = bumpGeneration(
        { ...state, status: "running" },
        "resume",
      );
      // Drop incomplete dispatch intent — reconcile rather than replay.
      if (state.pendingDispatch?.status === "pending") {
        const pendingId = state.pendingDispatch.operationId;
        const { pendingDispatch: _pending, ...rest } = state;
        void _pending;
        state = {
          ...rest,
          status: "stopped",
          stopReason: "reconcile required",
          blocker: `pending dispatch ${pendingId} at resume`,
        };
        await saveRunState(state);
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      }
      await saveRunState(state);

      const host = await openHost({
        intake: state.intake,
        activeVersion: state.activeVersion,
        generation: state.generation,
        ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
        ...(request.host !== undefined ? { host: request.host } : {}),
      });

      const session: ActiveSession = {
        runId: state.runId,
        stateDir: state.stateDir,
        host,
        stopRequested: false,
      };
      registerSession(session);

      try {
        const validators =
          request.validators ??
          (await loadValidatorsFromBundle(
            state.intake,
            state.definition.defaultValidators.map((b) => b.validatorId),
          ));

        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators,
          shouldStop: () => session.stopRequested,
        });
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      } finally {
        await reapSession(session);
      }
    },

    async inspect(runRef, options): Promise<InspectReport> {
      const stateDir = await resolveStateDir(runRef, options?.stateRoot);
      const state = await loadRunState(stateDir);
      return toInspect(state);
    },

    async continueAfterRestart(stateDir, deps): Promise<RunReport> {
      const resumeReq: ResumeRequest = {
        runRef: stateDir,
        runner: deps.runner,
      };
      if (deps.validators !== undefined) {
        resumeReq.validators = deps.validators;
      }
      if (deps.plugin !== undefined) {
        resumeReq.plugin = deps.plugin;
      }
      if (deps.host !== undefined) {
        resumeReq.host = deps.host;
      }
      return this.resume(resumeReq);
    },
  };
}

async function openHost(args: {
  plugin?: GraphPlugin;
  host?: PluginHost;
  intake: IntakePin;
  activeVersion: string;
  generation: number;
}): Promise<PluginHost> {
  if (args.host) {
    return args.host;
  }
  if (args.plugin) {
    return createInProcessPluginHost(args.plugin, {
      activeVersion: args.activeVersion,
      generation: args.generation,
    });
  }
  const entryModule = resolveBundleEntry(args.intake);
  return createChildPluginHost({
    entryModule,
    activeVersion: args.activeVersion,
    generation: args.generation,
    cwd: args.intake.bundle.bundlePath,
  });
}

async function resolveStateDir(runRef: string, stateRoot?: string): Promise<string> {
  if (path.isAbsolute(runRef)) {
    await access(path.join(runRef, "state.json"));
    return runRef;
  }
  if (!stateRoot) {
    throw new Error("stateRoot required when runRef is not an absolute state directory");
  }
  const dir = path.join(stateRoot, assertSafeRunId(runRef));
  await access(path.join(dir, "state.json"));
  return dir;
}

function toInspect(state: DurableRunState): InspectReport {
  const report: InspectReport = {
    runId: state.runId,
    status: state.status,
    mode: state.mode,
    stages: state.definition.stages.map((s) => ({
      id: s.id,
      name: s.name,
      requirementIds: [...s.requirementIds],
      complete: s.requirementIds.every((reqId) =>
        state.receipts.some(
          (r) => r.stageId === s.id && r.requirementId === reqId && r.valid,
        ),
      ),
    })),
    current: structuredClone(state.current),
    evidenceRefs: state.evidence.map((e) => e.ref),
    budgets: { ...state.budgets },
    versionHistory: structuredClone(state.versionHistory ?? []),
    activeVersion: state.activeVersion,
    generation: state.generation,
    worktreePath: state.worktreePath,
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
export type { DurableRunState, RunStatus, VersionRecord } from "./state.js";
export type { IntakePin } from "./intake.js";
export { assertSafeRunId, assertSafeGraphId } from "./ids.js";
export { resolveBundleEntry, loadValidatorsFromBundle } from "./bundle.js";

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
