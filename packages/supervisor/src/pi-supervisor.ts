import type { GraphDecision } from "@graphloom/sdk";
import { parseSupervisorDecision } from "./decision.js";
import type { PiSupervisorSession } from "./pi-session.js";
import {
  assertGrantedRoot,
  type CandidatePatchRequest,
  type Supervisor,
  type SupervisorInput,
} from "./types.js";

export interface SupervisorModelRef {
  provider: string;
  modelId: string;
}

export interface ModelSwitchRecord {
  at: string;
  from: SupervisorModelRef;
  to: SupervisorModelRef;
  reason: string;
  status: "intent" | "committed" | "failed";
  error?: string;
}

/** Durable identity restored across controller restarts. */
export interface SupervisorBinding {
  sessionId: string;
  sessionFile: string | undefined;
  provider: string;
  modelId: string;
  switchJournal: ModelSwitchRecord[];
}

export type PiSupervisorSessionPort = PiSupervisorSession;

export interface PiSupervisor extends Supervisor {
  readonly binding: SupervisorBinding;
  /** Provider/model calls since the last drain (each decide prompt counts as ≥1). */
  drainProviderCalls(): number;
  switchModel(args: {
    provider: string;
    modelId: string;
    reason: string;
  }): Promise<void>;
  /** Last granted candidate coding root, if any. */
  candidateCodingRoot(): string | undefined;
}

export interface CreatePiSupervisorOptions {
  session: PiSupervisorSessionPort;
  /** Models the operator has configured; switches outside this set are rejected. */
  configuredModels?: SupervisorModelRef[];
  /** Rehydrate journal when restoring a durable binding. */
  initialSwitchJournal?: ModelSwitchRecord[];
  /** Timeout for one candidate patch episode, which may span many tool turns. Default 600_000. */
  patchTimeoutMs?: number;
}

const MAX_PATCH_SUMMARY_CHARS = 2_000;

/**
 * Pi-backed recovery supervisor: one logical session, JSON GraphDecision replies,
 * explicit model switching, and provider-call accounting for controller budgets.
 */
export function createPiSupervisor(options: CreatePiSupervisorOptions): PiSupervisor {
  const { session } = options;
  const configured = options.configuredModels ?? [
    { provider: session.provider, modelId: session.modelId },
  ];
  const switchJournal: ModelSwitchRecord[] = [
    ...(options.initialSwitchJournal ?? []).map((r) => ({ ...r })),
  ];
  let providerCalls = 0;
  let closed = false;
  let codingRoot: string | undefined;
  const patchTimeoutMs = options.patchTimeoutMs ?? 600_000;

  /** Settle the model calls of one prompt; a prompt always costs at least one. */
  function settleTurns(): void {
    providerCalls += Math.max(1, session.drainTurnCount?.() ?? 0);
  }

  const binding: SupervisorBinding = {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    provider: session.provider,
    modelId: session.modelId,
    switchJournal,
  };

  function syncBindingModel(): void {
    binding.provider = session.provider;
    binding.modelId = session.modelId;
    binding.sessionId = session.sessionId;
    binding.sessionFile = session.sessionFile;
  }

  return {
    sessionId: session.sessionId,
    get binding() {
      return {
        ...binding,
        switchJournal: [...switchJournal],
      };
    },

    drainProviderCalls() {
      const n = providerCalls;
      providerCalls = 0;
      return n;
    },

    candidateCodingRoot() {
      return codingRoot;
    },

    async grantCandidateCoding(candidateRoot: string) {
      if (closed) {
        throw new Error("supervisor is closed");
      }
      if (!session.grantCandidateCoding) {
        throw new Error("supervisor session cannot grant candidate coding tools");
      }
      // Same session identity for every repair round — only the scoped root changes.
      await session.grantCandidateCoding(candidateRoot);
      codingRoot = candidateRoot;
    },

    async revokeCandidateCoding() {
      codingRoot = undefined;
      await session.revokeCandidateCoding?.();
    },

    async decide(input: SupervisorInput): Promise<GraphDecision> {
      if (closed) {
        throw new Error("supervisor is closed");
      }
      const prompt = buildRecoveryPrompt(input);
      let text: string;
      try {
        text = await session.prompt(prompt);
      } finally {
        settleTurns();
      }
      return parseSupervisorDecision(text);
    },

    async patchCandidate(args: CandidatePatchRequest) {
      if (closed) {
        throw new Error("supervisor is closed");
      }
      assertGrantedRoot(codingRoot, args.candidateRoot);
      const maxTurns = args.maxProviderCalls;
      if (maxTurns !== undefined && maxTurns < 1) {
        throw new Error("patchCandidate has no provider-call allowance");
      }
      let text: string;
      try {
        text = await session.prompt(buildRepairPrompt(args), {
          timeoutMs: patchTimeoutMs,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
        });
      } finally {
        settleTurns();
      }
      const summary = text.trim().slice(0, MAX_PATCH_SUMMARY_CHARS);
      return { summary: summary === "" ? "(no summary returned)" : summary };
    },

    async switchModel(args) {
      if (closed) {
        throw new Error("supervisor is closed");
      }
      const to = { provider: args.provider, modelId: args.modelId };
      if (!isConfigured(configured, to)) {
        throw new Error(
          `model not configured: ${to.provider}/${to.modelId}; refusing silent fallback`,
        );
      }
      const from = { provider: binding.provider, modelId: binding.modelId };
      const record: ModelSwitchRecord = {
        at: new Date().toISOString(),
        from,
        to,
        reason: args.reason,
        status: "intent",
      };
      switchJournal.push(record);

      try {
        await session.setModel(to);
        syncBindingModel();
        record.status = "committed";
      } catch (err) {
        record.status = "failed";
        record.error = err instanceof Error ? err.message : String(err);
        syncBindingModel();
        throw err;
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      await session.close();
    },
  };
}

function isConfigured(configured: SupervisorModelRef[], ref: SupervisorModelRef): boolean {
  return configured.some(
    (m) => m.provider === ref.provider && m.modelId === ref.modelId,
  );
}

export function buildRecoveryPrompt(input: SupervisorInput): string {
  const viewSummary = {
    runId: input.runId,
    episodeId: input.episodeId,
    trigger: input.trigger,
    current: input.view.current,
    recoveryEpisodeId: input.view.recoveryEpisodeId,
    budgets: input.view.budgets,
    outstanding: input.view.outstanding,
    receipts: input.view.receipts.map((r) => ({
      stageId: r.stageId,
      valid: r.valid,
      requirementId: r.requirementId,
    })),
    evidenceRefs: input.view.evidence.map((e) => e.ref),
    generation: input.view.generation,
    stateRevision: input.view.stateRevision,
    activeVersion: input.view.activeVersion,
    repairCandidates: input.view.repairCandidates ?? [],
  };

  return [
    "You are the GraphLoom run supervisor in recovery.",
    "Propose exactly one GraphDecision as JSON (optionally in a ```json fence).",
    "Allowed action types: dispatch, observe, validate, reenter, qualify_repair, activate_repair, return, stop.",
    "Never propose Accept. Never add, remove, rename, or reorder graph steps.",
    "Prefer further authorized remedies over Stop while budgets and authority remain.",
    "For activate_repair, use a qualifiedArtifactId from repairCandidates with status qualified.",
    `Episode: ${input.episodeId}`,
    "Recovery context:",
    "```json",
    JSON.stringify(viewSummary, null, 2),
    "```",
  ].join("\n");
}

/**
 * Candidate patch instruction for the same supervisor session that proposed the
 * QualifyRepair. The earlier recovery turns in this session carry the failure
 * evidence; this prompt fixes the scope and the rules.
 */
export function buildRepairPrompt(args: CandidatePatchRequest): string {
  return [
    "You are the GraphLoom run supervisor, now authoring the qualified repair you proposed.",
    `Target: ${args.target}`,
    `Reason: ${args.reason}`,
    `Candidate root: ${args.candidateRoot}`,
    "Use the read, edit, write, and ls tools to fix the defect in the candidate tree.",
    "Every path must stay inside the candidate root; the live install and the run worktree are off limits.",
    "Do not edit graphloom.stages.json. Do not add, remove, rename, or reorder graph steps, and do not change requirement statements or evidence schemas.",
    "Keep existing tests and negative cases; do not loosen expected outcomes. Add a focused regression case when the defect is testable.",
    "No shell is available. The controller builds and tests the candidate after you finish, then an independent reviewer decides.",
    ...(args.maxProviderCalls !== undefined
      ? [`You have at most ${args.maxProviderCalls} model turns, including tool turns; the patch is aborted beyond that.`]
      : []),
    "When done, reply with a short plain-text summary of what you changed and why (at most a few sentences). Do not include private reasoning.",
  ].join("\n");
}
