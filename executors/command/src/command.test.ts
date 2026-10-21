import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { confinementUnsupported, createBuiltinExecutorRunner } from "@graphloom/runner";
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
    expect(effect("cp", "/runs/w/a", "/etc/a")).toContain("/etc/a");
    expect(effect("mv", "/runs/w/a", "/var/a")).toContain("/var/a");
    expect(effect("cp", "-t", "/etc", "/runs/w/a")).toContain("/etc");
    expect(effect("sh", "-c", "echo x > /etc/motd")).toContain("/etc/motd");
    expect(effect("sh", "-c", "echo x >>/etc/motd")).toContain("/etc/motd");
    expect(effect("sh", "-c", "echo '>' && echo x > '/etc/quoted'")).toContain("/etc/quoted");
    expect(effect("bash", "-c", "cd /runs/w && true; rm -rf /var/cache/x")).toContain("/var/cache/x");
  });

  it("leaves commands that stay in scope, or only read, alone", () => {
    expect(effect("go", "env", "GOCACHE")).toBeUndefined();
    expect(effect("rm", "-rf", "/runs/w/build")).toBeUndefined();
    expect(effect("rm", "build/out")).toBeUndefined();
    expect(effect("cat", "/etc/hosts")).toBeUndefined();
    // Reads are not writes, whatever the paths.
    expect(effect("cp", "/etc/hosts", "/runs/w/hosts")).toBeUndefined();
    expect(effect("git", "config", "--global", "--get", "user.name")).toBeUndefined();
    expect(effect("git", "config", "--global", "--list")).toBeUndefined();
    expect(effect("npm", "config", "get", "cache", "-g")).toBeUndefined();
    // A path that merely appears as an argument is not a command or a destination.
    expect(effect("cat", "/tmp/rm", "/etc/hosts")).toBeUndefined();
    expect(effect("sh", "-c", "cat /etc/hosts | grep x > /runs/w/out; ls /var")).toBeUndefined();
    expect(effect("sh", "-c", "cp /etc/hosts /runs/w/hosts && grep -q rm /etc/hosts")).toBeUndefined();
    // `>` is a literal argument in a plain argv, and stays literal inside quotes in a script.
    expect(effect("echo", ">", "/etc/hosts")).toBeUndefined();
    expect(effect("echo", ">>", "/etc/hosts")).toBeUndefined();
    expect(effect("sh", "-c", "echo '> /etc/hosts' \"a > /etc/b\"")).toBeUndefined();
    expect(effect("sh", "-c", "echo hi >/runs/w/out 2>&1")).toBeUndefined();
    expect(effect("sh", "-c", "echo x > /runs/state/scratch/out")).toBeUndefined();
  });
});

const confinementUnavailable = await confinementUnsupported();

describe.skipIf(confinementUnavailable !== undefined)("stopping a confined command job (#165)", () => {
  const detachedWriter = (file: string, marker: string) => ({
    stageId: "s",
    kind: "command" as const,
    purpose: "work" as const,
    instruction: "start a detached writer and wait",
    writeScope: ["grow.txt"],
    executor: { id: COMMAND_RUN_ID },
    input: {
      commands: [
        {
          id: "grow",
          // The writer leaves the command's process group (setsid) and ignores hangup, as a daemon would.
          argv: ["sh", "-c", `setsid nohup sh -c 'while true; do echo x >> ${file}; sleep 0.05; done # ${marker}' >/dev/null 2>&1 & sleep 60`],
        },
      ],
    },
  });
  const sizeOf = async (file: string) => (await readFile(file, "utf8").catch(() => "")).length;
  const alive = (marker: string) => spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim() !== "";

  it.each([
    ["the run stops", { stop: true }],
    ["the job times out", { stop: false }],
  ])("leaves no descendant writing to the worktree after %s", async (_name, { stop }) => {
    const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
    const marker = `gl-detached-${Date.now()}-${stop ? "stop" : "timeout"}`;
    const scratch = path.join(dir, "scratch");
    const worktree = path.join(dir, "wt");
    await mkdir(worktree, { recursive: true });
    const file = path.join(worktree, "grow.txt");
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: commandExecutorPackage, ...commandBinding({ timeoutMs: 1_500 }) }],
      fallback: { runJob: async () => Promise.reject(new Error("fallback must not run")) },
      timeoutMs: 1_500,
    });
    const abort = new AbortController();
    const running = runner.runJob(detachedWriter(file, marker) as never, {
      runId: "r",
      operationId: "op-1",
      generation: 1,
      worktreePath: worktree,
      artifactDir: path.join(dir, "artifacts"),
      signal: abort.signal,
      confinement: { scratchDir: scratch, writablePaths: [worktree] },
    });
    // Wait until the detached writer is really writing.
    for (let i = 0; i < 100 && (await sizeOf(file)) === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(await sizeOf(file)).toBeGreaterThan(0);
    if (stop) abort.abort();
    const result = await running;
    expect(result.status).toBe("failed");
    const settledSize = await sizeOf(file);
    await new Promise((r) => setTimeout(r, 600));
    expect(await sizeOf(file)).toBe(settledSize);
    await new Promise((r) => setTimeout(r, 600));
    expect(await sizeOf(file)).toBe(settledSize);
    expect(alive(marker)).toBe(false);
  }, 30_000);
});

describe("command host effect and the job's /tmp (#171)", () => {
  const effectIn = (scope: { writablePaths: string[]; privateTmp?: boolean }, ...argv: string[]) => executor.hostEffect?.({ commands: [{ id: "c", argv }] }, scope);
  const writes: string[][] = [
    ["sh", "-c", "echo x > /tmp/f"],
    ["mkdir", "-p", "/tmp/x"],
    ["cp", "/runs/w/a", "/tmp/b"],
  ];

  it("accepts writes under /tmp when the launch mounts a private /tmp, but still refuses the rest of the host", () => {
    for (const argv of writes) expect(effectIn({ writablePaths: ["/runs/w"], privateTmp: true }, ...argv)).toBeUndefined();
    expect(effectIn({ writablePaths: ["/runs/w"], privateTmp: true }, "sh", "-c", "echo x > /etc/motd")).toContain("/etc/motd");
    expect(effectIn({ writablePaths: ["/runs/w"], privateTmp: true }, "mkdir", "/var/tmp/x")).toContain("/var/tmp/x");
  });

  it("refuses writes under /tmp when the host's /tmp stays read-only", () => {
    for (const argv of writes) expect(effectIn({ writablePaths: ["/runs/w"], privateTmp: false }, ...argv)).toContain("/tmp");
    for (const argv of writes) expect(effectIn({ writablePaths: ["/runs/w"] }, ...argv)).toContain("/tmp");
  });

  describe.skipIf(confinementUnavailable !== undefined)("as admitted by the runner", () => {
    const job = {
      stageId: "s",
      kind: "command" as const,
      purpose: "work" as const,
      instruction: "write a temp file",
      writeScope: ["x"],
      executor: { id: COMMAND_RUN_ID },
      input: { commands: [{ id: "t", argv: ["sh", "-c", "echo x > /tmp/f"] }] },
    };
    const makeRunner = async () => {
      const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
      return createBuiltinExecutorRunner({
        packages: [{ manifest: commandExecutorPackage, ...commandBinding({}) }],
        fallback: { runJob: async () => Promise.reject(new Error("fallback must not run")) },
      });
    };

    it("takes the write while /tmp is private, and refuses it when something the job reads lives under /tmp", async () => {
      const runner = await makeRunner();
      const base = { scratchDir: path.join(dir, "scratch"), writablePaths: [path.join(dir, "wt")] };
      expect(await runner.checkJob!(job as never, { confinement: base })).toBeUndefined();
      expect(await runner.checkJob!(job as never, { confinement: { ...base, readPaths: [path.join(dir, "shared-git")] } })).toMatch(/\/tmp\/f, outside the run's worktree/);
    });
  });
});

describe.skipIf(confinementUnavailable !== undefined || spawnSync("go", ["version"]).status !== 0)("a confined job's Go module cache (#171)", () => {
  const version = "v1.0.0";
  const mod = "example.com/hello";
  const saved = { ...process.env };
  let proxy: string;
  let operatorCache: string;

  const listing = (root: string): string[] => {
    const out = spawnSync("find", [root, "-mindepth", "1"], { encoding: "utf8" }).stdout.trim();
    return out === "" ? [] : out.split("\n").sort();
  };
  const sh = (cmd: string, cwd: string) => {
    const res = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  };

  beforeEach(async () => {
    // A local module proxy, so no network is needed.
    proxy = path.join(dir, "proxy");
    const vdir = path.join(proxy, mod, "@v");
    const src = path.join(dir, "src", `${mod}@${version}`);
    await mkdir(vdir, { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "go.mod"), `module ${mod}\n\ngo 1.20\n`);
    await writeFile(path.join(src, "hello.go"), 'package hello\n\nfunc Hi() string { return "hi" }\n');
    await writeFile(path.join(vdir, "list"), `${version}\n`);
    await writeFile(path.join(vdir, `${version}.info`), JSON.stringify({ Version: version, Time: "2024-01-01T00:00:00Z" }));
    await writeFile(path.join(vdir, `${version}.mod`), `module ${mod}\n\ngo 1.20\n`);
    sh(`zip -qrD ${path.join(vdir, `${version}.zip`)} example.com`, path.join(dir, "src"));
    operatorCache = path.join(dir, "operator-cache");
    await mkdir(operatorCache, { recursive: true });
    process.env.GOMODCACHE = operatorCache;
    process.env.GOSUMDB = "off";
    process.env.GOFLAGS = "-mod=mod";
    process.env.GOENV = "off";
    process.env.GOTOOLCHAIN = "local";
  });
  afterEach(() => {
    for (const name of ["GOMODCACHE", "GOSUMDB", "GOFLAGS", "GOENV", "GOPROXY", "GOTOOLCHAIN"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    // Module caches are read-only trees; the directory must be removable.
    spawnSync("chmod", ["-R", "u+w", dir]);
  });

  const confinedGo = async (script: string) => {
    const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: commandExecutorPackage, ...commandBinding({}) }],
      fallback: { runJob: async () => Promise.reject(new Error("fallback must not run")) },
      timeoutMs: 60_000,
    });
    const scratch = path.join(dir, "scratch");
    const worktree = path.join(dir, "wt");
    await mkdir(worktree, { recursive: true });
    const result = await runner.runJob(
      {
        stageId: "s",
        kind: "command",
        purpose: "work",
        instruction: "use a module",
        writeScope: ["x"],
        executor: { id: COMMAND_RUN_ID },
        input: { commands: [{ id: "go", argv: ["sh", "-c", script] }] },
      } as never,
      { runId: "r", operationId: "op-go", generation: 1, worktreePath: worktree, artifactDir: path.join(dir, "artifacts"), confinement: { scratchDir: scratch, writablePaths: [worktree] } },
    );
    const outcome = (result.evidence![0]!.payload as { command: CommandOutcome }).command;
    return { scratch, outcome };
  };

  it("downloads an uncached module into run scratch and leaves the operator's cache untouched", async () => {
    process.env.GOPROXY = pathToFileURL(proxy).href;
    const before = listing(operatorCache);
    const { scratch, outcome } = await confinedGo(`go mod download ${mod}@${version}`);
    expect(outcome.exitCode, outcome.stderrTail).toBe(0);
    expect(listing(path.join(scratch, "go", "mod")).some((p) => p.endsWith(`${mod}@${version}/hello.go`))).toBe(true);
    expect(listing(operatorCache)).toEqual(before);
  }, 60_000);

  it("copies a module the operator already cached, reading it through the operator's cache", async () => {
    process.env.GOPROXY = pathToFileURL(proxy).href;
    sh(`go mod download ${mod}@${version}`, dir);
    const before = listing(operatorCache);
    expect(before.length).toBeGreaterThan(0);
    // The real proxy is gone: only the operator's cache can supply the module.
    process.env.GOPROXY = "off";
    const { scratch, outcome } = await confinedGo(`go mod download ${mod}@${version}`);
    expect(outcome.exitCode, outcome.stderrTail).toBe(0);
    expect(listing(path.join(scratch, "go", "mod")).some((p) => p.endsWith(`${mod}@${version}/hello.go`))).toBe(true);
    expect(listing(operatorCache)).toEqual(before);
  }, 60_000);
});
