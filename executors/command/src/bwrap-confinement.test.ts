// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confinementUnsupported, createBuiltinExecutorRunner, type JobContext, type Runner } from "@graphloom/runner";
import type { BwrapConfinement, JobSpec } from "@graphloom/sdk";
import type { CommandOutcome } from "./run.js";

const unsupported = await confinementUnsupported();

let dir: string;
let work: string;
let secretDir: string;
let runner: Runner;
let server: Server;
let port = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-bwrap-job-"));
  work = path.join(dir, "work");
  await mkdir(work);
  // Outside /tmp, which a confined job sees as a private one: a mask must hide what is really there.
  secretDir = await mkdtemp(path.join(process.cwd(), ".bwrap-secret-"));
  await writeFile(path.join(secretDir, "token"), "s3cret");
  server = createServer((socket) => socket.end("hello"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
  runner = createBuiltinExecutorRunner({
    packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
    fallback: { runJob: async () => { throw new Error("not served"); } },
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  await rm(secretDir, { recursive: true, force: true });
});

const sandbox = (over: Partial<BwrapConfinement> = {}): BwrapConfinement => ({ kind: "bwrap", network: true, mask: [], binds: [], ...over });

function job(argv: string[], confinement: BwrapConfinement | undefined, readOnly = true): JobSpec {
  return {
    stageId: "s",
    kind: "command",
    purpose: "check",
    instruction: "x",
    ...(readOnly ? { readOnly: true } : { writeScope: ["."] }),
    input: { commands: [{ id: "c", argv }] },
    ...(confinement !== undefined ? { confinement } : {}),
  };
}

let op = 0;
function ctx(scope = true): JobContext {
  op += 1;
  return {
    runId: "r1",
    operationId: `op-${op}`,
    generation: 1,
    worktreePath: work,
    artifactDir: path.join(dir, "artifacts"),
    ...(scope ? { confinement: { scratchDir: path.join(dir, "scratch"), writablePaths: [work] } } : {}),
  };
}

async function outcome(spec: JobSpec, context = ctx()): Promise<CommandOutcome> {
  const result = await runner.runJob(spec, context);
  expect(result.status, result.summary).toBe("ok");
  return (result.evidence![0]!.payload as { command: CommandOutcome }).command;
}

const dial = ["node", "-e", `require("net").connect(${"PORT"}, "127.0.0.1").on("data", (d) => { console.log("got " + d); process.exit(0); }).on("error", (e) => { console.log("failed " + e.code); process.exit(3); })`];

describe.skipIf(unsupported !== undefined)("a command job with a bwrap confinement", () => {
  it("runs the job's commands without a network when asked", async () => {
    const argv = [process.execPath, ...dial.slice(1)].map((a) => a.replace("PORT", String(port)));
    expect((await outcome(job(argv, sandbox({ network: true })))).stdoutTail).toContain("got hello");
    const off = await outcome(job(argv, sandbox({ network: false })));
    expect(off.exitCode).toBe(3);
    expect(off.stdoutTail).toMatch(/failed (ECONNREFUSED|ENETUNREACH)/);
  });

  it("hides a masked path from the job's commands", async () => {
    const argv = ["sh", "-c", `cat ${secretDir}/token; echo "[$(ls -A ${secretDir} | wc -l)]"`];
    expect((await outcome(job(argv, sandbox()))).stdoutTail).toContain("s3cret");
    const masked = await outcome(job(argv, sandbox({ mask: [secretDir] })));
    expect(masked.stdoutTail).not.toContain("s3cret");
    expect(masked.stdoutTail).toContain("[0]");
  });

  it("keeps a read-only job from writing the workspace, and lets a writing job write it", async () => {
    const argv = ["sh", "-c", "echo x > out.txt && echo wrote"];
    expect((await outcome(job(argv, sandbox(), true))).stdoutTail).not.toContain("wrote");
    expect((await outcome(job(argv, sandbox(), false))).stdoutTail).toContain("wrote");
    expect(await readFile(path.join(work, "out.txt"), "utf8")).toBe("x\n");
  });

  it("refuses a job that asks for a sandbox when the run gave it no scope", async () => {
    const result = await runner.runJob(job(["true"], sandbox()), ctx(false));
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/needs the run's scope/);
  });

  it("passes admission where bwrap works", async () => {
    expect(await runner.checkJob!(job(["true"], sandbox()))).toBeUndefined();
  });
});
