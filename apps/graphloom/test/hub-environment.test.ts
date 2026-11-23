// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The hub service's environment (docs/design-run-hub.md §9): `hub status`'s
 * environment summary and `hub doctor`, both computed by a test hub with a
 * controlled environment (never the caller's), and `hub service
 * --capture-env` / `--token-env-file` on a fake login shell, in a temporary
 * HOME. Nothing here reads or writes the real ~/.config, ~/.claude or
 * ~/.codex, or the real hub's socket.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { HubEnvironmentSummary } from "@graphloom/sdk";
import type { DoctorReport } from "../src/doctor.js";
import { hubCommand } from "../src/hub-cli.js";
import { capturedVariable, environmentDropIn, parseCapturedEnvironment } from "../src/hub-environment.js";
import { repoRoot } from "./cli-env.js";
import { makeDoctorEnv, removeDoctorBase } from "./doctor-env.js";
import { socketEnvironment } from "./hub-test-env.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });
afterAll(removeDoctorBase);

async function invoke(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const code = await hubCommand(args);
    return { code, out: log.mock.calls.map(call => call.join(" ")).join("\n"), err: error.mock.calls.map(call => call.join(" ")).join("\n") };
  } finally { log.mockRestore(); error.mockRestore(); }
}
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function executable(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o755 });
}

describe("hub status: the hub's environment, names only", () => {
  it("reports the PATH head, where each tool resolves, which token variables are set, and warns on an enabled harness's missing CLI", async () => {
    const home = await temp("gl-hub-env-");
    const bin = path.join(home, "bin");
    await executable(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await mkdir(path.join(home, ".config", "graphloom"), { recursive: true });
    await writeFile(path.join(home, ".config", "graphloom", "runner.json"), JSON.stringify({
      harness: "claude-code", harnesses: ["claude-code", "codex"], allowUnrestricted: true, github: { tokenEnv: "GL_TEST_READ_TOKEN", writeTokenEnv: "GL_TEST_WRITE_TOKEN" },
    }));
    const secret = "ghp_hubEnvironmentSecret000000000000000";
    const { socket } = await socketEnvironment(cleanups, 2, undefined, undefined, { HOME: home, PATH: [bin, "/nonexistent-a", "/nonexistent-b", "/nonexistent-c", "/nonexistent-d", "/nonexistent-e"].join(":"), GL_TEST_READ_TOKEN: secret, CLAUDE_CONFIG_DIR: path.join(home, ".claude-x") });
    const text = await invoke(["status", "--socket", socket]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`Environment PATH: ${bin}:/nonexistent-a:/nonexistent-b:/nonexistent-c:/nonexistent-d (+1 more)`);
    expect(text.out).toContain(`Tools: claude not found · codex ${path.join(bin, "codex")} · git not found`);
    expect(text.out).toContain("Variables: GL_TEST_READ_TOKEN set (github.tokenEnv) · GL_TEST_WRITE_TOKEN unset (github.writeTokenEnv) · CLAUDE_CONFIG_DIR set");
    expect(text.out).toContain("CODEX_HOME unset");
    expect(text.out).toContain("Warning: claude is not found on the hub's PATH, but the runner config enables claude-code: runs that use it fail");
    expect(text.out).toContain("Warning: git is not found on the hub's PATH, but every run");
    expect(text.out).not.toContain("Warning: codex");
    expect(text.out).not.toContain(secret);
    const json = await invoke(["status", "--json", "--socket", socket]);
    expect(json.out).not.toContain(secret);
    const environment = (JSON.parse(json.out) as { environment: HubEnvironmentSummary }).environment;
    expect(environment).toMatchObject({ pathEntries: 6, warnings: [expect.stringContaining("claude"), expect.stringContaining("git")] });
    expect(environment.tools.find((tool) => tool.name === "claude")).toMatchObject({ path: null, neededBy: ["the runner config enables claude-code"] });
    expect(environment.variables.find((v) => v.name === "GL_TEST_READ_TOKEN")).toEqual({ name: "GL_TEST_READ_TOKEN", set: true, source: "github.tokenEnv" });
  });
});

describe("hub doctor: doctor's checks in the hub's environment", () => {
  async function hubWith(claude: "ok" | "missing") {
    const env = await makeDoctorEnv({ claude });
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", allowUnrestricted: true }));
    const { socket } = await socketEnvironment(cleanups, 1, undefined, undefined, env.env);
    return socket;
  }

  it("fails the check a tool missing from the hub's PATH fails, whatever the caller's shell has, with doctor's exit codes", async () => {
    const missing = await hubWith("missing");
    const failed = await invoke(["doctor", "--json", "--socket", missing]);
    expect(failed.code, failed.err).toBe(1);
    const report = JSON.parse(failed.out) as DoctorReport;
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "claude-code")).toMatchObject({ status: "warn", detail: expect.stringContaining("claude was not found on PATH") });
    expect(report.checks.find((c) => c.name === "runner config")).toMatchObject({ status: "fail", detail: expect.stringContaining("claude was not found") });
    const text = await invoke(["doctor", "--socket", missing]);
    expect(text.code).toBe(1);
    expect(text.out).toMatch(/^Doctor in the hub's environment \(.*\): what its runs find, not your shell/);
    expect(text.out).toMatch(/fail\s+runner config/);

    const present = await hubWith("ok");
    const passed = JSON.parse((await invoke(["doctor", "--json", "--socket", present])).out) as DoctorReport;
    expect(passed.checks.find((c) => c.name === "runner config")).toMatchObject({ status: "pass" });
    expect(passed.checks.find((c) => c.name === "claude-code")?.detail).toContain("capability probe passed");
  }, 180_000);

  it("refuses a relative task path at the endpoint and exits 1 when no hub answers", async () => {
    const down = await invoke(["doctor", "--socket", "/nonexistent-dir/hub.sock"]);
    expect(down.code).toBe(1); expect(down.err).toContain("cannot reach hub at /nonexistent-dir/hub.sock");
    const { socket } = await socketEnvironment(cleanups, 1);
    const { hubRequest } = await import("../src/hub-client.js");
    await expect(hubRequest("POST", "/v1/doctor", { taskPath: "task.yaml" }, socket)).rejects.toMatchObject({ status: 400 });
    await expect(hubRequest("POST", "/v1/doctor", { command: "rm" }, socket)).rejects.toMatchObject({ status: 400 });
  });
});

describe("hub service --capture-env and --token-env-file", () => {
  const cli = path.join(repoRoot, "apps", "graphloom", "dist", "main.js");
  function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
  /** A login shell whose "profile" prints a banner and exports a toolchain and some secrets, then runs the command it is given. */
  async function sandbox() {
    const root = await temp("gl-hub-service-");
    const home = path.join(root, "home");
    const shell = path.join(root, "fake-shell");
    const seen = path.join(root, "shell-saw.env");
    await mkdir(home, { recursive: true });
    await executable(shell, `#!/bin/sh
env > '${seen}'
echo "Welcome to the profile banner"
export PATH=/opt/go/bin:/home/u/.nvm/versions/node/v26/bin:/usr/bin:/bin
export GOPATH=/home/u/go GOTOOLCHAIN=local GOOGLE_API_KEY=secret-google OPENAI_API_KEY=sk-secret-openai
export CLAUDE_CONFIG_DIR=/home/u/.claude-work LANG=C.UTF-8 no_proxy=localhost
export HTTPS_PROXY=http://proxyuser:proxypass@proxy.example:3128
export ODD='50%% "quoted" \\\\ value'
[ "$1 $2 $3" = "-l -i -c" ] || { echo "unexpected arguments: $*" >&2; exit 9; }
exec /bin/sh -c "$4"
`);
    const stub = path.join(root, "stub-bin");
    await executable(path.join(stub, "gh"), `#!/bin/sh\n[ "$1 $2" = "auth token" ] && { echo gho_fromGhAuthToken123; exit 0; }\nexit 1\n`);
    await mkdir(path.join(home, ".config", "graphloom"), { recursive: true });
    await writeFile(path.join(home, ".config", "graphloom", "runner.json"), JSON.stringify({ harness: "claude-code", allowUnrestricted: true, github: { tokenEnv: "GL_TEST_READ_TOKEN", writeTokenEnv: "GL_TEST_WRITE_TOKEN" } }));
    const env: NodeJS.ProcessEnv = { HOME: home, SHELL: shell, PATH: `${stub}:${process.env.PATH}`, LEAK_ME: "from-the-caller", XDG_CONFIG_HOME: path.join(home, ".config"), GRAPHLOOM_DISABLE_AUTOUPDATE: "1" };
    const dir = path.join(home, ".config", "systemd", "user", "graphloom-hub.service.d");
    return { root, home, shell, seen, env, dropIn: path.join(dir, "environment.conf"), tokensDropIn: path.join(dir, "tokens.conf") };
  }

  it("prints a drop-in of the allowlisted variables from a clean login shell, names on stderr, and writes nothing without --write", async () => {
    const s = await sandbox();
    const r = await run(["hub", "service", "--capture-env"], s.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("[Service]\n");
    expect(r.stdout).toContain('Environment="PATH=/opt/go/bin:/home/u/.nvm/versions/node/v26/bin:/usr/bin:/bin"');
    expect(r.stdout).toContain('Environment="GOPATH=/home/u/go"');
    expect(r.stdout).toContain('Environment="GOTOOLCHAIN=local"');
    expect(r.stdout).toContain('Environment="CLAUDE_CONFIG_DIR=/home/u/.claude-work"');
    expect(r.stdout).toContain('Environment="LANG=C.UTF-8"');
    expect(r.stdout).toContain('Environment="no_proxy=localhost"');
    for (const leaked of ["GOOGLE_API_KEY", "secret-google", "OPENAI_API_KEY", "sk-secret-openai", "proxypass", "LEAK_ME", "banner", "EnvironmentFile"]) expect(r.stdout).not.toContain(leaked);
    expect(r.stderr).toContain(`captured from a clean login shell of ${s.shell}: CLAUDE_CONFIG_DIR, GOPATH, GOTOOLCHAIN, LANG, PATH, no_proxy`);
    expect(r.stderr).toContain("not captured: HTTPS_PROXY (it holds credentials; put it in the --token-env-file instead)");
    expect(r.stderr).not.toContain("proxypass");
    expect(r.stderr).toContain(`printed only; with --write it writes ${s.dropIn}`);
    // The shell started clean: only HOME, SHELL, TERM (and USER/LOGNAME when the caller has them).
    const seen = readFileSync(s.seen, "utf8");
    expect(seen).not.toContain("LEAK_ME"); expect(seen).toContain(`HOME=${s.home}`); expect(seen).toContain("TERM=dumb");
    expect(() => statSync(s.dropIn)).toThrow();
  });

  it("writes the drop-in and an owner-only token file with --write; the write token only with --write-token; never prints a token", async () => {
    const s = await sandbox();
    const tokens = path.join(s.home, ".config", "graphloom", "hub-tokens.env");
    const read = "ghp_readTokenFromCallerEnv000000000000";
    let r = await run(["hub", "service", "--capture-env", "--token-env-file", tokens, "--write"], { ...s.env, GL_TEST_READ_TOKEN: read });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(read);
    expect(r.stderr).toContain("token env file: GL_TEST_READ_TOKEN from your environment");
    expect(r.stderr).toContain("token env file: GL_TEST_WRITE_TOKEN (github.writeTokenEnv) left out; --write-token adds it");
    expect(r.stderr).toContain(`wrote ${tokens} (mode 0600): GL_TEST_READ_TOKEN`);
    expect(statSync(tokens).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokens, "utf8")).toBe(`GL_TEST_READ_TOKEN=${read}\n`);
    const dropIn = readFileSync(s.dropIn, "utf8");
    expect(statSync(s.dropIn).mode & 0o777).toBe(0o600);
    expect(dropIn).toContain('Environment="GOPATH=/home/u/go"');
    expect(readFileSync(s.tokensDropIn, "utf8")).toContain(`[Service]\nEnvironmentFile=-${tokens}\n`);
    for (const file of [s.dropIn, s.tokensDropIn]) expect(readFileSync(file, "utf8")).not.toContain(read);

    // Opt in to the write token; with neither variable in the caller's environment both come from gh auth token.
    r = await run(["hub", "service", "--token-env-file", tokens, "--write-token", "--write"], s.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("gho_fromGhAuthToken123");
    expect(r.stderr).toContain("token env file: GL_TEST_WRITE_TOKEN from gh auth token");
    expect(readFileSync(tokens, "utf8")).toBe("GL_TEST_READ_TOKEN=gho_fromGhAuthToken123\nGL_TEST_WRITE_TOKEN=gho_fromGhAuthToken123\n");
    // Refreshing the tokens leaves the captured environment's drop-in alone.
    expect(readFileSync(s.dropIn, "utf8")).toBe(dropIn);

    // The plain form is unchanged: the unit, nothing written.
    const unit = await run(["hub", "service"], s.env);
    expect(unit.stdout).toContain("Delegate=yes");
    expect((await run(["hub", "service", "--write"], s.env)).stderr).toContain("--write and --write-token need --capture-env or --token-env-file");
  }, 60_000);

  it("keeps only allowlisted names and escapes systemd specifiers and quotes", () => {
    for (const name of ["PATH", "GOPATH", "GOROOT", "GOTOOLCHAIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "LANG", "LC_ALL", "HTTPS_PROXY", "https_proxy", "NO_PROXY"]) expect(capturedVariable(name), name).toBe(true);
    for (const name of ["GOOGLE_API_KEY", "GOOGLEKEY", "GO_SECRET", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "HOME", "LC_CTYPE", "SSH_AUTH_SOCK"]) expect(capturedVariable(name), name).toBe(false);
    const captured = parseCapturedEnvironment("noise\0__graphloom_captured_environment__\0PATH=/a:/b\0GOFLAGS=50% \"x\" \\y\0MULTI=a\0LANG=x\ny\0");
    expect(captured.variables).toEqual([["GOFLAGS", '50% "x" \\y'], ["PATH", "/a:/b"]]);
    expect(captured.skipped).toEqual([{ name: "LANG", reason: "its value spans lines" }]);
    const text = environmentDropIn({ captured, shell: "/bin/zsh", at: new Date(0) });
    expect(text).toContain("[Service]\nEnvironment=");
    expect(text).toContain('Environment="GOFLAGS=50%% \\"x\\" \\\\y"');
    expect(() => parseCapturedEnvironment("PATH=/a\0")).toThrow(/no marker/);
  });
});
