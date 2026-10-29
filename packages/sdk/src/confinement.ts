// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { BwrapConfinement, ConfinementSpec, DockerConfinement } from "./types.js";

const MAX_PATHS = 64;
const MAX_PATH_CHARS = 4_096;
const MAX_ENV = 64;
const MAX_ENV_VALUE_CHARS = 4_096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `name@sha256:<64 hex>`: a name that cannot be read as a flag, pinned by digest. */
const IMAGE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;
/** Docker's size syntax: a whole number with an optional `b`, `k`, `m` or `g`. */
const SIZE = /^[1-9][0-9]{0,14}[bkmg]?$/i;
const MAX_WALL_CLOCK_MS = 24 * 60 * 60_000;

/** The scratch prefix a docker mount may use for a run-scoped directory. */
export const SCRATCH_MOUNT_PREFIX = "@scratch/";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pathProblem(at: string, value: unknown, allow: (p: string) => string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS) {
    return `${at}: must be a non-empty string of at most ${MAX_PATH_CHARS} characters`;
  }
  if (value.includes("\0") || value.includes("\n")) return `${at}: must not contain a NUL or newline`;
  const detail = allow(value);
  return detail === undefined ? undefined : `${at}: ${detail}`;
}

function noParent(p: string): boolean {
  return !p.split("/").includes("..");
}

/** A bwrap path: absolute, or `~` / `~/…` for the operator's home; never the whole filesystem. */
function bwrapPath(p: string): string | undefined {
  if (p !== "~" && !p.startsWith("~/") && !p.startsWith("/")) return "must be absolute or start with ~/";
  if (!noParent(p)) return "must not contain ..";
  if (p === "/" || p === "~" || p === "~/") return "must not be the whole filesystem or home";
  return undefined;
}

/** A docker mount: absolute, `.`, relative to the workspace, or under the run's scratch. */
function dockerPath(p: string): string | undefined {
  if (p.includes(":") || p.includes(",")) return "must not contain : or ,";
  if (!noParent(p)) return "must not contain ..";
  if (p.startsWith(SCRATCH_MOUNT_PREFIX)) return p.length > SCRATCH_MOUNT_PREFIX.length ? undefined : "needs a directory after @scratch/";
  if (p.startsWith("@") || p.startsWith("~")) return "must be absolute, a path relative to the workspace, or @scratch/<dir>";
  if (p === "/") return "must not be the whole filesystem";
  return undefined;
}

function pathList(at: string, value: unknown, allow: (p: string) => string | undefined): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_PATHS) return `${at}: must be an array of at most ${MAX_PATHS} paths`;
  for (const [i, p] of value.entries()) {
    const problem = pathProblem(`${at}[${i}]`, p, allow);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Why `v` is not a valid job confinement, or undefined when it is. */
export function confinementProblem(v: unknown): string | undefined {
  if (!isRecord(v)) return "confinement: must be an object with a kind of bwrap or docker";
  if (v.kind === "bwrap") return bwrapProblem(v);
  if (v.kind === "docker") return dockerProblem(v);
  return `confinement.kind: must be "bwrap" or "docker", got ${JSON.stringify(v.kind)}`;
}

function bwrapProblem(v: Record<string, unknown>): string | undefined {
  const known = new Set(["kind", "network", "mask", "binds"]);
  const extra = Object.keys(v).find((k) => !known.has(k));
  if (extra !== undefined) return `confinement.${extra}: not a bwrap confinement field`;
  if (typeof v.network !== "boolean") return "confinement.network: required boolean";
  const mask = pathList("confinement.mask", v.mask, bwrapPath);
  if (mask !== undefined) return mask;
  if (!Array.isArray(v.binds) || v.binds.length > MAX_PATHS) return `confinement.binds: must be an array of at most ${MAX_PATHS} {path, readOnly}`;
  for (const [i, b] of v.binds.entries()) {
    const at = `confinement.binds[${i}]`;
    if (!isRecord(b)) return `${at}: must be an object {path, readOnly}`;
    const extraKey = Object.keys(b).find((k) => k !== "path" && k !== "readOnly");
    if (extraKey !== undefined) return `${at}.${extraKey}: not a bind field`;
    const problem = pathProblem(`${at}.path`, b.path, bwrapPath);
    if (problem !== undefined) return problem;
    if (typeof b.readOnly !== "boolean") return `${at}.readOnly: required boolean`;
  }
  return undefined;
}

function dockerProblem(v: Record<string, unknown>): string | undefined {
  const known = new Set(["kind", "image", "cpus", "memory", "pids", "tmp", "wallClockMs", "writable", "readOnly", "env"]);
  const extra = Object.keys(v).find((k) => !known.has(k));
  if (extra !== undefined) return `confinement.${extra}: not a docker confinement field`;
  if (typeof v.image !== "string" || !IMAGE_DIGEST.test(v.image)) {
    return "confinement.image: must be pinned by digest, as name@sha256:<64 hex digits>; a tag can change under the run";
  }
  if (typeof v.cpus !== "number" || !Number.isFinite(v.cpus) || v.cpus <= 0 || v.cpus > 1024) return "confinement.cpus: must be a number above 0 and at most 1024";
  for (const key of ["memory", "tmp"] as const) {
    const value = v[key];
    if (typeof value !== "string" || !SIZE.test(value)) return `confinement.${key}: must be a size such as 8g, 512m or 1048576`;
  }
  if (typeof v.pids !== "number" || !Number.isSafeInteger(v.pids) || v.pids < 1 || v.pids > 4_194_304) return "confinement.pids: must be a whole number from 1 to 4194304";
  if (typeof v.wallClockMs !== "number" || !Number.isSafeInteger(v.wallClockMs) || v.wallClockMs < 1 || v.wallClockMs > MAX_WALL_CLOCK_MS) {
    return `confinement.wallClockMs: must be a whole number of milliseconds from 1 to ${MAX_WALL_CLOCK_MS}`;
  }
  const writable = pathList("confinement.writable", v.writable, dockerPath);
  if (writable !== undefined) return writable;
  const readOnly = pathList("confinement.readOnly", v.readOnly, dockerPath);
  if (readOnly !== undefined) return readOnly;
  const writableSet = new Set(v.writable as string[]);
  const both = (v.readOnly as string[]).find((p) => writableSet.has(p));
  if (both !== undefined) return `confinement.readOnly: ${both} is also writable`;
  if (!isRecord(v.env)) return "confinement.env: must be an object of string values";
  const names = Object.keys(v.env);
  if (names.length > MAX_ENV) return `confinement.env: at most ${MAX_ENV} variables`;
  for (const name of names) {
    if (!ENV_NAME.test(name)) return `confinement.env.${name}: name must match ${ENV_NAME.source}`;
    const value = v.env[name];
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_CHARS || value.includes("\0")) {
      return `confinement.env.${name}: must be a string of at most ${MAX_ENV_VALUE_CHARS} characters`;
    }
    // A value that names the run's scratch directory is a path the runner creates before the container starts.
    if (value.startsWith(SCRATCH_MOUNT_PREFIX)) {
      const problem = pathProblem(`confinement.env.${name}`, value, dockerPath);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/** Validate and canonicalize (a copy, in the declared field order) a job's confinement. */
export function assertConfinement(value: unknown): ConfinementSpec {
  const problem = confinementProblem(value);
  if (problem !== undefined) throw new Error(`job ${problem}`);
  const v = value as unknown as BwrapConfinement | DockerConfinement;
  if (v.kind === "bwrap") {
    return { kind: "bwrap", network: v.network, mask: [...v.mask], binds: v.binds.map((b) => ({ path: b.path, readOnly: b.readOnly })) };
  }
  return {
    kind: "docker",
    image: v.image,
    cpus: v.cpus,
    memory: v.memory,
    pids: v.pids,
    tmp: v.tmp,
    wallClockMs: v.wallClockMs,
    writable: [...v.writable],
    readOnly: [...v.readOnly],
    env: { ...v.env },
  };
}
