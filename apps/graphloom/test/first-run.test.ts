// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom setup` and the automatic first run under a real pseudo-terminal
 * (util-linux `script`) and without one (docs/design-release.md §4.5): `run`
 * with no config completes setup and then the run; a non-interactive `run`
 * (no terminal, `--json`, or inside an `--on-stop` hook) exits 1 naming
 * `graphloom setup --yes`, and `check` reports and continues. Stub agents on
 * a stubbed PATH and HOME; no written file holds a stub credential.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NO_RUNNER_NOTE } from "../src/capability-probe.js";
import { STUB_SECRETS, makeDoctorEnv, realBwrap, removeDoctorBase, repoRoot, type DoctorEnv, type DoctorEnvOptions } from "./doctor-env.js";

afterAll(removeDoctorBase);

const HELLO_REQUEST = 'Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by one newline. Do not modify other files.';
const writer = [{ bash: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" }, { structured: { summary: "Wrote GREETING.txt." } }];
const reviewer = [{ bash: "cat GREETING.txt" }, { structured: { verdict: "approved", summary: "Reviewed: approved." } }];
const hasScript = (() => {
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The hello task beside its linked bundle, and a git repository, in the environment's directory. */
async function helloTask(env: DoctorEnv): Promise<void> {
  const repo = path.join(env.root, "test-repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env: env.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env: env.env });
  await mkdir(path.join(env.root, "plugins"));
  await symlink(path.join(repoRoot, "examples", "plugins", "hello"), path.join(env.root, "plugins", "hello"));
  await writeFile(path.join(env.root, "task.yaml"), `graph: hello\nrepo: ./test-repo\nrequest: ${JSON.stringify(HELLO_REQUEST)}\n`);
  await writeFile(env.claudeScript, JSON.stringify({ byPrompt: [{ match: "independent read-only reviewer", steps: reviewer }, { match: "GREETING.txt", steps: writer }] }));
}

function expectNoSecrets(...files: string[]): void {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const secret of Object.values(STUB_SECRETS)) expect(text, file).not.toContain(secret);
    expect(text).not.toMatch(/apiKey|token"/i);
  }
}

async function envWith(options: DoctorEnvOptions): Promise<DoctorEnv> {
  const env = await makeDoctorEnv(options);
  await helloTask(env);
  return env;
}

describe.runIf(hasScript)("under a pseudo-terminal", () => {
  it.runIf(realBwrap !== undefined)("run with no runner config completes setup, then the run", async () => {
    const env = await envWith({ codex: "missing" });
    // The Claude Code supervisor (default yes), then the consent.
    const { output, code } = await env.runTty(["run", "task.yaml"], ["", "y"]);
    expect(output).toContain(`graphloom: no runner config at ${env.runnerFile}; starting graphloom setup, then run continues.`);
    // Only Claude Code is available: no other job harness is offered; it is also the supervisor (S3).
    expect(output).not.toMatch(/Default harness \[/);
    expect(output).toContain("Enable a Claude Code supervisor (your own Claude Code login)? [Y/n]");
    expect(output).toContain("Allow coding agents to run with your user permissions? [y/N]");
    expect(output).toContain(`wrote ${env.runnerFile}`);
    expect(output).toContain("graphloom: setup done; continuing with run.");
    expect(output).toMatch(/"status": "succeeded"/);
    expect(code, output).toBe(0);
    expect(JSON.parse(readFileSync(env.runnerFile, "utf8"))).toEqual({ harness: "claude-code", allowUnrestricted: true });
    expect(statSync(env.runnerFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(env.supervisorFile, "utf8"))).toEqual({ harnesses: ["claude-code"], claude: {} });
    expect(output).not.toContain(STUB_SECRETS.email);
    expectNoSecrets(env.runnerFile);
  });

  it("run whose setup is declined continues as it would with no configuration", async () => {
    const env = await envWith({ codex: "missing" });
    const { output, code } = await env.runTty(["run", "task.yaml"], ["", "n"]);
    expect(output).toContain("Declined: setup wrote nothing.");
    expect(output).toContain("graphloom: setup did not write a runner config; run continues without one.");
    expect(output).toContain("no agent runner configured: run graphloom setup (graphloom setup --yes in scripts)");
    expect(code).toBe(1);
    expect(existsSync(env.runnerFile)).toBe(false);
  });

  it("graphloom setup asks on the terminal and writes both files without secrets", async () => {
    const env = await envWith({ piEnv: true, piStore: true });
    // Default harness, Codex, Pi, Pi provider, Pi model, Pi supervisor, Claude Code supervisor, Codex supervisor, consent.
    const { output, code } = await env.runTty(["setup"], ["", "", "", "", "", "", "", "", "y"]);
    // Nothing is configured yet, so the recommendation is the first provider with a credential, on Pi's own default model.
    expect(code, output).toBe(0);
    expect(output).toMatch(/Default harness \[claude-code\/pi\] \(recommended: claude-code\)/);
    expect(output).toMatch(/Pi provider with a credential, or new to add a custom one \[deepseek\/minimax-cn\/new\] \(recommended: deepseek\)/);
    expect(output).toMatch(/Claude: via Claude Code \(logged in\) or via Pi \(anthropic: no ANTHROPIC_API_KEY\)/);
    expect(JSON.parse(readFileSync(env.runnerFile, "utf8"))).toEqual({
      harness: "claude-code",
      allowUnrestricted: true,
      harnesses: ["claude-code", "codex", "pi"],
      pi: { provider: "deepseek", modelId: "deepseek-v4-pro" },
    });
    expect(JSON.parse(readFileSync(env.supervisorFile, "utf8"))).toEqual({ harnesses: ["pi", "claude-code", "codex"], pi: { provider: "deepseek", modelId: "deepseek-v4-pro" }, claude: {}, codex: {} });
    for (const secret of Object.values(STUB_SECRETS)) expect(output).not.toContain(secret);
    expectNoSecrets(env.runnerFile, env.supervisorFile);
    // The doctor now passes the configuration.
    const doctor = JSON.parse((await env.run(["doctor", "--json"], { MINIMAX_CN_API_KEY: STUB_SECRETS.minimax })).stdout) as { checks: Array<{ name: string; status: string }> };
    expect(doctor.checks.find((c) => c.name === "runner config")?.status).toBe("pass");
    expect(doctor.checks.find((c) => c.name === "supervisor config")?.status).toBe("pass");
  });

  it("with --json or inside an --on-stop hook, run never prompts and exits 1 naming graphloom setup --yes", async () => {
    const env = await envWith({});
    for (const [args, extra] of [[["run", "task.yaml", "--json"], {}], [["run", "task.yaml"], { GRAPHLOOM_RUN_ID: "run-1" }]] as const) {
      const { output, code } = await env.runTty([...args], [], extra);
      expect(output).not.toContain("starting graphloom setup");
      expect(output).toContain("no agent runner configured: run graphloom setup (graphloom setup --yes in scripts), or point GRAPHLOOM_RUNNER_CONFIG at a runner config");
      expect(code).toBe(1);
    }
    expect(existsSync(env.runnerFile)).toBe(false);
  });

  it("a missing file named by GRAPHLOOM_RUNNER_CONFIG is an error and never starts setup", async () => {
    const env = await envWith({});
    const { output, code } = await env.runTty(["run", "task.yaml"], [], { GRAPHLOOM_RUNNER_CONFIG: path.join(env.root, "missing.json") });
    expect(output).not.toContain("starting graphloom setup");
    expect(output).toContain("cannot read runner config");
    expect(code).toBe(1);
  });
});

describe("without a terminal", () => {
  it("run, resume, and probe exit 1 naming graphloom setup --yes", async () => {
    const env = await envWith({});
    for (const args of [["run", "task.yaml"], ["resume", "no-such-run"], ["probe", "task.yaml", "--contract", "writer-result-v1"]]) {
      const r = await env.run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("graphloom setup --yes");
      expect(r.stdout + r.stderr).not.toContain("starting graphloom setup");
    }
  });

  it("check reports the missing configuration and continues", async () => {
    const env = await envWith({});
    const r = await env.run(["check", "task.yaml"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("graphloom setup --yes");
    const report = JSON.parse(r.stdout) as { ok: boolean; capabilities: { status: string; notes: string[] } };
    expect(report.ok).toBe(true);
    expect(report.capabilities).toMatchObject({ status: "unverified", notes: [NO_RUNNER_NOTE] });
  });

  it("setup refuses to prompt; setup --yes writes the recommendations", async () => {
    const env = await envWith({ codex: "missing" });
    const refused = await env.run(["setup"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("graphloom setup --yes");
    const yes = await env.run(["setup", "--yes"]);
    expect(yes.code, yes.stdout + yes.stderr).toBe(0);
    expect(JSON.parse(readFileSync(env.runnerFile, "utf8"))).toEqual({ harness: "claude-code", allowUnrestricted: true });
    expectNoSecrets(env.runnerFile);
    // A rerun with --yes leaves it unchanged.
    const again = await env.run(["setup", "--yes"]);
    expect(again.stdout).toContain("matches the recommendation; unchanged");
  });

  it("setup --yes with no harness that can write writes nothing and exits 1", async () => {
    const env = await envWith({ claude: "loggedout" });
    const r = await env.run(["setup", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Claude Code: claude");
    expect(existsSync(env.runnerFile)).toBe(false);
  });
});
