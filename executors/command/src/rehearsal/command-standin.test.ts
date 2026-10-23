import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REHEARSAL_ONLY_ENV, REHEARSAL_SCENARIO_ENV, resetRehearsalScenarioCache, type RehearsalScenario } from "@graphloom/sdk";
import type { ExecutorContext } from "@graphloom/sdk";
import { commandSucceeded, type CommandOutcome } from "../run.js";
import { createCommandRehearsalExecutor } from "./command-standin.js";

let dir: string;
let ctx: ExecutorContext;

beforeEach(async () => {
  for (const name of REHEARSAL_ONLY_ENV) vi.stubEnv(name, undefined);
  resetRehearsalScenarioCache();
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-command-rehearsal-"));
  ctx = { runId: "r1", operationId: "op-1", generation: 1, worktreePath: dir, artifactDir: path.join(dir, ".artifacts") };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetRehearsalScenarioCache();
  await rm(dir, { recursive: true, force: true });
});

function outcomes(result: unknown): CommandOutcome[] {
  const evidence = (result as { evidence: Array<{ kind: string; payload: { command: CommandOutcome } }> }).evidence;
  expect(evidence.every((e) => e.kind === "command")).toBe(true);
  return evidence.map((e) => e.payload.command);
}

async function withScenario(scenario: RehearsalScenario): Promise<void> {
  const file = path.join(dir, "scenario.json");
  await writeFile(file, JSON.stringify(scenario), "utf8");
  vi.stubEnv(REHEARSAL_SCENARIO_ENV, file);
}

const executor = createCommandRehearsalExecutor();

describe("command rehearsal stand-in", () => {
  it("refuses to run without a scenario (the seam guard)", async () => {
    await expect(executor.execute({ commands: [{ id: "build", argv: ["make", "build"] }] }, ctx)).rejects.toThrow(/refuses to impersonate/);
  });

  it("defaults an unnamed command to a plain success, never actually running it", async () => {
    await withScenario({ results: {}, expect: { status: "succeeded" } });
    const result = await executor.execute({ commands: [{ id: "build", argv: ["false"] }] }, ctx);
    expect(outcomes(result)[0]).toMatchObject({ id: "build", exitCode: 0, stdoutTail: "", stderrTail: "" });
  });

  it("answers a named command from the scenario instead of running its real argv", async () => {
    await withScenario({
      results: {},
      commands: { "test-ci": { exitCode: 0, stdout: "ok\n" }, build: { exitCode: 1, stderr: "build failed\n" } },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { commands: [{ id: "test-ci", argv: ["false"] }, { id: "build", argv: ["false"] }], continueOnFailure: true },
      ctx,
    );
    const [testCi, build] = outcomes(result);
    expect(testCi).toMatchObject({ exitCode: 0, stdoutTail: "ok\n" });
    expect(build).toMatchObject({ exitCode: 1, stderrTail: "build failed\n" });
  });

  it("stops at the first failing command, same as the real executor, unless continueOnFailure", async () => {
    await withScenario({ results: {}, commands: { fail: { exitCode: 3 } }, expect: { status: "succeeded" } });
    const result = await executor.execute({ commands: [{ id: "fail", argv: ["false"] }, { id: "never", argv: ["false"] }] }, ctx);
    const recorded = outcomes(result);
    expect(recorded).toHaveLength(1);
    expect(commandSucceeded(recorded[0]!)).toBe(false);
  });

  it("fails a command the declared number of times before giving its real declared result (the retry-timing path)", async () => {
    await withScenario({
      results: {},
      commands: { flaky: { exitCode: 0, stdout: "done\n", failTimes: 2 } },
      expect: { status: "succeeded" },
    });
    const dispatch = () => executor.execute({ commands: [{ id: "flaky", argv: ["false"] }] }, ctx);
    const first = outcomes(await dispatch())[0]!;
    const second = outcomes(await dispatch())[0]!;
    const third = outcomes(await dispatch())[0]!;
    expect(commandSucceeded(first)).toBe(false);
    expect(commandSucceeded(second)).toBe(false);
    expect(third).toMatchObject({ exitCode: 0, stdoutTail: "done\n" });
  });
});
