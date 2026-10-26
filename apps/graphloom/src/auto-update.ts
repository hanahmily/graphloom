// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom __auto-update`: the detached daily update check
 * (docs/design-release.md §5.4). The shim starts it at most once a day, with
 * output appended to `update/log`. It reads `autoUpdate` from the runner
 * config, asks `gh` for the published releases, and by the policy table either
 * does nothing, writes a one-line `update/notice`, or installs a non-breaking
 * release with `install.sh --version <v> --auto`, which verifies, switches,
 * and auto-prunes under `install.lock`. Every failure is silent in the
 * foreground; it is recorded in `update/last-failure` and retried at the next
 * daily check. It never touches a run.
 */
import { spawn } from "node:child_process";
import { constants, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRunnerConfig } from "./runner-config.js";

export type AutoUpdateMode = "auto" | "notify" | "off";
export const AUTO_UPDATE_MODES: readonly AutoUpdateMode[] = ["auto", "notify", "off"];
export const DISABLE_AUTOUPDATE_ENV = "GRAPHLOOM_DISABLE_AUTOUPDATE";
export const RELEASE_REPO = "hanahmily/graphloom";
/** The release query's bound, and the whole job's. */
export const QUERY_TIMEOUT_MS = 15_000;
export const JOB_TIMEOUT_MS = 10 * 60_000;
/** install.sh's exit status when another install holds `install.lock`. */
const LOCK_BUSY = 75;

/** `$GRAPHLOOM_HOME`, otherwise `${XDG_DATA_HOME:-~/.local/share}/graphloom` (§4.1). */
export function graphloomHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GRAPHLOOM_HOME) return path.resolve(env.GRAPHLOOM_HOME);
  const data = env.XDG_DATA_HOME || path.join(env.HOME ?? os.homedir(), ".local", "share");
  return path.join(data, "graphloom");
}

type Semver = [number, number, number];

export function parseSemver(version: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === undefined || y === undefined) throw new Error(`not a MAJOR.MINOR.PATCH version: ${x === undefined ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** Breaking (§3): a new major, or before 1.0 a new minor. */
export function isBreaking(current: string, next: string): boolean {
  const [cm, cn] = parseSemver(current)!;
  const [nm, nn] = parseSemver(next)!;
  if (nm !== cm) return true;
  return cm === 0 && nn !== cn;
}

export type UpdateDecision =
  | { action: "none"; reason: string }
  | { action: "notify"; version: string; breaking: boolean }
  | { action: "install"; version: string };

/** The §5.4 policy table. `newest` is the newest published release, if any. */
export function decideUpdate(args: { mode: Exclude<AutoUpdateMode, "off">; current: string; newest?: string; skipped?: string }): UpdateDecision {
  const { current, newest, skipped } = args;
  if (newest === undefined) return { action: "none", reason: "no published release" };
  if (compareSemver(newest, current) <= 0) return { action: "none", reason: `${current} is the newest release` };
  if (skipped !== undefined && parseSemver(skipped) !== undefined && compareSemver(newest, skipped) <= 0) {
    return { action: "none", reason: `${newest} is not newer than the skipped ${skipped}` };
  }
  const breaking = isBreaking(current, newest);
  if (breaking || args.mode === "notify") return { action: "notify", version: newest, breaking };
  return { action: "install", version: newest };
}

export interface AutoUpdateOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Runs one check. Resolves to the action taken; never throws. */
export async function runAutoUpdate(options: AutoUpdateOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(`${now().toISOString()} auto-update: ${line}`));
  const home = graphloomHome(env);
  const update = path.join(home, "update");
  let version: string | undefined;
  const fail = async (reason: string) => {
    log(`failed: ${reason}`);
    await writeAtomic(path.join(update, "last-failure"), `${JSON.stringify({ ...(version !== undefined ? { version } : {}), reason, time: now().toISOString() })}\n`).catch(() => undefined);
    return "failed";
  };
  try {
    if (env[DISABLE_AUTOUPDATE_ENV] === "1") {
      log(`disabled by ${DISABLE_AUTOUPDATE_ENV}=1`);
      return "disabled";
    }
    let mode: AutoUpdateMode;
    try {
      mode = (await loadRunnerConfig(env))?.autoUpdate ?? "auto";
    } catch (err) {
      return await fail(`cannot read the runner config: ${message(err)}`);
    }
    if (mode === "off") {
      log("autoUpdate is off");
      return "off";
    }
    const currentRoot = path.join(home, "current");
    const current = installedVersion(currentRoot);
    if (current === undefined) return await fail(`no current version under ${home}`);

    const listed = await run("gh", ["release", "list", "-R", env.GRAPHLOOM_RELEASE_REPO || RELEASE_REPO, "--exclude-drafts", "--exclude-pre-releases", "--json", "tagName,isDraft,isPrerelease", "--limit", "100"], { env, timeoutMs: QUERY_TIMEOUT_MS });
    if (listed.error !== undefined) return await fail(`cannot list releases with gh: ${listed.error}`);
    if (listed.status !== 0) return await fail(`gh release list failed: ${lastLine(listed.stderr) || `exit ${listed.status}`}`);
    let newest: string | undefined;
    try {
      newest = newestRelease(JSON.parse(listed.stdout));
    } catch (err) {
      return await fail(`unreadable gh release list output: ${message(err)}`);
    }
    const skipped = readFirstLine(path.join(update, "skip"));
    const decision = decideUpdate({ mode, current, ...(newest !== undefined ? { newest } : {}), ...(skipped !== undefined ? { skipped } : {}) });
    const recordCheck = (action: string) =>
      writeAtomic(path.join(update, "last-check"), `${JSON.stringify({ time: now().toISOString(), mode, current, ...(newest !== undefined ? { newest } : {}), action })}\n`);
    if (decision.action !== "install") await recordCheck(decision.action);
    if (decision.action === "none") {
      log(`nothing to do: ${decision.reason}`);
      return "none";
    }
    version = decision.version;
    if (decision.action === "notify") {
      await writeNotice(update, decision.breaking
        ? `GraphLoom ${decision.version} is available (current ${current}). It is a breaking release, so it is not installed automatically; read its notes, then run graphloom upgrade.`
        : `GraphLoom ${decision.version} is available (current ${current}); run graphloom upgrade.`);
      log(`announced ${decision.version}${decision.breaking ? " (breaking)" : ""}`);
      return "notified";
    }
    // An unattended install requires a verified signature (§5.4): without the means to verify one, announce instead.
    const cannotVerify = !(await onPath("ssh-keygen", env.PATH ?? ""))
      ? "ssh-keygen is not installed"
      : !existsSync(path.join(currentRoot, "release", "allowed_signers"))
        ? `GraphLoom ${current} carries no release/allowed_signers`
        : undefined;
    await recordCheck(cannotVerify !== undefined ? "notify" : "install");
    if (cannotVerify !== undefined) {
      await writeNotice(update, `GraphLoom ${decision.version} is available (current ${current}), but it is not installed automatically because its signature cannot be verified (${cannotVerify}); run graphloom upgrade.`);
      log(`announced ${decision.version}: ${cannotVerify}`);
      return "notified";
    }
    const installer = path.join(currentRoot, "install.sh");
    const args = [installer, "--version", decision.version, "--auto", "--home", home];
    if (env.GRAPHLOOM_SHIM) args.push("--bin-dir", path.dirname(env.GRAPHLOOM_SHIM));
    log(`installing ${decision.version}`);
    const installed = await run("sh", args, { env, timeoutMs: JOB_TIMEOUT_MS - QUERY_TIMEOUT_MS, passthrough: log });
    if (installed.error !== undefined) return await fail(`install.sh: ${installed.error}`);
    if (installed.status === LOCK_BUSY) {
      log("another install holds install.lock; retrying at the next check");
      return "busy";
    }
    // install.sh --auto has recorded its own failure in update/last-failure.
    if (installed.status !== 0) {
      log(`install.sh --auto failed: ${lastLine(installed.stderr) || `exit ${installed.status}`}`);
      return "failed";
    }
    const now_ = installedVersion(currentRoot);
    if (now_ !== decision.version) {
      log(`current is ${now_ ?? "missing"}, not ${decision.version}; nothing switched`);
      return "none";
    }
    const older = runsOnOlderVersions(home, decision.version);
    await writeNotice(update, `GraphLoom updated to ${decision.version} (from ${current}).${older > 0 ? ` ${older} run${older === 1 ? " stays" : "s stay"} on older versions; see graphloom self list.` : ""} Undo with graphloom self rollback.`);
    log(`installed and switched to ${decision.version}`);
    return "installed";
  } catch (err) {
    return await fail(message(err));
  } finally {
    log("done");
  }
}

/** The version of the release tree `root`, from its `release.json`. */
function installedVersion(root: string): string | undefined {
  try {
    const release = JSON.parse(readFileSync(path.join(realpathSync(root), "release.json"), "utf8")) as { version?: unknown };
    return typeof release.version === "string" && parseSemver(release.version) !== undefined ? release.version : undefined;
  } catch {
    return undefined;
  }
}

/** The newest published (not draft, not prerelease) `v<MAJOR.MINOR.PATCH>` tag. */
export function newestRelease(list: unknown): string | undefined {
  if (!Array.isArray(list)) throw new Error("expected a JSON array");
  let newest: string | undefined;
  for (const entry of list as Array<{ tagName?: unknown; isDraft?: unknown; isPrerelease?: unknown }>) {
    if (entry === null || typeof entry !== "object" || entry.isDraft === true || entry.isPrerelease === true) continue;
    if (typeof entry.tagName !== "string" || !/^v\d+\.\d+\.\d+$/.test(entry.tagName)) continue;
    const v = entry.tagName.slice(1);
    if (newest === undefined || compareSemver(v, newest) > 0) newest = v;
  }
  return newest;
}

/** Runs whose ownership record (§5.1) names a version older than `version` and whose state still exists. */
function runsOnOlderVersions(home: string, version: string): number {
  const dir = path.join(home, "runs");
  let count = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const rec = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { version?: unknown; stateDir?: unknown };
      if (typeof rec.version !== "string" || typeof rec.stateDir !== "string" || parseSemver(rec.version) === undefined) continue;
      if (compareSemver(rec.version, version) < 0 && existsSync(rec.stateDir)) count++;
    } catch {
      continue;
    }
  }
  return count;
}

function readFirstLine(file: string): string | undefined {
  try {
    const line = readFileSync(file, "utf8").split("\n")[0]?.trim();
    return line ? line : undefined;
  } catch {
    return undefined;
  }
}

async function writeNotice(update: string, text: string): Promise<void> {
  await writeAtomic(path.join(update, "notice"), `graphloom: ${text}\n`);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function onPath(command: string, searchPath: string): Promise<boolean> {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    if (await access(path.join(dir, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Process groups of the children running now, killed whole on a timeout. */
const activeGroups = new Set<number>();

/** Kills every running child's process group, such as a hung `gh` under install.sh that holds `install.lock`. */
export function killActiveChildren(): void {
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  activeGroups.clear();
}

/**
 * Spawns `command` in its own process group with stdin closed, killing the
 * whole group after `timeoutMs`. `passthrough` receives its output lines.
 */
function run(command: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; passthrough?: (line: string) => void }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid !== undefined) activeGroups.add(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (opts.passthrough) for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) opts.passthrough(`  ${line}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (opts.passthrough) for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) opts.passthrough(`  ${line}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (child.pid !== undefined) activeGroups.delete(child.pid);
      resolve({ status: null, stdout, stderr, error: (err as NodeJS.ErrnoException).code === "ENOENT" ? `${command} is not installed` : err.message });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (child.pid !== undefined) activeGroups.delete(child.pid);
      resolve(timedOut ? { status, stdout, stderr, error: `timed out after ${opts.timeoutMs} ms` } : { status, stdout, stderr });
    });
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
