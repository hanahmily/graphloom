import type { AgentSessionView, EvidenceRecord } from "@graphloom/sdk";
import { parseSupervisorDecision } from "./decision.js";
import type { PiSupervisorSession } from "./pi-session.js";
import { continuationRefusal, createAdmissionTools, escapingObservePath, supervisorProposalKey, writeScopeRefusal } from "./tools.js";
import {
  assertGrantedRoot,
  type CandidatePatchRequest,
  type Supervisor,
  type SupervisorInput,
  type SupervisorProposal,
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
  /** Models the operator configured; switches outside this set are refused. */
  configuredModels?: SupervisorModelRef[];
}

export type PiSupervisorSessionPort = PiSupervisorSession;

export interface PiSupervisor extends Supervisor {
  readonly binding: SupervisorBinding;
  /** Provider/model calls since the last drain (turns that started). */
  drainProviderCalls(): number;
  switchModel(args: {
    provider: string;
    modelId: string;
    reason: string;
  }): Promise<void>;
  grantCandidateCoding(candidateRoot: string): Promise<void>;
  revokeCandidateCoding(): Promise<void>;
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
 * Pi-backed recovery supervisor: one logical session, one admission tool call per
 * decision (JSON reply as fallback), explicit model switching, and provider-call
 * accounting for controller budgets.
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

  /**
   * Settle the model calls of one prompt: the turns that actually started, so
   * a prompt aborted before its first provider request costs nothing. A session
   * that cannot count turns is charged one call per prompt.
   */
  function settleTurns(): void {
    providerCalls += session.drainTurnCount !== undefined ? session.drainTurnCount() : 1;
  }

  const binding: SupervisorBinding = {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    provider: session.provider,
    modelId: session.modelId,
    switchJournal,
    configuredModels: configured.map((m) => ({ ...m })),
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

    async decide(input: SupervisorInput): Promise<SupervisorProposal> {
      if (closed) {
        throw new Error("supervisor is closed");
      }
      if (input.maxProviderCalls !== undefined && input.maxProviderCalls < 1) {
        throw new Error("decide has no provider-call allowance");
      }
      const toolbox = createAdmissionTools(
        configured,
        input.view.agentSessions ?? [],
        input.view.generation,
        input.trigger.code,
        input.view.escalation?.repeatedProposals,
      );
      const prompt = buildRecoveryPrompt(input, {
        current: { provider: binding.provider, modelId: binding.modelId },
        configured,
      });
      let text: string;
      try {
        text = await session.prompt(prompt, {
          tools: toolbox.tools,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.maxProviderCalls !== undefined ? { maxTurns: input.maxProviderCalls } : {}),
        });
      } finally {
        settleTurns();
      }
      // Models without tool calling may still reply with the decision as JSON,
      // bypassing the admission tools' in-turn checks entirely; an otherwise
      // malformed proposal from that path would reach the controller and
      // hard-stop the run with no chance to self-correct, the way the
      // tool-call path's reject() already lets the model fix in-turn.
      const proposal = toolbox.proposal() ?? parseSupervisorDecision(text);
      const sanitized = sanitizeProposal(proposal, input.view.agentSessions ?? [], input.view.generation);
      // A JSON-only reply never went through the admission tools' own
      // repeated-proposal rejection (there is no tool call to reject, and no
      // further turn for the model to retry in): reject it here instead of
      // letting a repeated no-progress proposal reach the controller through
      // this path alone.
      if ("action" in sanitized) {
        const key = supervisorProposalKey(input.trigger.code, sanitized.action);
        const already = input.view.escalation?.repeatedProposals[key]?.count ?? 0;
        if (already + 1 >= 3) {
          throw new Error(
            `this exact ${sanitized.action.type} proposal would be the ${already + 1 === 3 ? "3rd" : `${already + 1}th`} time with no progress since the controller last checked; propose something that would change the outcome, or stop`,
          );
        }
      }
      return sanitized;
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
          ...(args.signal !== undefined ? { signal: args.signal } : {}),
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
      const from = { provider: binding.provider, modelId: binding.modelId };
      const record: ModelSwitchRecord = {
        at: new Date().toISOString(),
        from,
        to,
        reason: args.reason,
        status: "intent",
      };
      switchJournal.push(record);
      if (!isConfigured(configured, to)) {
        record.status = "failed";
        record.error = `model not configured: ${to.provider}/${to.modelId}; refusing silent fallback`;
        throw new Error(record.error);
      }

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

/**
 * Repair what the tool-call path's reject() would have let the model correct
 * in-turn, so a text-only reply cannot reach the controller with a mistake
 * that hard-stops the whole run instead of being recoverable.
 *
 * - An invalid continueFrom is dropped: the dispatch still runs (fresh
 *   session, same instruction and writeScope), which is a far better outcome
 *   than losing the run to it.
 * - A work job missing its writeScope cannot be safely defaulted (there is no
 *   safe scope to invent), so the dispatch is replaced with a reenter of the
 *   same stage instead: safe, and it gives the supervisor another turn to
 *   dispatch that work with a real writeScope.
 * - An observe action keeps only the paths that do not escape the worktree.
 */
function sanitizeProposal(
  proposal: SupervisorProposal,
  agentSessions: readonly AgentSessionView[],
  generation: number,
): SupervisorProposal {
  if (!("action" in proposal)) return proposal;
  const { action } = proposal;
  if (action.type === "dispatch") {
    const scopeRefusal = writeScopeRefusal(action.job);
    if (scopeRefusal !== undefined) {
      return { ...proposal, action: { type: "reenter", reenter: { stageId: action.job.stageId, reason: scopeRefusal } } };
    }
    if (continuationRefusal(action.job, agentSessions, generation) === undefined) return proposal;
    const { continueFrom: _continueFrom, ...job2 } = action.job;
    void _continueFrom;
    return { ...proposal, action: { ...action, job: job2 } };
  }
  if (action.type === "observe" && action.observe.paths !== undefined) {
    const escaping = action.observe.paths.filter(
      (p) => escapingObservePath([p]) === undefined,
    );
    if (escaping.length === action.observe.paths.length) return proposal;
    return { ...proposal, action: { ...action, observe: { ...action.observe, paths: escaping } } };
  }
  return proposal;
}

/**
 * Why each recovery trigger code fired and which actions are, or are not, a
 * usable remedy given it — "what #97 did for correction_limit," generalized.
 * A code absent here (`supervise`, `unhandled`) gets no fixed guidance: read
 * the trigger's own message instead.
 */
const TRIGGER_GUIDANCE: Partial<Record<string, string>> = {
  // The controller already refused the graph's own work dispatch for the
  // current stage and discarded it unrun (see
  // packages/controller/src/escalation.ts's settleCorrectionTrial):
  // reenter does not clear that, so reenter then return only sends the
  // graph back to the same refusal; it is not a usable remedy here.
  correction_limit:
    'This episode\'s trigger is correction_limit: the controller already refused the graph\'s own next work dispatch for the current stage and discarded it unrun, because that stage hit its correction-trial limit. reenter does not clear that limit, so reenter then return only sends the graph back to the same refusal; it is not a usable remedy here. Dispatch that stage\'s work yourself (job.purpose "work", kind "agent", continuing the stage\'s earlier agent session with job.continueFrom when agentSessions has one for its dispatch key) to make real progress, or stop if the underlying problem is genuinely unrepairable. A work job\'s writeScope is required and must be non-empty; when you do not know this stage\'s own narrower convention, job.writeScope: ["."] (the whole worktree) is always valid — do not omit writeScope or the controller refuses the dispatch outright.',
  stalled:
    "This episode's trigger is stalled: the graph proposed the exact same decision twice with no progress since it last proposed it. Propose something that would actually change the outcome, not the same action again; reenter or dispatch new work for the stage are usually more useful than return.",
  executor_failed:
    "This episode's trigger is executor_failed: an executor reported failure or an abnormal result. Check this stage's own agentSessions entries' executorId first: only when it shows the default built-in agent executor, graphloom.agent/run, does a plain instruction-only dispatch (no input needed) retry safely yourself. For any other pinned executor — the usual case for a plugin's own work/review stages — its input shape (e.g. input.assignment, a harness choice) is plugin-specific and not visible to you, so a guessed dispatch usually fails the executor's own input schema validation rather than retrying anything; return instead, so the graph's own advance() reissues the dispatch with the input shape it already knows. Repairing the executor's package, or stopping, are the remedies when return does not change the outcome.",
  environment_changed:
    "This episode's trigger is environment_changed: a file the graph's environment declaration pins no longer matches what it was written against. A repair that updates the declaration (qualify_repair target plugin, when the bundle is source-repairable) is usually the fix; the run stays blocked otherwise.",
  plugin_crash:
    "This episode's trigger is plugin_crash: the graph plugin itself failed while deciding. A plugin repair (qualify_repair target plugin) may fix it when the bundle is source-repairable; otherwise stop, citing the failure.",
  plugin_timeout:
    "This episode's trigger is plugin_timeout: the graph plugin did not respond in time. Reentering rarely helps if the plugin itself is hanging; prefer a plugin repair when the bundle is source-repairable, or stop.",
  plugin_malformed:
    "This episode's trigger is plugin_malformed: the graph returned a decision the controller could not validate. A plugin repair (qualify_repair target plugin) may fix it when the bundle is source-repairable; otherwise stop, citing what was malformed.",
  contract_violation:
    "This episode's trigger is contract_violation: an agent result repeatedly failed to match its job's declared result contract (a missing/mis-typed field, or a reference id outside the set it was shown) even after the harness gave it a chance to correct it in-turn. Re-dispatch the stage's work with a more explicit instruction about the required shape, or switch to another pinned executor for it, if the contract itself looks right. If the trigger message shows the contract's own schema or reference set is wrong for what the stage actually needs, qualify_repair target plugin instead (when the bundle is source-repairable) rather than repeating the same dispatch.",
};

export function buildRecoveryPrompt(
  input: SupervisorInput,
  models?: { current: SupervisorModelRef; configured: readonly SupervisorModelRef[] },
): string {
  const currentGeneration = currentGenerationEvidence(input.view.evidence, input.view.generation);
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
    // Older generations are named here by ref only: a long recovery history
    // should not force every past episode's full detail into every prompt.
    evidenceRefs: input.view.evidence.map((e) => e.ref),
    // The current generation's own evidence, described rather than just named:
    // across many recovery episodes this session's own memory of what an older
    // evidence ref actually contained gets less reliable than reading it fresh.
    currentGenerationEvidence: currentGeneration.map((e) => describeRecoveryEvidence(e)),
    generation: input.view.generation,
    stateRevision: input.view.stateRevision,
    activeVersion: input.view.activeVersion,
    repairCandidates: input.view.repairCandidates ?? [],
    agentSessions: input.view.agentSessions ?? [],
    ...(input.view.repairAuthority !== undefined ? { repairAuthority: input.view.repairAuthority } : {}),
    ...(input.view.escalation !== undefined ? { escalation: input.view.escalation } : {}),
  };
  const workThisGeneration = currentGeneration.some((e) => producerOf(e)?.purpose === "work");
  const latestReviewVerdict = [...currentGeneration].reverse().map((e) => verdictOf(e)).find((v) => v !== undefined);
  const triggerGuidance = TRIGGER_GUIDANCE[input.trigger.code];

  const settlement = input.lastSettlement;
  return [
    "You are the GraphLoom run supervisor in recovery.",
    "Propose exactly one action by calling one GraphLoom tool: dispatch, observe, validate, reenter, qualify_repair, activate_repair, return, or stop.",
    "The controller admits and settles it and reports the outcome at the start of your next turn.",
    "If tools are unavailable, reply with one GraphDecision as JSON ({\"reason\", \"action\": {\"type\", ...}}), optionally in a ```json fence.",
    "Never propose Accept. Never add, remove, rename, or reorder graph steps.",
    "Prefer further authorized remedies over Stop while budgets and authority remain.",
    "For activate_repair, use a qualifiedArtifactId from repairCandidates with status qualified.",
    "repairAuthority shows what the operator granted and whether the graph bundle's code can be patched. An opaque bundle's code cannot be: retry the work or repair its environment instead. Substitute a validator (qualify_repair target validator with requirementId, adding files without editing existing ones) only when validatorSubstitution is granted and that requirement has a readable statement. Otherwise stop, citing the failing validation's evidenceRefs; never invent a replacement criterion.",
    "reenter starts a new attempt but runs nothing. To have the graph run that attempt's own jobs (its instructions, result schemas and write scopes), return after reentering; dispatch only work the graph would not run itself.",
    "To retry a stage's agent work with the context of its earlier session, dispatch with job.kind \"agent\" and job.continueFrom set to an operationId from agentSessions of that stage and dispatch key; start fresh instead when that context is misleading. continueFrom only works on an agent job: a command job has no session to resume.",
    ...(triggerGuidance !== undefined ? [triggerGuidance] : []),
    ...(triggerGuidance === undefined && latestReviewVerdict === "approved" && !workThisGeneration
      ? [
          "The current generation's own review already approved, and no work-purpose evidence exists yet this generation: the graph has not actually attempted that work. Prefer reenter then return over re-dispatching another review of the same approved plan.",
        ]
      : []),
    "A proposal identical to one you already made, with no progress since, is tracked: the 2nd time is reported back as a settlement fact on your next turn, and the 3rd time is rejected in-turn by the tool itself — propose something that would actually change the outcome instead, or stop.",
    ...(models !== undefined
      ? [
          `Your model is ${models.current.provider}/${models.current.modelId}. To continue on another operator-configured model (${models.configured
            .map((m) => `${m.provider}/${m.modelId}`)
            .join(", ")}), call switch_model instead of an action.`,
        ]
      : []),
    ...(settlement !== undefined
      ? [
          `Since the last proposal (${settlement.action}: ${settlement.reason}), the controller settled:`,
          ...settlement.facts.map((f) => `- ${f}`),
        ]
      : []),
    `Episode: ${input.episodeId}`,
    "Recovery context:",
    "```json",
    JSON.stringify(viewSummary, null, 2),
    "```",
  ].join("\n");
}

const MAX_CURRENT_GENERATION_EVIDENCE = 40;
const MAX_EVIDENCE_DETAIL_CHARS = 160;

function currentGenerationEvidence(evidence: EvidenceRecord[], generation: number): EvidenceRecord[] {
  return evidence.filter((e) => e.generation === generation).slice(-MAX_CURRENT_GENERATION_EVIDENCE);
}

function producerOf(record: EvidenceRecord): { stageId?: string; purpose?: string } | undefined {
  const payload = record.payload as { producer?: { stageId?: string; purpose?: string } } | undefined;
  return payload?.producer;
}

/** The verdict a review-purpose or review-kind evidence record carries, wherever its payload puts it. */
function verdictOf(record: EvidenceRecord): string | undefined {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.verdict === "string") return payload.verdict;
  const output = (payload.codingAgent as { output?: unknown } | undefined)?.output as
    | Record<string, unknown>
    | undefined;
  return typeof output?.verdict === "string" ? (output.verdict as string) : undefined;
}

/**
 * One line describing an evidence record by its producer and whatever
 * verdict/status/summary its payload carries, not just its bare ref: across
 * many recovery episodes this session's own memory of an older ref's content
 * gets less reliable than reading a fresh, bounded description of it.
 */
function describeRecoveryEvidence(record: EvidenceRecord): string {
  const producer = producerOf(record);
  const who = producer?.stageId !== undefined && producer?.purpose !== undefined ? `${producer.stageId}/${producer.purpose}` : record.kind;
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const codingAgent = payload.codingAgent as { status?: string; output?: unknown } | undefined;
  const output = codingAgent?.output as Record<string, unknown> | undefined;
  const verdict = verdictOf(record);
  const status = typeof output?.status === "string" ? (output.status as string) : codingAgent?.status;
  // "summary" and "reason" are both common across this codebase's evidence
  // shapes (job summaries vs. decision/review reasons); either is worth showing.
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const summary = text(payload.summary) ?? text(output?.summary) ?? text(payload.reason) ?? text(output?.reason);
  const detail = [verdict, status, summary].filter((s): s is string => s !== undefined).join(", ");
  return `${record.ref} (${who})${detail !== "" ? `: ${clipDetail(detail)}` : ""}`;
}

function clipDetail(text: string): string {
  return text.length <= MAX_EVIDENCE_DETAIL_CHARS ? text : `${text.slice(0, MAX_EVIDENCE_DETAIL_CHARS)}…`;
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
    "Your working directory is the candidate root. Use the shell and file tools to investigate, fix the defect, and build and run the candidate's tests.",
    "Change only files inside the candidate root; the live install and the run worktree are off limits, and the controller stops the run if the patch changes the live install, the run worktree, or the run state.",
    "Do not edit graphloom.stages.json. Do not add, remove, rename, or reorder graph steps, and do not change requirement statements or evidence schemas.",
    "Keep existing tests and negative cases; do not loosen expected outcomes. Add a focused regression case when the defect is testable.",
    "After you finish, the controller builds and tests the candidate itself, then an independent reviewer decides.",
    ...(args.maxProviderCalls !== undefined
      ? [`You have at most ${args.maxProviderCalls} model turns, including tool turns; the patch is aborted beyond that.`]
      : []),
    "When done, reply with a short plain-text summary of what you changed and why (at most a few sentences). Do not include private reasoning.",
  ].join("\n");
}
