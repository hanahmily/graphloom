import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinExecutorRunner } from "@graphloom/runner";
import type { ExecutorContext } from "@graphloom/sdk";
import { COMMAND_RUN_ID, commandSucceeded, createCommandExecutor, type CommandOutcome } from "./run.js";

let dir: string;
let ctx: ExecutorContext;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-command-"));
  ctx = { runId: "r1", operationId: "op-1", generation: 1, worktreePath: dir, artifactDir: path.join(dir, ".artifacts") };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function outcomes(result: unknown): CommandOutcome[] {
  const evidence = (result as { evidence: Array<{ kind: string; payload: { command: CommandOutcome } }> }).evidence;
  expect(evidence.every((e) => e.kind === "command")).toBe(true);
  return evidence.map((e) => e.payload.command);
}

const executor = createCommandExecutor();

describe("command executor", () => {
  it("runs commands in the workspace and records exit codes and output", async () => {
    await writeFile(path.join(dir, "marker.txt"), "here\n");
    const result = await executor.execute(
      { commands: [{ id: "cat", argv: ["cat", "marker.txt"] }, { id: "err", argv: ["sh", "-c", "echo oops >&2"] }] },
      ctx,
    );
    const [cat, err] = outcomes(result);
    expect(cat).toMatchObject({ id: "cat", exitCode: 0, stdoutTail: "here\n", timedOut: false });
    expect(err).toMatchObject({ exitCode: 0, stderrTail: "oops\n" });
    expect((result as { status: string }).status).toBe("ok");
  });

  it("reports a non-zero exit as an observation and skips the rest", async () => {
    const result = await executor.execute(
      { commands: [{ id: "fail", argv: ["sh", "-c", "exit 3"] }, { id: "never", argv: ["true"] }] },
      ctx,
    );
    const recorded = outcomes(result);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ id: "fail", exitCode: 3 });
    expect(commandSucceeded(recorded[0]!)).toBe(false);
    expect(result).toMatchObject({ status: "ok", summary: "fail exited 3; 1 not run" });
  });

  it("keeps going after a failure when asked", async () => {
    const result = await executor.execute(
      { commands: [{ id: "fail", argv: ["false"] }, { id: "after", argv: ["true"] }], continueOnFailure: true },
      ctx,
    );
    expect(outcomes(result).map((o) => [o.id, o.exitCode])).toEqual([["fail", 1], ["after", 0]]);
  });

  it("records a program that is not installed", async () => {
    const [missing] = outcomes(await executor.execute({ commands: [{ id: "go", argv: ["no-such-program-gl"] }] }, ctx));
    expect(missing!.spawnError).toMatch(/ENOENT/);
    expect(commandSucceeded(missing!)).toBe(false);
  });

  it("stops a command that outlives its timeout, including what it started", async () => {
    const pidFile = path.join(dir, "child.pid");
    const [slow] = outcomes(
      await executor.execute(
        { commands: [{ id: "slow", argv: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], timeoutMs: 300 }] },
        ctx,
      ),
    );
    expect(slow).toMatchObject({ timedOut: true, exitCode: null });
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("does not settle a stop until a descendant that ignores SIGTERM is gone", async () => {
    const pidFile = path.join(dir, "stubborn.pid");
    const stubborn = `trap '' TERM; echo \\$\\$ > ${pidFile}; exec sleep 30`;
    const abort = new AbortController();
    const running = executor.execute(
      { commands: [{ id: "long", argv: ["sh", "-c", `sh -c "${stubborn}" >/dev/null 2>&1 </dev/null & wait`] }] },
      { ...ctx, signal: abort.signal },
    );
    while ((await readFile(pidFile, "utf8").catch(() => "")).trim() === "") await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const [long] = outcomes(await running);
    expect(long).toMatchObject({ aborted: true });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("stops what a command left running in the background once it exits", async () => {
    const pidFile = path.join(dir, "stray.pid");
    const [quick] = outcomes(
      await executor.execute(
        { commands: [{ id: "quick", argv: ["sh", "-c", `sh -c "echo \\$\\$ > ${pidFile}; exec sleep 30" >/dev/null 2>&1 & while [ ! -s ${pidFile} ]; do sleep 0.02; done`] }] },
        ctx,
      ),
    );
    expect(quick).toMatchObject({ exitCode: 0 });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("finishes a command whose background descendant still holds its output pipes", async () => {
    const pidFile = path.join(dir, "holder.pid");
    const started = Date.now();
    const [quick] = outcomes(
      await executor.execute(
        { commands: [{ id: "quick", argv: ["sh", "-c", `sleep 3 & echo $! > ${pidFile}; echo done; exit 0`], timeoutMs: 150 }] },
        ctx,
      ),
    );
    expect(quick).toMatchObject({ exitCode: 0, timedOut: false, stdoutTail: "done\n" });
    expect(commandSucceeded(quick!)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_500);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops when the job is aborted", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const result = await executor.execute(
      { commands: [{ id: "long", argv: ["sleep", "30"] }, { id: "next", argv: ["true"] }] },
      { ...ctx, signal: abort.signal },
    );
    const recorded = outcomes(result);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ aborted: true });
  });

  it("keeps only the tail of long output and of the report file", async () => {
    const [big] = outcomes(
      await executor.execute(
        {
          commands: [
            {
              id: "big",
              argv: ["sh", "-c", 'head -c 20000 /dev/zero | tr "\\0" a; printf END; head -c 100000 /dev/zero | tr "\\0" b > "$GRAPHLOOM_REPORT_FILE"; printf REPORT_END >> "$GRAPHLOOM_REPORT_FILE"'],
            },
          ],
        },
        ctx,
      ),
    );
    expect(big!.stdoutTail.startsWith("…")).toBe(true);
    expect(big!.stdoutTail.endsWith("END")).toBe(true);
    expect(Buffer.byteLength(big!.stdoutTail)).toBeLessThanOrEqual(8_192 + 3);
    expect(big!.report!.truncated).toBe(true);
    expect(big!.report!.text.endsWith("REPORT_END")).toBe(true);
    expect(big!.report!.text.length).toBe(65_536);
  });

  it("passes extra environment variables and gives each command its own report file", async () => {
    const [first, second] = outcomes(
      await executor.execute(
        {
          env: { GL_GREETING: "hi" },
          commands: [
            { id: "one", argv: ["sh", "-c", 'echo "$GL_GREETING one" > "$GRAPHLOOM_REPORT_FILE"'] },
            { id: "two", argv: ["sh", "-c", "true"] },
          ],
        },
        ctx,
      ),
    );
    expect(first!.report).toEqual({ text: "hi one\n", truncated: false });
    expect(second!.report).toBeUndefined();
  });

  it("rejects malformed input", () => {
    const valid = executor.inputSchema!;
    expect(valid({ commands: [{ id: "a", argv: ["true"] }] })).toBe(true);
    expect(valid({ commands: [] })).toBe(false);
    expect(valid({ commands: [{ id: "a", argv: [] }] })).toBe(false);
    expect(valid({ commands: [{ id: "a", argv: ["true"] }, { id: "a", argv: ["true"] }] })).toBe(false);
    expect(valid({ commands: [{ id: "a b", argv: ["true"] }] })).toBe(false);
    expect(valid({ commands: [{ id: "a", argv: ["true"] }], env: { GRAPHLOOM_REPORT_FILE: "/etc/passwd" } })).toBe(false);
  });
});

describe("command executor package", () => {
  it("is served in its own executor process by the built-in runner", async () => {
    // The executor process loads the built entry module, so use the built manifest.
    const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
      fallback: { runJob: async () => { throw new Error("not served"); } },
    });
    const result = await runner.runJob(
      {
        stageId: "fix",
        kind: "command",
        purpose: "check",
        instruction: "print the working directory",
        readOnly: true,
        input: { commands: [{ id: "pwd", argv: ["pwd"] }] },
      },
      { runId: "r1", operationId: "op-2", generation: 1, worktreePath: dir, artifactDir: path.join(dir, ".artifacts") },
    );
    expect(result).toMatchObject({ status: "ok", summary: "1 command(s) succeeded" });
    const outcome = (result.evidence![0]!.payload as { command: CommandOutcome }).command;
    expect(outcome.stdoutTail.trim()).toBe(await realpath(dir));
    const described = await runner.describeExecutors!();
    expect(described.map((d) => d.id)).toContain(COMMAND_RUN_ID);
  });
});
