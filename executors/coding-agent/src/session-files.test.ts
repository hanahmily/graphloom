import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { copyFiles, filesUnder } from "./session-files.js";

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-session-files-"));
  dirs.push(dir);
  const source = path.join(dir, "source");
  await mkdir(path.join(source, "subagents"), { recursive: true });
  await writeFile(path.join(source, "subagents", "agent-1.jsonl"), "subagent\n");
  const secret = path.join(dir, "secret");
  await mkdir(secret);
  await writeFile(path.join(secret, "agent-1.jsonl"), "secret\n");
  return { dir, source, secret, target: path.join(dir, "target") };
}

describe("session side files", () => {
  it("copies the regular files a scan saw", async () => {
    const t = await tree();
    const side = await filesUnder(t.source);
    await copyFiles(t.source, side!.files, t.target);
    expect(await readFile(path.join(t.target, "subagents", "agent-1.jsonl"), "utf8")).toBe("subagent\n");
  });

  it("refuses a file swapped for a symlink after the scan", async () => {
    const t = await tree();
    const side = await filesUnder(t.source);
    const file = path.join(t.source, "subagents", "agent-1.jsonl");
    await unlink(file);
    await symlink(path.join(t.secret, "agent-1.jsonl"), file);
    await expect(copyFiles(t.source, side!.files, t.target)).rejects.toThrow("was replaced while it was copied");
    expect(existsSync(path.join(t.target, "subagents", "agent-1.jsonl"))).toBe(false);
  });

  it("refuses a directory swapped for a symlink after the scan", async () => {
    const t = await tree();
    const side = await filesUnder(t.source);
    await rename(path.join(t.source, "subagents"), path.join(t.dir, "moved"));
    await symlink(t.secret, path.join(t.source, "subagents"));
    await expect(copyFiles(t.source, side!.files, t.target)).rejects.toThrow("was replaced while it was copied");
    expect(existsSync(path.join(t.target, "subagents", "agent-1.jsonl"))).toBe(false);
  });

  it("refuses a file swapped for a FIFO after the scan, without blocking on it", async () => {
    const t = await tree();
    const side = await filesUnder(t.source);
    const file = path.join(t.source, "subagents", "agent-1.jsonl");
    await unlink(file);
    await execFileAsync("mkfifo", [file]);
    await expect(copyFiles(t.source, side!.files, t.target)).rejects.toThrow("was replaced while it was copied");
  }, 5_000);

  it("refuses a file replaced by another regular file after the scan", async () => {
    const t = await tree();
    const side = await filesUnder(t.source);
    const file = path.join(t.source, "subagents", "agent-1.jsonl");
    await writeFile(`${file}.new`, "other\n");
    await rename(`${file}.new`, file);
    await expect(copyFiles(t.source, side!.files, t.target)).rejects.toThrow("was replaced while it was copied");
  });

  it("refuses a new file that reuses the scanned file's inode number", async () => {
    const t = await tree();
    const side = await filesUnder(t.source);
    const file = path.join(t.source, "subagents", "agent-1.jsonl");
    await unlink(file);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(file, "other\n");
    await expect(copyFiles(t.source, side!.files, t.target)).rejects.toThrow("was replaced while it was copied");
  });
});
