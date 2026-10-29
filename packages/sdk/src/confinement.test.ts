// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { assertConfinement, confinementProblem, pinJobExecutor, type JobSpec } from "./index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

const docker = (over: Record<string, unknown> = {}) => ({
  kind: "docker",
  image: `golang@${DIGEST}`,
  cpus: 4,
  memory: "8g",
  pids: 512,
  tmp: "1g",
  wallClockMs: 600_000,
  writable: [".", "@scratch/cache"],
  readOnly: ["/home/u/go/pkg/mod"],
  env: { HOME: "/tmp", GOFLAGS: "-mod=readonly" },
  ...over,
});

const bwrap = (over: Record<string, unknown> = {}) => ({
  kind: "bwrap",
  network: false,
  mask: ["~/.ssh", "/etc/shadow"],
  binds: [{ path: "~/deps", readOnly: true }],
  ...over,
});

const job = (confinement: unknown, over: Partial<JobSpec> = {}): JobSpec =>
  ({ stageId: "s", kind: "command", purpose: "check", instruction: "x", confinement, ...over }) as JobSpec;

describe("job confinement shape", () => {
  it("accepts a valid bwrap and a valid docker confinement and keeps them on the pinned job", () => {
    expect(confinementProblem(bwrap())).toBeUndefined();
    expect(confinementProblem(docker())).toBeUndefined();
    expect(pinJobExecutor(job(docker())).confinement).toEqual(docker());
    expect(pinJobExecutor(job(bwrap(), { kind: "agent" })).confinement).toEqual(bwrap());
    expect(pinJobExecutor(job(undefined)).confinement).toBeUndefined();
  });

  it("rejects what is not a confinement", () => {
    for (const bad of [null, "docker", [], { kind: "chroot" }, {}]) expect(confinementProblem(bad), JSON.stringify(bad)).toBeDefined();
  });

  it.each([
    ["no network flag", bwrap({ network: undefined }), /network/],
    ["a relative mask", bwrap({ mask: ["secrets"] }), /absolute/],
    ["masking everything", bwrap({ mask: ["/"] }), /whole filesystem/],
    ["a parent segment", bwrap({ mask: ["/home/../etc"] }), /\.\./],
    ["a bind without readOnly", bwrap({ binds: [{ path: "/opt" }] }), /readOnly/],
    ["an unknown field", bwrap({ extra: 1 }), /extra/],
    ["a bind of the filesystem root", bwrap({ binds: [{ path: "/", readOnly: true }] }), /whole filesystem/],
  ])("rejects a bwrap confinement with %s", (_name, value, pattern) => {
    expect(confinementProblem(value)).toMatch(pattern);
  });

  it.each([
    ["a tag instead of a digest", docker({ image: "golang:1.26" }), /digest/],
    ["a short digest", docker({ image: "golang@sha256:abc" }), /digest/],
    ["an image that reads as a flag", docker({ image: `--privileged@${DIGEST}` }), /digest/],
    ["zero cpus", docker({ cpus: 0 }), /cpus/],
    ["a memory size without units sense", docker({ memory: "lots" }), /memory/],
    ["a negative pid limit", docker({ pids: -1 }), /pids/],
    ["no tmp", docker({ tmp: undefined }), /tmp/],
    ["a zero wall clock", docker({ wallClockMs: 0 }), /wallClockMs/],
    ["a colon in a mount", docker({ writable: ["/a:/b"] }), /: or ,/],
    ["a parent segment in a mount", docker({ writable: ["../x"] }), /\.\./],
    ["an empty scratch mount", docker({ writable: ["@scratch/"] }), /scratch/],
    ["a path both writable and read-only", docker({ readOnly: ["."] }), /also writable/],
    ["a bad variable name", docker({ env: { "A-B": "x" } }), /env/],
    ["a non-string variable", docker({ env: { A: 1 } }), /env\.A/],
    ["an unknown field such as network", docker({ network: "host" }), /network/],
  ])("rejects a docker confinement with %s", (_name, value, pattern) => {
    expect(confinementProblem(value)).toMatch(pattern);
  });

  it("pins only command jobs to a docker confinement", () => {
    expect(() => pinJobExecutor(job(docker(), { kind: "agent" }))).toThrow(/only command jobs/);
  });

  it("refuses an invalid confinement when the job is pinned", () => {
    expect(() => pinJobExecutor(job(docker({ image: "golang:latest" })))).toThrow(/job confinement\.image/);
    expect(() => assertConfinement({ kind: "bwrap" })).toThrow(/network/);
  });

  it("copies the confinement, so the pinned job does not alias the plugin's object", () => {
    const original = docker();
    const pinned = pinJobExecutor(job(original)).confinement as { env: Record<string, string> };
    pinned.env.HOME = "/changed";
    expect((original.env as Record<string, string>).HOME).toBe("/tmp");
  });
});
