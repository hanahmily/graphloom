// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The hub's systemd user unit across upgrades (docs/design-run-hub.md §9.2).
 *
 * - **The launcher.** `hub service` writes an `ExecStart` that runs
 *   `<home>/current/bin/graphloom hub serve`: systemd resolves `current` when
 *   it starts the hub, and the version's own launcher then loads every module
 *   from the real path of that version, so a hub start after an install runs
 *   the new version with no new unit, and a running hub keeps the version it
 *   loaded. Never the user shim, which starts the daily update check.
 * - **The refresh** (`hub service --refresh`, which `graphloom upgrade` runs
 *   when a hub unit is installed): migrates a unit whose `ExecStart` is pinned
 *   to `versions/<v>/` of this home to the launcher, once; reloads systemd;
 *   then restarts the hub on the new version: at once when no launch runs,
 *   else by asking the hub to restart when idle (it holds new launches and,
 *   once none runs, exits 75, which the unit restarts). When systemd is not
 *   reachable, or the hub cannot take the request, it prints the command
 *   instead. It never captures the environment again: the drop-ins are the
 *   operator's.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubHealth } from "@graphloom/sdk";
import { HubHttpError, hubRequest } from "./hub-client.js";
import { hubPaths, loadHubConfig } from "./hub-config.js";
import type { HubDoctorResult } from "./hub-environment.js";
import { selfInstall, type SelfInstall } from "./ownership.js";
import { installRoot } from "./version.js";

export const HUB_UNIT = "graphloom-hub.service";
/** `hub serve`'s exit status for a requested restart when idle; the unit restarts on it (RestartForceExitStatus). */
export const HUB_RESTART_EXIT = 75;
/** `hub serve`'s exit status when the hub state's format is newer than it reads; the unit does not restart (RestartPreventExitStatus). */
export const HUB_STATE_FORMAT_EXIT = 78;

/** Where the user unit lives: `$XDG_CONFIG_HOME/systemd/user/graphloom-hub.service`. */
export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME ?? os.homedir(), ".config");
  return path.join(config, "systemd", "user", HUB_UNIT);
}

/** The version-independent launcher of an install home. */
export function hubLauncher(home: string): string {
  return path.join(home, "current", "bin", "graphloom");
}

/** A systemd command-line word: bare when plain, else quoted with `%` specifiers, backslashes, quotes and newlines escaped. */
function quote(value: string): string {
  if (/^[A-Za-z0-9_+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * The command that starts the hub: the install home's launcher when this CLI is
 * an installed version, else (a clone) this Node and this checkout's CLI, pinned.
 */
export function hubExecStart(config: string, self: SelfInstall = selfInstall()): string[] {
  const serve = ["hub", "serve", "--config", config];
  return self.home !== undefined ? [hubLauncher(self.home), ...serve] : [process.execPath, path.join(installRoot(), "apps", "graphloom", "dist", "main.js"), ...serve];
}

const RESTART_LINES = [
  `# ${HUB_RESTART_EXIT}: the hub restarts itself when idle after an upgrade; ${HUB_STATE_FORMAT_EXIT}: its state is newer than the installed GraphLoom reads.`,
  `SuccessExitStatus=${HUB_RESTART_EXIT}`,
  `RestartForceExitStatus=${HUB_RESTART_EXIT}`,
  `RestartPreventExitStatus=${HUB_STATE_FORMAT_EXIT}`,
];

/** The user unit `hub service` prints. */
export function hubServiceUnit(config: string, execStart: string[] = hubExecStart(config)): string {
  return [
    "[Unit]", "Description=GraphLoom run hub", "",
    "[Service]", "Type=exec",
    `ExecStart=${execStart.map(quote).join(" ")}`,
    "Restart=on-failure", "RestartSec=5", ...RESTART_LINES,
    "Delegate=yes", "KillMode=mixed", "TimeoutStopSec=90", "UMask=0077", "",
    "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

/** Splits a systemd command line into words: double- or single-quoted words with escapes, `%%` as `%`. */
export function execWords(line: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    let word = "";
    const q = line[i] === '"' || line[i] === "'" ? line[i++] : undefined;
    for (; i < line.length; i++) {
      const c = line[i]!;
      if (q === undefined && /\s/.test(c)) break;
      if (c === q) { i++; break; }
      if (c === "\\" && i + 1 < line.length) { const n = line[++i]!; word += n === "n" ? "\n" : n; continue; }
      if (c === "%" && line[i + 1] === "%") { word += "%"; i++; continue; }
      word += c;
    }
    words.push(word);
  }
  return words;
}

export type UnitKind = "launcher" | "pinned" | "other";
export interface UnitInspection {
  kind: UnitKind;
  /** The ExecStart words (without systemd's `-`/`@`/... prefixes). */
  words: string[];
  /** The arguments after the program (`hub serve --config ...`). */
  args: string[];
  /** The version an old-style unit is pinned to. */
  pinned?: string;
  /** Whether the unit restarts on the hub's idle-restart exit status. */
  restartsOnIdleExit: boolean;
}

/**
 * Reads a unit's `ExecStart`: this home's launcher, a command pinned to one of
 * this home's `versions/<v>/` (its Node and CLI, as `hub service` wrote it
 * before the launcher), or anything else, which is the operator's own.
 */
export function inspectUnit(text: string, home: string): UnitInspection {
  const line = text.split("\n").map((l) => l.trim()).find((l) => /^ExecStart\s*=/.test(l));
  const words = line === undefined ? [] : execWords(line.replace(/^ExecStart\s*=\s*[-@:+!]*/, ""));
  const restartsOnIdleExit = text.split("\n").some((l) => /^RestartForceExitStatus\s*=.*\b75\b/.test(l.trim()));
  const versions = `${path.join(home, "versions")}/`;
  if (words[0] === hubLauncher(home)) return { kind: "launcher", words, args: words.slice(1), restartsOnIdleExit };
  const pinnedOf = (word: string | undefined) => word?.startsWith(versions) ? word.slice(versions.length).split("/")[0] : undefined;
  const node = pinnedOf(words[0]);
  if (node !== undefined && words[0] === path.join(versions, node, "node", "bin", "node") && words[1] === path.join(versions, node, "apps", "graphloom", "dist", "main.js")) {
    return { kind: "pinned", words, args: words.slice(2), pinned: node, restartsOnIdleExit };
  }
  if (node !== undefined && words[0] === path.join(versions, node, "bin", "graphloom")) return { kind: "pinned", words, args: words.slice(1), pinned: node, restartsOnIdleExit };
  return { kind: "other", words, args: words.slice(1), restartsOnIdleExit };
}

/**
 * The unit with the launcher's `ExecStart` (the same arguments) and the restart
 * exit statuses, every other line the operator's. Unchanged text when nothing is missing.
 */
export function migrateUnit(text: string, home: string): string {
  const unit = inspectUnit(text, home);
  const lines = text.split("\n");
  if (unit.kind === "pinned") {
    const at = lines.findIndex((l) => /^\s*ExecStart\s*=/.test(l));
    lines[at] = `ExecStart=${[hubLauncher(home), ...unit.args].map(quote).join(" ")}`;
  }
  if (!unit.restartsOnIdleExit) {
    const own = new Set(RESTART_LINES.slice(1).map((l) => l.split("=")[0]));
    const kept = lines.filter((l) => !own.has(l.trim().split("=")[0]!.trim()));
    const at = kept.findIndex((l) => /^\s*ExecStart\s*=/.test(l));
    const after = kept.findIndex((l, i) => i > at && /^\s*RestartSec\s*=/.test(l));
    kept.splice((after >= 0 ? after : at) + 1, 0, ...RESTART_LINES);
    return kept.join("\n");
  }
  return lines.join("\n");
}

export interface SystemctlResult { code: number; stdout: string; stderr: string }
export type Systemctl = (args: string[]) => Promise<SystemctlResult>;

/** `systemctl --user <args>`; never through a shell. */
export const systemctlUser: Systemctl = (args) => new Promise((resolve) => {
  execFile("systemctl", ["--user", ...args], { timeout: 150_000 }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 127;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
  });
});

export interface RefreshOptions {
  env?: NodeJS.ProcessEnv;
  self?: SelfInstall;
  systemctl?: Systemctl;
  /** Lines for the operator (stderr in the CLI). */
  note?: (line: string) => void;
  /** How long to wait for the restarted hub to answer on the new version. */
  readyTimeoutMs?: number;
}

export interface RefreshResult {
  unit: "absent" | "migrated" | "current" | "other";
  restart: "none" | "already" | "now" | "when-idle" | "manual" | "not-running";
  doctor?: "pass" | "fail" | "pending";
}

const MANUAL_RESTART = `systemctl --user restart ${HUB_UNIT}`;

/**
 * `hub service --refresh` (docs/design-run-hub.md §9.2): brings an installed hub
 * unit and the hub it runs to this version, without capturing the environment.
 */
export async function refreshHubService(options: RefreshOptions = {}): Promise<RefreshResult> {
  const env = options.env ?? process.env;
  const note = options.note ?? ((line: string) => console.error(line));
  const systemctl = options.systemctl ?? systemctlUser;
  const self = options.self ?? selfInstall();
  if (self.home === undefined) throw new Error("hub service --refresh needs an installed GraphLoom (install.sh): this one is a clone, whose hub unit you manage yourself");
  const version = self.record.version;
  const file = unitPath(env);
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    note(`hub: no ${HUB_UNIT} at ${file}; nothing to refresh`);
    return { unit: "absent", restart: "none" };
  }
  const unit = inspectUnit(text, self.home);
  if (unit.kind === "other") {
    note(`hub: ${file} starts ${unit.words[0] ?? "nothing"}, not this install's launcher (${hubLauncher(self.home)}); left as it is, and not restarted (graphloom hub service prints a unit that follows upgrades)`);
    return { unit: "other", restart: "none" };
  }
  const migrated = migrateUnit(text, self.home);
  const changed = migrated !== text;
  if (changed) {
    await writeUnit(file, migrated);
    note(unit.kind === "pinned"
      ? `hub: ${file}: ExecStart pinned to GraphLoom ${unit.pinned} now runs the launcher ${hubLauncher(self.home)}, which follows current (one-time migration; your drop-ins and other lines are kept)`
      : `hub: ${file}: added the restart-when-idle exit statuses`);
  }
  const socket = await unitSocket(unit.args, env);
  const manual = (why: string): RefreshResult => {
    note(`hub: ${why}; when the hub is idle, run: ${changed ? "systemctl --user daemon-reload && " : ""}${MANUAL_RESTART} (a restart while runs are active stops them cooperatively and continues them afterwards), then graphloom hub doctor`);
    return { unit: changed ? "migrated" : "current", restart: "manual", doctor: "pending" };
  };
  const show = await systemctl(["show", "--property=ActiveState", "--property=RestartForceExitStatus", HUB_UNIT]);
  const active = /^ActiveState=(.*)$/m.exec(show.stdout)?.[1]?.trim();
  if (show.code !== 0 || active === undefined) return manual(`systemd's user manager is not reachable (${(show.stderr.trim().split("\n")[0] || `exit ${show.code}`).slice(0, 200)})`);
  if (changed) {
    const reload = await systemctl(["daemon-reload"]);
    if (reload.code !== 0) return manual(`systemctl --user daemon-reload failed (${reload.stderr.trim().split("\n")[0]?.slice(0, 200) ?? reload.code})`);
  }
  const result = (restart: RefreshResult["restart"], doctor?: RefreshResult["doctor"]): RefreshResult => ({ unit: changed ? "migrated" : "current", restart, ...(doctor !== undefined ? { doctor } : {}) });
  if (active !== "active") {
    note(`hub: ${HUB_UNIT} is ${active}; it runs GraphLoom ${version} when it starts (systemctl --user start ${HUB_UNIT})`);
    return result("not-running");
  }
  let health: HubHealth;
  try { health = await hubRequest<HubHealth>("GET", "/v1/health", undefined, socket, 10_000); }
  catch (error) { return manual(`the service is active but its hub does not answer at ${socket} (${error instanceof Error ? error.message : String(error)})`); }
  if (health.version === version) {
    note(`hub: already runs GraphLoom ${version}`);
    return result("already", await reportDoctor(socket, version, note));
  }
  const running = health.occupiedSlots;
  if (running === 0) {
    const restarted = await systemctl(["restart", HUB_UNIT]);
    if (restarted.code !== 0) return manual(`${MANUAL_RESTART} failed (${restarted.stderr.trim().split("\n")[0]?.slice(0, 200) ?? restarted.code})`);
    note(`hub: restarted (it was idle): GraphLoom ${health.version ?? "unknown"} -> ${version}`);
    return result("now", await afterRestart(socket, version, note, options.readyTimeoutMs));
  }
  // Busy: the hub restarts itself once idle, holding new launches meanwhile; the unit must restart on that exit.
  const restartsOnIdleExit = /^RestartForceExitStatus=.*\b75\b/m.test(changed ? (await systemctl(["show", "--property=RestartForceExitStatus", HUB_UNIT])).stdout : show.stdout);
  if (!restartsOnIdleExit) return manual(`${running} launch${running === 1 ? "" : "es"} running, and the loaded unit does not restart on exit ${HUB_RESTART_EXIT}`);
  try {
    await hubRequest("POST", "/v1/restart", { when: "idle", reason: `GraphLoom ${version} is installed (the hub runs ${health.version ?? "an unknown version"})` }, socket, 10_000);
  } catch (error) {
    const why = error instanceof HubHttpError && error.status === 404 ? `the hub (GraphLoom ${health.version ?? "unknown"}) does not take a restart request` : error instanceof Error ? error.message : String(error);
    return manual(`${running} launch${running === 1 ? "" : "es"} running; ${why}`);
  }
  note(`hub: ${running} launch${running === 1 ? "" : "es"} running on GraphLoom ${health.version ?? "unknown"}: the hub restarts on ${version} once ${running === 1 ? "it finishes" : "they finish"}, and starts no new launch until then (graphloom hub status shows it; ${MANUAL_RESTART} restarts it now, stopping them cooperatively)`);
  note("hub doctor: runs on the new version after the restart: graphloom hub doctor");
  return result("when-idle", "pending");
}

/** The socket of the hub the unit starts: from its `--config`, else the default. */
async function unitSocket(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const at = args.indexOf("--config");
  const config = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
  try { return (await loadHubConfig(config, env)).socket; }
  catch { return hubPaths(env).socket; }
}

/** Waits for the restarted hub to answer on `version`, then reports its doctor. */
async function afterRestart(socket: string, version: string, note: (line: string) => void, timeoutMs = 90_000): Promise<RefreshResult["doctor"]> {
  const until = Date.now() + timeoutMs;
  let seen: string | undefined;
  while (Date.now() < until) {
    try { seen = (await hubRequest<HubHealth>("GET", "/v1/health", undefined, socket, 5_000)).version; if (seen === version) return reportDoctor(socket, version, note); }
    catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  note(`hub: did not answer on GraphLoom ${version} within ${Math.round(timeoutMs / 1000)} s${seen !== undefined ? ` (it answers as ${seen})` : ""}: journalctl --user -u ${HUB_UNIT}; then graphloom hub doctor`);
  return "pending";
}

/** The new version's doctor in the hub's environment, in one line per failing check. */
async function reportDoctor(socket: string, version: string, note: (line: string) => void): Promise<RefreshResult["doctor"]> {
  try {
    const { report } = await hubRequest<HubDoctorResult>("POST", "/v1/doctor", {}, socket, 240_000);
    const fails = report.checks.filter((c) => c.status === "fail");
    const warns = report.checks.filter((c) => c.status === "warn").length;
    if (fails.length === 0) { note(`hub doctor (GraphLoom ${version}, the hub's environment): ok${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}`); return "pass"; }
    note(`hub doctor (GraphLoom ${version}, the hub's environment): ${fails.length} failed: ${fails.map((c) => `${c.name}${c.fix ? ` (fix: ${c.fix})` : ""}`).join("; ")}; graphloom hub doctor shows every check. The captured environment is yours: graphloom hub service --capture-env refreshes it`);
    return "fail";
  } catch (error) {
    note(`hub doctor: could not run (${error instanceof Error ? error.message : String(error)}); graphloom hub doctor`);
    return "pending";
  }
}

/** Writes the unit through a renamed temporary file, keeping its mode. */
async function writeUnit(file: string, text: string): Promise<void> {
  const mode = (await stat(file)).mode & 0o777;
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, "w", mode);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  try { await chmod(temp, mode); await rename(temp, file); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

/** The version `current` names in this CLI's install home, when it is an installed version. */
export function currentVersion(self: SelfInstall = selfInstall()): string | undefined {
  if (self.home === undefined) return undefined;
  try { return (JSON.parse(readFileSync(path.join(self.home, "current", "release.json"), "utf8")) as { version?: unknown }).version as string | undefined; }
  catch { return undefined; }
}
