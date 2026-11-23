// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The hub service's environment (docs/design-run-hub.md §9): what the running
 * hub reports about it (`hub status`), the doctor it runs inside it (`hub
 * doctor`), and the systemd drop-in `hub service --capture-env` derives from a
 * clean login shell. A systemd user service reads no shell profile, so its
 * runs see only what the unit gives them.
 */
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLAUDE_BIN_ENV, CODEX_BIN_ENV } from "@graphloom/executor-coding-agent";
import type { HubEnvironmentSummary, HubEnvironmentTool, HubEnvironmentVariable } from "@graphloom/sdk";
import type { DoctorReport } from "./doctor.js";
import type { HubServiceConfig } from "./hub-config.js";
import { enabledHarnesses, loadRunnerConfig, RUNNER_CONFIG_ENV, type RunnerConfig } from "./runner-config.js";
import { loadSupervisorConfig, type SupervisorConfig } from "./supervisor-config.js";
import { installRoot } from "./version.js";

const PATH_HEAD = 5;

/** The environment a hub's runs inherit: its own, with the hub config's runner and supervisor paths, as a managed launch sets them. */
export function hubRunEnvironment(env: NodeJS.ProcessEnv, config: Pick<HubServiceConfig, "runnerConfig" | "supervisorConfig">): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(config.runnerConfig !== undefined ? { [RUNNER_CONFIG_ENV]: config.runnerConfig } : {}),
    ...(config.supervisorConfig !== undefined ? { GRAPHLOOM_SUPERVISOR_CONFIG: config.supervisorConfig } : {}),
  };
}

async function resolve(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const expanded = command === "~" || command.startsWith("~/") ? path.join(env.HOME ?? os.homedir(), command.slice(1)) : command;
  const candidates = expanded.includes("/") ? [path.resolve(expanded)] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, expanded));
  for (const candidate of candidates) if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  return null;
}

/**
 * `hub status`'s environment summary, computed in the hub process: the head of
 * its `PATH`, where the harness CLIs and host tools resolve, and whether the
 * runner config's token variables and the agents' login locations are set
 * (names only). A harness the runner or supervisor config enables whose CLI
 * is not found is a warning: every run that uses it would fail.
 */
export async function summarizeHubEnvironment(env: NodeJS.ProcessEnv, config: Pick<HubServiceConfig, "runnerConfig" | "supervisorConfig">): Promise<HubEnvironmentSummary> {
  const runEnv = hubRunEnvironment(env, config);
  const errors: string[] = [];
  const runner = await loadRunnerConfig(runEnv).catch((error: unknown) => { errors.push(error instanceof Error ? error.message : String(error)); return undefined; });
  const supervisor = await loadSupervisorConfig(runEnv).catch((error: unknown) => { errors.push(error instanceof Error ? error.message : String(error)); return undefined; });
  const entries = (runEnv.PATH ?? "").split(path.delimiter).filter(Boolean);
  const needs = harnessNeeds(runner, supervisor);
  const lookups: Array<{ name: string; command: string; neededBy?: string[] }> = [
    { name: "claude", command: runner?.claude?.command ?? (runEnv[CLAUDE_BIN_ENV] || "claude"), ...(needs["claude-code"].length ? { neededBy: needs["claude-code"] } : {}) },
    { name: "codex", command: runner?.codex?.command ?? (runEnv[CODEX_BIN_ENV] || "codex"), ...(needs.codex.length ? { neededBy: needs.codex } : {}) },
    { name: "git", command: "git", neededBy: ["every run"] },
    { name: "gh", command: "gh" },
    { name: "docker", command: "docker" },
    { name: "bwrap", command: "bwrap" },
  ];
  const tools: HubEnvironmentTool[] = await Promise.all(lookups.map(async (tool) => ({ ...tool, path: await resolve(tool.command, runEnv) })));
  const variables: HubEnvironmentVariable[] = [];
  const named = (name: string | undefined, source: string) => { if (name) variables.push({ name, set: Boolean(runEnv[name]), source }); };
  named(runner?.github?.tokenEnv, "github.tokenEnv");
  named(runner?.github?.writeTokenEnv, "github.writeTokenEnv");
  named("CLAUDE_CONFIG_DIR", "Claude Code login (default ~/.claude)");
  named("CODEX_HOME", "Codex login (default ~/.codex)");
  const warnings = tools.filter((tool) => tool.path === null && tool.neededBy !== undefined)
    .map((tool) => `${tool.command} is not found on the hub's PATH, but ${tool.neededBy!.join(" and ")}: runs that use it fail (graphloom hub service --capture-env; graphloom hub doctor)`);
  return { pathHead: entries.slice(0, PATH_HEAD), pathEntries: entries.length, tools, variables, warnings, ...(errors.length ? { error: errors.join("; ").slice(0, 1024) } : {}) };
}

function harnessNeeds(runner: RunnerConfig | undefined, supervisor: SupervisorConfig | undefined): Record<"claude-code" | "codex", string[]> {
  const needs: Record<"claude-code" | "codex", string[]> = { "claude-code": [], codex: [] };
  const enabled = runner !== undefined ? enabledHarnesses(runner) : [];
  for (const harness of ["claude-code", "codex"] as const) {
    if (enabled.includes(harness)) needs[harness].push(`the runner config enables ${harness}`);
    if (supervisor?.harnesses?.includes(harness)) needs[harness].push(`the supervisor config enables ${harness}`);
  }
  return needs;
}

export interface HubDoctorResult {
  /** The doctor's exit code: 0 no check failed, 1 one did. */
  exitCode: number;
  report: DoctorReport;
}

/**
 * Runs this installation's `graphloom doctor --json [--task <file>]` as a child
 * of the hub with the hub's run environment, so it checks exactly what a run
 * would find. Never through a shell; the task path is an argument.
 */
export async function runHubDoctor(env: NodeJS.ProcessEnv, config: Pick<HubServiceConfig, "runnerConfig" | "supervisorConfig" | "directory">, taskPath?: string, timeoutMs = 180_000): Promise<HubDoctorResult> {
  const main = path.join(installRoot(), "apps", "graphloom", "dist", "main.js");
  const args = [main, "doctor", "--json", ...(taskPath !== undefined ? ["--task", taskPath] : [])];
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    execFile(process.execPath, args, { cwd: config.directory, env: hubRunEnvironment(env, config), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, out, err) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") { fail(new Error(`the hub could not run the doctor: ${error.message.slice(0, 1024)}`)); return; }
      done({ code: error ? (error as { code: number }).code : 0, stdout: out, stderr: err });
    });
  });
  let report: DoctorReport;
  try { report = JSON.parse(stdout) as DoctorReport; }
  catch { throw new Error(`the hub's doctor exited ${code} without a report: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 1024)}`); }
  if (!Array.isArray(report.checks)) throw new Error("the hub's doctor returned no checks");
  return { exitCode: report.ok ? 0 : 1, report };
}

// ---------------------------------------------------------------- hub service --capture-env

/**
 * The variables `--capture-env` keeps: `PATH`, Go's (`GOPATH`, `GOROOT`,
 * `GOTOOLCHAIN`, ...; no underscore, so never `GOOGLE_API_KEY`), the agents'
 * login locations, the locale, and the proxies. Nothing else, so no secret a
 * profile exports reaches the drop-in.
 */
export function capturedVariable(name: string): boolean {
  return /^(PATH|CLAUDE_CONFIG_DIR|CODEX_HOME|LANG|LC_ALL)$/.test(name)
    || (/^GO[A-Z0-9]*$/.test(name) && !name.startsWith("GOOGLE"))
    || /^(http|https|ftp|all|no)_proxy$/i.test(name);
}

export interface CapturedEnvironment {
  /** The kept variables, in name order. */
  variables: Array<[string, string]>;
  /** Allowlisted names left out, with why (never their values). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Splits `env -0` output after the marker; a profile's own output before it is ignored. */
export function parseCapturedEnvironment(output: string, marker = CAPTURE_MARKER): CapturedEnvironment {
  const at = output.indexOf(`\0${marker}\0`);
  if (at < 0) throw new Error("the login shell did not print its environment (no marker in its output)");
  const variables: Array<[string, string]> = [];
  const skipped: CapturedEnvironment["skipped"] = [];
  for (const entry of output.slice(at + marker.length + 2).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!capturedVariable(name)) continue;
    if (/[\n\r]/.test(value)) skipped.push({ name, reason: "its value spans lines" });
    else if (/_proxy$/i.test(name) && /:\/\/[^/@\s]*:[^/@\s]*@/.test(value)) skipped.push({ name, reason: "it holds credentials; put it in the --token-env-file instead" });
    else variables.push([name, value]);
  }
  variables.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { variables, skipped };
}

const CAPTURE_MARKER = "__graphloom_captured_environment__";

/**
 * Runs `$SHELL -l -i -c` in an otherwise empty environment (`HOME`, `USER`,
 * `LOGNAME`, `SHELL`, `TERM=dumb`), as a fresh login would, and keeps the
 * allowlisted variables it ends with. Stdin is closed; a profile that waits
 * for input times out.
 */
export async function captureLoginEnvironment(options: { shell: string; home: string; user?: string; timeoutMs?: number }): Promise<CapturedEnvironment> {
  if (!path.isAbsolute(options.shell)) throw new Error(`the login shell must be an absolute path, not ${options.shell}`);
  const env: NodeJS.ProcessEnv = { HOME: options.home, SHELL: options.shell, TERM: "dumb", ...(options.user ? { USER: options.user, LOGNAME: options.user } : {}) };
  const script = `printf '\\000%s\\000' '${CAPTURE_MARKER}'; exec env -0`;
  const output = await new Promise<string>((done, fail) => {
    const child = spawn(options.shell, ["-l", "-i", "-c", script], { cwd: options.home, env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } fail(new Error(`${options.shell} -l -i did not finish within ${options.timeoutMs ?? 20_000} ms`)); }, options.timeoutMs ?? 20_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 4 * 1024 * 1024) chunks.push(chunk); });
    child.on("error", (error) => { clearTimeout(timer); fail(new Error(`cannot start ${options.shell}: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 && !text.includes(CAPTURE_MARKER)) fail(new Error(`${options.shell} -l -i -c exited ${code}`));
      else done(text);
    });
  });
  return parseCapturedEnvironment(output);
}

/** A systemd `Environment=` assignment: the whole assignment quoted, `%` specifiers escaped. */
function assignment(name: string, value: string): string {
  return `"${`${name}=${value}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

const HEADER = [
  "# Re-run after changing the shell profile or a toolchain, or after gh auth login; then",
  "# systemctl --user daemon-reload && systemctl --user restart graphloom-hub.service",
];

/** The drop-in `graphloom-hub.service.d/environment.conf`: the variables captured from a clean login shell. */
export function environmentDropIn(options: { captured: CapturedEnvironment; shell: string; at?: Date }): string {
  return `${[
    `# Written by graphloom hub service --capture-env on ${(options.at ?? new Date()).toISOString()}, from a clean login shell of ${options.shell}.`,
    ...HEADER, "[Service]",
    ...options.captured.variables.map(([name, value]) => `Environment=${assignment(name, value)}`),
  ].join("\n")}\n`;
}

/** The drop-in `graphloom-hub.service.d/tokens.conf`: the owner-only token file, loaded when it exists. */
export function tokensDropIn(tokenEnvFile: string, at?: Date): string {
  return `${[
    `# Written by graphloom hub service --token-env-file on ${(at ?? new Date()).toISOString()}; the tokens are in that file (mode 0600), not here.`,
    ...HEADER, "[Service]", `EnvironmentFile=-${tokenEnvFile.replace(/%/g, "%%")}`,
  ].join("\n")}\n`;
}

/** Where a drop-in goes: beside the user unit graphloom-hub.service. */
export function dropInPath(name: "environment.conf" | "tokens.conf", env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME ?? os.homedir(), ".config");
  return path.join(config, "systemd", "user", "graphloom-hub.service.d", name);
}

/** Writes `file` owner-only (0600) through a temporary sibling renamed into place. */
export async function writeOwnerOnly(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  try { await chmod(temp, 0o600); await rename(temp, file); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

/** One `NAME=value` line per token for an `EnvironmentFile=`; a value systemd would split or expand is refused. */
export function tokenEnvFileText(tokens: Array<[string, string]>): string {
  for (const [name, value] of tokens) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${name} is not a variable name`);
    if (!/^[A-Za-z0-9_.\-]+$/.test(value)) throw new Error(`the value for ${name} is not a plain token`);
  }
  return `${tokens.map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}
