// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { LoopCandidate } from "@graphloom/sdk";
import type { LoopDefinition } from "./definition.js";

export type SubmissionState = "queued" | "running" | "waiting" | "blocked" | "failed" | "succeeded" | "canceled" | "archived";

export interface KnownKey { state: SubmissionState; generation: number }

export interface DecideInput {
  loop: LoopDefinition;
  /** One UTC instant; informational, the engine reads no clock. */
  now: string;
  candidates: readonly LoopCandidate[];
  /** Run key to the latest known submission of that key. */
  knownKeys: ReadonlyMap<string, KnownKey> | Readonly<Record<string, KnownKey>>;
  /** Current generation per subject (the store's); a subject absent here is at 0. */
  generations?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  liveRunCount: number;
  startsToday: number;
}

export type Decision =
  | { action: "start"; subject: string; key: string; generation: number; taskArgs: string[] }
  | { action: "skip"; subject: string; key: string; generation: number; reason: string };

export function runKey(loopName: string, subject: string, generation: number): string {
  return `loop:${loopName}:${subject}:${generation}`;
}

function lookup<V>(m: ReadonlyMap<string, V> | Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  if (m === undefined) return undefined;
  if (m instanceof Map) return m.get(key);
  const r = m as Readonly<Record<string, V>>;
  return Object.hasOwn(r, key) ? r[key] : undefined;
}

function existingReason(state: SubmissionState): string {
  switch (state) {
    case "queued":
    case "running":
    case "waiting":
      return `live: already ${state}`;
    case "blocked":
    case "failed":
      return `${state}: needs the operator (unpark)`;
    case "succeeded":
    case "canceled":
      return `already ${state}; not restarted`;
    case "archived":
      return "archived; not restarted";
  }
}

/** Pure: which candidates to start this tick, and why each other one is skipped. */
export function decide(input: DecideInput): Decision[] {
  const { loop, candidates, liveRunCount, startsToday } = input;
  const caps = [
    { name: "maxStartsPerTick", room: loop.limits.maxStartsPerTick },
    { name: "maxLiveRuns", room: loop.limits.maxLiveRuns - liveRunCount },
    { name: "maxStartsPerDay", room: loop.limits.maxStartsPerDay - startsToday },
  ];
  let started = 0;
  const seen = new Set<string>();
  return candidates.map((candidate): Decision => {
    const subject = candidate.key;
    const duplicate = seen.has(subject);
    seen.add(subject);
    const generation = lookup(input.generations, subject) ?? 0;
    const key = runKey(loop.name, subject, generation);
    if (duplicate) return { action: "skip", subject, key, generation, reason: "duplicate subject in this tick" };
    const known = lookup(input.knownKeys, key);
    if (known) return { action: "skip", subject, key, generation, reason: existingReason(known.state) };
    const blocking = caps.find((c) => c.room - started <= 0);
    if (blocking) return { action: "skip", subject, key, generation, reason: `${blocking.name} reached` };
    started += 1;
    return { action: "start", subject, key, generation, taskArgs: [...candidate.taskArgs] };
  });
}
