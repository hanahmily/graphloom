import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { changedPaths, pathsOutsideWriteScope, worktreeChangeFingerprints } from "./worktree.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphloom-worktree-"));
  cleanup.push(dir);
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "tracked.txt"), "one\n");
  await writeFile(path.join(dir, ".gitignore"), "build/\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("write-scope change detection", () => {
  it("reports edited, new, and renamed paths but not ignored ones", async () => {
    const dir = await repo();
    const before = await worktreeChangeFingerprints(dir);
    expect(before.size).toBe(0);

    await mkdir(path.join(dir, "src/deep"), { recursive: true });
    await writeFile(path.join(dir, "src/deep/new.ts"), "x\n");
    await mkdir(path.join(dir, "build"));
    await writeFile(path.join(dir, "build/out.js"), "ignored\n");
    await rename(path.join(dir, "tracked.txt"), path.join(dir, "moved.txt"));
    await execFileAsync("git", ["add", "-A"], { cwd: dir });

    expect(changedPaths(before, await worktreeChangeFingerprints(dir))).toEqual(["moved.txt", "src/deep/new.ts", "tracked.txt"]);
  });

  it("lists each untracked file rather than its new directory", async () => {
    const dir = await repo();
    const before = await worktreeChangeFingerprints(dir);
    await mkdir(path.join(dir, "notes/day"), { recursive: true });
    await writeFile(path.join(dir, "notes/day/one.md"), "x\n");

    expect(changedPaths(before, await worktreeChangeFingerprints(dir))).toEqual(["notes/day/one.md"]);
  });

  it("reports a path already dirty only when its content changes again", async () => {
    const dir = await repo();
    await writeFile(path.join(dir, "tracked.txt"), "two\n");
    const before = await worktreeChangeFingerprints(dir);

    expect(changedPaths(before, await worktreeChangeFingerprints(dir))).toEqual([]);
    await writeFile(path.join(dir, "tracked.txt"), "three\n");
    expect(changedPaths(before, await worktreeChangeFingerprints(dir))).toEqual(["tracked.txt"]);
  });

  it("leaves out a path restored to HEAD", async () => {
    const dir = await repo();
    await writeFile(path.join(dir, "tracked.txt"), "two\n");
    await writeFile(path.join(dir, "stray.txt"), "stray\n");
    const before = await worktreeChangeFingerprints(dir);

    await writeFile(path.join(dir, "tracked.txt"), "one\n");
    await rm(path.join(dir, "stray.txt"));
    expect(changedPaths(before, await worktreeChangeFingerprints(dir))).toEqual([]);
  });

  it("allows exact paths and files under directory entries", () => {
    const changed = ["README.md", "src/a.ts", "src/nested/b.ts", "srcx/c.ts", "docs"];
    expect(pathsOutsideWriteScope(changed, { writeScope: ["README.md", "src/"] })).toEqual(["srcx/c.ts", "docs"]);
    expect(pathsOutsideWriteScope(changed, { writeScope: ["src", "docs"] })).toEqual(["README.md", "srcx/c.ts"]);
    expect(pathsOutsideWriteScope(changed, {})).toEqual(changed);
    expect(pathsOutsideWriteScope(changed, { readOnly: true, writeScope: ["README.md"] })).toEqual(changed);
  });
});
