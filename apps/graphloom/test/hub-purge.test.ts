// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `hub purge` (docs/design-run-hub.md §4.3) on a temporary hub with a synthetic
 * driver: archived submissions' run directories, worktrees, branches and ownership
 * records go; the archive entry stays, marked purged; live submissions and other
 * hubs' runs are refused. Every path is under a temporary directory.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubPurgeReport, HubStatus, HubSubmission } from "@graphloom/sdk";
import { hubCommand } from "../src/hub-cli.js";
import { hubRequest } from "../src/hub-client.js";
import { fakeInput, socketEnvironment } from "./hub-test-env.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });

async function invoke(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const code = await hubCommand(args);
    return { code, out: log.mock.calls.map((call) => call.join(" ")).join("\n"), err: error.mock.calls.map((call) => call.join(" ")).join("\n") };
  } finally { log.mockRestore(); error.mockRestore(); }
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(async () => {
    // Read-only module caches a failed test left behind must not leak the directory.
    await execFileAsync("chmod", ["-R", "u+w", dir]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function makeRepo(): Promise<string> {
  const repo = path.join(await tempDir("gl-hub-purge-repo-"), "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(path.join(repo, "README.md"), "repo\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** A hub with one repository; its submissions' runs are made by `runFor`. */
async function purgeHub(limit = 3) {
  const repo = await makeRepo();
  const home = await tempDir("gl-hub-purge-home-");
  const env = await socketEnvironment(cleanups, limit, undefined, (file) => ({ ...fakeInput(file), repoPath: repo }), undefined, undefined, { installHomes: [home] });
  // Runs left unpurged keep read-only module caches; make them removable before the hub directory goes.
  cleanups.push(async () => { await execFileAsync("chmod", ["-R", "u+w", env.directory]).catch(() => undefined); });
  return { ...env, repo, home };
}

/**
 * What a hub run leaves: state, binding, a read-only Go module cache in scratch, a
 * worktree and branch the repository records for the state directory, and the
 * installed owner's ownership record.
 */
async function runFor(hub: { directory: string; repo: string; home: string }, submission: HubSubmission, binding: { hubStateDir?: string; submissionId?: string } = {}) {
  const stateDir = path.join(hub.directory, "runs", submission.runId);
  await mkdir(stateDir, { recursive: true });
  const worktreePath = path.join(hub.repo, "graphloom", submission.runId);
  const branch = `graphloom/${submission.runId}`;
  await git(hub.repo, "worktree", "add", "-q", "-b", branch, worktreePath);
  await git(hub.repo, "config", `branch.${branch}.graphloomStateDir`, stateDir);
  const root = path.join(hub.home, "versions", "0.1.0");
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({ runId: submission.runId, status: "succeeded", intake: { repoPath: hub.repo, pinnedHead: await git(hub.repo, "rev-parse", "HEAD") }, worktreePath, worktreeBranch: branch, install: { version: "0.1.0", root } }));
  await writeFile(path.join(stateDir, "managed-run.json"), JSON.stringify({ protocolVersion: 1, hubId: "h-test", hubStateDir: binding.hubStateDir ?? hub.directory, submissionId: binding.submissionId ?? submission.id, runId: submission.runId, generation: 1, launchId: "l-test" }));
  await writeFile(path.join(stateDir, "agent-session.jsonl"), "x".repeat(64 * 1024));
  const cache = path.join(stateDir, "scratch", "go", "mod", "example.com", "m@v1.0.0");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "go.mod"), "module example.com/m\n");
  await chmod(cache, 0o555);
  await chmod(path.dirname(cache), 0o555);
  await mkdir(path.join(hub.home, "runs"), { recursive: true });
  const record = path.join(hub.home, "runs", `${submission.runId}.json`);
  await writeFile(record, JSON.stringify({ version: "0.1.0", stateDir, plugin: path.join(hub.directory, "submissions", submission.id, "plugins", "hello") }));
  return { stateDir, worktreePath, branch, record };
}

async function finishedAndArchived(hub: Awaited<ReturnType<typeof purgeHub>>, key: string, body: Record<string, unknown> = {}): Promise<HubSubmission> {
  const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: `/tasks/${key}.yaml`, key, ...body }, hub.socket);
  await hub.service.hub.tick();
  hub.driver.complete(hub.service.hub.inspect(item.id));
  await hub.service.hub.tick();
  expect(hub.service.hub.inspect(item.id).state).toBe("succeeded");
  await hubRequest("POST", `/v1/submissions/${item.id}/archive`, {}, hub.socket);
  return item;
}

const purge = (socket: string, id: string, body: Record<string, unknown> = {}) => hubRequest<HubPurgeReport>("POST", `/v1/submissions/${encodeURIComponent(id)}/purge`, body, socket);

describe("hub purge", () => {
  it("removes an archived run's directory, worktree, branch and ownership record, and keeps its entry marked purged", async () => {
    const hub = await purgeHub();
    const item = await finishedAndArchived(hub, "fix-widgets-1");
    const run = await runFor(hub, item);

    const dry = await purge(hub.socket, item.id, { dryRun: true });
    expect(dry).toMatchObject({ id: item.id, runId: item.runId, stateDir: run.stateDir, worktreePath: run.worktreePath, branch: run.branch, dryRun: true });
    expect(dry.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(existsSync(run.stateDir) && existsSync(run.worktreePath) && existsSync(run.record)).toBe(true);
    expect(hub.service.hub.archived()[0]!.purgedAt).toBeUndefined();

    const report = await purge(hub.socket, item.runId);
    expect(report).toMatchObject({ id: item.id, runId: item.runId, bytes: dry.bytes, ownershipRecords: [run.record], purgedAt: expect.any(String) });
    expect(existsSync(run.stateDir)).toBe(false);
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(existsSync(run.record)).toBe(false);
    expect(await git(hub.repo, "branch", "--list", "graphloom/*")).toBe("");
    expect(await git(hub.repo, "worktree", "list")).not.toContain(run.worktreePath);
    expect(existsSync(path.join(hub.repo, "README.md"))).toBe(true);

    // The entry stays (ids, key, verdict, times), marked purged; list and inspect say so.
    const [entry] = hub.service.hub.archived();
    expect(entry).toMatchObject({ id: item.id, runId: item.runId, key: "fix-widgets-1", state: "succeeded", purgedAt: report.purgedAt });
    const index = JSON.parse(await readFile(path.join(hub.directory, "archive-index.json"), "utf8")) as { entries: Array<{ purgedAt?: string }> };
    expect(index.entries[0]!.purgedAt).toBe(report.purgedAt);
    const listed = await invoke(["list", "--archived", "--socket", hub.socket]);
    expect(listed.out).toContain(`${item.id}  succeeded (archived, purged)`);
    await expect(hubRequest("GET", `/v1/submissions/${item.id}/snapshot`, undefined, hub.socket)).rejects.toMatchObject({ status: 410, message: expect.stringContaining(`is archived and its run files were purged at ${report.purgedAt}`) });
    const inspected = invoke(["inspect", item.id, "--socket", hub.socket]);
    await expect(inspected).rejects.toThrow("its run files were purged");

    // Idempotent: a repeat finds nothing to remove and keeps the first time.
    expect(await purge(hub.socket, item.id)).toMatchObject({ id: item.id, alreadyPurged: true, bytes: 0, purgedAt: report.purgedAt });
  });

  it("refuses a live submission, an unknown one, and a run another hub or submission owns", async () => {
    const hub = await purgeHub(0);
    const queued = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/q.yaml", key: "queued" }, hub.socket);
    await expect(purge(hub.socket, queued.id)).rejects.toMatchObject({ status: 409, message: `submission ${queued.id} is queued, not archived: hub purge removes only archived submissions' run files; cancel it or let it finish, then archive it` });
    await hubRequest("POST", `/v1/submissions/${queued.id}/cancel`, {}, hub.socket);
    await expect(purge(hub.socket, queued.id)).rejects.toThrow(`archive it first (graphloom hub archive ${queued.id})`);
    await expect(purge(hub.socket, "s-unknown")).rejects.toMatchObject({ status: 404 });
    // An archived inspect that was not purged says where its run is.
    await hubRequest("POST", `/v1/submissions/${queued.id}/archive`, {}, hub.socket);
    await expect(hubRequest("GET", `/v1/submissions/${queued.id}`, undefined, hub.socket)).rejects.toThrow(`submission ${queued.id} is archived; its run stays at`);

    const other = await tempDir("gl-hub-purge-other-");
    const run = await runFor(hub, queued, { hubStateDir: other });
    await expect(purge(hub.socket, queued.id)).rejects.toThrow(`it belongs to hub submission ${queued.id} of the hub at ${other}`);
    expect(existsSync(run.stateDir) && existsSync(run.worktreePath) && existsSync(run.record)).toBe(true);
    expect(hub.service.hub.archived()[0]!.purgedAt).toBeUndefined();
    await expect(purge(hub.socket, queued.id, { dryRun: "yes" })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses uncommitted worktree changes without force, then purges on a retry with force", async () => {
    const hub = await purgeHub();
    const item = await finishedAndArchived(hub, "dirty");
    const run = await runFor(hub, item);
    await writeFile(path.join(run.worktreePath, "notes.txt"), "work\n");
    await expect(purge(hub.socket, item.id)).rejects.toThrow(`cannot delete run ${item.runId}: its worktree has uncommitted changes (notes.txt); pass force to discard them`);
    expect(existsSync(run.stateDir) && existsSync(run.worktreePath)).toBe(true);
    expect(hub.service.hub.archived()[0]!.purgedAt).toBeUndefined();
    const cli = await invoke(["purge", item.id, "--socket", hub.socket]);
    expect(cli.code).toBe(1);
    expect(cli.out).toContain(`refused ${item.id}: cannot delete run ${item.runId}: its worktree has uncommitted changes`);
    expect(cli.out).toContain("Purged 0 submissions (0 B freed), 1 refused.");
    const forced = await invoke(["purge", item.id, "--force", "--socket", hub.socket]);
    expect(forced.code).toBe(0);
    expect(forced.out).toMatch(new RegExp(`^purged ${item.id}  ${item.runId}  \\d`));
    expect(existsSync(run.stateDir) || existsSync(run.worktreePath)).toBe(false);
  });

  it("finishes a purge that failed partway (worktree and state.json gone, files left)", async () => {
    const hub = await purgeHub();
    const item = await finishedAndArchived(hub, "partial");
    const run = await runFor(hub, item);
    // What an interrupted delete leaves: worktree, branch and state.json removed, the rest not.
    await git(hub.repo, "worktree", "remove", "--force", run.worktreePath);
    await git(hub.repo, "branch", "-D", run.branch);
    await rm(path.join(run.stateDir, "state.json"));
    const report = await purge(hub.socket, item.id);
    expect(report).toMatchObject({ id: item.id, ownershipRecords: [run.record], purgedAt: expect.any(String) });
    expect(existsSync(run.stateDir)).toBe(false);
    expect(existsSync(run.record)).toBe(false);
  });

  it("purges in bulk only archived, unpurged entries matching the filters, and lists them on a dry run", async () => {
    const hub = await purgeHub();
    const widgets = await finishedAndArchived(hub, "fix-widgets-7");
    const gadgets = await finishedAndArchived(hub, "fix-gadgets-8");
    const rehearsal = await finishedAndArchived(hub, "rehearse-widgets", { rehearsal: { scenario: "happy" } });
    const live = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/live.yaml", key: "fix-widgets-live" }, hub.socket);
    const runs = new Map([[widgets.id, await runFor(hub, widgets)], [gadgets.id, await runFor(hub, gadgets)], [rehearsal.id, await runFor(hub, rehearsal)]]);
    const common = ["--socket", hub.socket];

    await expect(invoke(["purge", "--key", "widgets", ...common])).rejects.toThrow("--key selects archived submissions: add --archived");
    await expect(invoke(["purge", widgets.id, "--archived", ...common])).rejects.toThrow("not both");
    await expect(invoke(["purge", ...common])).rejects.toThrow("hub purge needs submissions");

    const dry = await invoke(["purge", "--archived", "--key", "widgets", "--dry-run", ...common]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`would purge ${widgets.id}`); expect(dry.out).toContain(`would purge ${rehearsal.id}`);
    expect(dry.out).not.toContain(gadgets.id); expect(dry.out).not.toContain(live.id);
    expect(dry.out).toMatch(/Would purge 2 submissions \(\d/);
    for (const run of runs.values()) expect(existsSync(run.stateDir)).toBe(true);

    expect((await invoke(["purge", "--archived", "--before", "2000-01-01", "--dry-run", ...common])).out).toBe("Would purge 0 submissions (0 B).");
    const onlyRehearsals = JSON.parse((await invoke(["purge", "--archived", "--rehearsal", "--json", ...common])).out) as { results: HubPurgeReport[] };
    expect(onlyRehearsals.results.map((item) => item.id)).toEqual([rehearsal.id]);
    expect(existsSync(runs.get(rehearsal.id)!.stateDir)).toBe(false);
    expect(existsSync(runs.get(widgets.id)!.stateDir)).toBe(true);

    const rest = await invoke(["purge", "--archived", "--key", "widgets", ...common]);
    expect(rest.out).toContain(`purged ${widgets.id}`);
    expect(rest.out).toMatch(/Purged 1 submission \(.+ freed\), 1 already purged\./);
    expect(existsSync(runs.get(widgets.id)!.stateDir)).toBe(false);
    expect(existsSync(runs.get(gadgets.id)!.stateDir)).toBe(true);
    expect(hub.service.hub.inspect(live.id).id).toBe(live.id);
    expect(hub.service.hub.archivedSubmission(live.id)).toBeUndefined();
    const search = await hubRequest<HubStatus>("GET", "/v1/submissions?archived=true", undefined, hub.socket);
    expect(Object.fromEntries((search.archived ?? []).map((entry) => [entry.id, entry.purgedAt !== undefined]))).toEqual({ [widgets.id]: true, [gadgets.id]: false, [rehearsal.id]: true });
  });

  it("names purge in hub --help", async () => {
    const help = await invoke(["purge", "--help"]);
    expect(help.out).toContain("graphloom hub purge <submission>... | --archived");
    expect(help.out).toContain("--dry-run");
  });
});
