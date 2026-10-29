// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom doctor` against stub agents on a stubbed PATH and HOME
 * (docs/design-release.md §4.4, phase R4): each discovery result for each
 * agent with its fix, the Pi credential by presence only, the configuration
 * checks as `run` reads them, and no secret in the output.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "../src/doctor.js";
import { STUB_SECRETS, makeDoctorEnv, realBwrap, removeDoctorBase, type DoctorEnv, type DoctorEnvOptions } from "./doctor-env.js";

afterAll(removeDoctorBase);

async function doctor(env: DoctorEnv, args: string[] = [], extra: NodeJS.ProcessEnv = {}): Promise<{ report: DoctorReport; code: number; text: string }> {
  const json = await env.run(["doctor", "--json", ...args], extra);
  const text = await env.run(["doctor", ...args], extra);
  expect(json.code, json.stderr).toBe(text.code);
  for (const secret of Object.values(STUB_SECRETS)) {
    expect(json.stdout).not.toContain(secret);
    expect(text.stdout).not.toContain(secret);
    expect(json.stderr + text.stderr).not.toContain(secret);
  }
  return { report: JSON.parse(json.stdout) as DoctorReport, code: json.code, text: text.stdout };
}

const row = (report: DoctorReport, name: string): DoctorCheck => {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no ${name} check in ${JSON.stringify(report.checks.map((c) => c.name))}`);
  return found;
};

async function withEnv(options: DoctorEnvOptions) {
  const env = await makeDoctorEnv(options);
  return { env, ...(await doctor(env)) };
}

describe("graphloom doctor: agent discovery", () => {
  it("reports every warn and fail with a fix, prints pass/warn/fail per check, and exits 0 without a fail", async () => {
    const { report, code, text } = await withEnv({ codex: "missing", gh: "missing" });
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    for (const c of report.checks) if (c.status !== "pass") expect(c.fix, c.name).toBeTruthy();
    expect(text).toMatch(/^ {2}pass {2}platform/m);
    expect(text).toMatch(/^ {2}warn {2}codex/m);
    expect(text).toMatch(/fix: npm install -g @openai\/codex/);
    // No host Node is looked for: there is no node row, and PATH has none.
    expect(report.checks.some((c) => /node/i.test(c.name))).toBe(false);
  });

  it.each([
    ["missing", "warn", /claude was not found on PATH/, /claude\.ai\/install\.sh/],
    ["badprobe", "warn", /capability probe failed: .*does not mention/, /^claude update$/],
    ["loggedout", "warn", /not logged in \(claude auth status\)/, /^claude$/],
    ["noauth", "warn", /available; login not verified/, /^claude$/],
    ["ok", "pass", /2\.1\.300 \(Claude Code\); .*capability probe passed; logged in/, undefined],
  ] as const)("Claude Code %s", async (mode, status, detail, fix) => {
    const { report } = await withEnv({ claude: mode });
    const c = row(report, "claude-code");
    expect(c.status).toBe(status);
    expect(c.detail).toMatch(detail);
    if (fix === undefined) expect(c.fix).toBeUndefined();
    else expect(c.fix).toMatch(fix);
    expect(report.available.includes("claude-code")).toBe(mode === "ok" || mode === "noauth");
  });

  it.each([
    ["missing", "warn", /codex was not found on PATH/, /npm install -g @openai\/codex/],
    ["badprobe", "warn", /capability probe failed/, /@openai\/codex@latest/],
    ["loggedout", "warn", /not logged in \(codex login status\)/, /^codex login$/],
    ["unverifiable", "warn", /available; login not verified/, /^codex login$/],
    ["ok", "pass", /codex-cli 0\.162\.1; .*logged in/, undefined],
  ] as const)("Codex %s", async (mode, status, detail, fix) => {
    const { report } = await withEnv({ codex: mode });
    const c = row(report, "codex");
    expect(c.status).toBe(status);
    expect(c.detail).toMatch(detail);
    if (fix === undefined) expect(c.fix).toBeUndefined();
    else expect(c.fix).toMatch(fix);
  });

  it("finds a Claude Code command named by GRAPHLOOM_CLAUDE_BIN or claude.command, not only on PATH", async () => {
    const env = await makeDoctorEnv({ claude: "missing" });
    const other = path.join(env.root, "tools", "my-claude");
    await mkdir(path.dirname(other), { recursive: true });
    const stub = (await makeDoctorEnv({})).bin;
    await writeFile(other, `#!/bin/sh\nexec '${path.join(stub, "claude")}' "$@"\n`);
    await chmod(other, 0o755);
    expect(row((await doctor(env, [], { GRAPHLOOM_CLAUDE_BIN: other })).report, "claude-code").status).toBe("pass");
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, claude: { command: other } }));
    const { report } = await doctor(env);
    expect(row(report, "claude-code").status).toBe("pass");
    expect(row(report, "runner config").status).toBe("pass");
  });

  it("Pi: discovers any provider's credential, built-in by Pi's own variable or custom from models.json, and a DeepSeek supervisor", async () => {
    const env = await makeDoctorEnv({});
    const agentDir = path.join(env.home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { "my-endpoint": { baseUrl: "http://127.0.0.1:9/v1", api: "anthropic-messages", apiKey: "$GL_TEST_MY_ENDPOINT_KEY", models: [{ id: "my-model" }] } } }),
    );
    await mkdir(path.dirname(env.supervisorFile), { recursive: true });
    await writeFile(env.supervisorFile, JSON.stringify({ provider: "deepseek", modelId: "deepseek-v4-pro" }));
    const keys = { DEEPSEEK_API_KEY: STUB_SECRETS.stored, GEMINI_API_KEY: STUB_SECRETS.stored, GL_TEST_MY_ENDPOINT_KEY: STUB_SECRETS.stored };
    const { report } = await doctor(env, [], keys);
    expect(row(report, "pi")).toMatchObject({ status: "pass" });
    for (const present of ["deepseek (DEEPSEEK_API_KEY)", "google (GEMINI_API_KEY)", "my-endpoint (GL_TEST_MY_ENDPOINT_KEY)", "supervisor config: deepseek/deepseek-v4-pro"]) {
      expect(row(report, "pi").detail).toContain(present);
    }
    expect(row(report, "supervisor config").status).toBe("pass");
    expect(row(report, "supervisor routes").detail).toContain("via Pi (credentials present for deepseek (DEEPSEEK_API_KEY), google (GEMINI_API_KEY), my-endpoint (GL_TEST_MY_ENDPOINT_KEY))");
    // Without its key, the DeepSeek supervisor's fix names DeepSeek's own variable.
    const without = await doctor(env, [], { GEMINI_API_KEY: STUB_SECRETS.stored });
    expect(row(without.report, "supervisor config")).toMatchObject({ status: "warn", fix: expect.stringContaining("export DEEPSEEK_API_KEY=<key>") });
  });

  it("Pi: no credential, a provider variable, and an auth store entry, by presence only", async () => {
    const none = (await withEnv({})).report;
    expect(row(none, "pi")).toMatchObject({ status: "warn", fix: expect.stringMatching(/^export the API key variable of any provider Pi supports/) });
    expect(none.available).not.toContain("pi");

    const viaEnv = (await withEnv({ piEnv: true })).report;
    expect(row(viaEnv, "pi")).toMatchObject({ status: "pass", detail: expect.stringContaining("minimax-cn (MINIMAX_CN_API_KEY)") });
    expect(viaEnv.available).toContain("pi");

    const viaStore = (await withEnv({ piStore: true })).report;
    expect(row(viaStore, "pi")).toMatchObject({ status: "pass", detail: expect.stringContaining("deepseek (auth store)") });
  });

  it("Pi: a configured pi.provider and pi.modelId must resolve in Pi's model registry", async () => {
    const env = await makeDoctorEnv({ piEnv: true });
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "no-such-model" } }));
    const { report, code } = await doctor(env);
    expect(row(report, "pi")).toMatchObject({ status: "warn", detail: expect.stringContaining("minimax-cn/no-such-model (not in Pi's model registry)") });
    // The runner config enables a harness that is not available: run would refuse, so a fail.
    expect(row(report, "runner config")).toMatchObject({ status: "fail", fix: expect.stringContaining("graphloom setup") });
    expect(code).toBe(1);
  });

  it.each([
    ["missing", /gh is not on PATH/, /gh auth login/],
    ["loggedout", /gh is not logged in/, /^gh auth login$/],
    ["noaccess", /gh cannot read hanahmily\/graphloom/, /read access/],
  ] as const)("GitHub CLI %s", async (mode, detail, fix) => {
    const { report } = await withEnv({ gh: mode });
    expect(row(report, "gh")).toMatchObject({ status: "warn", detail: expect.stringMatching(detail), fix: expect.stringMatching(fix) });
  });

  it("GitHub CLI available", async () => {
    const { report } = await withEnv({});
    expect(row(report, "gh")).toMatchObject({ status: "pass", detail: expect.stringContaining("can read hanahmily/graphloom") });
  });
});

describe("graphloom doctor: supervisor harnesses (S3)", () => {
  it("on a Claude Code-only machine, Claude Code is the viable supervisor; setup --yes writes it and doctor passes it", async () => {
    const env = await makeDoctorEnv({ codex: "missing" });
    let { report } = await doctor(env);
    expect(row(report, "supervisor")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^claude-code \(recommended: claude-code/) });
    expect(report.viable).toMatchObject({ supervisor: "claude-code", supervisors: ["claude-code"] });
    const setup = await env.run(["setup", "--yes"]);
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    ({ report } = await doctor(env));
    expect(row(report, "supervisor config")).toMatchObject({ status: "pass", detail: expect.stringContaining("(the per-harness form): claude-code;") });
  });

  it("Claude Code without its login marker fails S3's supervisor probe and does not count", async () => {
    const env = await makeDoctorEnv({ codex: "missing", claude: "noauth" });
    await (await import("node:fs/promises")).rm(path.join(env.home, ".claude", ".credentials.json"));
    const { report } = await doctor(env);
    expect(report.viable.supervisors).toEqual([]);
    expect(row(report, "supervisor")).toMatchObject({ status: "warn", detail: expect.stringContaining("claude-code: Claude Code has no login") });
  });

  it("with Pi present, Pi comes first", async () => {
    const { report } = await withEnv({ piEnv: true });
    expect(report.viable).toMatchObject({ supervisor: "pi", supervisors: ["pi", "claude-code", "codex"] });
  });
});

describe("graphloom doctor: the Codex supervisor (S4)", () => {
  it("counts Codex once its CLI, its login, and the supervisor probe pass; setup --yes writes it and doctor passes it", async () => {
    const env = await makeDoctorEnv({ claude: "missing" });
    let { report } = await doctor(env);
    expect(report.viable).toMatchObject({ supervisor: "codex", supervisors: ["codex"] });
    expect(row(report, "supervisor")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^codex \(recommended: codex/) });
    // Codex cannot write, so setup still needs a writer; Pi gives it one.
    const withPi = await makeDoctorEnv({ claude: "missing", piEnv: true });
    const setup = await withPi.run(["setup", "--yes"]);
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    ({ report } = await doctor(withPi));
    expect(report.viable).toMatchObject({ supervisor: "pi", supervisors: ["pi", "codex"] });
    expect(row(report, "supervisor config")).toMatchObject({ status: "pass", detail: expect.stringContaining("(the per-harness form): pi (minimax-cn/MiniMax-M3); codex;") });
  });

  it("does not count a Codex that is logged out or too old for the supervisor", async () => {
    const out = (await withEnv({ claude: "missing", codex: "loggedout" })).report;
    expect(out.viable.supervisors).toEqual([]);
    expect(row(out, "supervisor")).toMatchObject({ status: "warn", detail: expect.stringContaining("codex: not logged in"), fix: expect.stringContaining("Codex: codex login") });
    const old = (await withEnv({ claude: "missing", codex: "nosupervisor" })).report;
    expect(old.viable.supervisors).toEqual([]);
    expect(row(old, "supervisor").detail).toMatch(/codex: codex exec --help does not mention --ignore-user-config/);
  });
});

describe("graphloom doctor: host", () => {
  it("reuses the confinement probe: no bwrap, and one that cannot create a namespace naming the AppArmor setting", async () => {
    const missing = (await withEnv({ bwrap: "missing" })).report;
    expect(row(missing, "confinement")).toMatchObject({ status: "fail", fix: "sudo apt-get install bubblewrap" });
    // Claude Code and Codex also need confinement to count as available.
    expect(missing.available).not.toContain("claude-code");
    expect(row(missing, "claude-code").detail).toMatch(/confinement is not available/);

    const refused = await withEnv({ bwrap: "fail" });
    expect(row(refused.report, "confinement")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("kernel.apparmor_restrict_unprivileged_userns"),
      fix: expect.stringContaining("sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"),
    });
    expect(refused.code).toBe(1);
  });

  it.runIf(realBwrap !== undefined)("passes platform, git, flock, confinement, and a clone's integrity", async () => {
    const { report } = await withEnv({});
    for (const name of ["platform", "git", "flock", "confinement", "install integrity"]) expect(row(report, name).status, name).toBe("pass");
    expect(row(report, "install integrity").detail).toMatch(/a clone/);
  });
});

describe("graphloom doctor: docker sandbox", () => {
  it("warns, without failing, when the docker CLI is missing", async () => {
    const out = await withEnv({ docker: "missing" });
    expect(row(out.report, "docker")).toMatchObject({ section: "host", status: "warn", detail: expect.stringContaining("not on PATH"), fix: expect.stringContaining("rootless") });
    // An optional prerequisite: it never turns a doctor failure on.
    expect(out.report.checks.filter((c) => c.status === "fail").map((c) => c.name)).not.toContain("docker");
  });

  it("warns when the CLI cannot reach a daemon, naming why", async () => {
    const { report } = await withEnv({ docker: "nodaemon" });
    expect(row(report, "docker")).toMatchObject({ status: "warn", detail: expect.stringContaining("Cannot connect to the Docker daemon"), fix: expect.stringContaining("rootless") });
  });

  it("passes for a rootless daemon", async () => {
    const { report } = await withEnv({ docker: "rootless" });
    expect(row(report, "docker")).toMatchObject({ status: "pass", detail: expect.stringMatching(/27\.3\.1.*daemon reachable; rootless/) });
  });

  it("warns that docker-group membership is root-equivalent when the daemon is not rootless", async () => {
    const { report } = await withEnv({ docker: "rootful" });
    const docker = row(report, "docker");
    expect(docker.status).toBe("warn");
    expect(docker.detail).toMatch(/root-equivalent/);
    expect(docker.detail).toMatch(/rootless Docker is recommended/);
    expect(docker.fix).toMatch(/docs.docker.com\/engine\/security\/rootless/);
  });
});

describe("graphloom doctor: configuration", () => {
  it("a missing runner and supervisor config warn with graphloom setup; a malformed one fails as run would", async () => {
    const env = await makeDoctorEnv({});
    let { report } = await doctor(env);
    expect(row(report, "runner config")).toMatchObject({ status: "warn", fix: "graphloom setup" });
    expect(row(report, "supervisor config")).toMatchObject({ status: "warn", detail: expect.stringContaining("no automatic recovery"), fix: "graphloom setup" });

    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, apiKey: "x" }));
    await writeFile(env.supervisorFile, "{not json");
    const bad = await doctor(env);
    expect(bad.code).toBe(1);
    expect(row(bad.report, "runner config")).toMatchObject({ status: "fail", detail: expect.stringContaining("credentials must use the harness login") });
    expect(row(bad.report, "supervisor config").status).toBe("fail");

    ({ report } = await doctor(env, [], { GRAPHLOOM_RUNNER_CONFIG: path.join(env.root, "nope.json") }));
    expect(row(report, "runner config")).toMatchObject({ status: "fail", detail: expect.stringContaining("nope.json") });
  });

  it("a runner config that enables an unavailable harness fails; a supervisor whose Pi credential is missing warns", async () => {
    const env = await makeDoctorEnv({ codex: "loggedout" });
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", harnesses: ["claude-code", "codex"], allowUnrestricted: true, github: { tokenEnv: "STUB_GH_TOKEN" } }));
    await writeFile(env.supervisorFile, JSON.stringify({ provider: "minimax-cn", modelId: "MiniMax-M3" }));
    const { report, code } = await doctor(env);
    expect(code).toBe(1);
    expect(row(report, "runner config")).toMatchObject({ status: "fail", detail: expect.stringContaining("enables codex"), fix: expect.stringContaining("codex login") });
    expect(row(report, "supervisor config")).toMatchObject({ status: "warn", fix: expect.stringContaining("MINIMAX_CN_API_KEY") });
    expect(row(report, "github token")).toMatchObject({ status: "warn", fix: expect.stringContaining("export STUB_GH_TOKEN=<token>") });
    const set = await doctor(env, [], { STUB_GH_TOKEN: STUB_SECRETS.github, MINIMAX_CN_API_KEY: STUB_SECRETS.minimax });
    expect(row(set.report, "github token")).toMatchObject({ status: "pass", detail: "STUB_GH_TOKEN is set" });
    expect(row(set.report, "supervisor config").status).toBe("pass");
  });

  it("reports why automatic updates are a no-op: off by the environment, off in the runner config, and a clone", async () => {
    const env = await makeDoctorEnv({});
    expect(row((await doctor(env)).report, "updates")).toMatchObject({ status: "warn", detail: expect.stringContaining("not an installed release") });
    expect(row((await doctor(env, [], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" })).report, "updates")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("off (from GRAPHLOOM_DISABLE_AUTOUPDATE=1)"),
    });
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, autoUpdate: "off" }));
    expect(row((await doctor(env)).report, "updates")).toMatchObject({ status: "warn", detail: expect.stringContaining(`off (from ${env.runnerFile})`) });
  });
});
