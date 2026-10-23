import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readUnverifiedReads,
  REHEARSAL_ONLY_ENV,
  REHEARSAL_SCENARIO_ENV,
  resetRehearsalScenarioCache,
  type RehearsalScenario,
} from "@graphloom/sdk";
import type { ExecutorContext } from "@graphloom/sdk";
import { executors } from "./github-standin.js";

const GET_ISSUE = "graphloom.github/get-issue";

let dir: string;
let scenarioFile: string;
let ctx: ExecutorContext;

beforeEach(async () => {
  for (const name of REHEARSAL_ONLY_ENV) vi.stubEnv(name, undefined);
  resetRehearsalScenarioCache();
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-github-rehearsal-"));
  scenarioFile = path.join(dir, "scenario.json");
  ctx = { runId: "r1", operationId: "op-1", generation: 1, worktreePath: dir, artifactDir: path.join(dir, ".artifacts") };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetRehearsalScenarioCache();
  await rm(dir, { recursive: true, force: true });
});

async function withScenario(scenario: RehearsalScenario): Promise<void> {
  await writeFile(scenarioFile, JSON.stringify(scenario), "utf8");
  vi.stubEnv(REHEARSAL_SCENARIO_ENV, scenarioFile);
}

function executor(id: string) {
  const found = executors.find((e) => e.id === id);
  if (found === undefined) throw new Error(`stand-in declares no executor ${id}`);
  return found;
}

describe("github rehearsal stand-in (--offline, §4.6)", () => {
  it("refuses to run without a scenario (the seam guard)", async () => {
    await expect(executor(GET_ISSUE).execute({}, ctx)).rejects.toThrow(/refuses to impersonate/);
  });

  it("replays a recorded read instead of asking GitHub, repeating the last once exhausted", async () => {
    const first = { operation: "get-issue", query: { owner: "apache", repo: "skywalking", number: 1 }, item: { number: 1, title: "first" } };
    const second = { operation: "get-issue", query: { owner: "apache", repo: "skywalking", number: 1 }, item: { number: 1, title: "second" } };
    await withScenario({ results: {}, reads: { [GET_ISSUE]: [first, second] }, expect: { status: "succeeded" } });
    const one = (await executor(GET_ISSUE).execute({}, ctx)) as { status: string; evidence: Array<{ payload: { github: unknown } }> };
    expect(one.status).toBe("ok");
    expect(one.evidence[0]!.payload.github).toEqual(first);
    const two = (await executor(GET_ISSUE).execute({}, ctx)) as { evidence: Array<{ payload: { github: unknown } }> };
    expect(two.evidence[0]!.payload.github).toEqual(second);
    const three = (await executor(GET_ISSUE).execute({}, ctx)) as { evidence: Array<{ payload: { github: unknown } }> };
    expect(three.evidence[0]!.payload.github).toEqual(second); // repeats the last
    expect(await readUnverifiedReads(scenarioFile)).toEqual([]);
  });

  it("fails the job and records the gap when the scenario has no recorded read for this executor id — never a fabricated payload", async () => {
    await withScenario({ results: {}, expect: { status: "succeeded" } });
    const result = (await executor(GET_ISSUE).execute({}, ctx)) as { status: string; summary: string };
    expect(result.status).toBe("failed");
    expect(result.summary).toContain(GET_ISSUE);
    expect(await readUnverifiedReads(scenarioFile)).toEqual([GET_ISSUE]);
  });

  it("declares no write executor at all, regardless of the binding's own allowedEffects", () => {
    expect(executors.some((e) => e.id === "graphloom.github/create-issue-comment")).toBe(false);
    expect(executors.every((e) => e.effect === "read")).toBe(true);
  });
});
