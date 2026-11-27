// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Input of a bundle's `loopCandidates` hook (one round). */
export interface LoopCandidatesInput {
  protocol: 1;
  /** The parsed profile JSON, unread by the loop. */
  profile: unknown;
  /** One UTC instant per tick, the same in every round. */
  now: string;
  /** 0 for the first round. */
  round: number;
  /** The previous round's reads, same order; empty at round 0. */
  results: LoopReadResult[];
}

export interface LoopRead { id: string; executor: string; input: Record<string, unknown> }
export interface LoopReadResult { id: string; ok: boolean; output?: unknown; error?: string }
export interface LoopCandidate { key: string; taskArgs: string[]; observedState?: string }

export type LoopCandidatesReply =
  | { refused: string }
  | { reads: LoopRead[] }
  | { candidates: LoopCandidate[] };

export interface LoopReplyLimits { maxReadsPerRound: number; maxCandidates: number }

export class LoopReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopReplyError";
  }
}

const KEY = /^[A-Za-z0-9:._#/@-]{1,200}$/;
const MAX_TASK_ARGS = 16;
const MAX_TASK_ARG_LENGTH = 512;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extras(where: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) throw new LoopReplyError(`${where}: unknown property ${JSON.stringify(name)}`);
  }
}

function noNul(where: string, name: string, value: string): void {
  if (value.includes("\0")) throw new LoopReplyError(`${where}: ${name} must not contain a NUL character`);
}

/**
 * Read ids are checked unique within one reply only; the evaluator must also enforce
 * uniqueness per tick (across rounds), because results are matched back by id.
 */
function validateRead(read: unknown, index: number, ids: Set<string>): void {
  const where = `reads[${index}]`;
  if (!plain(read)) throw new LoopReplyError(`${where}: must be an object`);
  extras(where, read, ["id", "executor", "input"]);
  if (typeof read.id !== "string" || read.id === "" || read.id.length > 200) throw new LoopReplyError(`${where}: id must be a string of 1 to 200 characters`);
  if (ids.has(read.id)) throw new LoopReplyError(`${where}: duplicate read id ${JSON.stringify(read.id)}`);
  noNul(where, "id", read.id);
  ids.add(read.id);
  if (typeof read.executor !== "string" || read.executor === "") throw new LoopReplyError(`${where}: executor must be a non-empty string`);
  noNul(where, "executor", read.executor);
  if (!plain(read.input)) throw new LoopReplyError(`${where}: input must be an object`);
}

function validateCandidate(candidate: unknown, index: number, keys: Set<string>): void {
  const where = `candidates[${index}]`;
  if (!plain(candidate)) throw new LoopReplyError(`${where}: must be an object`);
  extras(where, candidate, ["key", "taskArgs", "observedState"]);
  if (typeof candidate.key !== "string" || !KEY.test(candidate.key)) throw new LoopReplyError(`${where}: key must be 1 to 200 characters from [A-Za-z0-9:._#/@-]`);
  if (keys.has(candidate.key)) throw new LoopReplyError(`${where}: duplicate candidate key ${JSON.stringify(candidate.key)}`);
  keys.add(candidate.key);
  const args = candidate.taskArgs;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new LoopReplyError(`${where}: taskArgs must be an array of strings`);
  if (args.length > MAX_TASK_ARGS) throw new LoopReplyError(`${where}: taskArgs has more than ${MAX_TASK_ARGS} strings`);
  if (args.some((a: string) => a.length > MAX_TASK_ARG_LENGTH)) throw new LoopReplyError(`${where}: a taskArgs string is longer than ${MAX_TASK_ARG_LENGTH} characters`);
  if (candidate.observedState !== undefined && typeof candidate.observedState !== "string") throw new LoopReplyError(`${where}: observedState must be a string`);
}

/** Check a hook reply; returns it typed, or throws a LoopReplyError naming the rule. */
export function validateLoopReply(reply: unknown, limits: LoopReplyLimits): LoopCandidatesReply {
  if (!plain(reply)) throw new LoopReplyError("reply must be an object");
  extras("reply", reply, ["refused", "reads", "candidates"]);
  const present = ["refused", "reads", "candidates"].filter((name) => reply[name] !== undefined);
  if (present.length > 1) throw new LoopReplyError(`reply must have exactly one of refused, reads, candidates; got ${present.join(", ")}`);
  if (present.length === 0) throw new LoopReplyError("reply must have one of refused, reads, candidates");
  if (reply.refused !== undefined) {
    if (typeof reply.refused !== "string" || reply.refused === "") throw new LoopReplyError("refused must be a non-empty string");
    if (reply.refused.includes("\0")) throw new LoopReplyError("refused must not contain a NUL character");
    if (/[\r\n]/.test(reply.refused)) throw new LoopReplyError("refused must be a single line");
  } else if (reply.reads !== undefined) {
    if (!Array.isArray(reply.reads)) throw new LoopReplyError("reads must be an array");
    if (reply.reads.length > limits.maxReadsPerRound) throw new LoopReplyError(`reads has more than ${limits.maxReadsPerRound} entries`);
    const ids = new Set<string>();
    reply.reads.forEach((read, i) => validateRead(read, i, ids));
  } else {
    if (!Array.isArray(reply.candidates)) throw new LoopReplyError("candidates must be an array");
    if (reply.candidates.length > limits.maxCandidates) throw new LoopReplyError(`candidates has more than ${limits.maxCandidates} entries`);
    const keys = new Set<string>();
    reply.candidates.forEach((c, i) => validateCandidate(c, i, keys));
  }
  return reply as LoopCandidatesReply;
}
