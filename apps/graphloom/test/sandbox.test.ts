// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom sandbox pull`: the pre-run image check a graph's environment
 * check calls. Usage errors need no Docker; the rest run against the real
 * daemon and skip, saying why, where there is none.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sandboxCommand } from "../src/sandbox.js";

const IMAGE = "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const ABSENT = `busybox@sha256:${"0".repeat(64)}`;

function dockerUnavailable(): string | undefined {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 30_000 });
  if (info.error !== undefined || info.status !== 0) return "the docker CLI or daemon is not available";
  if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) return undefined;
  const pull = spawnSync("docker", ["pull", IMAGE], { encoding: "utf8", timeout: 180_000 });
  return pull.status === 0 ? undefined : `${IMAGE} is not present locally and could not be pulled`;
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await sandboxCommand(args, (l) => out.push(l), (l) => err.push(l));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("graphloom sandbox pull: usage", () => {
  it("refuses an image without a digest, and a missing or extra argument", async () => {
    expect(await run(["pull", "busybox:latest"])).toMatchObject({ code: 2, err: expect.stringContaining("not pinned by digest") });
    expect((await run(["pull"])).code).toBe(2);
    expect((await run(["pull", IMAGE, "extra"])).code).toBe(2);
    expect((await run(["pull", IMAGE, "--force"])).code).toBe(2);
    expect((await run(["fetch", IMAGE])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });
});

const unavailable = dockerUnavailable();
if (unavailable !== undefined) console.warn(`graphloom sandbox tests skipped: ${unavailable}`);

describe.skipIf(unavailable !== undefined)("graphloom sandbox pull: against Docker", () => {
  it("reports an image that is already in the local store, with or without --check", async () => {
    expect(await run(["pull", IMAGE])).toMatchObject({ code: 0, out: `present: ${IMAGE}` });
    expect(await run(["pull", IMAGE, "--check"])).toMatchObject({ code: 0, out: `present: ${IMAGE}` });
  });

  it("with --check, reports a missing image and pulls nothing", async () => {
    const result = await run(["pull", ABSENT, "--check"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/missing: docker image .* is not present locally; run graphloom sandbox pull/);
    expect(spawnSync("docker", ["image", "inspect", ABSENT], { stdio: "ignore" }).status).not.toBe(0);
  });

  it("fails clearly when a missing image cannot be pulled", async () => {
    const result = await run(["pull", ABSENT]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^failed: docker pull .* failed/);
  }, 120_000);
});
