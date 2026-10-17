import type { AgentSessionView, CaseFile, EvidenceRecord, GraphAction } from "@graphloom/sdk";
import { parseSupervisorDecision } from "./decision.js";
import type { PiSupervisorSession, ThinkingLevel } from "./pi-session.js";
import { isSupervisorProviderError, SupervisorProviderError, type ProviderFailure } from "./provider-failure.js";
import {
  continuationRefusal,
  createAdmissionTools,
  escapingObservePath,
  offeredActions,
  rejectionText,
  supervisorProposalKey,
  writeScopeRefusal,
  type GraphLoomSupervisorAction,
} from "./tools.js";
import {
  assertGrantedRoot,
  type CandidatePatchRequest,
  type Supervisor,
  type SupervisorInput,
  type SupervisorProposal,
  type SupervisorRemedy,
} from "./types.js";

export interface SupervisorModelRef {
  provider: string;
  modelId: string;
  /** Reasoning level this model needs; omit for the "off" default. */
  thinkingLevel?: ThinkingLevel;
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
  /** Deterministic remedies applied to failed provider turns since the last drain. */
  drainRemedies(): SupervisorRemedy[];
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
  /** The first episode's session; it may not have been prompted yet. */
  session: PiSupervisorSessionPort;
  /**
   * Open a fresh session on `model` for a new recovery episode. Each episode
   * then starts with no earlier chat: its memory of past episodes is the
   * controller's case file in the prompt. Omitted (tests, hosts that cannot
   * open sessions), every episode shares `session`.
   */
  openSession?: (model: SupervisorModelRef) => Promise<PiSupervisorSessionPort>;
  /**
   * The logical supervisor identity, stable across episode sessions and
   * restarts. Default: the first session's id.
   */
  logicalSessionId?: string;
  /** Models the operator has configured; switches outside this set are rejected. */
  configuredModels?: SupervisorModelRef[];
  /** Rehydrate journal when restoring a durable binding. */
  initialSwitchJournal?: ModelSwitchRecord[];
  /** Timeout for one candidate patch episode, which may span many tool turns. Default 600_000. */
  patchTimeoutMs?: number;
  /**
   * Operator fallback: how long to wait before retrying a quota error whose
   * message states no reset time. Omitted means such an error stops the run.
   * Still bounded by the turn's `maxWaitMs` and the per-turn wait limit.
   */
  quotaRetryMs?: number;
  /**
   * Hold this supervisor's `stop`, `reenter` and validator- or executor-blaming
   * repairs to citing evidence or an episode probe (default true). Turn it off
   * only for a session that cannot call tools and so cannot probe or list evidence.
   */
  requireCitedEvidence?: boolean;
}

const MAX_PATCH_SUMMARY_CHARS = 2_000;
/** Quota waits one decision turn may take before the failure stops the run. */
const MAX_QUOTA_WAITS = 3;
/** Upper bound of one compaction's provider requests (mirrors pi-session.ts). */
const COMPACTION_PROVIDER_CALLS = 2;
/** A compaction plus at least one retried turn. */
const COMPACT_AND_RETRY_CALLS = COMPACTION_PROVIDER_CALLS + 1;
/** Identical resends of an interrupted reply one decision turn may make before the slip remedies apply. */
const MAX_INTERRUPTED_RESENDS = 2;

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!(ms > 0) || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Pi-backed recovery supervisor: one logical supervisor with a fresh Pi session
 * per recovery episode, one admission tool call per decision (JSON reply as
 * fallback), explicit model switching, and provider-call accounting for
 * controller budgets.
 */
export function createPiSupervisor(options: CreatePiSupervisorOptions): PiSupervisor {
  let session = options.session;
  /** The episode the current session belongs to, once it has been prompted for one. */
  let sessionEpisode: string | undefined;
  const logicalSessionId = options.logicalSessionId ?? session.sessionId;
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
  const quotaRetryMs =
    options.quotaRetryMs !== undefined && Number.isFinite(options.quotaRetryMs) && options.quotaRetryMs > 0
      ? Math.ceil(options.quotaRetryMs)
      : undefined;

  /**
   * Settle the model calls of one prompt: the turns that actually started, so
   * a prompt aborted before its first provider request costs nothing. A session
   * that cannot count turns is charged one call per prompt.
   */
  function settleTurns(): number {
    const n = session.drainTurnCount !== undefined ? session.drainTurnCount() : 1;
    providerCalls += n;
    return n;
  }

  let remedies: SupervisorRemedy[] = [];

  const binding: SupervisorBinding = {
    sessionId: logicalSessionId,
    sessionFile: session.sessionFile,
    provider: session.provider,
    modelId: session.modelId,
    switchJournal,
    configuredModels: configured.map((m) => ({ ...m })),
  };

  function syncBindingModel(): void {
    binding.provider = session.provider;
    binding.modelId = session.modelId;
    binding.sessionFile = session.sessionFile;
  }

  /**
   * Give `episodeId` its own session: the first episode keeps the session it
   * was created with; a later one opens a fresh session on the current model,
   * so no chat from an earlier episode (or an earlier process) reaches it.
   */
  async function enterEpisode(episodeId: string): Promise<void> {
    if (sessionEpisode === episodeId) return;
    if (sessionEpisode !== undefined && options.openSession !== undefined) await replaceSession(options.openSession);
    sessionEpisode = episodeId;
  }

  /**
   * The episode session a turn set aside while one of its attempts runs on
   * another configured model (the last remedy for an empty or malformed
   * reply). Set only inside one decide(); the binding keeps the bound model.
   */
  let boundSession: PiSupervisorSessionPort | undefined;

  /**
   * Swap in a new session on the current session's model, keeping any
   * candidate coding grant, and close the old one.
   */
  async function replaceSession(open: NonNullable<CreatePiSupervisorOptions["openSession"]>): Promise<void> {
    const current = { provider: session.provider, modelId: session.modelId };
    const next = await open(findConfigured(configured, current) ?? current);
    if (codingRoot !== undefined) await next.grantCandidateCoding?.(codingRoot);
    const previous = session;
    session = next;
    if (boundSession === undefined) syncBindingModel();
    await previous.close().catch(() => undefined);
  }

  /** Run the rest of this turn on `model`, in its own session, setting the bound session aside. */
  async function enterTransientModel(
    open: NonNullable<CreatePiSupervisorOptions["openSession"]>,
    model: SupervisorModelRef,
  ): Promise<void> {
    const next = await open(model);
    if (codingRoot !== undefined) await next.grantCandidateCoding?.(codingRoot);
    if (boundSession === undefined) boundSession = session;
    else await session.close().catch(() => undefined);
    session = next;
  }

  /** Back to the bound session once the turn that set it aside is over. */
  async function leaveTransientModel(): Promise<void> {
    if (boundSession === undefined) return;
    const transient = session;
    session = boundSession;
    boundSession = undefined;
    syncBindingModel();
    await transient.close().catch(() => undefined);
  }

  /** One decision turn, on the episode's session (see decide). */
  async function decideTurn(input: SupervisorInput): Promise<SupervisorProposal> {
    const toolsFor = () =>
      createAdmissionTools(
        configured,
        input.view.agentSessions ?? [],
        input.view.generation,
        input.trigger.code,
        input.view.escalation?.repeatedProposals,
        input.admission,
        input.recordFinding,
        input.inspect,
      );
    const callsBefore = providerCalls;
    // Every prompt of this turn shares the controller's one allowance:
    // re-asks, rejection re-asks, provider-failure retries and compaction.
    const remainingCalls = () =>
      input.maxProviderCalls === undefined ? undefined : input.maxProviderCalls - (providerCalls - callsBefore);
    // Provider-failure remedies (design-supervisor-robustness.md §4.3) share
    // one wait budget and one compaction across the whole turn.
    let waitLeft = Math.max(0, input.maxWaitMs ?? 0);
    let quotaWaits = 0;
    let compacted = false;
    let timeoutRetried = false;
    let resends = 0;
    const remedy = (
      failure: ProviderFailure,
      kind: SupervisorRemedy["remedy"],
      waitedMs?: number,
      waitBasis?: SupervisorRemedy["waitBasis"],
      model?: SupervisorModelRef,
    ): void => {
      remedies.push({
        at: new Date().toISOString(),
        failureClass: failure.failureClass,
        remedy: kind,
        message: failure.message,
        ...(waitedMs !== undefined ? { waitedMs } : {}),
        ...(waitBasis !== undefined ? { waitBasis } : {}),
        ...(model !== undefined ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
      });
    };

    /** This turn's full recovery prompt; a fresh session needs it before any follow-up. */
    let opening = "";
    /**
     * The controller's latest rejection prompt this turn, if any: a fresh
     * session is sent the opening and then this, never a re-ask's correction.
     */
    let followUp: string | undefined;
    /** What a session with no chat is sent to retry this turn. */
    const freshPrompt = () => (followUp === undefined ? opening : `${opening}\n\n${followUp}`);

    /**
     * One prompt. A provider error (quota, overflow, auth, unknown) is
     * remedied here without asking the model what to do, or thrown as a
     * SupervisorProviderError; it never reaches admission, so it is never
     * counted as an inadmissible proposal. A reply that arrived but is empty
     * or unreadable is returned for the caller's bounded slip remedies.
     */
    const ask = async (text: string, toolbox: ReturnType<typeof toolsFor>): Promise<string> => {
      let last: SupervisorProviderError | undefined;
      let sent = text;
      for (;;) {
        const maxTurns = remainingCalls();
        if (maxTurns !== undefined && maxTurns < 1) {
          if (last !== undefined) throw last.withUnremedied("no provider calls left in the run's budget to retry");
          throw new Error("decide has no provider-call allowance left this turn");
        }
        let reply = "";
        let timedOut: SupervisorProviderError | undefined;
        try {
          reply = await session.prompt(sent, {
            tools: toolbox.tools,
            // Once a proposal is admitted (or the rejection allowance is spent)
            // the turn is over: no further provider request for a summary.
            done: () => toolbox.proposal() !== undefined || toolbox.exhausted() !== undefined,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
            ...(maxTurns !== undefined ? { maxTurns } : {}),
          });
        } catch (err) {
          // Stop always wins: an aborted prompt is never a timeout to remedy.
          if (input.signal?.aborted === true || !isSupervisorProviderError(err) || err.failureClass !== "timeout") throw err;
          timedOut = err;
        } finally {
          // Charged to the session that made the calls, before any replacement.
          settleTurns();
        }
        if (timedOut !== undefined) {
          // A provider that went silent (or never finished) is retried once,
          // in a fresh episode session: the aborted one may still be busy and
          // refuse reuse, and its partial turn is no context worth keeping.
          last = timedOut;
          if (timeoutRetried) throw last.withUnremedied("already retried once");
          if ((remainingCalls() ?? 1) < 1) throw last.withUnremedied("no provider calls left in the run's budget to retry");
          if (options.openSession === undefined) throw last.withUnremedied("the host cannot open a fresh session");
          timeoutRetried = true;
          try {
            await replaceSession(options.openSession);
          } catch (err) {
            throw last.withUnremedied(`opening a fresh session failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          remedy({ failureClass: "timeout", message: last.providerMessage }, "fresh_session_retry");
          // The fresh session has no chat: a re-ask or rejection follows the full prompt.
          sent = text.startsWith(opening) ? text : `${opening}\n\n${text}`;
          continue;
        }
        if (toolbox.proposal() !== undefined || toolbox.exhausted() !== undefined) return reply;
        const failure = session.lastReplyFailure?.();
        if (
          failure?.failureClass === "interrupted" &&
          resends < MAX_INTERRUPTED_RESENDS &&
          input.signal?.aborted !== true &&
          (remainingCalls() ?? 1) >= 1 &&
          session.omitLastExchange?.() === true
        ) {
          // The provider dropped output the model generated (billed, never
          // delivered). The model did not choose to stop, so nothing is wrong
          // with what it was asked: the half turn is taken out of its context
          // and the identical prompt is sent again, with no correction text.
          resends += 1;
          remedy(failure, "resend_interrupted");
          continue;
        }
        if (
          failure === undefined ||
          failure.failureClass === "interrupted" ||
          failure.failureClass === "empty" ||
          failure.failureClass === "malformed"
        ) {
          return reply;
        }
        last = new SupervisorProviderError(failure);
        switch (failure.failureClass) {
          case "quota": {
            if (failure.retryAt === undefined && quotaRetryMs === undefined) {
              throw last.withUnremedied("the provider gave no reset time to wait for");
            }
            if (quotaWaits >= MAX_QUOTA_WAITS) {
              throw last.withUnremedied(`still over quota after ${MAX_QUOTA_WAITS} waits in this turn`);
            }
            if ((remainingCalls() ?? 1) < 1) throw last.withUnremedied("no provider calls left in the run's budget to retry");
            const waitBasis = failure.retryAt !== undefined ? ("provider" as const) : ("operator" as const);
            const waitMs =
              failure.retryAt !== undefined ? Math.max(0, Date.parse(failure.retryAt) - Date.now()) : quotaRetryMs!;
            if (waitMs > waitLeft) {
              throw last.withUnremedied(
                (waitBasis === "provider"
                  ? `the reset at ${failure.retryAt} is ${Math.ceil(waitMs / 1000)}s away`
                  : `the provider gave no reset time, and the operator's quotaRetryMs wait is ${Math.ceil(waitMs / 1000)}s`) +
                  `; ${Math.floor(waitLeft / 1000)}s of the run's wait budget remain`,
              );
            }
            const started = Date.now();
            await abortableSleep(waitMs, input.signal);
            const elapsed = Date.now() - started;
            const waited = Math.min(waitLeft, input.signal?.aborted === true ? elapsed : Math.max(waitMs, elapsed));
            waitLeft -= waited;
            quotaWaits += 1;
            remedy(failure, "wait_and_retry", waited, waitBasis);
            if (input.signal?.aborted) throw new Error("supervisor prompt aborted");
            continue;
          }
          case "overflow": {
            if (compacted) throw last.withUnremedied("already compacted and retried once in this turn");
            if (session.compact === undefined) throw last.withUnremedied("the session cannot compact");
            const left = remainingCalls();
            if (left !== undefined && left < COMPACT_AND_RETRY_CALLS) {
              throw last.withUnremedied(`compacting and retrying needs ${COMPACT_AND_RETRY_CALLS} provider calls; ${left} remain`);
            }
            compacted = true;
            try {
              await session.compact(input.signal !== undefined ? { signal: input.signal } : undefined);
            } catch (err) {
              throw last.withUnremedied(`compaction failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              if (session.drainTurnCount !== undefined) {
                settleTurns();
              } else {
                // A session that cannot count turns is charged compaction's upper bound.
                providerCalls += COMPACTION_PROVIDER_CALLS;
              }
            }
            remedy(failure, "compact_and_retry");
            continue;
          }
          default:
            throw last;
        }
      }
    };

    /** A reply with no admitted tool call: a JSON decision, or why it is not one (empty or malformed). */
    const readReply = (reply: string): { proposal: SupervisorProposal } | { failure: ProviderFailure } => {
      const classified = session.lastReplyFailure?.();
      if (classified?.failureClass === "empty" || classified?.failureClass === "interrupted") return { failure: classified };
      if (reply.trim() === "") return { failure: { failureClass: "empty", message: "the reply had no tool call or text" } };
      try {
        return { proposal: parseSupervisorDecision(reply) };
      } catch (err) {
        return {
          failure: {
            failureClass: "malformed",
            message: `${err instanceof Error ? err.message : String(err)}; reply began: ${JSON.stringify(reply.slice(0, 160))}`,
          },
        };
      }
    };

    let toolbox = toolsFor();
    opening = buildRecoveryPrompt(input, {
      current: { provider: binding.provider, modelId: binding.modelId },
      configured,
      offered: toolbox.offered,
    });
    if (input.rejection !== undefined) followUp = buildRejectionPrompt(input.rejection, toolbox.offered);
    let text = await ask(followUp ?? opening, toolbox);

    // Empty (e.g. thinking-only) and malformed replies are model slips, not
    // provider errors: each gets the next of three bounded remedies, then the
    // turn stops naming what was tried. Every attempt is charged to the
    // turn's allowance like any other call.
    const slipTried: string[] = [];
    const slipSkipped: string[] = [];
    let reasked = false;
    let slipFresh = false;
    let slipModel = false;
    /** Apply the next slip remedy and return its reply, or throw once none is left. */
    const remedySlip = async (failure: ProviderFailure): Promise<string> => {
      const stop = (why?: string) =>
        new SupervisorProviderError(
          failure,
          [...(slipTried.length > 0 ? [`already ${slipTried.join(", then ")} in this turn`] : []), ...slipSkipped, ...(why !== undefined ? [why] : [])].join("; "),
        );
      if (input.signal?.aborted === true) throw new SupervisorProviderError(failure, "the run stopped");
      if ((remainingCalls() ?? 1) < 1) throw stop("no provider calls left in the run's budget to retry");
      if (!reasked) {
        // 1. Ask again in the same session, saying what was wrong.
        reasked = true;
        slipTried.push("re-asked once");
        remedy(failure, "reask");
        toolbox = toolsFor();
        return ask(buildReaskPrompt(failure.message, toolbox.offered), toolbox);
      }
      const open = options.openSession;
      if (!slipFresh) {
        // 2. Retry the turn in a fresh episode session: none of the slipped
        // replies is context worth keeping.
        slipFresh = true;
        if (open === undefined) {
          slipSkipped.push("the host cannot open a fresh session");
        } else {
          let opened = false;
          try {
            await replaceSession(open);
            opened = true;
          } catch (err) {
            slipSkipped.push(`opening a fresh session failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (opened) {
            slipTried.push("retried in a fresh session");
            remedy(failure, "fresh_session_retry");
            toolbox = toolsFor();
            return ask(freshPrompt(), toolbox);
          }
        }
      }
      if (!slipModel && open !== undefined) {
        // 3. Retry on the next operator-configured model, for this turn only.
        slipModel = true;
        const current = { provider: session.provider, modelId: session.modelId };
        const next = nextConfiguredModel(configured, current);
        if (next === undefined) {
          slipSkipped.push("no other configured model to try");
        } else {
          const name = `${next.provider}/${next.modelId}`;
          let entered = false;
          try {
            await enterTransientModel(open, next);
            entered = true;
          } catch (err) {
            slipSkipped.push(`opening a session on ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (entered) {
            slipTried.push(`retried on ${name}`);
            remedy(failure, "model_retry", undefined, undefined, next);
            toolbox = toolsFor();
            opening = buildRecoveryPrompt(input, { current: next, configured, offered: toolbox.offered });
            return ask(freshPrompt(), toolbox);
          }
        }
      }
      throw stop();
    };
    for (;;) {
      const exhausted = toolbox.exhausted();
      if (exhausted !== undefined) {
        throw new Error(`inadmissible proposal limit reached this turn: ${exhausted.action}: ${exhausted.reason}`);
      }
      // Models without tool calling may still reply with the decision as
      // JSON, bypassing the admission tools' in-turn checks; that path gets
      // the same chances to self-correct within this decide().
      let proposal = toolbox.proposal();
      if (proposal === undefined) {
        const read = readReply(text);
        if ("failure" in read) {
          // An empty or unreadable reply gets the next slip remedy before it
          // counts as a failed turn. It is not an inadmissible proposal:
          // nothing was proposed.
          text = await remedySlip(read.failure);
          continue;
        }
        proposal = read.proposal;
      }
      if (!("action" in proposal)) return proposal;
      if (input.admission !== undefined) {
        // Admitted tool calls already passed these checks; a JSON reply has
        // not. The original proposal is judged, never a sanitized rewrite:
        // a local refusal is charged to the turn's allowance like the
        // controller's own, and the model is asked again in this decide().
        const local = localRefusal(proposal.action, input.view.agentSessions ?? [], input.view.generation);
        const rejection =
          local !== undefined
            ? await input.admission.refuse(proposal.action.type, local)
            : await input.admission.check(proposal);
        if (rejection === undefined) return proposal;
        if (rejection.remaining <= 0 || input.signal?.aborted === true || (remainingCalls() ?? 1) < 1) {
          throw new Error(`inadmissible proposal: ${rejection.action}: ${rejection.reason}`);
        }
        toolbox = toolsFor();
        followUp = buildRejectionPrompt(rejection, toolbox.offered);
        text = await ask(followUp, toolbox);
        continue;
      }
      // Without the controller's check (legacy path), repair what the tools
      // would have refused rather than let it reach admission.
      const sanitized = sanitizeProposal(proposal, input.view.agentSessions ?? [], input.view.generation);
      if (!("action" in sanitized)) return sanitized;
      // A JSON-only reply never went through the admission tools' own
      // repeated-proposal rejection: reject it here instead of letting a
      // repeated no-progress proposal through.
      const key = supervisorProposalKey(input.trigger.code, sanitized.action);
      const already = input.view.escalation?.repeatedProposals[key]?.count ?? 0;
      if (already + 1 >= 3) {
        throw new Error(
          `this exact ${sanitized.action.type} proposal would be the ${already + 1 === 3 ? "3rd" : `${already + 1}th`} time with no progress since the controller last checked; propose something that would change the outcome, or stop`,
        );
      }
      return sanitized;
    }
  }

  return {
    sessionId: logicalSessionId,
    requiresCitedEvidence: options.requireCitedEvidence !== false,
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

    drainRemedies() {
      const drained = remedies;
      remedies = [];
      return drained;
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
      await enterEpisode(input.episodeId);
      try {
        return await decideTurn(input);
      } finally {
        // A turn that ended on a transient model leaves the episode on its bound one.
        await leaveTransientModel();
      }
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
      const target = findConfigured(configured, to);
      if (!target) {
        record.status = "failed";
        record.error = `model not configured: ${to.provider}/${to.modelId}; refusing silent fallback`;
        throw new Error(record.error);
      }

      try {
        await session.setModel(target);
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
  return findConfigured(configured, ref) !== undefined;
}

/**
 * The configured model after `current` in the operator's order (wrapping), or
 * undefined when no other model is configured.
 */
export function nextConfiguredModel(
  configured: readonly SupervisorModelRef[],
  current: { provider: string; modelId: string },
): SupervisorModelRef | undefined {
  const at = configured.findIndex((m) => m.provider === current.provider && m.modelId === current.modelId);
  for (let i = 1; i <= configured.length; i += 1) {
    const m = configured[(at + i + configured.length) % configured.length]!;
    if (m.provider !== current.provider || m.modelId !== current.modelId) return m;
  }
  return undefined;
}

/** The operator's own configured entry for `ref` (carries its thinkingLevel), or undefined if not configured. */
export function findConfigured(
  configured: SupervisorModelRef[],
  ref: { provider: string; modelId: string },
): SupervisorModelRef | undefined {
  return configured.find((m) => m.provider === ref.provider && m.modelId === ref.modelId);
}

/** The admission tools' own pre-checks, applied to a JSON-only proposal. */
function localRefusal(
  action: GraphAction,
  agentSessions: readonly AgentSessionView[],
  generation: number,
): string | undefined {
  if (action.type === "dispatch") {
    return writeScopeRefusal(action.job) ?? continuationRefusal(action.job, agentSessions, generation);
  }
  if (action.type === "observe") {
    const escaping = escapingObservePath(action.observe.paths);
    return escaping === undefined ? undefined : `observe paths are relative to the run worktree; ${escaping} is not`;
  }
  return undefined;
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

/** Re-ask within the same turn after the controller refused a proposal; the run has not changed since. */
export function buildRejectionPrompt(
  rejection: NonNullable<SupervisorInput["rejection"]>,
  offered: readonly GraphLoomSupervisorAction[],
): string {
  return [
    `Rejected: ${rejectionText(rejection)}.`,
    "Nothing in the run changed. Propose one admissible action now, using the current values above.",
    `Call one GraphLoom tool: ${actionList(offered)}.`,
  ].join("\n");
}

/** Re-ask once after a reply that was neither a tool call nor a readable GraphDecision. */
export function buildReaskPrompt(err: unknown, offered: readonly GraphLoomSupervisorAction[]): string {
  return [
    `Your reply could not be read as a decision: ${err instanceof Error ? err.message : String(err)}.`,
    `Call one GraphLoom tool (${actionList(offered)}), or reply with one GraphDecision as JSON ({"reason", "action": {"type", ...}}).`,
  ].join("\n");
}

function actionList(offered: readonly string[]): string {
  if (offered.length <= 1) return offered.join("");
  return `${offered.slice(0, -1).join(", ")}, or ${offered[offered.length - 1]}`;
}

export function buildRecoveryPrompt(
  input: SupervisorInput,
  models?: {
    current: SupervisorModelRef;
    configured: readonly SupervisorModelRef[];
    /** The action tools offered this turn; defaults to those the input's admission facts allow. */
    offered?: readonly GraphLoomSupervisorAction[];
  },
): string {
  const offered = models?.offered ?? offeredActions(input.admission?.facts);
  const currentGeneration = currentGenerationEvidence(input.view.evidence, input.view.generation);
  // Every list below is capped so the prompt stays the same size however long
  // the run has been going: the case file carries what earlier episodes
  // established, and evidence is described for the current generation only.
  const receipts = input.view.receipts;
  const sessions = continuableSessions(input.view.agentSessions ?? []);
  const candidates = input.view.repairCandidates ?? [];
  const repeated = Object.entries(input.view.escalation?.repeatedProposals ?? {});
  const viewSummary = {
    runId: input.runId,
    episodeId: input.episodeId,
    trigger: {
      code: input.trigger.code,
      message: clipText(input.trigger.message, MAX_TRIGGER_MESSAGE_CHARS),
      ...(input.trigger.evidenceRefs !== undefined
        ? { evidenceRefs: input.trigger.evidenceRefs.slice(0, MAX_PROMPT_TRIGGER_REFS) }
        : {}),
    },
    current: input.view.current,
    recoveryEpisodeId: input.view.recoveryEpisodeId,
    budgets: input.view.budgets,
    outstanding: input.view.outstanding.slice(-MAX_PROMPT_LIST),
    receipts: receipts.slice(-MAX_PROMPT_RECEIPTS).map((r) => ({
      id: r.id,
      stageId: r.stageId,
      valid: r.valid,
      requirementId: r.requirementId,
    })),
    ...(receipts.length > MAX_PROMPT_RECEIPTS ? { olderReceipts: receipts.length - MAX_PROMPT_RECEIPTS } : {}),
    evidence: {
      total: input.view.evidence.length,
      currentGeneration: currentGeneration.length,
    },
    // The current generation's own evidence, described rather than just named;
    // older generations are counted only, and a fact an earlier episode
    // verified about them reaches this one through the case file.
    currentGenerationEvidence: currentGeneration.slice(-MAX_CURRENT_GENERATION_EVIDENCE).map((e) => describeRecoveryEvidence(e)),
    generation: input.view.generation,
    stateRevision: input.view.stateRevision,
    activeVersion: input.view.activeVersion,
    ...(input.view.candidateDigest !== undefined ? { candidateDigest: input.view.candidateDigest } : {}),
    repairCandidates: candidates.slice(-MAX_PROMPT_CANDIDATES).map((c) => ({
      ...c,
      ...(c.preflightSummary !== undefined ? { preflightSummary: clipText(c.preflightSummary, MAX_SUMMARY_CHARS) } : {}),
      ...(c.patchSummary !== undefined ? { patchSummary: clipText(c.patchSummary, MAX_SUMMARY_CHARS) } : {}),
      ...(c.rejectionReason !== undefined ? { rejectionReason: clipText(c.rejectionReason, MAX_SUMMARY_CHARS) } : {}),
      reason: clipText(c.reason, MAX_SUMMARY_CHARS),
    })),
    ...(candidates.length > MAX_PROMPT_CANDIDATES ? { olderRepairCandidates: candidates.length - MAX_PROMPT_CANDIDATES } : {}),
    // Only sessions a dispatch may still continue (none has continued them yet).
    agentSessions: sessions.slice(-MAX_PROMPT_LIST),
    ...(input.view.repairAuthority !== undefined ? { repairAuthority: input.view.repairAuthority } : {}),
    ...(input.view.escalation !== undefined
      ? {
          escalation: {
            correctionTrials: input.view.escalation.correctionTrials,
            handoff: input.view.escalation.handoff,
            repeatedProposals: Object.fromEntries(repeated.slice(-MAX_PROMPT_LIST)),
          },
        }
      : {}),
  };
  const workThisGeneration = currentGeneration.some((e) => producerOf(e)?.purpose === "work");
  const latestReviewVerdict = [...currentGeneration].reverse().map((e) => verdictOf(e)).find((v) => v !== undefined);
  const triggerGuidance = TRIGGER_GUIDANCE[input.trigger.code];

  const settlement = input.lastSettlement;
  return [
    "You are the GraphLoom run supervisor in recovery.",
    `Propose exactly one action by calling one GraphLoom tool: ${actionList(offered)}.`,
    "The controller admits and settles it and reports the outcome at the start of your next turn.",
    "If tools are unavailable, reply with one GraphDecision as JSON ({\"reason\", \"action\": {\"type\", ...}}), optionally in a ```json fence.",
    "Never propose Accept. Never add, remove, rename, or reorder graph steps.",
    "Prefer further authorized remedies over Stop while budgets and authority remain.",
    "This session holds this episode only. What earlier episodes verified is the case file below, kept by the controller: a fact or refutation is listed only while the workspace candidate and plugin version it was established against are current, and attempts are the controller's own settlements of earlier proposals.",
    ...(input.recordFinding !== undefined
      ? [
          "Before you propose, call record_finding for anything you verified that a later episode should know, citing the evidence refs that show it; it does not end your turn.",
        ]
      : []),
    ...(offered.includes("activate_repair")
      ? ["For activate_repair, use a qualifiedArtifactId from repairCandidates with status qualified."]
      : []),
    ...(input.inspect !== undefined
      ? [
          "Claims must be checkable. get_evidence, list_evidence, list_receipts, read_candidate and diff_candidate read the run without changing it, and check_validate, check_activation and check_checkout dry-run the controller's own checks on a copy of state (each returns a probeId; probes are limited). A stop, a reenter, or a qualify_repair that blames a validator or executor is refused unless its evidence lists an evidence ref or a probe id from this episode that supports it; check before you claim that validate cannot pass.",
        ]
      : []),
    "A proposal the controller would not admit is returned to you in this same turn with the failed precondition and the current value; correct it and propose again.",
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
    ...caseFileLines(input.caseFile),
    "Recovery context:",
    "```json",
    JSON.stringify(viewSummary, null, 2),
    "```",
  ].join("\n");
}

const MAX_CURRENT_GENERATION_EVIDENCE = 24;
const MAX_EVIDENCE_DETAIL_CHARS = 160;
const MAX_PROMPT_RECEIPTS = 20;
const MAX_PROMPT_CANDIDATES = 6;
const MAX_PROMPT_LIST = 10;
const MAX_PROMPT_TRIGGER_REFS = 10;
const MAX_TRIGGER_MESSAGE_CHARS = 1_000;
const MAX_SUMMARY_CHARS = 400;

function currentGenerationEvidence(evidence: EvidenceRecord[], generation: number): EvidenceRecord[] {
  return evidence.filter((e) => e.generation === generation);
}

/** Agent sessions no later dispatch has continued: the only ones `continueFrom` accepts. */
function continuableSessions(sessions: readonly AgentSessionView[]): AgentSessionView[] {
  const continued = new Set(sessions.map((s) => s.continuedFrom).filter((id): id is string => id !== undefined));
  return sessions.filter((s) => !continued.has(s.operationId));
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The live case file, compactly; nothing when it is empty. */
function caseFileLines(file: CaseFile | undefined): string[] {
  if (file === undefined) return [];
  const { facts, refuted, attempts, open } = file;
  if (facts.length + refuted.length + attempts.length + open.length === 0) return [];
  return [
    "Case file:",
    ...facts.map((f) => `- fact ${f.id} (generation ${f.since}; ${f.evidence.join(", ")}): ${f.text}`),
    ...refuted.map((r) => `- refuted ${r.id} (generation ${r.since}; ${r.by.join(", ")}): ${r.claim}`),
    ...attempts.map((a) => `- attempt in ${a.episodeId} (${a.trigger}, generation ${a.generation}): ${a.action} -> ${a.outcome}`),
    ...open.map((q) => `- open question: ${q.text}`),
  ];
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
 * Candidate patch instruction for the episode session that proposed the
 * QualifyRepair. That episode's recovery turns carry the failure evidence;
 * this prompt fixes the scope and the rules.
 */
export function buildRepairPrompt(args: CandidatePatchRequest): string {
  return [
    args.reviewFeedback !== undefined
      ? "You are the GraphLoom run supervisor, revising the qualified repair you are authoring after the independent reviewer sent it back."
      : "You are the GraphLoom run supervisor, now authoring the qualified repair you proposed.",
    `Target: ${args.target}`,
    `Reason: ${args.reason}`,
    `Candidate root: ${args.candidateRoot}`,
    "Your working directory is the candidate root. Use the shell and file tools to investigate, fix the defect, and build and run the candidate's tests.",
    "Change only files inside the candidate root; the live install and the run worktree are off limits, and the controller stops the run if the patch changes the live install, the run worktree, or the run state.",
    "Do not edit graphloom.stages.json. Do not add, remove, rename, or reorder graph steps, and do not change requirement statements or evidence schemas.",
    "Keep existing tests and negative cases; do not loosen expected outcomes. Add a focused regression case when the defect is testable.",
    ...(args.reviewFeedback !== undefined
      ? [
          "",
          "The independent reviewer rejected your last revision of this same candidate:",
          args.reviewFeedback,
          "Fix exactly what the reviewer raised; keep whatever it did not object to. Do not reintroduce the original defect while addressing this feedback.",
          "",
        ]
      : []),
    "After you finish, the controller builds and tests the candidate itself, then an independent reviewer decides.",
    ...(args.maxProviderCalls !== undefined
      ? [`You have at most ${args.maxProviderCalls} model turns, including tool turns; the patch is aborted beyond that.`]
      : []),
    "When done, reply with a short plain-text summary of what you changed and why (at most a few sentences). Do not include private reasoning.",
  ].join("\n");
}
