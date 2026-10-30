// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confinementUnsupported, createBuiltinExecutorRunner, packageClosure, type JobContext, type Runner } from "@graphloom/runner";
import { READONLY_SANDBOX_ENV, type BwrapConfinement, type JobSpec } from "@graphloom/sdk";
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

  describe("a read-only job's shell (what lets a read-only agent run git show and git grep)", () => {
    let repo: string;
    const repoCtx = (): JobContext => ({ ...ctx(), worktreePath: repo, confinement: { scratchDir: path.join(dir, "scratch"), writablePaths: [repo] } });
    const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });

    beforeAll(async () => {
      repo = path.join(dir, "repo");
      await mkdir(repo);
      git("init", "-q");
      await writeFile(path.join(repo, "base.txt"), "needle on the base\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      await writeFile(path.join(repo, "base.txt"), "the head has changed\n");
    });

    it("cannot write the workspace (read-only filesystem), though git show HEAD:<file> and git grep still work", async () => {
      const script = 'git show HEAD:base.txt; git grep -n needle HEAD; echo "head: $(cat base.txt)"; if echo x > out.txt; then echo WROTE; else echo WRITE_FAILED; fi; if git checkout -- base.txt 2>/dev/null; then echo CHECKED_OUT; fi; touch .git/pwned 2>&1 || true';
      const out = (await outcome(job(["sh", "-c", script], sandbox(), true), repoCtx())).stdoutTail;
      expect(out).toContain("needle on the base");
      expect(out).toMatch(/HEAD:base\.txt:1:needle on the base/);
      expect(out).toContain("head: the head has changed");
      expect(out).toContain("WRITE_FAILED");
      expect(out).toContain("Read-only file system");
      expect(out).not.toContain("WROTE");
      expect(out).not.toContain("CHECKED_OUT");
      expect(existsSync(path.join(repo, "out.txt"))).toBe(false);
      expect(existsSync(path.join(repo, ".git", "pwned"))).toBe(false);
      expect(await readFile(path.join(repo, "base.txt"), "utf8")).toBe("the head has changed\n");
    });

    it("tells the executor the workspace is mounted read-only, only for a read-only bwrap job, and never from the operator's environment", async () => {
      const probe = ["sh", "-c", `echo "signal=\${${READONLY_SANDBOX_ENV}:-unset}"`];
      expect((await outcome(job(probe, sandbox(), true), repoCtx())).stdoutTail).toContain("signal=1");
      expect((await outcome(job(probe, sandbox(), false), repoCtx())).stdoutTail).toContain("signal=unset");
      expect((await outcome(job(probe, undefined, true), repoCtx())).stdoutTail).toContain("signal=unset");
      // A declared read-write bind could reopen the workspace, so the sandbox no longer vouches for read-only.
      const reopened = sandbox({ binds: [{ path: repo, readOnly: false }] });
      expect((await outcome(job(probe, reopened, true), repoCtx())).stdoutTail).toContain("signal=unset");
      expect((await outcome(job(probe, sandbox({ binds: [{ path: repo, readOnly: true }] }), true), repoCtx())).stdoutTail).toContain("signal=1");
      const before = process.env[READONLY_SANDBOX_ENV];
      process.env[READONLY_SANDBOX_ENV] = "1";
      try {
        expect((await outcome(job(probe, sandbox(), false), repoCtx())).stdoutTail).toContain("signal=unset");
        expect((await outcome(job(probe, undefined, true), repoCtx())).stdoutTail).toContain("signal=unset");
      } finally {
        if (before === undefined) delete process.env[READONLY_SANDBOX_ENV];
        else process.env[READONLY_SANDBOX_ENV] = before;
      }
    });
  });

  it("still starts the executor when GraphLoom is installed under the hidden home", async () => {
    // The installation (its packages and the dependencies they import) lives beneath the operator's home here.
    const installHome = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const realHome = process.env.HOME;
    process.env.HOME = installHome;
    try {
      const probe = await outcome(job(["sh", "-c", `echo started; ls -A ${installHome} | wc -l`], sandbox()));
      expect(probe.stdoutTail).toContain("started");
      // The rest of that home is hidden: only what the executor needs shows through.
      expect(Number(probe.stdoutTail.trim().split("\n").pop())).toBeLessThan((await readdir(installHome)).length);
    } finally {
      process.env.HOME = realHome;
    }
  });

  it("shows through a hidden home the packages the executor imports, not only its own", async () => {
    const { commandExecutorPackage } = await import("../dist/package.js");
    const closure = packageClosure([commandExecutorPackage.entryModule]);
    // @graphloom/sdk is found through an ancestor node_modules, outside the executor's own package.
    expect(closure).toContain(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/sdk"));
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
