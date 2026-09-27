import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeCliEnv } from "./cli-env.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const writer = [{ bash: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" }, { structured: { summary: "Wrote GREETING.txt." } }];
const reviewer = (verdict: string) => [{ bash: "cat GREETING.txt" }, { structured: { verdict, summary: `Reviewed: ${verdict}.` } }];

async function readTree(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) parts.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
  }
  return parts.join("\n");
}

describe("graphloom run with a coding agent", () => {
  it("runs hello on Claude Code at a relative path with a ten-minute job timeout, and inspect shows its receipts", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude(
      {
        byPrompt: [
          { match: "independent read-only reviewer", steps: reviewer("approved") },
          { match: "GREETING.txt", steps: writer },
        ],
      },
      { command: "./claude", timeoutMs: 600_000 },
    );

    const run = await env.graphloom("run", "task.yaml");
    const report = JSON.parse(run.stdout) as { runId: string; status: string; blocker?: string; worktreePath: string };
    expect(report.status, report.blocker ?? run.stderr).toBe("succeeded");
    expect(run.code).toBe(0);
    expect(await readFile(path.join(report.worktreePath, "GREETING.txt"), "utf8")).toBe("Hello, GraphLoom!\n");

    const inspect = JSON.parse((await env.graphloom("inspect", report.runId, "--state-root", env.stateRoot)).stdout) as {
      stages: { id: string; complete: boolean }[];
      receipts: { stageId: string; requirementId: string; validatorId: string; valid: boolean; evidenceRefs: string[] }[];
    };
    expect(inspect.stages.map((s) => [s.id, s.complete])).toEqual([
      ["write", true],
      ["review", true],
    ]);
    expect(inspect.receipts.filter((r) => r.valid).map((r) => [r.stageId, r.requirementId, r.validatorId])).toEqual([
      ["write", "greeting-bytes", "exact-greeting"],
      ["review", "independent-review", "independent-reviewer"],
    ]);

    const calls = (await readFile(env.env.FAKE_CLAUDE_LOG!, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; prompt: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toContain("Create GREETING.txt with exact UTF-8 bytes");
    expect(calls[1]!.prompt).toContain("You are an independent read-only reviewer.");
    expect(calls[1]!.prompt).toContain("read-only");
  }, 60_000);

  it("reenters Write each time the reviewer requests changes, until the run's budget runs out", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({
      byPrompt: [
        { match: "independent read-only reviewer", steps: reviewer("request_changes") },
        { match: "GREETING.txt", steps: writer },
      ],
    });
    const run = await env.graphloom("run", "task.yaml");
    const report = JSON.parse(run.stdout) as { status: string; stopReason: string; evidence: { kind: string; payload?: { verdict?: string } }[] };
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toMatch(/budget/);
    expect(run.code).toBe(1);
    const verdicts = report.evidence.filter((e) => e.kind === "review").map((e) => e.payload?.verdict);
    expect(verdicts.length).toBeGreaterThan(1);
    expect(new Set(verdicts)).toEqual(new Set(["request_changes"]));
    const prompts = (await readFile(env.env.FAKE_CLAUDE_LOG!, "utf8")).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { prompt: string }).prompt);
    expect(prompts.filter((p) => p.startsWith("Create GREETING.txt")).length).toBe(verdicts.length);
  }, 60_000);

  it("fails before the run starts when no runner is configured, Pi has no model, or Claude Code is missing", async () => {
    const env = await makeCliEnv(cleanups);
    const run = await env.graphloom("run", "task.yaml");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no agent runner configured");
    expect(existsSync(env.stateRoot)).toBe(false);
    expect(await env.git("branch", "--list", "graphloom/*")).toBe("");

    const config = path.join(env.dir, "runner.json");
    env.env.GRAPHLOOM_RUNNER_CONFIG = config;
    await writeFile(config, JSON.stringify({ harness: "pi", allowUnrestricted: true }));
    const pi = await env.graphloom("run", "task.yaml");
    expect(pi.stderr).toContain("the pi harness needs pi.provider and pi.modelId in the runner config (or GRAPHLOOM_PI_PROVIDER and GRAPHLOOM_PI_MODEL)");

    await writeFile(config, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, claude: { command: "./missing" } }));
    const missing = await env.graphloom("run", "task.yaml");
    expect(missing.stderr).toContain("Claude Code command ./missing was not found");
    const resumed = await env.graphloom("resume", "some-run");
    expect(resumed.stderr).toContain("Claude Code command ./missing was not found");
    expect(existsSync(env.stateRoot)).toBe(false);
  }, 60_000);

  it("keeps credentials out of the run's records", async () => {
    const env = await makeCliEnv(cleanups);
    const secret = "sk-ant-cli-run-secret";
    env.env.ANTHROPIC_API_KEY = secret;
    env.env.MINIMAX_CN_API_KEY = secret;
    await env.fakeClaude({
      byPrompt: [
        { match: "independent read-only reviewer", steps: reviewer("approved") },
        { match: "GREETING.txt", steps: writer },
      ],
    });
    const run = await env.graphloom("run", "task.yaml");
    const report = JSON.parse(run.stdout) as { status: string; stateDir: string };
    expect(report.status).toBe("succeeded");
    expect(run.stdout).not.toContain(secret);
    expect(await readTree(report.stateDir)).not.toContain(secret);
    const calls = await readFile(env.env.FAKE_CLAUDE_LOG!, "utf8");
    expect(calls).not.toContain(secret);
  }, 60_000);
});
