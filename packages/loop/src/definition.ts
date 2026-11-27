// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export interface LoopLimits { maxStartsPerTick: number; maxLiveRuns: number; maxStartsPerDay: number }

export interface LoopDefinition {
  name: string;
  /** The interval as written ("15m") and in milliseconds. */
  every: string;
  everyMs: number;
  graph: string;
  profile: string;
  sink: "hub";
  limits: LoopLimits;
  version?: string;
  repo?: string;
}

export class LoopDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopDefinitionError";
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVERY = /^([1-9][0-9]{0,6})([smhd])$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** setTimeout's largest delay is 2^31-1 ms (about 24.8 days); an interval must stay below it. */
const MIN_EVERY_MS = 60_000;
const MAX_EVERY_MS = 2_147_483_647;
const TOP = ["name", "every", "graph", "profile", "sink", "limits", "version", "repo"];
const LIMITS = ["maxStartsPerTick", "maxLiveRuns", "maxStartsPerDay"];

function fail(rule: string): never {
  throw new LoopDefinitionError(`loop definition: ${rule}`);
}

function text(value: Record<string, unknown>, field: string): string {
  const v = value[field];
  if (typeof v !== "string" || v.trim() === "") fail(`${field} must be a non-empty string`);
  return v;
}

function count(value: Record<string, unknown>, field: string, fallback?: number): number {
  const v = value[field];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail(`limits.${field} must be a positive integer`);
  return v;
}

/** Validate a parsed loop definition (from YAML or JSON); pure. */
export function parseLoopDefinition(value: unknown): LoopDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!TOP.includes(key)) fail(`unknown property ${JSON.stringify(key)}`);
  const name = text(o, "name");
  if (!NAME.test(name)) fail("name must be 1 to 64 characters from [A-Za-z0-9._-], starting alphanumeric");
  const every = text(o, "every");
  const match = EVERY.exec(every);
  if (!match) fail('every must be a positive count and a unit s, m, h or d, such as "15m"');
  const everyMs = Number(match![1]) * UNIT_MS[match![2] as keyof typeof UNIT_MS];
  if (everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) fail("every must be between 1m and 24d (the timer limit of 2^31-1 ms)");
  const graph = text(o, "graph");
  if (!NAME.test(graph)) fail("graph must be a graph id");
  const profile = text(o, "profile");
  if (!NAME.test(profile)) fail("profile must be a profile name");
  if (o.sink !== "hub") fail('sink must be "hub"');
  const rawLimits = o.limits;
  if (rawLimits === null || typeof rawLimits !== "object" || Array.isArray(rawLimits)) fail("limits must be an object");
  const l = rawLimits as Record<string, unknown>;
  for (const key of Object.keys(l)) if (!LIMITS.includes(key)) fail(`unknown limits property ${JSON.stringify(key)}`);
  const definition: LoopDefinition = {
    name,
    every,
    everyMs,
    graph,
    profile,
    sink: "hub",
    limits: {
      maxStartsPerTick: count(l, "maxStartsPerTick", 1),
      maxLiveRuns: count(l, "maxLiveRuns"),
      maxStartsPerDay: count(l, "maxStartsPerDay"),
    },
  };
  if (o.version !== undefined) definition.version = text(o, "version");
  if (o.repo !== undefined) definition.repo = text(o, "repo");
  return definition;
}
