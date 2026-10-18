import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeScopeProblem, type CaseFinding, type CaseFindingOutcome, type GraphAction, type GraphDecision } from "@graphloom/sdk";
import { inspectionToolInput, toolInputKey, type EpisodeToolCall, type SupervisorEpisodeRecord } from "./episode.js";
import { continuationRefusal, escapingObservePath, offeredActions, writeScopeRefusal } from "./tools.js";
import { isModelSwitchRequest } from "./types.js";
import type {
  ProbeResult,
  Supervisor,
  SupervisorInput,
  SupervisorInspection,
  SupervisorProposal,
  SupervisorRejection,
} from "./types.js";

/** Inadmissible proposals one replayed turn may make, as the controller allows (MAX_INADMISSIBLE_PER_TURN). */
const REPLAY_REJECTION_LIMIT = 3;
const DEFAULT_EPISODE_TIMEOUT_MS = 60_000;
/** How long an aborted decide() may take to settle before its usage is read and the supervisor closed. */
const DEFAULT_CLEANUP_MS = 5_000;

/** One action a supervisor may take for a recorded decide() call and still count as right. */
export interface AcceptableAction {
  type: string;
  /** The stage the action must concern (dispatch, validate, reenter). */
  stageId?: string;
  /** For `dispatch`: the job's purpose, such as `work` (a review of the same candidate is not `work`). */
  purpose?: string;
}

/** What a supervisor may propose for one recorded decide() call and still count as right. */
export interface EpisodeLabel {
  episodeId: string;
  /** The decide() call within the episode the label is for; default 1. */
  turn?: number;
  acceptable: AcceptableAction[];
  /** Why these are the acceptable answers (the run's facts, for a reader). */
  note?: string;
}

export interface ReplayEpisodeResult {
  episodeId: string;
  turn: number;
  /** The proposed action type, `switch_model`, or undefined when decide() failed. */
  proposed?: string;
  correct: boolean;
  /** Proposals the recorded admission facts refuse, counted across the turn. */
  inadmissible: number;
  /** The turn ended on an inadmissible proposal or an exhausted rejection allowance: in a run, the controller's safe default applies. */
  inadmissibleStop: boolean;
  /** Dry-run probes (`check_*`) the supervisor requested. */
  probes: number;
  /** What `options.tokens` reported for the episode; 0 when no counter is given. */
  tokens: number;
  providerCalls: number;
  error?: string;
}

export interface ReplayScore {
  episodes: number;
  correct: number;
  accuracy: number;
  inadmissibleStops: number;
  inadmissiblePerEpisode: number;
  probesPerEpisode: number;
  tokensPerEpisode: number;
  results: ReplayEpisodeResult[];
}

export interface ReplayOptions {
  episodes: SupervisorEpisodeRecord[];
  labels: EpisodeLabel[];
  /** A supervisor configuration for one episode; closed after its decide(). */
  createSupervisor(episode: SupervisorEpisodeRecord): Supervisor | Promise<Supervisor>;
  /** Tokens the supervisor spent on the episode (read after decide() has settled); the Supervisor interface reports calls, not tokens. */
  tokens?(supervisor: Supervisor, episode: SupervisorEpisodeRecord): number;
  /** Per-episode limit; a decide() that has not settled by then is aborted and scored as failed. */
  timeoutMs?: number;
  /** After a timeout, how long the aborted decide() gets to settle before usage is read (default 5s). */
  cleanupMs?: number;
}

export function stageOfAction(action: GraphAction): string | undefined {
  switch (action.type) {
    case "dispatch":
      return action.job.stageId;
    case "validate":
      return action.validate.stageId;
    case "reenter":
      return action.reenter.stageId;
    default:
      return undefined;
  }
}

/** Whether `proposal` is among the label's acceptable actions. */
export function isAcceptable(label: EpisodeLabel, proposal: SupervisorProposal): boolean {
  if (isModelSwitchRequest(proposal)) return false;
  const { action } = proposal;
  const stage = stageOfAction(action);
  return label.acceptable.some(
    (a) =>
      a.type === action.type &&
      (a.stageId === undefined || a.stageId === stage) &&
      (a.purpose === undefined || (action.type === "dispatch" && action.job.purpose === a.purpose)),
  );
}

/**
 * Why the recorded state would refuse `decision`: its type is not offered, or a
 * parameter fails what the controller's admission or the supervisor's own tools
 * check from the recorded facts (an artifact that is not qualified, a work job
 * with no write scope, an escaping observe path, a continuation that is not
 * recorded). Checks that need state a record does not hold (declared stages,
 * candidate digests) are not made.
 */
export function replayRefusal(episode: SupervisorEpisodeRecord, decision: GraphDecision): string | undefined {
  const { action } = decision;
  const facts = episode.admission.facts;
  if (!new Set<string>(offeredActions(facts)).has(action.type)) return `${action.type} is not admissible in the recorded state`;
  switch (action.type) {
    case "activate_repair": {
      const id = action.activate.qualifiedArtifactId;
      return facts === undefined || facts.qualifiedArtifactIds.includes(id) ? undefined : `${id} is not a qualified candidate in the recorded state`;
    }
    case "dispatch": {
      const { job } = action;
      if (job.stageId !== episode.input.view.current.stageId) {
        return `recovery may only dispatch work for the current stage ${episode.input.view.current.stageId}, not ${job.stageId}`;
      }
      if (job.readOnly === true && job.writeScope !== undefined && job.writeScope.length > 0) return "readOnly jobs must not declare writeScope";
      const scope = job.writeScope !== undefined && job.writeScope.length > 0 ? writeScopeProblem(job.writeScope) : undefined;
      if (scope !== undefined) return scope;
      return writeScopeRefusal(job) ?? continuationRefusal(action.job, episode.input.view.agentSessions ?? [], episode.input.view.generation);
    }
    case "observe": {
      const escaping = escapingObservePath(action.observe.paths);
      return escaping === undefined ? undefined : `observe paths are relative to the run worktree; ${escaping} is not`;
    }
    default:
      return undefined;
  }
}

const NOT_RECORDED = "not recorded in this episode";

function recordedInspection(episode: SupervisorEpisodeRecord, onCall: (name: string) => void): SupervisorInspection {
  const unused = new Set(episode.toolCalls.map((_, i) => i));
  /** The next recorded call with exactly this tool and input, in the order the calls were made; never another call's result. */
  const lookup = (name: string, args: readonly unknown[]): unknown => {
    onCall(name);
    const key = toolInputKey(name, inspectionToolInput(name, args));
    const at = episode.toolCalls.findIndex((c, i) => unused.has(i) && toolInputKey(c.name, c.input) === key);
    if (at < 0) throw new Error(NOT_RECORDED);
    unused.delete(at);
    const call = episode.toolCalls[at]!;
    if (call.pending === true) throw new Error("the recorded call had not settled when the turn ended");
    if (call.threw === true) throw new Error(String((call.result as { error?: unknown } | null)?.error ?? "tool call failed"));
    return call.result;
  };
  const probe = (name: string, args: readonly unknown[]): ProbeResult => {
    try {
      return lookup(name, args) as ProbeResult;
    } catch (err) {
      // A probe that cannot run says why in `reason`, as a live one does; a recorded failure rejects.
      if (err instanceof Error && err.message === NOT_RECORDED) {
        return { probeId: "probe-not-recorded", accepted: false, reason: NOT_RECORDED, stateRevision: episode.input.view.stateRevision };
      }
      throw err;
    }
  };
  return {
    getEvidence: (ref) => (lookup("get_evidence", [ref]) ?? undefined) as ReturnType<SupervisorInspection["getEvidence"]>,
    listEvidence: (filter) => lookup("list_evidence", [filter]) as ReturnType<SupervisorInspection["listEvidence"]>,
    listReceipts: () => lookup("list_receipts", []) as ReturnType<SupervisorInspection["listReceipts"]>,
    readCandidate: async (path) => lookup("read_candidate", [path]) as { text: string } | { error: string },
    diffCandidate: async () => lookup("diff_candidate", []) as { diff: string } | { error: string },
    checkValidate: async (spec) => probe("check_validate", [spec]),
    checkActivation: async (id) => probe("check_activation", [id]),
    checkCheckout: async (spec) => probe("check_checkout", [spec]),
  };
}

/** `record_finding` answered from the recorded calls, in order; an unrecorded finding is not kept. */
function recordedFindings(episode: SupervisorEpisodeRecord): (finding: CaseFinding) => Promise<CaseFindingOutcome> {
  const unused = new Set(episode.toolCalls.map((_, i) => i));
  return async (finding) => {
    const key = toolInputKey("record_finding", finding);
    const at = episode.toolCalls.findIndex((c, i) => unused.has(i) && c.name === "record_finding" && toolInputKey(c.name, c.input) === key);
    if (at < 0) return { kept: false, reason: NOT_RECORDED };
    unused.delete(at);
    const call = episode.toolCalls[at]!;
    if (call.threw === true) throw new Error(String((call.result as { error?: unknown } | null)?.error ?? "record_finding failed"));
    return call.result as CaseFindingOutcome;
  };
}

/**
 * Feeds each recorded decide() call to a supervisor configuration and scores
 * the proposal against its label. Nothing here touches a run, a provider or the
 * network: tool results come from the record, and admission is judged against
 * the facts recorded for the call.
 */
export async function replayEpisodes(options: ReplayOptions): Promise<ReplayScore> {
  const labels = new Map<string, EpisodeLabel>();
  for (const l of options.labels) {
    const key = `${l.episodeId}#${l.turn ?? 1}`;
    if (labels.has(key)) throw new Error(`duplicate label for episode ${l.episodeId} turn ${l.turn ?? 1}`);
    labels.set(key, l);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EPISODE_TIMEOUT_MS;
  const results: ReplayEpisodeResult[] = [];
  for (const episode of options.episodes) {
    const label = labels.get(`${episode.episodeId}#${episode.turn}`);
    if (label === undefined) throw new Error(`no label for episode ${episode.episodeId} turn ${episode.turn}`);
    results.push(await replayOne(options, episode, label, timeoutMs));
  }
  const n = results.length;
  const mean = (pick: (r: ReplayEpisodeResult) => number) => (n === 0 ? 0 : results.reduce((sum, r) => sum + pick(r), 0) / n);
  const correct = results.filter((r) => r.correct).length;
  return {
    episodes: n,
    correct,
    accuracy: n === 0 ? 0 : correct / n,
    inadmissibleStops: results.filter((r) => r.inadmissibleStop).length,
    inadmissiblePerEpisode: mean((r) => r.inadmissible),
    probesPerEpisode: mean((r) => r.probes),
    tokensPerEpisode: mean((r) => r.tokens),
    results,
  };
}

async function replayOne(
  options: ReplayOptions,
  episode: SupervisorEpisodeRecord,
  label: EpisodeLabel,
  timeoutMs: number,
): Promise<ReplayEpisodeResult> {
  const supervisor = await options.createSupervisor(episode);
  const rejections: SupervisorRejection[] = [];
  // The allowance is the turn's, not the call's: a retried call starts with what its rejection left (`remaining`).
  const priorRejections = Math.min(REPLAY_REJECTION_LIMIT, Math.max(0, REPLAY_REJECTION_LIMIT - (episode.input.rejection?.remaining ?? REPLAY_REJECTION_LIMIT)));
  const reject = (action: string, reason: string): SupervisorRejection => {
    const rejection: SupervisorRejection = {
      action,
      reason,
      remaining: Math.max(0, REPLAY_REJECTION_LIMIT - priorRejections - rejections.length - 1),
    };
    rejections.push(rejection);
    return rejection;
  };
  const judge = (decision: GraphDecision): SupervisorRejection | undefined => {
    const refusal = replayRefusal(episode, decision);
    return refusal === undefined ? undefined : reject(decision.action.type, refusal);
  };
  let probes = 0;
  const abort = new AbortController();
  const recorded = episode.input;
  const input: SupervisorInput = {
    runId: episode.runId,
    episodeId: episode.episodeId,
    trigger: structuredClone(recorded.trigger),
    view: structuredClone(recorded.view),
    ...(recorded.caseFile !== undefined ? { caseFile: structuredClone(recorded.caseFile) } : {}),
    ...(recorded.lastSettlement !== undefined ? { lastSettlement: structuredClone(recorded.lastSettlement) } : {}),
    ...(recorded.rejection !== undefined ? { rejection: structuredClone(recorded.rejection) } : {}),
    ...(recorded.maxProviderCalls !== undefined ? { maxProviderCalls: recorded.maxProviderCalls } : {}),
    ...(recorded.maxWaitMs !== undefined ? { maxWaitMs: recorded.maxWaitMs } : {}),
    signal: abort.signal,
    recordFinding: recordedFindings(episode),
    inspect: recordedInspection(episode, (name) => {
      if (name.startsWith("check_")) probes += 1;
    }),
    admission: {
      facts: episode.admission.facts ?? { inRecovery: true, canQualify: true, qualifiedArtifactIds: [] },
      check: async (decision) => judge(decision),
      refuse: async (action, reason) => reject(action, reason),
    },
  };
  let proposal: SupervisorProposal | undefined;
  let error: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deciding = Promise.resolve().then(() => supervisor.decide(input));
  try {
    const timedOut = new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => {
        abort.abort();
        rejectTimeout(new Error(`decide did not settle within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    proposal = await Promise.race([deciding, timedOut]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (abort.signal.aborted) {
      // An aborted decide() settles its provider calls as it unwinds: give it a bounded moment first.
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        deciding.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, options.cleanupMs ?? DEFAULT_CLEANUP_MS);
        }),
      ]);
      if (grace !== undefined) clearTimeout(grace);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  let finalRefused = false;
  if (proposal !== undefined && !isModelSwitchRequest(proposal)) {
    finalRefused = judge(proposal) !== undefined;
  }
  // The controller ends the turn with its safe default once the allowance is spent, whatever came after.
  const exhausted = priorRejections + rejections.length >= REPLAY_REJECTION_LIMIT;
  const failedOnInadmissible = error !== undefined && /inadmissible/i.test(error);
  // Closing is bounded too: a supervisor whose abort never finishes must not hold the replay.
  if (supervisor.close !== undefined) {
    let closeGrace: NodeJS.Timeout | undefined;
    await Promise.race([
      supervisor.close().then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        closeGrace = setTimeout(resolve, options.cleanupMs ?? DEFAULT_CLEANUP_MS);
      }),
    ]);
    if (closeGrace !== undefined) clearTimeout(closeGrace);
  }
  // Usage is read last: an aborted decide() may charge its calls while it unwinds or while the supervisor closes.
  const tokens = options.tokens?.(supervisor, episode) ?? 0;
  const providerCalls = supervisor.drainProviderCalls?.() ?? 0;
  return {
    episodeId: episode.episodeId,
    turn: episode.turn,
    ...(proposal !== undefined ? { proposed: isModelSwitchRequest(proposal) ? "switch_model" : proposal.action.type } : {}),
    correct: proposal !== undefined && !finalRefused && !exhausted && isAcceptable(label, proposal),
    inadmissible: rejections.length,
    inadmissibleStop: finalRefused || exhausted || failedOnInadmissible,
    probes,
    tokens,
    providerCalls,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Where the committed fixtures of run 9bfa446d-4ea live, relative to this module (src/ or dist/). */
export const DEFAULT_FIXTURE_DIR = new URL("../fixtures/episodes/9bfa446d-4ea/", import.meta.url);

/** Reads `episodes.json` and `labels.json` from a fixture directory. */
export async function loadReplayFixtures(dir: string | URL = DEFAULT_FIXTURE_DIR): Promise<{ episodes: SupervisorEpisodeRecord[]; labels: EpisodeLabel[] }> {
  const base = typeof dir === "string" ? dir : dir.pathname;
  const read = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(base, name), "utf8"));
  return {
    episodes: (await read("episodes.json")) as SupervisorEpisodeRecord[],
    labels: (await read("labels.json")) as EpisodeLabel[],
  };
}
