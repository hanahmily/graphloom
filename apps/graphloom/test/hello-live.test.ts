import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_SETUP_ENV } from "../src/runner-config.js";
import { makeCliEnv } from "./cli-env.js";

/**
 * `graphloom run` on hello against a real coding model, through the operator's
 * own setup: their HOME (the agent's login, runner and supervisor config) and
 * GRAPHLOOM_RUNNER_CONFIG when set, else Claude Code. Opt in with
 * GRAPHLOOM_HELLO_LIVE=1; it never runs in CI.
 */
const live = process.env.GRAPHLOOM_HELLO_LIVE === "1";
const OPERATOR_ENV = ["HOME", "GRAPHLOOM_SUPERVISOR_CONFIG", ...RUNNER_SETUP_ENV];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe.skipIf(!live)("graphloom run on hello with a real coding model", () => {
  it("writes and independently reviews GREETING.txt, and inspect shows both receipts", async () => {
    const env = await makeCliEnv(cleanups);
    for (const name of OPERATOR_ENV) if (process.env[name]) env.env[name] = process.env[name];
    if (!env.env.GRAPHLOOM_RUNNER_CONFIG && !existsSync(path.join(env.env.HOME!, ".config/graphloom/runner.json"))) {
      env.env.GRAPHLOOM_RUNNER_CONFIG = path.join(env.dir, "runner.json");
      await writeFile(env.env.GRAPHLOOM_RUNNER_CONFIG, JSON.stringify({ harness: "claude-code", allowUnrestricted: true }));
    }

    const run = await env.graphloom("run", "task.yaml");
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stopReason?: string; blocker?: string; worktreePath: string };
    expect(report.status, `${report.stopReason}: ${report.blocker}\n${run.stderr}`).toBe("succeeded");
    expect(await readFile(path.join(report.worktreePath, "GREETING.txt"), "utf8")).toBe("Hello, GraphLoom!\n");

    const inspect = JSON.parse((await env.graphloom("inspect", report.runId, "--state-root", env.stateRoot)).stdout) as {
      stages: { id: string; complete: boolean }[];
      receipts: { stageId: string; valid: boolean }[];
    };
    expect(inspect.stages.every((s) => s.complete)).toBe(true);
    expect(new Set(inspect.receipts.filter((r) => r.valid).map((r) => r.stageId))).toEqual(new Set(["write", "review"]));
  }, 15 * 60_000);
});
