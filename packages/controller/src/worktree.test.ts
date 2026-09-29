import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateChange,
  changedPaths,
  listDirtyPaths,
  pathsOutsideWriteScope,
  workspaceChangeManifest,
  worktreeChangeFingerprints,
} from "./worktree.js";

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

describe("source checkout dirt", () => {
  it("lists a large ignored build tree as one entry", async () => {
    const dir = await repo();
    const deps = path.join(dir, "build", "node_modules", "pkg");
    await mkdir(deps, { recursive: true });
    const name = "a".repeat(200);
    await Promise.all(Array.from({ length: 6000 }, (_, i) => writeFile(path.join(deps, `${name}-${i}.js`), "")));
    await writeFile(path.join(dir, "tracked.txt"), "two\n");
    await writeFile(path.join(dir, "notes.md"), "x\n");

    expect((await listDirtyPaths(dir)).sort()).toEqual(["build/", "notes.md", "tracked.txt"]);
    expect(await workspaceChangeManifest(dir)).toHaveLength(6002);
  });
});

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

  it("allows the whole workspace except excluded paths", () => {
    const changed = ["README.md", "api/proto/v1/a.proto", "api/protox.go", "go.mod", "pkg/x.go"];
    expect(pathsOutsideWriteScope(changed, { writeScope: [".", "!api/proto/", "!go.mod"] })).toEqual(["api/proto/v1/a.proto", "go.mod"]);
    expect(pathsOutsideWriteScope(changed, { writeScope: ["pkg", "!pkg/x.go"] })).toEqual(["README.md", "api/proto/v1/a.proto", "api/protox.go", "go.mod", "pkg/x.go"]);
  });
});

describe("candidate change", () => {
  it("covers committed and uncommitted changes against the pinned base, but not ignored files", async () => {
    const dir = await repo();
    const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    const empty = await candidateChange(dir, base);
    expect([...empty.fingerprints.keys()]).toEqual([]);

    await writeFile(path.join(dir, "tracked.txt"), "two\n");
    await execFileAsync("git", ["commit", "-am", "agent commit"], { cwd: dir });
    await writeFile(path.join(dir, "new.txt"), "x\n");
    await mkdir(path.join(dir, "build"));
    await writeFile(path.join(dir, "build/out.js"), "ignored\n");
    const changed = await candidateChange(dir, base);
    expect([...changed.fingerprints.keys()]).toEqual(["new.txt", "tracked.txt"]);
    expect(changed.digest).not.toBe(empty.digest);

    await writeFile(path.join(dir, "build/out.js"), "still ignored\n");
    expect((await candidateChange(dir, base)).digest).toBe(changed.digest);
    await writeFile(path.join(dir, "new.txt"), "y\n");
    expect((await candidateChange(dir, base)).digest).not.toBe(changed.digest);
  });

  it("changes when only a file's executable bit changes", async () => {
    const dir = await repo();
    const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    await writeFile(path.join(dir, "run.sh"), "echo hi\n");
    const plain = await candidateChange(dir, base);
    await chmod(path.join(dir, "run.sh"), 0o755);
    expect((await candidateChange(dir, base)).digest).not.toBe(plain.digest);
  });
});
