// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The sandbox's Go against the repository's (design §6.8, §8.2). The sandbox runs `GOTOOLCHAIN=local` with no network, so a
 * `go.mod` whose `go` or `toolchain` line is newer than the image's Go builds nothing: Go stops with
 * `go: go.mod requires go >= 1.26.11 (running go 1.26.10; GOTOOLCHAIN=local)`. That is a fact about the profile's pinned
 * image, not about the test or the code under review, so reproducing tests and coverage name it instead of "build failed".
 * Everything here is a pure function of the error text Go printed.
 */

interface GoVersion {
  parts: [number, number, number];
  /** A release candidate or beta (`1.26rc1`) sorts before its release. */
  pre: number;
}

/** A Go version as `go.mod` or `go version` writes it (`1.26`, `1.26.10`, `go1.26.11`, `1.26rc1`), or undefined. */
export function parseGoVersion(text: string): GoVersion | undefined {
  const m = /^(?:go)?(\d+)\.(\d+)(?:\.(\d+))?(?:(?:rc|beta)(\d+))?$/.exec(text.trim());
  if (m === null) return undefined;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4]) };
}

/** Negative when `a` is older than `b`, zero when equal (`1.26` is `1.26.0`), positive when newer; undefined when either is not a Go version. */
export function compareGoVersions(a: string, b: string): number | undefined {
  const x = parseGoVersion(a);
  const y = parseGoVersion(b);
  if (x === undefined || y === undefined) return undefined;
  for (const i of [0, 1, 2] as const) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  return x.pre === y.pre ? 0 : x.pre < y.pre ? -1 : 1;
}

export interface ToolchainMismatch {
  required: string;
  running: string;
}

const MISMATCH = /requires go >= ((?:go)?\d[\w.]*) \(running go ((?:go)?\d[\w.]*); GOTOOLCHAIN=local\)/;

/** The mismatch Go's error text states, when it states one and the required version really is newer than the running one. */
export function toolchainMismatch(text: string): ToolchainMismatch | undefined {
  const m = MISMATCH.exec(text);
  if (m === null) return undefined;
  const required = m[1]!.replace(/^go/, "");
  const running = m[2]!.replace(/^go/, "");
  const order = compareGoVersions(running, required);
  return order !== undefined && order < 0 ? { required, running } : undefined;
}

/** The plain sentence for a mismatch, which names the profile field to change. */
export function toolchainSentence(t: ToolchainMismatch): string {
  return `the sandbox's Go ${t.running} is older than go.mod's ${t.required}; update metrics.sandbox.go.image`;
}
