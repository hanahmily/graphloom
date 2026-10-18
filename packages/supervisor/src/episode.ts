import type { CaseFinding, CaseFile, RunView } from "@graphloom/sdk";
import type {
  AdmissionFacts,
  RecoveryTrigger,
  SupervisorInspection,
  SupervisorProposal,
  SupervisorRejection,
  SupervisorSettlement,
} from "./types.js";

/** Episode records the controller keeps in run state; older ones are dropped. */
export const MAX_EPISODE_RECORDS = 50;
/** Tool calls one record keeps; later calls are counted in `droppedToolCalls`. */
export const MAX_EPISODE_TOOL_CALLS = 50;
/** One tool result's size in a record (matches the inspection tools' own reply bound). */
export const MAX_EPISODE_TOOL_RESULT_CHARS = 8_000;
/** Upper bound of one record, as serialized JSON. */
export const MAX_EPISODE_RECORD_CHARS = 65_536;

/** A tool call the supervisor made during a decide() turn, with the controller's reply. */
export interface EpisodeToolCall {
  /** An inspection tool name (`check_validate`, `list_evidence`, ...) or `record_finding`. */
  name: string;
  input: unknown;
  /** The reply, shrunk to its bound with its shape kept (see `shrinkJson`); `{ error }` when the call threw. */
  result: unknown;
  /** The call rejected (or threw) rather than returned: `result` is `{ error }`, and replay rejects the same way. */
  threw?: true;
  /** The call had not settled when the turn ended; `result` is null. */
  pending?: true;
}

export type EpisodeOutcome =
  /** decide() returned; the controller has not settled it yet. */
  | "pending"
  | "admitted"
  /** Every proposal of the turn was inadmissible, or the turn ended on the rejection limit. */
  | "inadmissible"
  | "model_switch"
  | "error"
  | "aborted";

export interface EpisodeAdmission {
  /** What the controller told the supervisor it could offer this turn. */
  facts?: AdmissionFacts;
  /** Each rejection of this decide() call as `<action>: <reason>`, oldest first. */
  rejections: string[];
  outcome: EpisodeOutcome;
}

/** One decide() call: what the supervisor was given and asked, and what came of it. */
export interface SupervisorEpisodeRecord {
  episodeId: string;
  /** 1-based decide() call within the episode. */
  turn: number;
  runId: string;
  at: string;
  input: {
    trigger: RecoveryTrigger;
    /** The run view, shrunk only when the record would exceed its bound (see `shrinkJson`). */
    view: RunView;
    caseFile?: CaseFile;
    lastSettlement?: SupervisorSettlement;
    /** The controller's rejection of the previous proposal, passed to a retried decide() call. */
    rejection?: SupervisorRejection;
    /** The provider-call and wait allowances the call ran under. */
    maxProviderCalls?: number;
    maxWaitMs?: number;
  };
  toolCalls: EpisodeToolCall[];
  droppedToolCalls?: number;
  proposal?: SupervisorProposal;
  /** The decide() failure, bounded. */
  error?: string;
  admission: EpisodeAdmission;
  providerCalls: number;
  /** Set when any part of the record was cut to stay within its bounds. */
  truncated?: boolean;
}

export interface ShrinkLimits {
  /** Longest string kept; longer ones are cut with a marker. */
  maxString: number;
  /** Most array entries kept (the newest). */
  maxArray: number;
  /**
   * Most keys kept per object (the first ones), for objects at depth 3 and below.
   * The record's own structure (record, input, view, admission and the like, at
   * depth 0 to 2) always keeps every key, since a record without them is not one.
   */
  maxKeys: number;
  /** Deepest nesting kept; deeper values become `[]` or `{}`. */
  maxDepth: number;
}

/**
 * `value` with long strings cut and long arrays reduced to their newest
 * entries. The shape (object keys, array-ness, string-ness) is kept, so what a
 * replay hands back to the supervisor still has the type the live call had.
 */
export function shrinkJson<T>(value: T, limits: ShrinkLimits): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      return v.length <= limits.maxString ? v : `${v.slice(0, limits.maxString)}…[truncated ${v.length - limits.maxString} chars]`;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= limits.maxDepth) return Array.isArray(v) ? [] : {};
    if (Array.isArray(v)) return (limits.maxArray <= 0 ? [] : v.slice(-limits.maxArray)).map((e) => walk(e, depth + 1));
    const entries = Object.entries(v as Record<string, unknown>);
    return Object.fromEntries(
      (depth >= STRUCTURE_DEPTH ? entries.slice(0, limits.maxKeys) : entries).map(([k, e]) => [
        k.length > limits.maxString ? k.slice(0, limits.maxString) : k,
        walk(e, depth + 1),
      ]),
    );
  };
  return walk(value, 0) as T;
}

/** Objects shallower than this keep all their keys (see ShrinkLimits.maxKeys). */
const STRUCTURE_DEPTH = 3;

const SHRINK_LEVELS: ShrinkLimits[] = [
  { maxString: 2_000, maxArray: 50, maxKeys: 200, maxDepth: 24 },
  { maxString: 500, maxArray: 20, maxKeys: 100, maxDepth: 12 },
  { maxString: 200, maxArray: 8, maxKeys: 60, maxDepth: 8 },
  { maxString: 80, maxArray: 2, maxKeys: 40, maxDepth: 6 },
  { maxString: 24, maxArray: 0, maxKeys: 24, maxDepth: 6 },
];

function jsonLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "null").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** `value` unchanged when it fits `maxChars`, else the least-shrunk version (shape kept) that does. */
export function boundValue<T>(value: T, maxChars: number): { value: T; truncated: boolean } {
  if (value === undefined) return { value: null as T, truncated: false };
  if (jsonLength(value) <= maxChars) return { value, truncated: false };
  for (const level of SHRINK_LEVELS) {
    const shrunk = shrinkJson(value, level);
    if (jsonLength(shrunk) <= maxChars) return { value: shrunk, truncated: true };
  }
  return { value: shrinkJson(value, SHRINK_LEVELS[SHRINK_LEVELS.length - 1]!), truncated: true };
}

/** The tool input a recorded call is keyed by, for the inspection method `name` called with `args`. */
export function inspectionToolInput(name: string, args: readonly unknown[]): unknown {
  switch (name) {
    case "get_evidence":
      return { ref: args[0] };
    case "read_candidate":
      return { path: args[0] };
    case "check_activation":
      return { artifactId: args[0] };
    case "list_evidence":
    case "check_validate":
    case "check_checkout":
      return args[0] ?? {};
    default:
      return {};
  }
}

/** Stable text of a tool input, so a recorded call and a replayed one compare equal. */
export function toolInputKey(name: string, input: unknown): string {
  return `${name}:${stableText(input)}`;
}

function stableText(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableText(v)}`).join(",")}}`;
}

export interface EpisodeRecorder {
  /** The inspection surface, recording every call; the supervisor sees the same results. */
  inspect(inspection: SupervisorInspection): SupervisorInspection;
  recordFinding<T extends (finding: CaseFinding) => Promise<unknown>>(fn: T): T;
  toolCalls(): EpisodeToolCall[];
  dropped(): number;
  truncated(): boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Captures a turn's tool calls without changing them: results and thrown errors
 * pass through untouched, and the supervisor's own AbortSignal is forwarded.
 * A call takes its position when it starts, so concurrent calls replay in the
 * order they were made, whatever order they settle in. Recording never throws
 * into the caller.
 */
export function createEpisodeRecorder(): EpisodeRecorder {
  const calls: EpisodeToolCall[] = [];
  let dropped = 0;
  let cut = false;
  /** Reserve the call's position; the returned function fills in its outcome. */
  const begin = (name: string, input: unknown): ((outcome: { result: unknown; threw?: true }) => void) => {
    if (calls.length >= MAX_EPISODE_TOOL_CALLS) {
      dropped += 1;
      return () => undefined;
    }
    const boundedInput = boundValue(input, MAX_EPISODE_TOOL_RESULT_CHARS);
    const slot: EpisodeToolCall = { name, input: boundedInput.value, result: null, pending: true };
    if (boundedInput.truncated) cut = true;
    calls.push(slot);
    return ({ result, threw }) => {
      const bounded = boundValue(result, MAX_EPISODE_TOOL_RESULT_CHARS);
      if (bounded.truncated) cut = true;
      slot.result = bounded.value;
      delete slot.pending;
      if (threw) slot.threw = true;
    };
  };
  const wrap = <A extends unknown[], R>(name: string, fn: (...args: A) => R, inputOf: (args: A) => unknown): ((...args: A) => R) => {
    return (...args: A): R => {
      const settle = begin(name, inputOf(args));
      let result: R;
      try {
        result = fn(...args);
      } catch (err) {
        settle({ result: { error: errorText(err) }, threw: true });
        throw err;
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            settle({ result: value });
            return value;
          },
          (err: unknown) => {
            settle({ result: { error: errorText(err) }, threw: true });
            throw err;
          },
        ) as R;
      }
      settle({ result });
      return result;
    };
  };
  return {
    inspect(i) {
      return {
        getEvidence: wrap("get_evidence", (ref: string) => i.getEvidence(ref), (a) => inspectionToolInput("get_evidence", a)),
        listEvidence: wrap("list_evidence", (f: Parameters<SupervisorInspection["listEvidence"]>[0]) => i.listEvidence(f), (a) => inspectionToolInput("list_evidence", a)),
        listReceipts: wrap("list_receipts", () => i.listReceipts(), () => ({})),
        readCandidate: wrap("read_candidate", (p: string, s?: AbortSignal) => i.readCandidate(p, s), (a) => inspectionToolInput("read_candidate", a)),
        diffCandidate: wrap("diff_candidate", (s?: AbortSignal) => i.diffCandidate(s), () => ({})),
        checkValidate: wrap(
          "check_validate",
          (spec: Parameters<SupervisorInspection["checkValidate"]>[0], s?: AbortSignal) => i.checkValidate(spec, s),
          (a) => inspectionToolInput("check_validate", a),
        ),
        checkActivation: wrap("check_activation", (id: string, s?: AbortSignal) => i.checkActivation(id, s), (a) => inspectionToolInput("check_activation", a)),
        checkCheckout: wrap(
          "check_checkout",
          (spec: Parameters<SupervisorInspection["checkCheckout"]>[0], s?: AbortSignal) => i.checkCheckout(spec, s),
          (a) => inspectionToolInput("check_checkout", a),
        ),
      };
    },
    recordFinding(fn) {
      return wrap("record_finding", (finding: CaseFinding) => fn(finding), (a) => a[0]) as unknown as typeof fn;
    },
    toolCalls: () => calls.map((c) => ({ ...c })),
    dropped: () => dropped,
    truncated: () => cut,
  };
}

export interface EpisodeRecordArgs {
  episodeId: string;
  turn: number;
  runId: string;
  at?: string;
  trigger: RecoveryTrigger;
  view: RunView;
  caseFile?: CaseFile;
  lastSettlement?: SupervisorSettlement;
  rejection?: SupervisorRejection;
  maxProviderCalls?: number;
  maxWaitMs?: number;
  recorder: EpisodeRecorder;
  proposal?: SupervisorProposal;
  error?: unknown;
  admission: EpisodeAdmission;
  providerCalls: number;
}

/** Rejections one record keeps (the newest); each is cut at 1,000 chars. */
export const MAX_EPISODE_REJECTIONS = 20;

/** Bound a record's rejection list: newest entries, each cut. Idempotent. */
export function boundRejections(rejections: readonly string[]): string[] {
  return rejections.slice(-MAX_EPISODE_REJECTIONS).map((r) => (r.length > 1_000 ? `${r.slice(0, 1_000)}…[truncated ${r.length - 1_000} chars]` : r));
}

/**
 * `record` within MAX_EPISODE_RECORD_CHARS. A record that fits is returned as it
 * is. Otherwise the whole record (input, tool calls, proposal, facts and
 * rejections alike) is shrunk level by level, keeping each field's shape (see
 * `shrinkJson`); tool calls are dropped last-first, then the view's lists
 * emptied, only if the tightest level still does not fit. Used both when a
 * record is built and when the controller later rewrites one.
 */
export function fitEpisodeRecord(record: SupervisorEpisodeRecord): SupervisorEpisodeRecord {
  if (jsonLength(record) <= MAX_EPISODE_RECORD_CHARS) return record;
  let fitted = record;
  for (const level of SHRINK_LEVELS) {
    fitted = { ...shrinkJson(record, level), truncated: true };
    if (jsonLength(fitted) <= MAX_EPISODE_RECORD_CHARS) return fitted;
  }
  while (jsonLength(fitted) > MAX_EPISODE_RECORD_CHARS && fitted.toolCalls.length > 0) {
    fitted.toolCalls.pop();
    fitted.droppedToolCalls = (fitted.droppedToolCalls ?? 0) + 1;
  }
  if (jsonLength(fitted) > MAX_EPISODE_RECORD_CHARS) {
    const v = fitted.input.view;
    fitted.input.view = { ...v, evidence: [], receipts: [], outstanding: [], validatorBindings: [] };
  }
  return fitted;
}

/** Builds a record from a turn, within MAX_EPISODE_RECORD_CHARS (see `fitEpisodeRecord`). */
export function buildEpisodeRecord(args: EpisodeRecordArgs): SupervisorEpisodeRecord {
  const dropped = args.recorder.dropped();
  const message = args.error === undefined ? undefined : errorText(args.error).slice(0, 1_000);
  return fitEpisodeRecord({
    episodeId: args.episodeId,
    turn: args.turn,
    runId: args.runId,
    at: args.at ?? new Date().toISOString(),
    input: {
      trigger: args.trigger,
      view: args.view,
      ...(args.caseFile !== undefined ? { caseFile: args.caseFile } : {}),
      ...(args.lastSettlement !== undefined ? { lastSettlement: args.lastSettlement } : {}),
      ...(args.rejection !== undefined ? { rejection: args.rejection } : {}),
      ...(args.maxProviderCalls !== undefined ? { maxProviderCalls: args.maxProviderCalls } : {}),
      ...(args.maxWaitMs !== undefined ? { maxWaitMs: args.maxWaitMs } : {}),
    },
    toolCalls: args.recorder.toolCalls(),
    ...(dropped > 0 ? { droppedToolCalls: dropped } : {}),
    ...(args.proposal !== undefined ? { proposal: args.proposal } : {}),
    ...(message !== undefined ? { error: message } : {}),
    admission: {
      ...(args.admission.facts !== undefined ? { facts: args.admission.facts } : {}),
      rejections: boundRejections(args.admission.rejections),
      outcome: args.admission.outcome,
    },
    providerCalls: args.providerCalls,
    ...(args.recorder.truncated() || dropped > 0 ? { truncated: true } : {}),
  });
}
