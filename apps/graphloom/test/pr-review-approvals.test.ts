// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRunState, type OperatorApprovalPayload } from "@graphloom/controller";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createScope, createTaskWorkspace, exampleBundle, execFileAsync, goVersion, repoRoot } from "@graphloom/testkit";
import { REHEARSAL_GITHUB_TOKEN_ENV, rehearseStopAt, resumeRehearsal } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const GO = goVersion();
const bundle = exampleBundle("pr-review");
const scope = createScope();

let fixture: { REHEARSAL_REQUEST: string; REHEARSAL_HEAD_FILES: Record<string, string> };
beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-pr-review"], { cwd: repoRoot });
  fixture = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal.js")).href)) as typeof fixture;
}, 120_000);

let github: FakeGitHub | undefined;
let savedPath: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (savedPath !== undefined) process.env.PATH = savedPath;
  savedPath = undefined;
  await github?.close();
  github = undefined;
  await scope.dispose();
});

async function ready() {
  const profile = JSON.parse(await readFile(path.join(bundle, "profiles", "banyandb.json"), "utf8")) as object;
  const env = await createTaskWorkspace(scope, {
    graph: "pr-review",
    repoName: "banyandb",
    files: { "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`, ...fixture.REHEARSAL_HEAD_FILES },
    config: { name: "profile.json", value: profile },
    request: fixture.REHEARSAL_REQUEST,
    bundle,
  });
  github = await startFakeGitHub({});
  const agents = await writeFakeCodingAgents(env.dir);
  savedPath = process.env.PATH;
  process.env.PATH = `${agents.bin}:${savedPath}`;
  vi.stubEnv(GITHUB_API_URL_ENV, github.baseUrl);
  vi.stubEnv(REHEARSAL_GITHUB_TOKEN_ENV, "fake");
  const runnerConfigPath = path.join(env.dir, "runner.json");
  await writeFile(runnerConfigPath, JSON.stringify(fakeRunnerConfig(agents)));
  vi.stubEnv(RUNNER_CONFIG_ENV, runnerConfigPath);
  const supervisorConfigPath = path.join(env.dir, "supervisor.json");
  await writeFile(supervisorConfigPath, JSON.stringify({ provider: "minimax-cn", modelId: "MiniMax-M3" }));
  vi.stubEnv("GRAPHLOOM_SUPERVISOR_CONFIG", supervisorConfigPath);
  return env;
}

const approvalsOf = async (stateDir: string) =>
  (await loadRunState(stateDir)).evidence.map((e) => e.payload as OperatorApprovalPayload | undefined).filter((p) => p?.type === "operator-approval") as OperatorApprovalPayload[];

describe.skipIf(GO === undefined)("pr-review approvals: the decision half", () => {
  it("stops final at report ready after Answers; --approve review-layer is refused with the version named; --decline finishes the run as succeeded, report only, with operator-approval evidence", async () => {
    const env = await ready();
    const opts = { scenario: "happy", offline: true, commands: "stub" as const };
    const stopped = await rehearseStopAt(env.taskPath, "answers", opts);
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    const stateDir = stopped.stateDir;

    // The graph is asked what is next: the run stops, final, at "report ready".
    const ready1 = await resumeRehearsal(stateDir);
    expect(ready1.status).toBe("stopped");
    expect(ready1.stopReason).toBe("report ready");
    expect(ready1.blocker).toContain("--decline review-layer");
    // A plain resume holds a final stop: nothing it depends on changed.
    expect((await resumeRehearsal(stateDir)).stopReason).toBe("report ready");
    expect(await approvalsOf(stateDir)).toEqual([]);

    // The declared approval is data in the pinned definition.
    const state = await loadRunState(stateDir);
    expect(state.definition.approvals).toEqual([expect.objectContaining({ id: "review-layer", stageId: "review", unavailable: expect.stringContaining("no Review stage") })]);

    // Refusals record nothing and change nothing.
    const before = await readFile(path.join(stateDir, "state.json"), "utf8");
    await expect(resumeRehearsal(stateDir, { approval: { approvalId: "review-layer", decision: "approve", operator: "tester" } })).rejects.toThrow(/pr-review 0\.8\.0 has no Review stage.*--decline review-layer finishes the run as succeeded/);
    await expect(resumeRehearsal(stateDir, { approval: { approvalId: "publish-review", decision: "decline", operator: "tester" } })).rejects.toThrow(/declares no approval "publish-review"; it declares review-layer/);
    expect(await readFile(path.join(stateDir, "state.json"), "utf8")).toBe(before);
    expect(await approvalsOf(stateDir)).toEqual([]);

    // The decline lifts the final stop and ends the run as succeeded.
    const done = await resumeRehearsal(stateDir, { approval: { approvalId: "review-layer", decision: "decline", reason: "report is enough", operator: "tester" } });
    expect(done.status).toBe("succeeded");
    expect(done.stopReason).toBe("complete");
    expect(done.blocker).toContain("report only");
    const records = await approvalsOf(stateDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "operator-approval", approvalId: "review-layer", decision: "decline", reason: "report is enough", operator: "tester", files: [] });
    expect(records[0]!.generation).toBe((await loadRunState(stateDir)).generation);

    // A finished run has nothing left to decide.
    await expect(resumeRehearsal(stateDir, { approval: { approvalId: "review-layer", decision: "decline", operator: "tester" } })).rejects.toThrow(/has succeeded; there is nothing left to decline/);
  }, 240_000);
});
