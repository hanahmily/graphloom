import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinExecutorRunner } from "@graphloom/runner";
import { boundedInputShape, type ExecutorContext } from "@graphloom/sdk";
import { COMMAND_INPUT_SHAPE, COMMAND_RUN_ID, commandInputProblem, commandSucceeded, createCommandExecutor, isCommandInput, type CommandOutcome } from "./run.js";

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

  it("does not start a command when the job is aborted while it is being set up", async () => {
    const marker = path.join(dir, "started");
    const abort = new AbortController();
    const running = executor.execute({ commands: [{ id: "touch", argv: ["sh", "-c", `touch ${marker}`] }] }, { ...ctx, signal: abort.signal });
    abort.abort();
    const [touch] = outcomes(await running);
    expect(touch).toMatchObject({ aborted: true, exitCode: null });
    await expect(readFile(marker)).rejects.toThrow();
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

describe("command input problems and declared shape", () => {
  it("reports the first failing path and its rule", () => {
    expect(commandInputProblem({ commands: [{ id: "a", argv: ["true"] }] })).toBeUndefined();
    expect(commandInputProblem(null)).toBe("input: must be an object");
    expect(commandInputProblem({ argv: { item: ["go"] } })).toBe("commands: required, an array of 1-16 {id, argv} objects (got only: argv)");
    expect(commandInputProblem({ commands: [] })).toBe("commands: must be an array of 1-16 {id, argv} objects");
    expect(commandInputProblem({ commands: [{ argv: ["true"] }] })).toBe("commands[0].id: required string");
    expect(commandInputProblem({ commands: [{ id: "a", argv: { item: ["go"] } }] })).toBe(
      'commands[0].argv: must be an array of strings, e.g. ["go","env"] (got object)',
    );
    expect(commandInputProblem({ commands: [{ id: "a", argv: ["go", 1] }] })).toMatch(/^commands\[0\]\.argv\[1\]: must be a string/);
    expect(commandInputProblem({ commands: [{ id: "a", argv: ["x"] }, { id: "a", argv: ["x"] }] })).toMatch(/^commands\[1\]\.id: duplicate/);
    expect(commandInputProblem({ commands: [{ id: "a", argv: ["x"] }], env: { GRAPHLOOM_REPORT_FILE: "x" } })).toMatch(/^env\.GRAPHLOOM_REPORT_FILE: reserved/);
  });

  it("agrees with the predicate, which stays authoritative", () => {
    for (const v of [{}, { commands: [] }, { commands: [{ id: "a", argv: ["true"] }] }, { commands: "x" }]) {
      expect(isCommandInput(v)).toBe(commandInputProblem(v) === undefined);
    }
  });

  it("declares a schema and an example that the predicate accepts", () => {
    expect(isCommandInput(COMMAND_INPUT_SHAPE.example)).toBe(true);
    expect(COMMAND_INPUT_SHAPE.schema.required).toEqual(["commands"]);
    expect(boundedInputShape(COMMAND_INPUT_SHAPE)).toEqual(COMMAND_INPUT_SHAPE);
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
    // The input shape the executor process declared reaches the catalog as data.
    expect(described.find((d) => d.id === COMMAND_RUN_ID)?.inputShape).toEqual(COMMAND_INPUT_SHAPE);
  });

  it("gives every command the agent locations it is bound with, and nothing else", async () => {
    const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
    const env = { GRAPHLOOM_CODEX_BIN: "/opt/codex/bin/codex", GRAPHLOOM_CODEX_HOME: "/srv/codex-home" };
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: commandExecutorPackage, ...commandBinding({ env }) }],
      fallback: { runJob: async () => { throw new Error("not served"); } },
    });
    const result = await runner.runJob(
      {
        stageId: "fix",
        kind: "command",
        purpose: "check",
        instruction: "print the Codex location",
        readOnly: true,
        input: { commands: [{ id: "where", argv: ["sh", "-c", 'printf "%s %s" "$GRAPHLOOM_CODEX_BIN" "$GRAPHLOOM_CODEX_HOME"'] }] },
      },
      { runId: "r1", operationId: "op-3", generation: 1, worktreePath: dir, artifactDir: path.join(dir, ".artifacts") },
    );
    expect((result.evidence![0]!.payload as { command: CommandOutcome }).command.stdoutTail).toBe("/opt/codex/bin/codex /srv/codex-home");
    expect(() => commandBinding({ env: { GITHUB_TOKEN: "t" } })).toThrow('does not accept configuration "GITHUB_TOKEN"');
  });
});

describe("command host effect (#165)", () => {
  const scope = { writablePaths: ["/runs/w", "/runs/state/scratch"] };
  const effect = (...argv: string[]) => executor.hostEffect?.({ commands: [{ id: "c", argv }] }, scope);

  it("names a global configuration write and a mutation aimed outside the scope", () => {
    expect(effect("go", "env", "-w", "GOCACHE=/x")).toContain("global Go configuration");
    expect(effect("git", "config", "--global", "user.name", "x")).toContain("global git configuration");
    expect(effect("npm", "config", "set", "cache", "/x", "-g")).toContain("global npm configuration");
    expect(effect("rm", "-rf", "/home/u/.cache/go-build")).toContain("/home/u/.cache/go-build");
    expect(effect("mkdir", "-p", "~/x")).toContain("~/x");
    expect(effect("sh", "-c", "echo x > /etc/motd")).toContain("/etc/motd");
    expect(effect("bash", "-c", "cd /runs/w && true; rm -rf /var/cache/x")).toContain("/var/cache/x");
  });

  it("leaves commands that stay in scope, or only read, alone", () => {
    expect(effect("go", "env", "GOCACHE")).toBeUndefined();
    expect(effect("rm", "-rf", "/runs/w/build")).toBeUndefined();
    expect(effect("rm", "build/out")).toBeUndefined();
    expect(effect("cat", "/etc/hosts")).toBeUndefined();
    expect(effect("sh", "-c", "echo x > /runs/state/scratch/out")).toBeUndefined();
  });
});
