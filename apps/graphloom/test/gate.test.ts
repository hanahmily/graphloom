import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runGate } from "../src/gate.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(graph: "hello" | "release", request: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-gate-"));
  dirs.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(root, "examples/plugins", graph), path.join(dir, "plugins", graph));
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, `graph: ${graph}\nrepo: ./repo\nrequest: ${JSON.stringify(request)}\n`);
  const stateRoot = path.join(dir, "graphloom-state");
  return { dir, repo, taskPath, stateRoot };
}

describe("the gate in run (§3.5)", () => {
  it("reaches ready for hello's happy scenario, then reuses the cached report instead of rerunning L1", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const first = await runGate(f.taskPath, { stateRoot: f.stateRoot });
    expect(first.verdict).toBe("ready");
    expect(first.fingerprint).not.toBe("");

    const second = await runGate(f.taskPath, { stateRoot: f.stateRoot });
    expect(second.verdict).toBe("ready");
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.notes.some((n) => n.includes("reused cached rehearsal"))).toBe(true);
  }, 30_000);

  it("does not share a cached ready verdict across a different request or pinned checkout", async () => {
    // Regression: the fingerprint covered the bundle, runner config, and
    // environment, but not the task's own request text or repository
    // identity — rehearsal runs that request verbatim against that pinned
    // revision, so two tasks differing only in one of those could still
    // reuse each other's cached "ready", even if one would not actually
    // converge for real.
    const a = await fixture("hello", "Create GREETING.txt.");
    const b = await fixture("hello", "Create GREETING.txt. Please.");
    const resultA = await runGate(a.taskPath, { stateRoot: a.stateRoot });
    const resultB = await runGate(b.taskPath, { stateRoot: b.stateRoot });
    expect(resultA.fingerprint).not.toBe("");
    expect(resultB.fingerprint).not.toBe("");
    expect(resultA.fingerprint).not.toBe(resultB.fingerprint);
  }, 30_000);

  it("reports not-ready from L1 when the request never converges, and caches nothing", async () => {
    const f = await fixture("hello", "this request never mentions the greeting file");
    const result = await runGate(f.taskPath, { stateRoot: f.stateRoot });
    expect(result.verdict).toBe("not-ready");
    expect(result.report).toBeDefined();
    await expect(readdir(path.join(f.stateRoot, "rehearsals")).catch(() => [])).resolves.toEqual([]);
  }, 30_000);

  it("skips everything and records that choice when asked to", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const result = await runGate(f.taskPath, { stateRoot: f.stateRoot, skip: true });
    expect(result).toEqual({ fingerprint: "", verdict: "skipped", notes: expect.any(Array) });
    await expect(readdir(f.stateRoot).catch(() => [])).resolves.toEqual([]);
  });
});
