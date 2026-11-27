// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { validateLoopReply } from "@graphloom/sdk";
import { validInstant } from "./instant.js";
import type { LoopCandidate, LoopCandidatesInput, LoopRead, LoopReadResult } from "@graphloom/sdk";

export interface ReadOutcome {
  status: "ok" | "failed" | "conflict";
  summary: string;
  evidence?: Array<{ payload: unknown }>;
  retryAfterMs?: number;
}

export interface EvaluateDeps {
  /** Calls the bundle's hook once. Pure in its input. May throw or reject. */
  hook(input: LoopCandidatesInput, signal: AbortSignal): Promise<unknown>;
  /** Performs one allowed read. Never receives credentials from the hook. */
  read(read: LoopRead, signal: AbortSignal): Promise<ReadOutcome>;
}

export interface EvaluateLimits {
  maxRounds: number;
  maxReadsPerRound: number;
  maxReadsPerTick: number;
  maxCandidates: number;
  maxResultBytes: number;
  maxTotalResultBytes: number;
  hookTimeoutMs: number;
  readTimeoutMs: number;
  totalTimeoutMs: number;
}

export const DEFAULT_EVALUATE_LIMITS: EvaluateLimits = {
  maxRounds: 5,
  maxReadsPerRound: 8,
  maxReadsPerTick: 20,
  maxCandidates: 500,
  maxResultBytes: 256 * 1024,
  maxTotalResultBytes: 1024 * 1024,
  hookTimeoutMs: 10_000,
  readTimeoutMs: 30_000,
  totalTimeoutMs: 5 * 60_000,
};

export interface EvaluateOptions {
  protocol: 1;
  profile: unknown;
  now: string;
  /** The manifest's `loop.reads`. */
  allowedReads: readonly string[];
  limits?: Partial<EvaluateLimits>;
  /** Milliseconds, injectable; measures the whole-evaluation timeout. */
  clock?: () => number;
}

export interface TranscriptRound {
  round: number;
  reads: LoopRead[];
  results: LoopReadResult[];
  reply: unknown;
}

export interface Transcript {
  protocol: 1;
  now: string;
  rounds: TranscriptRound[];
}

export type EvaluateOutcome =
  | { kind: "candidates"; candidates: LoopCandidate[]; transcript: Transcript }
  | { kind: "refused"; reason: string; transcript: Transcript }
  | { kind: "blocked"; reason: string; transcript: Transcript }
  | { kind: "deferred"; until: string; reason: string; transcript: Transcript };

type Called<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" } | { kind: "aborted" };

/** Run `fn` under its own timeout and the shared signal; never waits past either. */
async function call<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, shared: AbortSignal): Promise<Called<T>> {
  if (shared.aborted) return { kind: "aborted" };
  const own = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<Called<T>>((resolve) => {
    timer = setTimeout(() => { own.abort(); resolve({ kind: "timeout" }); }, timeoutMs);
    onAbort = () => { own.abort(); resolve({ kind: "aborted" }); };
    shared.addEventListener("abort", onAbort, { once: true });
  });
  const run = (async (): Promise<Called<T>> => {
    try { return { kind: "ok", value: await fn(own.signal) }; } catch (error) { return { kind: "error", error }; }
  })();
  try {
    return await Promise.race([run, stop]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) shared.removeEventListener("abort", onAbort);
    run.catch(() => undefined);
  }
}

/** Longest error text that reaches the hook, the transcript or a deferral reason. */
const MAX_MESSAGE_CHARS = 4096;
/**
 * Longest wait a read may ask for. `retryAfterMs` comes from a network header with no
 * upper bound, so a deferral is capped at one day: the next tick after that re-reads.
 */
const MAX_DEFER_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8.64e15;

/** Cut to at most MAX_MESSAGE_CHARS UTF-16 units without splitting a surrogate pair. */
function cap(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const mark = "... [truncated]";
  let end = MAX_MESSAGE_CHARS - mark.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate would lose its pair
  return text.slice(0, end) + mark;
}

const message = (error: unknown): string => {
  try {
    return cap(error instanceof Error ? error.message : String(error));
  } catch {
    return "error message not readable";
  }
};

/** A copy of a value already in JSON form. Throws (RangeError) when nested too deeply. */
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Thrown when the caller's clock throws; becomes a `blocked` outcome. */
class ClockFailure extends Error {}

const MALFORMED = "read returned a malformed result";
const NOT_PLAIN = { $unserialisable: true };

/** The JSON form of a value: exactly what is measured, handed to the hook and stored. */
function jsonForm(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/** The JSON form of a value together with its size in bytes; one serialisation. */
function jsonFormSized(value: unknown): [unknown, number] {
  const text = JSON.stringify(value);
  return text === undefined ? [undefined, 0] : [JSON.parse(text), Buffer.byteLength(text)];
}

/** A read outcome whose shape was checked, read once. */
interface CheckedOutcome { status: "ok" | "failed" | "conflict"; summary: string; payload: unknown; hasPayload: boolean; retryAfterMs: number | undefined }

/** Read an untrusted outcome once; undefined for any malformed shape or any throwing access. */
function checkOutcome(outcome: unknown): CheckedOutcome | undefined {
  try {
    if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) return undefined;
    const o = outcome as Record<string, unknown>;
    const status = o.status;
    if (status !== "ok" && status !== "failed" && status !== "conflict") return undefined;
    const summary = o.summary;
    if (summary !== undefined && typeof summary !== "string") return undefined;
    const retry = o.retryAfterMs;
    if (retry !== undefined && typeof retry !== "number") return undefined;
    const evidence = o.evidence;
    let payload: unknown;
    let hasPayload = false;
    if (evidence !== undefined) {
      if (!Array.isArray(evidence)) return undefined;
      for (let i = 0; i < evidence.length; i++) {
        const item: unknown = evidence[i];
        if (typeof item !== "object" || item === null) return undefined;
      }
      if (evidence.length > 0) {
        payload = (evidence[0] as { payload?: unknown }).payload;
        hasPayload = payload !== undefined;
      }
    }
    return { status, summary: summary ?? "", payload, hasPayload, retryAfterMs: retry };
  } catch {
    return undefined;
  }
}

/** Map a checked outcome to the hook's result; the second value is its kept size in bytes. */
function toResult(id: string, outcome: CheckedOutcome | undefined, maxBytes: number): [LoopReadResult, number] {
  const fail = (error: string): [LoopReadResult, number] => {
    const failed: LoopReadResult = { id, ok: false, error };
    return [failed, Buffer.byteLength(JSON.stringify(failed))];
  };
  if (outcome === undefined) return fail(MALFORMED);
  const result: LoopReadResult = outcome.status === "ok"
    ? { id, ok: true, ...(outcome.hasPayload ? { output: outcome.payload } : {}) }
    : { id, ok: false, error: cap(outcome.summary) };
  let text: string | undefined;
  try { text = JSON.stringify(result); } catch (error) { return fail(error instanceof RangeError ? "result too deeply nested" : "result not serializable"); }
  if (text === undefined) return fail("result not serializable");
  const size = Buffer.byteLength(text);
  if (size > maxBytes) return fail("result too large");
  // Keep the measured form itself, so no non-JSON data survives a clone.
  try { return [JSON.parse(text) as LoopReadResult, size]; } catch { return fail("result too deeply nested"); }
}

const LIMIT_KEYS = ["maxRounds", "maxReadsPerRound", "maxReadsPerTick", "maxCandidates", "maxResultBytes", "maxTotalResultBytes", "hookTimeoutMs", "readTimeoutMs", "totalTimeoutMs"] as const;
const TIMEOUT_KEYS = new Set<string>(["hookTimeoutMs", "readTimeoutMs", "totalTimeoutMs"]);
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Programming errors in the options: thrown as a TypeError before any work. */
function resolveLimits(options: EvaluateOptions): EvaluateLimits {
  if (typeof options !== "object" || options === null) throw new TypeError("evaluate options must be an object");
  if (!Array.isArray(options.allowedReads) || !options.allowedReads.every((e) => typeof e === "string")) throw new TypeError("allowedReads must be an array of executor names");
  if (options.clock !== undefined && typeof options.clock !== "function") throw new TypeError("clock must be a function");
  const limits: EvaluateLimits = { ...DEFAULT_EVALUATE_LIMITS };
  const given = (options.limits ?? {}) as Record<string, unknown>;
  for (const key of LIMIT_KEYS) {
    const value = given[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new TypeError(`limit ${key} must be a positive integer, got ${String(value)}`);
    if (TIMEOUT_KEYS.has(key) && value > MAX_TIMER_MS) throw new TypeError(`limit ${key} must not exceed ${MAX_TIMER_MS} ms, got ${value}`);
    limits[key] = value;
  }
  return limits;
}

/**
 * Run the multi-round `loopCandidates` protocol (design 14.2 to 14.6).
 *
 * Invalid LIMIT or OPTION values (a limit that is not a positive integer, a timeout
 * above 2^31-1 ms, `allowedReads` not an array of strings, a non-function `clock`) are
 * programming errors: this throws a TypeError synchronously, before any work. Everything
 * else resolves to an outcome and the returned promise never rejects: whatever a hook,
 * a read, the clock or `now` produces (deeply nested, oversized, throwing, hostile)
 * becomes `blocked`, or an `ok: false` read result.
 */
export function evaluate(deps: EvaluateDeps, options: EvaluateOptions): Promise<EvaluateOutcome> {
  const limits = resolveLimits(options);
  return evaluateChecked(deps, options, limits);
}

async function evaluateChecked(deps: EvaluateDeps, options: EvaluateOptions, limits: EvaluateLimits): Promise<EvaluateOutcome> {
  const rawClock = options.clock ?? Date.now;
  const clock = (): number => {
    try { return rawClock(); } catch { throw new ClockFailure("clock failed"); }
  };
  let now: unknown;
  try { now = options.now; } catch { now = undefined; }
  const transcript: Transcript = { protocol: 1, now: typeof now === "string" ? now : "", rounds: [] };
  const blocked = (reason: string): EvaluateOutcome => ({ kind: "blocked", reason: cap(reason), transcript });
  if (typeof now !== "string" || !validInstant(now)) {
    let shown: string;
    try { shown = cap(JSON.stringify(now) ?? String(now)); } catch { shown = "an unreadable value"; }
    return blocked(`now must be a UTC instant, got ${shown}`);
  }
  try {
    return await evaluateRounds(deps, options, limits, now, transcript, blocked, clock);
  } catch (error) {
    if (error instanceof ClockFailure) return blocked("clock failed");
    return blocked(`evaluation failed: ${message(error)}`);
  }
}

async function evaluateRounds(
  deps: EvaluateDeps,
  options: EvaluateOptions,
  limits: EvaluateLimits,
  nowText: string,
  transcript: Transcript,
  blocked: (reason: string) => EvaluateOutcome,
  clock: () => number,
): Promise<EvaluateOutcome> {
  const started = clock();

  const whole = new AbortController();
  const wholeTimer = setTimeout(() => whole.abort(), limits.totalTimeoutMs);
  const overBudget = (): boolean => whole.signal.aborted || clock() - started >= limits.totalTimeoutMs;
  const wholeReason = `evaluation exceeded ${limits.totalTimeoutMs} ms`;
  try {
    const seenIds = new Set<string>();
    let readCount = 0;
    let totalBytes = 0;
    let results: LoopReadResult[] = [];

    for (let round = 0; round < limits.maxRounds; round++) {
      if (overBudget()) return blocked(wholeReason);
      // The hook gets its own copy; the transcript keeps the evaluator's.
      const input: LoopCandidatesInput = { protocol: options.protocol, profile: options.profile, now: nowText, round, results: snapshot(results) };
      const called = await call((signal) => deps.hook(input, signal), limits.hookTimeoutMs, whole.signal);
      if (called.kind === "aborted") return blocked(wholeReason);
      if (called.kind === "timeout") return blocked(`hook timed out after ${limits.hookTimeoutMs} ms at round ${round}`);
      if (called.kind === "error") return blocked(`hook failed at round ${round}: ${message(called.error)}`);
      // Validate and use one snapshot: never re-read the hook's object after the check.
      let raw: unknown;
      let replyBytes: number;
      try {
        [raw, replyBytes] = jsonFormSized(called.value);
      } catch {
        transcript.rounds.push({ round, reads: [], results: [], reply: NOT_PLAIN });
        return blocked(`invalid hook reply at round ${round}: hook reply is not plain data`);
      }

      if (replyBytes > limits.maxResultBytes) {
        transcript.rounds.push({ round, reads: [], results: [], reply: NOT_PLAIN });
        return blocked(`hook reply too large at round ${round}: ${replyBytes} bytes, over ${limits.maxResultBytes}`);
      }
      totalBytes += replyBytes;
      if (totalBytes > limits.maxTotalResultBytes) {
        transcript.rounds.push({ round, reads: [], results: [], reply: NOT_PLAIN });
        return blocked(`hook replies and read results exceed ${limits.maxTotalResultBytes} bytes in one tick`);
      }

      let reply;
      try {
        reply = validateLoopReply(raw, { maxReadsPerRound: limits.maxReadsPerRound, maxCandidates: limits.maxCandidates });
      } catch (error) {
        transcript.rounds.push({ round, reads: [], results: [], reply: raw });
        return blocked(`invalid hook reply at round ${round}: ${message(error)}`);
      }

      if ("refused" in reply && reply.refused !== undefined) {
        transcript.rounds.push({ round, reads: [], results: [], reply: raw });
        return { kind: "refused", reason: cap(reply.refused), transcript };
      }
      if ("candidates" in reply && reply.candidates !== undefined) {
        transcript.rounds.push({ round, reads: [], results: [], reply: raw });
        return { kind: "candidates", candidates: reply.candidates, transcript };
      }
      if (!("reads" in reply) || reply.reads === undefined) return blocked(`invalid hook reply at round ${round}: no usable kind`);

      const entry: TranscriptRound = { round, reads: snapshot(reply.reads), results: [], reply: raw };
      transcript.rounds.push(entry);
      if (round === limits.maxRounds - 1) return blocked(`no candidates after ${limits.maxRounds} rounds`);
      for (const read of reply.reads) {
        if (!options.allowedReads.includes(read.executor)) return blocked(`read ${JSON.stringify(read.id)} names executor ${JSON.stringify(read.executor)}, which the bundle does not declare in loop.reads`);
        if (seenIds.has(read.id)) return blocked(`duplicate read id ${JSON.stringify(read.id)} in this tick`);
        seenIds.add(read.id);
      }
      if (readCount + reply.reads.length > limits.maxReadsPerTick) return blocked(`more than ${limits.maxReadsPerTick} reads in one tick`);
      readCount += reply.reads.length;

      for (const read of reply.reads) {
        if (overBudget()) return blocked(wholeReason);
        const done = await call((signal) => deps.read(snapshot(read), signal), limits.readTimeoutMs, whole.signal);
        if (done.kind === "aborted") return blocked(wholeReason);
        let result: LoopReadResult;
        if (done.kind === "timeout") result = { id: read.id, ok: false, error: "read timed out" };
        else if (done.kind === "error") result = { id: read.id, ok: false, error: message(done.error) };
        else {
          const outcome = checkOutcome(done.value);
          const [mapped, size] = toResult(read.id, outcome, limits.maxResultBytes);
          // A non-finite or negative retryAfterMs is no deferral signal: the read is an
          // ordinary ok:false result and the hook decides.
          const wait = outcome?.retryAfterMs;
          if (outcome !== undefined && outcome.status !== "ok" && typeof wait === "number" && Number.isFinite(wait) && wait >= 0) {
            entry.results.push(mapped);
            const capped = Math.min(wait, MAX_DEFER_MS);
            const untilMs = Date.parse(nowText) + capped;
            if (untilMs > MAX_DATE_MS) return blocked(`cannot defer from ${nowText}: the instant is out of range`);
            return { kind: "deferred", until: new Date(untilMs).toISOString(), reason: cap(`read ${JSON.stringify(read.id)} asked to wait ${wait} ms${wait > capped ? ` (capped at ${capped} ms)` : ""}: ${outcome.summary}`), transcript };
          }
          totalBytes += size;
          if (totalBytes > limits.maxTotalResultBytes) return blocked(`hook replies and read results exceed ${limits.maxTotalResultBytes} bytes in one tick`);
          result = mapped;
        }
        entry.results.push(result);
      }
      results = entry.results;
    }
    return blocked(`no candidates after ${limits.maxRounds} rounds`);
  } finally {
    clearTimeout(wholeTimer);
  }
}

/**
 * Structural equality of JSON-like values, insensitive to object key order and
 * comparing as JSON would: 0 equals -0, an undefined-valued key equals a missing one,
 * and an undefined array element equals null. Throws RangeError on a cyclic value.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v ?? null, b[i] ?? null));
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && deepEqual(ra[k], rb[k]));
}

const deepEqualSafe = (a: unknown, b: unknown): boolean => { try { return deepEqual(a, b); } catch { return false; } };

export type ReplayOutcome = { ok: true } | { ok: false; round: number; reason: string };

/**
 * Re-run the hook on a transcript's recorded results, with no read host, and report
 * the first round whose reply differs from the recorded one. A transcript does not
 * hold the profile; pass it when the hook reads it.
 */
export async function replay(
  transcript: Transcript,
  hook: EvaluateDeps["hook"],
  options: { profile?: unknown; timeoutMs?: number } = {},
): Promise<ReplayOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATE_LIMITS.hookTimeoutMs;
  const never = new AbortController().signal;
  for (const [index, recorded] of transcript.rounds.entries()) {
    let results: LoopReadResult[];
    try {
      results = index === 0 ? [] : structuredClone(transcript.rounds[index - 1]!.results);
    } catch {
      return { ok: false, round: recorded.round, reason: "recorded results not cloneable" };
    }
    const input: LoopCandidatesInput = { protocol: transcript.protocol, profile: options.profile, now: transcript.now, round: recorded.round, results };
    if (deepEqualSafe(recorded.reply, NOT_PLAIN)) return { ok: false, round: recorded.round, reason: "reply was not plain data" };
    const called = await call((signal) => hook(input, signal), timeoutMs, never);
    if (called.kind === "timeout") return { ok: false, round: recorded.round, reason: `hook timed out after ${timeoutMs} ms` };
    if (called.kind === "error") return { ok: false, round: recorded.round, reason: `hook failed: ${message(called.error)}` };
    if (called.kind === "ok") {
      let form: unknown;
      try {
        form = jsonForm(called.value);
      } catch {
        return { ok: false, round: recorded.round, reason: "reply was not plain data" };
      }
      let same: boolean;
      try {
        same = deepEqual(form, recorded.reply);
      } catch {
        return { ok: false, round: recorded.round, reason: "reply not comparable" };
      }
      if (!same) return { ok: false, round: recorded.round, reason: "reply differs from the recorded reply" };
    }
  }
  return { ok: true };
}
