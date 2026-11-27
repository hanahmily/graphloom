// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The hub across upgrades (docs/design-run-hub.md §9.2) and the submit
 * preflight (§3.3): the version-independent launcher in the unit, the one-time
 * migration of a pinned unit, the restart after an upgrade (idle, busy,
 * systemd unreachable), the restart when idle the hub honours, the refused
 * newer state format, and the preflight's rules. Every systemctl is a stub and
 * every hub a test hub or a stub socket in a temporary directory: never the
 * operator's service, socket or install.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HubHealth, HubSubmission } from "@graphloom/sdk";
import { hubCommand, versionLines } from "../src/hub-cli.js";
import { hubRequest } from "../src/hub-client.js";
import type { DoctorCheck } from "../src/doctor.js";
import type { HubDoctorResult } from "../src/hub-environment.js";
import { preflightVerdict } from "../src/hub-preflight.js";
import { execWords, hubExecStart, hubLauncher, hubServiceUnit, inspectUnit, migrateUnit, refreshHubService, type SystemctlResult } from "../src/hub-service.js";
import type { SelfInstall } from "../src/ownership.js";
import { repoRoot } from "./cli-env.js";
import { socketEnvironment } from "./hub-test-env.js";
import { makeSandbox, realCli, removeTree, startDetached, tempBase } from "./install-env.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function invoke(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const code = await hubCommand(args);
    return { code, out: log.mock.calls.map((call) => call.join(" ")).join("\n"), err: error.mock.calls.map((call) => call.join(" ")).join("\n") };
  } finally { log.mockRestore(); error.mockRestore(); }
}

/** A stub hub on a Unix socket: health with a version and running launches, the restart request, the doctor. */
async function stubHub(socket: string, state: { version: string; occupied: number; restart?: 202 | 404; doctorFails?: boolean; upgradedWhen?: () => boolean; upgradedTo?: string }) {
  const calls: string[] = [];
  const server: Server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      const reply = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const version = state.upgradedWhen?.() === true ? state.upgradedTo! : state.version;
      if (request.url === "/v1/health") return reply(200, { hubId: "h-stub", maxConcurrentRuns: 2, occupiedSlots: version === state.version ? state.occupied : 0, submissions: [], version } satisfies HubHealth);
      if (request.url === "/v1/restart") return state.restart === 404 ? reply(404, { error: "unknown hub endpoint" }) : reply(202, { restart: { requestedAt: "now", reason: "test" }, occupiedSlots: state.occupied });
      if (request.url === "/v1/doctor") {
        const checks: DoctorCheck[] = [{ section: "host", name: "git", status: "pass", detail: "git" }, ...(state.doctorFails ? [{ section: "task" as const, name: "environment go", status: "fail" as const, detail: "go version: not found", fix: "put go on the service's PATH" }] : [])];
        return reply(200, { exitCode: state.doctorFails ? 1 : 0, report: { ok: !state.doctorFails, checks, available: [], viable: { defaultHarness: [], enable: [], supervisors: [] } } });
      }
      return reply(404, { error: "unknown hub endpoint" });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  cleanups.push(close);
  return { calls, close };
}

/** An install home with an installed GraphLoom `version`, a hub config naming `socket`, and a unit. */
async function installHome(unit: (home: string, config: string) => string, socket: string) {
  const root = await temp("gl-hubup-");
  const home = path.join(root, "share", "graphloom");
  const config = path.join(root, "config", "graphloom", "hub.json");
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ socket, directory: path.join(root, "state") }));
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_CONFIG_HOME: path.join(root, "config") };
  const unitFile = path.join(root, "config", "systemd", "user", "graphloom-hub.service");
  await mkdir(path.join(path.dirname(unitFile), "graphloom-hub.service.d"), { recursive: true });
  await writeFile(unitFile, unit(home, config));
  const dropIn = path.join(path.dirname(unitFile), "graphloom-hub.service.d", "environment.conf");
  await writeFile(dropIn, "[Service]\nEnvironment=\"PATH=/opt/go/bin:/usr/bin\"\n");
  const self: SelfInstall = { record: { version: "0.3.0", root: path.join(home, "versions", "0.3.0") }, home };
  return { root, home, config, env, unitFile, dropIn, self };
}
const pinnedUnit = (version: string) => (home: string, config: string) =>
  `[Unit]\nDescription=GraphLoom run hub\n\n[Service]\nType=exec\nExecStart="${home}/versions/${version}/node/bin/node" "${home}/versions/${version}/apps/graphloom/dist/main.js" hub serve --config "${config}"\nRestart=on-failure\nRestartSec=5\nDelegate=yes\nKillMode=mixed\nTimeoutStopSec=90\nUMask=0077\nNice=5\n\n[Install]\nWantedBy=default.target\n`;

/** A systemctl stand-in: answers `show` from the unit file (as loaded after daemon-reload), logs every call. */
function fakeSystemctl(unitFile: string, options: { reachable?: boolean; active?: string; onRestart?: () => void } = {}) {
  const calls: string[] = [];
  let loaded = readFileSync(unitFile, "utf8");
  const systemctl = async (args: string[]): Promise<SystemctlResult> => {
    calls.push(args.join(" "));
    if (options.reachable === false) return { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" };
    if (args[0] === "show") return { code: 0, stdout: `ActiveState=${options.active ?? "active"}\nRestartForceExitStatus=${/^RestartForceExitStatus=(.*)$/m.exec(loaded)?.[1] ?? ""}\n`, stderr: "" };
    if (args[0] === "daemon-reload") { loaded = readFileSync(unitFile, "utf8"); return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "restart") { options.onRestart?.(); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: `unsupported ${args.join(" ")}` };
  };
  return { calls, systemctl };
}

describe("the hub unit's launcher (§9.2)", () => {
  it("starts an installed hub through <home>/current/bin/graphloom, a clone through its own Node, and keeps the restart exit statuses", () => {
    const self: SelfInstall = { record: { version: "0.3.0", root: "/h/share/graphloom/versions/0.3.0" }, home: "/h/share/graphloom" };
    const unit = hubServiceUnit("/h/.config/graphloom/hub.json", hubExecStart("/h/.config/graphloom/hub.json", self));
    expect(unit).toContain("ExecStart=/h/share/graphloom/current/bin/graphloom hub serve --config /h/.config/graphloom/hub.json\n");
    expect(unit).not.toContain("versions/0.3.0");
    for (const line of ["SuccessExitStatus=75", "RestartForceExitStatus=75", "RestartPreventExitStatus=78", "Restart=on-failure", "Delegate=yes"]) expect(unit).toContain(`${line}\n`);
    expect(inspectUnit(unit, self.home!)).toMatchObject({ kind: "launcher", args: ["hub", "serve", "--config", "/h/.config/graphloom/hub.json"], restartsOnIdleExit: true });
    const clone = hubExecStart("/c.json", { record: { version: "0.3.0-dev", root: repoRoot } });
    expect(clone[0]).toBe(process.execPath);
    expect(clone[1]).toBe(path.join(repoRoot, "apps", "graphloom", "dist", "main.js"));
  });

  it("migrates a pinned ExecStart once, keeping its arguments and every other line, and leaves another unit alone", () => {
    const home = "/h/share/graphloom";
    const pinned = pinnedUnit("0.2.5")(home, "/h/cfg with space%.json");
    expect(inspectUnit(pinned, home)).toMatchObject({ kind: "pinned", pinned: "0.2.5", restartsOnIdleExit: false, args: ["hub", "serve", "--config", "/h/cfg with space%.json"] });
    const migrated = migrateUnit(pinned, home);
    expect(migrated).toContain(`ExecStart=${hubLauncher(home)} hub serve --config "/h/cfg with space%%.json"\n`);
    expect(migrated).toContain("Nice=5\n");
    expect(migrated.indexOf("RestartForceExitStatus=75")).toBeGreaterThan(migrated.indexOf("RestartSec=5"));
    expect(inspectUnit(migrated, home)).toMatchObject({ kind: "launcher", restartsOnIdleExit: true, args: ["hub", "serve", "--config", "/h/cfg with space%.json"] });
    expect(migrateUnit(migrated, home)).toBe(migrated);
    const other = pinned.replace(`"${home}/versions/0.2.5/node/bin/node" "${home}/versions/0.2.5/apps/graphloom/dist/main.js"`, "/opt/clone/node /opt/clone/main.js");
    expect(inspectUnit(other, home).kind).toBe("other");
    expect(execWords(`"a b" c\\"d 'e f' 50%%`)).toEqual(["a b", 'c"d', "e f", "50%"]);
  });
});

describe("hub service --refresh after an upgrade (§9.2)", () => {
  it("migrates a pinned unit, reloads systemd, restarts an idle hub at once, and reports the new version's doctor; the drop-ins are untouched", async () => {
    const socket = path.join(await temp("gl-hubsock-"), "hub.sock");
    const h = await installHome(pinnedUnit("0.2.5"), socket);
    let restarted = false;
    const hub = await stubHub(socket, { version: "0.2.5", occupied: 0, doctorFails: true, upgradedWhen: () => restarted, upgradedTo: "0.3.0" });
    const dropIn = await readFile(h.dropIn, "utf8");
    const { calls, systemctl } = fakeSystemctl(h.unitFile, { onRestart: () => { restarted = true; } });
    const notes: string[] = [];
    const result = await refreshHubService({ env: h.env, self: h.self, systemctl, note: (line) => notes.push(line), readyTimeoutMs: 5_000 });
    expect(result).toEqual({ unit: "migrated", restart: "now", doctor: "fail" });
    expect(inspectUnit(await readFile(h.unitFile, "utf8"), h.home)).toMatchObject({ kind: "launcher", restartsOnIdleExit: true });
    expect(calls).toEqual(["show --property=ActiveState --property=RestartForceExitStatus graphloom-hub.service", "daemon-reload", "restart graphloom-hub.service"]);
    expect(hub.calls).not.toContain("POST /v1/restart");
    const text = notes.join("\n");
    expect(text).toContain("ExecStart pinned to GraphLoom 0.2.5 now runs the launcher");
    expect(text).toContain("restarted (it was idle): GraphLoom 0.2.5 -> 0.3.0");
    expect(text).toMatch(/hub doctor \(GraphLoom 0\.3\.0, the hub's environment\): 1 failed: environment go \(fix: put go on the service's PATH\)/);
    // No environment is captured again: the drop-in is the operator's, and no new one appears.
    expect(await readFile(h.dropIn, "utf8")).toBe(dropIn);
    expect(existsSync(path.join(path.dirname(h.dropIn), "tokens.conf"))).toBe(false);
    // A second refresh finds nothing to migrate and the hub on the new version.
    const again = await refreshHubService({ env: h.env, self: h.self, systemctl, note: () => undefined });
    expect(again).toEqual({ unit: "current", restart: "already", doctor: "fail" });
  });

  it("asks a busy hub to restart when idle, and prints the command when the hub cannot take the request", async () => {
    const socket = path.join(await temp("gl-hubsock-"), "hub.sock");
    const h = await installHome(pinnedUnit("0.2.5"), socket);
    const hub = await stubHub(socket, { version: "0.2.5", occupied: 2 });
    const { calls, systemctl } = fakeSystemctl(h.unitFile);
    const notes: string[] = [];
    expect(await refreshHubService({ env: h.env, self: h.self, systemctl, note: (line) => notes.push(line) })).toEqual({ unit: "migrated", restart: "when-idle", doctor: "pending" });
    expect(hub.calls).toContain("POST /v1/restart");
    expect(calls).not.toContain("restart graphloom-hub.service");
    expect(notes.join("\n")).toContain("2 launches running on GraphLoom 0.2.5: the hub restarts on 0.3.0 once they finish, and starts no new launch until then");

    await hub.close();
    await stubHub(socket, { version: "0.2.5", occupied: 1, restart: 404 });
    const older: string[] = [];
    expect(await refreshHubService({ env: h.env, self: h.self, systemctl, note: (line) => older.push(line) })).toMatchObject({ unit: "current", restart: "manual" });
    expect(older.join("\n")).toMatch(/1 launch running; the hub \(GraphLoom 0\.2\.5\) does not take a restart request; when the hub is idle, run: systemctl --user restart graphloom-hub\.service/);
  });

  it("never restarts when systemd's user manager is unreachable: it migrates the unit and prints the commands", async () => {
    const socket = path.join(await temp("gl-hubsock-"), "hub.sock");
    const h = await installHome(pinnedUnit("0.2.5"), socket);
    const hub = await stubHub(socket, { version: "0.2.5", occupied: 0 });
    const { calls, systemctl } = fakeSystemctl(h.unitFile, { reachable: false });
    const notes: string[] = [];
    expect(await refreshHubService({ env: h.env, self: h.self, systemctl, note: (line) => notes.push(line) })).toEqual({ unit: "migrated", restart: "manual", doctor: "pending" });
    expect(calls).toEqual(["show --property=ActiveState --property=RestartForceExitStatus graphloom-hub.service"]);
    expect(hub.calls).toEqual([]);
    expect(notes.join("\n")).toContain("systemd's user manager is not reachable (Failed to connect to bus: No medium found); when the hub is idle, run: systemctl --user daemon-reload && systemctl --user restart graphloom-hub.service");
  });

  it("leaves a unit it did not write alone, and does nothing without a unit or with a stopped service", async () => {
    const socket = path.join(await temp("gl-hubsock-"), "hub.sock");
    const h = await installHome((_home, config) => `[Service]\nExecStart=/opt/clone/node /opt/clone/main.js hub serve --config ${config}\n`, socket);
    const before = await readFile(h.unitFile, "utf8");
    const { calls, systemctl } = fakeSystemctl(h.unitFile);
    expect(await refreshHubService({ env: h.env, self: h.self, systemctl, note: () => undefined })).toEqual({ unit: "other", restart: "none" });
    expect(await readFile(h.unitFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
    await rm(h.unitFile);
    expect(await refreshHubService({ env: h.env, self: h.self, systemctl, note: () => undefined })).toEqual({ unit: "absent", restart: "none" });
    await writeFile(h.unitFile, hubServiceUnit(h.config, hubExecStart(h.config, h.self)));
    const stopped = fakeSystemctl(h.unitFile, { active: "inactive" });
    expect(await refreshHubService({ env: h.env, self: h.self, systemctl: stopped.systemctl, note: () => undefined })).toEqual({ unit: "current", restart: "not-running" });
    expect(stopped.calls).toHaveLength(1);
  });

  it("status names the version current holds when the hub runs another", () => {
    expect(versionLines("0.2.5", "0.3.0")[0]).toContain("GraphLoom 0.3.0 is current, the hub runs 0.2.5: graphloom hub service --refresh restarts it");
    expect(versionLines("0.3.0", "0.3.0")).toEqual([]);
    expect(versionLines(undefined, "0.3.0")).toEqual([]);
  });
});

describe("a restart when idle, honoured by the hub (§9.2)", () => {
  it("holds new launches, lets the running one finish, then restarts once; a hub that cannot restart itself refuses", async () => {
    let restarts = 0;
    const { socket, service, driver } = await socketEnvironment(cleanups, 2, undefined, undefined, undefined, undefined, { onIdleRestart: () => { restarts++; } });
    const a = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml" }, socket);
    await service.hub.tick();
    expect(service.hub.inspect(a.id).state).toBe("running");
    const reply = await hubRequest<{ occupiedSlots: number; now?: boolean }>("POST", "/v1/restart", { when: "idle", reason: "GraphLoom 0.3.0 is installed" }, socket);
    expect(reply).toMatchObject({ occupiedSlots: 1 });
    expect(reply.now).toBeUndefined();
    const b = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/b.yaml" }, socket);
    await service.hub.tick();
    expect(service.hub.inspect(b.id)).toMatchObject({ state: "queued" });
    const health = await hubRequest<HubHealth>("GET", "/v1/health", undefined, socket);
    expect(health).toMatchObject({ restart: { reason: "GraphLoom 0.3.0 is installed" }, launchesHeld: "restart when idle: GraphLoom 0.3.0 is installed" });
    const status = await invoke(["status", "--socket", socket]);
    expect(status.out).toContain("Restart pending since");
    expect(status.out).toContain("no new launch starts; the service restarts once the 1 running launch finishes");
    expect(restarts).toBe(0);
    driver.complete(service.hub.inspect(a.id));
    await service.hub.tick();
    for (let i = 0; i < 40 && restarts === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restarts).toBe(1);
    expect(service.hub.inspect(b.id).launch).toBeUndefined();
    await hubRequest("POST", "/v1/restart", { when: "idle" }, socket);
    expect(restarts).toBe(1);

    const plain = await socketEnvironment(cleanups, 1);
    await expect(hubRequest("POST", "/v1/restart", { when: "idle" }, plain.socket)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("cannot restart itself") });
    await expect(hubRequest("POST", "/v1/restart", { when: "now" }, plain.socket)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to serve a hub state written in a newer format, before writing anything (exit 78)", async () => {
    const dir = await temp("gl-hubfmt-");
    const state = path.join(dir, "state");
    await mkdir(state, { mode: 0o700 });
    await chmod(state, 0o700);
    const newer = `${JSON.stringify({ schemaVersion: 2, hubId: "h-future", submissions: {} })}\n`;
    await writeFile(path.join(state, "scheduler.json"), newer);
    const config = path.join(dir, "hub.json");
    await writeFile(config, JSON.stringify({ directory: state, socket: path.join(dir, "hub.sock") }));
    const child = spawn(process.execPath, [path.join(repoRoot, "apps/graphloom/dist/main.js"), "hub", "serve", "--config", config], { env: { PATH: process.env.PATH, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(78);
    expect(stderr).toContain(`the hub state at ${state} has format 2 (scheduler.json schemaVersion), but this GraphLoom reads format 1: a newer GraphLoom wrote it. Nothing was changed.`);
    expect(await readFile(path.join(state, "scheduler.json"), "utf8")).toBe(newer);
    expect(existsSync(path.join(dir, "hub.sock"))).toBe(false);
    expect(existsSync(path.join(state, "endpoint.json"))).toBe(false);
  });
});

describe("hub submit's preflight (§3.3)", () => {
  const check = (section: DoctorCheck["section"], name: string, status: DoctorCheck["status"], fix?: string): DoctorCheck => ({ section, name, status, detail: `${name} detail`, ...(fix !== undefined ? { fix } : {}) });
  function doctorOf(checks: () => DoctorCheck[]) {
    const seen: Array<string | undefined> = [];
    const doctor = async (taskPath: string | undefined): Promise<HubDoctorResult> => {
      seen.push(taskPath);
      const list = checks();
      return { exitCode: list.some((c) => c.status === "fail") ? 1 : 0, report: { ok: !list.some((c) => c.status === "fail"), checks: list, available: [], viable: { defaultHarness: [], enable: [], supervisors: [] } } };
    };
    return { seen, doctor };
  }

  it("refuses a failing check with its fix and queues nothing; warnings pass; a pass is reused; --no-preflight skips it", async () => {
    let checks = [check("host", "git", "pass"), check("configuration", "github token", "warn", "export GH_TOKEN=<token>"), check("task", "environment go", "fail", "put go on the service's PATH")];
    const { seen, doctor } = doctorOf(() => checks);
    const { socket, service, directory } = await socketEnvironment(cleanups, 0, undefined, undefined, undefined, undefined, { doctor });
    const task = path.join(await temp("gl-preflight-"), "task.yaml");
    await writeFile(task, "graph: hello\n");
    const refused = await invoke(["submit", task, "--key", "fix-1", "--socket", socket]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("preflight refused the submission: 1 check the run needs fails in the hub's environment (nothing was queued)");
    expect(refused.err).toContain("fail  environment go: environment go detail");
    expect(refused.err).toContain("fix: put go on the service's PATH");
    expect(refused.err).toContain(`graphloom hub doctor --task ${task}`);
    expect(service.hub.list().submissions).toHaveLength(0);
    expect(seen).toEqual([task]);

    // Fixed: the failure was not remembered; the warning does not refuse.
    checks = checks.filter((c) => c.status !== "fail");
    const passed = await invoke(["submit", task, "--key", "fix-1", "--socket", socket]);
    expect(passed.code).toBe(0);
    expect(passed.err).toContain("preflight: passed in the hub's environment; warnings: github token");
    const submission = JSON.parse(passed.out) as HubSubmission & { preflight?: string };
    expect(submission.preflight).toBeUndefined();
    expect(service.hub.list().submissions).toHaveLength(1);
    // The same key is the same submission: no preflight for a retry.
    expect(JSON.parse((await invoke(["submit", task, "--key", "fix-1", "--socket", socket])).out).id).toBe(submission.id);
    expect(seen).toHaveLength(2);
    // The same task again, within the cache's time: passed without a doctor run.
    const cached = await invoke(["submit", task, "--key", "fix-2", "--socket", socket]);
    expect(cached.err).toContain("preflight: passed in the hub's environment (cached)");
    expect(seen).toHaveLength(2);
    // A changed runner config (the hub's, under its HOME) invalidates the cached pass.
    await mkdir(path.join(directory, ".config", "graphloom"), { recursive: true });
    await writeFile(path.join(directory, ".config", "graphloom", "runner.json"), "{}\n");
    const changed = await invoke(["submit", task, "--key", "fix-4", "--socket", socket]);
    expect(changed.err).not.toContain("(cached)");
    expect(seen).toHaveLength(3);

    checks = [check("task", "plugin", "fail", "graphloom check task.yaml")];
    const skipped = await invoke(["submit", task, "--key", "fix-3", "--no-preflight", "--socket", socket]);
    expect(skipped.code).toBe(0);
    expect(skipped.err).toContain("preflight: skipped (--no-preflight)");
    expect(seen).toHaveLength(3);
    expect(service.hub.list().submissions).toHaveLength(4);
  });

  it("checks for a rehearsal only what its stand-ins do not replace", async () => {
    const agentsMissing = [check("host", "git", "pass"), check("configuration", "runner config", "fail"), check("agents", "claude-code", "warn"), check("task", "plugin", "pass"), check("task", "supervisor selection", "fail"), check("task", "role writer", "fail"), check("task", "environment go", "fail", "put go on PATH")];
    const stub = preflightVerdict({ ok: false, checks: agentsMissing, available: [], viable: { defaultHarness: [], enable: [], supervisors: [] } }, { commands: "stub" });
    expect(stub.failures).toEqual([]);
    expect(stub.ignored.map((c) => c.name)).toEqual(["runner config", "supervisor selection", "role writer", "environment go"]);
    expect(preflightVerdict({ ok: false, checks: agentsMissing, available: [], viable: { defaultHarness: [], enable: [], supervisors: [] } }, { commands: "run" }).failures.map((c) => c.name)).toEqual(["environment go"]);
    expect(preflightVerdict({ ok: false, checks: agentsMissing, available: [], viable: { defaultHarness: [], enable: [], supervisors: [] } }).failures).toHaveLength(4);

    const { doctor } = doctorOf(() => agentsMissing);
    const { socket, service } = await socketEnvironment(cleanups, 0, undefined, undefined, undefined, undefined, { doctor });
    const rehearsal = await invoke(["submit", "/tasks/r.yaml", "--rehearsal", "--socket", socket]);
    expect(rehearsal.code).toBe(0);
    expect(rehearsal.err).toContain("not needed by a rehearsal: runner config, supervisor selection, role writer, environment go");
    const withCommands = await invoke(["submit", "/tasks/r.yaml", "--rehearsal", "--commands", "run", "--socket", socket]);
    expect(withCommands.code).toBe(1);
    expect(withCommands.err).toContain("preflight refused the rehearsal submission: 1 check the run needs fails");
    const real = await invoke(["submit", "/tasks/r.yaml", "--socket", socket]);
    expect(real.code).toBe(1);
    expect(real.err).toContain("4 checks the run needs fail");
    expect(service.hub.list().submissions).toHaveLength(1);
  });
});

describe("upgrade and the hub unit, in a temporary HOME (§9.2; release design §5.3)", () => {
  let base: string;
  beforeAll(async () => { base = await tempBase("gl-hubup-sb-"); });
  afterAll(async () => { await removeTree(base); });

  it("the launcher starts current, and a hub start after an install runs the new version", async () => {
    const sb = await makeSandbox(base);
    for (const v of ["0.1.0"]) expect(sb.installer(["--from", (await sb.build(v)).tarball], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).status).toBe(0);
    const [launcher, ...args] = hubExecStart("/cfg/hub.json", { record: { version: "0.1.0", root: path.join(sb.ghome, "versions", "0.1.0") }, home: sb.ghome });
    expect(launcher).toBe(path.join(sb.ghome, "current", "bin", "graphloom"));
    const start = async () => {
      const run = startDetached(launcher!, args, sb.env);
      const done = await run.done;
      expect(done.status, done.stderr).toBe(0);
      return JSON.parse(done.stdout) as { version: string; root: string; args: string[] };
    };
    expect(await start()).toMatchObject({ version: "0.1.0", root: path.join(sb.ghome, "versions", "0.1.0"), args: ["hub", "serve", "--config", "/cfg/hub.json"] });
    expect(sb.installer(["--from", (await sb.build("0.1.1")).tarball], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).status).toBe(0);
    expect(await start()).toMatchObject({ version: "0.1.1", root: path.join(sb.ghome, "versions", "0.1.1") });
  });

  it("graphloom upgrade migrates a pinned unit and restarts the idle hub with the new version's CLI; hub service then prints the launcher", async () => {
    const sb = await makeSandbox(base);
    expect(sb.installer(["--from", (await sb.build("0.1.0")).tarball], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).status).toBe(0);
    const socket = path.join(sb.root, "hub.sock");
    const config = path.join(sb.home, ".config", "graphloom", "hub.json");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({ socket, directory: path.join(sb.root, "hub-state") }));
    const unitFile = path.join(sb.home, ".config", "systemd", "user", "graphloom-hub.service");
    await mkdir(path.dirname(unitFile), { recursive: true });
    await writeFile(unitFile, pinnedUnit("0.1.0")(sb.ghome, config));
    const restartedFile = path.join(sb.root, "restarted");
    const hub = await stubHub(socket, { version: "0.1.0", occupied: 0, upgradedWhen: () => existsSync(restartedFile), upgradedTo: "0.2.0" });
    await sb.publish("0.2.0", { populate: realCli });
    const env = { ...sb.env, GRAPHLOOM_DISABLE_AUTOUPDATE: "1", FAKE_SYSTEMCTL: "up", FAKE_SYSTEMCTL_RESTARTED: restartedFile };
    const up = await startDetached(sb.shim, ["upgrade"], env).done;
    expect(up.status, up.stderr).toBe(0);
    const output = up.stdout + up.stderr;
    expect(output).toContain("current -> 0.2.0 (was 0.1.0)");
    expect(output).toContain("ExecStart pinned to GraphLoom 0.1.0 now runs the launcher");
    expect(output).toContain("restarted (it was idle): GraphLoom 0.1.0 -> 0.2.0");
    expect(output).toContain("hub doctor (GraphLoom 0.2.0, the hub's environment): ok");
    expect(inspectUnit(await readFile(unitFile, "utf8"), sb.ghome)).toMatchObject({ kind: "launcher", args: ["hub", "serve", "--config", config] });
    expect(readFileSync(path.join(sb.root, "systemctl.log"), "utf8").split("\n").filter(Boolean)).toEqual([
      "--user show --property=ActiveState --property=RestartForceExitStatus graphloom-hub.service", "--user daemon-reload", "--user restart graphloom-hub.service",
    ]);
    expect(hub.calls.filter((call) => call !== "GET /v1/health")).toEqual(["POST /v1/doctor"]);
    expect(existsSync(path.join(path.dirname(unitFile), "graphloom-hub.service.d"))).toBe(false);

    const printed = await startDetached(sb.shim, ["hub", "service"], { ...sb.env, GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).done;
    expect(printed.stdout).toContain(`ExecStart=${path.join(sb.ghome, "current", "bin", "graphloom")} hub serve --config `);
  }, 240_000);

  it("an automatic install leaves the hub alone unless the operator opted in, and an unreachable systemd is never restarted", async () => {
    const sb = await makeSandbox(base);
    expect(sb.installer(["--from", (await sb.build("0.2.0")).tarball], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).status).toBe(0);
    const unitFile = path.join(sb.home, ".config", "systemd", "user", "graphloom-hub.service");
    await mkdir(path.dirname(unitFile), { recursive: true });
    const unit = pinnedUnit("0.2.0")(sb.ghome, path.join(sb.home, "hub.json"));
    await writeFile(unitFile, unit);
    const auto = sb.installer(["--from", (await sb.build("0.2.1")).tarball, "--auto", "--allowed-signers", sb.signers], { FAKE_SYSTEMCTL: "up" });
    expect(auto.status, auto.stderr).toBe(0);
    expect(sb.current()).toBe("0.2.1");
    expect(auto.stdout).toContain("hub: keeps its version until restarted: graphloom hub service --refresh (GRAPHLOOM_HUB_RESTART_ON_AUTO_UPDATE=1 lets automatic updates do it)");
    expect(await readFile(unitFile, "utf8")).toBe(unit);
    expect(existsSync(path.join(sb.root, "systemctl.log")) ? readFileSync(path.join(sb.root, "systemctl.log"), "utf8") : "").toBe("");
    // A version without --refresh (these stub releases) is named, never run blind.
    const manual = sb.installer(["--from", (await sb.build("0.2.2")).tarball], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" });
    expect(manual.status, manual.stderr).toBe(0);
    expect(manual.stdout).toContain("hub: GraphLoom 0.2.2 cannot refresh");
  });
});
