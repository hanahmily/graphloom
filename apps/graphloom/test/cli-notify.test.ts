// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRunState, saveRunState } from "@graphloom/controller";
import { afterEach, describe, expect, it } from "vitest";
import { makeCliEnv, type CliEnv } from "./cli-env.js";
import { parseRunnerConfig } from "../src/runner-config.js";
import { parseDuration } from "../src/notify.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const writer = [{ bash: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" }, { structured: { summary: "Wrote GREETING.txt." } }];
const reviewer = (verdict: string) => [{ bash: "cat GREETING.txt" }, { structured: { verdict, summary: `Reviewed: ${verdict}.` } }];
const happy = {
  byPrompt: [
    { match: "independent read-only reviewer", steps: reviewer("approved") },
    { match: "GREETING.txt", steps: writer },
  ],
};

interface HookCall {
  env: Record<string, string | undefined>;
  stdin: { runId: string; status: string };
}

/** A hook command that appends one JSON line per firing: its env and its stdin. */
function recordingHook(env: CliEnv): { command: string; calls(): Promise<HookCall[]> } {
  const log = path.join(env.dir, "hook.log");
  const script = path.join(env.dir, "hook.mjs");
  return {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(log)}`,
    async calls() {
      const raw = await readFile(log, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HookCall);
    },
  };
}

async function installHook(env: CliEnv, body = ""): Promise<ReturnType<typeof recordingHook>> {
  await writeFile(
    path.join(env.dir, "hook.mjs"),
    `import { appendFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8").on("data", (c) => { stdin += c; }).on("end", () => {
  const keys = Object.keys(process.env).filter((k) => ["GRAPHLOOM_RUN_ID", "GRAPHLOOM_STATUS", "GRAPHLOOM_STOP_REASON", "GRAPHLOOM_STOP_RETRYABLE", "GRAPHLOOM_STATE_DIR"].includes(k));
  appendFileSync(process.argv[2], JSON.stringify({ env: Object.fromEntries(keys.map((k) => [k, process.env[k]])), stdin: JSON.parse(stdin) }) + "\\n");
  ${body}
});
`,
  );
  return recordingHook(env);
}

async function addNotify(env: CliEnv, notify: unknown): Promise<void> {
  const file = env.env.GRAPHLOOM_RUNNER_CONFIG!;
  await writeFile(file, JSON.stringify({ ...(JSON.parse(await readFile(file, "utf8")) as object), notify }));
}

async function eventually<T>(read: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

/** The state dir of the run that is currently `running`. */
async function runningStateDir(env: CliEnv): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  return eventually(async () => {
    for (const name of await readdir(env.stateRoot).catch(() => [] as string[])) {
      const candidate = path.join(env.stateRoot, name);
      if ((await loadRunState(candidate).catch(() => undefined))?.status === "running") return candidate;
    }
    return undefined;
  });
}

describe("--on-stop", () => {
  it("fires once with the run's env and report on stdin when the run succeeds", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    const hook = await installHook(env);
    const run = await env.graphloom("run", "task.yaml", "--on-stop", hook.command);
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stateDir: string };
    expect(report.status).toBe("succeeded");
    expect(run.code).toBe(0);
    const calls = await hook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toEqual({
      GRAPHLOOM_RUN_ID: report.runId,
      GRAPHLOOM_STATUS: "succeeded",
      GRAPHLOOM_STOP_REASON: "complete",
      GRAPHLOOM_STOP_RETRYABLE: "",
      GRAPHLOOM_STATE_DIR: report.stateDir,
    });
    expect(calls[0]!.stdin).toMatchObject({ runId: report.runId, status: "succeeded" });
  }, 60_000);

  it("fires on a final stop (budget exhausted) with retryable false, and notify.onStop in the runner config does the same", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({
      byPrompt: [
        { match: "independent read-only reviewer", steps: reviewer("request_changes") },
        { match: "GREETING.txt", steps: writer },
      ],
    });
    const hook = await installHook(env);
    await addNotify(env, { onStop: hook.command });
    const run = await env.graphloom("run", "task.yaml");
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stopReason: string; stopRetryable: boolean };
    expect(report.status).toBe("stopped");
    expect(run.code).toBe(1);
    const calls = await hook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({
      GRAPHLOOM_RUN_ID: report.runId,
      GRAPHLOOM_STATUS: "stopped",
      GRAPHLOOM_STOP_REASON: report.stopReason,
      GRAPHLOOM_STOP_RETRYABLE: String(report.stopRetryable),
    });
    expect(report.stopRetryable).toBe(false);
  }, 60_000);

  it("fires on a retryable stop, and again once from resume with --on-stop overriding the config", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({ byPrompt: [{ match: "GREETING.txt", steps: [{ error: "agent broke" }] }] }, { timeoutMs: 20_000 });
    const configHook = await installHook(env);
    await addNotify(env, { onStop: `${configHook.command}-config` });
    const run = await env.graphloom("run", "task.yaml", "--on-stop", configHook.command);
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stopReason: string; stopRetryable?: boolean; stateDir: string };
    expect(report.status).toBe("stopped");
    expect(report.stopRetryable).toBe(true);
    let calls = await configHook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ GRAPHLOOM_STATUS: "stopped", GRAPHLOOM_STOP_RETRYABLE: "true", GRAPHLOOM_STOP_REASON: report.stopReason });

    await env.fakeClaude(happy);
    await addNotify(env, { onStop: "exit 7" });
    const resumed = await env.graphloom("resume", report.runId, "--state-root", env.stateRoot, "--on-stop", configHook.command);
    expect(JSON.parse(resumed.stdout).status).toBe("succeeded");
    calls = await configHook.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.env).toMatchObject({ GRAPHLOOM_STATUS: "succeeded", GRAPHLOOM_RUN_ID: report.runId });
  }, 90_000);

  it("stops retryable on a Claude Code session limit past the wait budget, fires the hook, opens no supervisor episode, and resume continues", async () => {
    const env = await makeCliEnv(cleanups);
    const reset = new Date(Date.now() + 3 * 3_600_000);
    reset.setUTCSeconds(0, 0);
    const clock = `${reset.getUTCHours() % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, "0")}${reset.getUTCHours() >= 12 ? "pm" : "am"}`;
    await env.fakeClaude({ byPrompt: [{ match: "GREETING.txt", steps: [{ limit: `You've hit your session limit · resets ${clock} (UTC)` }] }] });
    const hook = await installHook(env);
    const run = await env.graphloom("run", "task.yaml", "--on-stop", hook.command);
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stopReason: string; stopRetryable?: boolean; stateDir: string };
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe(`harness quota exhausted until ${reset.toISOString()}`);
    expect(report.stopRetryable).toBe(true);
    const calls = await hook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ GRAPHLOOM_STATUS: "stopped", GRAPHLOOM_STOP_RETRYABLE: "true", GRAPHLOOM_STOP_REASON: report.stopReason });
    expect((await loadRunState(report.stateDir)).supervisorEpisodes ?? []).toEqual([]);

    await env.fakeClaude(happy);
    const resumed = await env.graphloom("resume", report.runId, "--state-root", env.stateRoot);
    expect(JSON.parse(resumed.stdout).status).toBe("succeeded");
  }, 90_000);

  it("fires when another process stops the run", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({ byPrompt: [{ match: "GREETING.txt", steps: [{ hang: true }] }] });
    const hook = await installHook(env);
    const running = env.graphloom("run", "task.yaml", "--on-stop", hook.command);
    const stateDir = await runningStateDir(env);
    await env.graphloom("stop", stateDir);
    const run = await running;
    expect(JSON.parse(run.stdout).status).toBe("stopped");
    const calls = await hook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ GRAPHLOOM_STATUS: "stopped", GRAPHLOOM_STOP_REASON: "operator stop", GRAPHLOOM_STOP_RETRYABLE: "false", GRAPHLOOM_STATE_DIR: stateDir });
  }, 90_000);

  it("never changes the report or exit code when the hook fails or times out", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    const failing = await env.graphloom("run", "task.yaml", "--on-stop", "echo hook-broke >&2; exit 9");
    expect(JSON.parse(failing.stdout).status).toBe("succeeded");
    expect(failing.code).toBe(0);
    expect(failing.stderr).toContain("hook-broke");
    expect(failing.stderr).toContain("on-stop hook exited 9");

    await addNotify(env, { onStop: "sleep 30", timeoutMs: 300 });
    const slow = await env.graphloom("run", "task.yaml");
    expect(JSON.parse(slow.stdout).status).toBe("succeeded");
    expect(slow.code).toBe(0);
    expect(slow.stderr).toContain("timed out after 300ms");
  }, 90_000);

  it("fires with status crashed when the CLI dies with an error", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    const hook = await installHook(env);
    const run = await env.graphloom("resume", "no-such-run", "--state-root", env.stateRoot, "--on-stop", hook.command);
    expect(run.code).toBe(1);
    const calls = await hook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toMatchObject({ GRAPHLOOM_RUN_ID: "no-such-run", GRAPHLOOM_STATUS: "crashed" });
    expect(calls[0]!.env.GRAPHLOOM_STOP_REASON).not.toBe("");
    expect(calls[0]!.stdin.status).toBe("crashed");
  }, 60_000);

  it("fires an explicit --on-stop even when the runner config is missing or malformed", async () => {
    const env = await makeCliEnv(cleanups);
    const hook = await installHook(env);
    const missing = await env.graphloom("run", "task.yaml", "--on-stop", hook.command);
    expect(missing.code).toBe(1);
    expect((await hook.calls()).map((c) => c.env.GRAPHLOOM_STATUS)).toEqual(["crashed"]);

    await writeFile(path.join(env.dir, "bad.json"), "{ not json");
    env.env.GRAPHLOOM_RUNNER_CONFIG = path.join(env.dir, "bad.json");
    const bad = await env.graphloom("run", "task.yaml", "--on-stop", hook.command);
    expect(bad.code).toBe(1);
    const calls = await hook.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.env.GRAPHLOOM_STOP_REASON).toContain("invalid JSON");
  }, 60_000);

  it("fires the configured notify.onStop when the harness executable is unavailable", async () => {
    const env = await makeCliEnv(cleanups);
    const hook = await installHook(env);
    await writeFile(
      path.join(env.dir, "runner.json"),
      JSON.stringify({ harness: "claude-code", allowUnrestricted: true, claude: { command: "/no/such/claude" }, notify: { onStop: hook.command } }),
    );
    env.env.GRAPHLOOM_RUNNER_CONFIG = path.join(env.dir, "runner.json");
    const run = await env.graphloom("run", "task.yaml");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("was not found");
    let calls = await hook.calls();
    expect(calls.map((c) => c.env.GRAPHLOOM_STATUS)).toEqual(["crashed"]);
    expect(calls[0]!.env.GRAPHLOOM_STOP_REASON).toContain("was not found");

    const resume = await env.graphloom("resume", "nope", "--state-root", env.stateRoot);
    expect(resume.code).toBe(1);
    calls = await hook.calls();
    expect(calls.map((c) => c.env.GRAPHLOOM_RUN_ID)).toEqual(["", "nope"]);
  }, 60_000);

  it("gives a crash after the run exists its run id and state dir", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    // The supervisor is built after the run's state is durable; a model that cannot be built crashes the CLI there.
    await writeFile(path.join(env.dir, "supervisor.json"), JSON.stringify({ provider: "no-such-provider", modelId: "none", agentDir: path.join(env.dir, "agent") }));
    env.env.GRAPHLOOM_SUPERVISOR_CONFIG = path.join(env.dir, "supervisor.json");
    const hook = await installHook(env);
    const run = await env.graphloom("run", "task.yaml", "--on-stop", hook.command);
    expect(run.code).toBe(1);
    const calls = await hook.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.GRAPHLOOM_STATUS).toBe("crashed");
    const stateDir = calls[0]!.env.GRAPHLOOM_STATE_DIR!;
    expect(stateDir).toContain("graphloom-state");
    expect(path.basename(stateDir)).toBe(calls[0]!.env.GRAPHLOOM_RUN_ID);
    expect((await loadRunState(stateDir)).runId).toBe(calls[0]!.env.GRAPHLOOM_RUN_ID);
  }, 60_000);
});

describe("notify config", () => {
  it("parses notify.onStop and rejects unknown or empty settings", () => {
    const base = { harness: "claude-code", allowUnrestricted: true };
    expect(parseRunnerConfig({ ...base, notify: { onStop: "x", timeoutMs: 5 } }).notify).toEqual({ onStop: "x", timeoutMs: 5 });
    expect(() => parseRunnerConfig({ ...base, notify: { onStop: "" } })).toThrow(/notify\.onStop/);
    expect(() => parseRunnerConfig({ ...base, notify: { webhook: "x" } })).toThrow(/unsupported setting/);
  });

  it("parses durations", () => {
    expect([parseDuration("90s"), parseDuration("10m"), parseDuration("2h"), parseDuration("500ms"), parseDuration("5")]).toEqual([90_000, 600_000, 7_200_000, 500, 5_000]);
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
  });
});

describe("graphloom wait", () => {
  it("returns and prints the stats summary when another process finishes the run", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({ byPrompt: [{ match: "GREETING.txt", steps: [{ hang: true }] }] });
    const running = env.graphloom("run", "task.yaml");
    const stateDir = await runningStateDir(env);

    const timedOut = await env.graphloom("wait", stateDir, "--timeout", "1s");
    expect(timedOut.code).toBe(2);
    expect(timedOut.stderr).toContain("still running");

    const waiting = env.graphloom("wait", path.basename(stateDir), "--state-root", env.stateRoot, "--timeout", "60s");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await env.graphloom("stop", stateDir);
    await running;
    const waited = await waiting;
    expect(waited.code).toBe(0);
    expect(waited.stdout).toMatch(/^run \S+ .* stopped \(operator stop\)/m);
    const stats = await env.graphloom("stats", stateDir);
    expect(waited.stdout.split("\n")[0]).toBe(stats.stdout.split("\n")[0]);
  }, 90_000);

  it("returns at once for a finished run", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    const report = JSON.parse((await env.graphloom("run", "task.yaml")).stdout) as { stateDir: string };
    const waited = await env.graphloom("wait", report.stateDir, "--json");
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({ status: "succeeded" });
  }, 60_000);

  it("fails distinctly, not as orphaned, when the owner claim cannot be read", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    const report = JSON.parse((await env.graphloom("run", "task.yaml")).stdout) as { stateDir: string };
    await saveRunState({ ...(await loadRunState(report.stateDir)), status: "running" });
    // A directory where the claim file belongs: reading it fails with something other than ENOENT.
    await mkdir(path.join(report.stateDir, "run.owner.json"));
    const waited = await env.graphloom("wait", report.stateDir, "--timeout", "10s");
    expect(waited.code).toBe(1);
    expect(waited.stderr).toContain("cannot read owner claim");
    expect(waited.stderr).not.toContain("controller died");
  }, 60_000);

  it("reports a run whose controller died with state still running as orphaned, distinct from timeout", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(happy);
    const report = JSON.parse((await env.graphloom("run", "task.yaml")).stdout) as { stateDir: string };
    const state = await loadRunState(report.stateDir);
    await saveRunState({ ...state, status: "running" });
    // A dead controller's claim: a pid that no longer exists.
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => dead.once("close", resolve));
    await writeFile(
      path.join(report.stateDir, "run.owner.json"),
      JSON.stringify({ ownerId: "x", controllerPid: dead.pid, claimedAt: new Date().toISOString(), expiresAt: Date.now() + 60_000 }),
    );
    const waited = await env.graphloom("wait", report.stateDir, "--timeout", "60s");
    expect(waited.code).toBe(3);
    expect(waited.stderr).toContain(`controller (pid ${dead.pid}) is no longer running`);
    expect(waited.stdout).toContain("running");
  }, 60_000);
});
