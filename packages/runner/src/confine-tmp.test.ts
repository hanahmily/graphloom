import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confineWorker, confinementUnsupported } from "./confine.js";

const unsupported = await confinementUnsupported();
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gl-confine-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(unsupported !== undefined)("confinement when what the job needs lives under /tmp (#165)", () => {
  const run = (command: string, args: string[], cwd: string, writable: string[], readPaths: string[]) => {
    const launch = confineWorker({ command, args, env: { ...process.env }, cwd, scratchDir: path.join(root, "scratch"), writable, readPaths, keepUserState: false });
    return spawnSync(launch.command, launch.args, { env: launch.env, cwd, encoding: "utf8" });
  };

  it("still loads a module that lives under /tmp, and still keeps writes to the rest of /tmp out", () => {
    expect(root.startsWith("/tmp/")).toBe(true);
    const pkg = path.join(root, "pkg");
    mkdirSync(pkg);
    const entry = path.join(pkg, "entry.mjs");
    const escaped = path.join(root, "escaped.txt");
    writeFileSync(entry, `import fs from "node:fs"; try { fs.writeFileSync(${JSON.stringify(escaped)}, "x"); console.log("wrote"); } catch { console.log("denied"); }`);
    const res = run(process.execPath, [entry], pkg, [], [entry, pkg]);
    expect(res.stdout.trim(), res.stderr).toBe("denied");
    expect(existsSync(escaped)).toBe(false);
  });

  it("keeps the repository's shared git directory readable from a linked worktree under /tmp", () => {
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    sh("init", "-q");
    sh("-c", "user.email=t@e.x", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = path.join(root, "wt");
    sh("worktree", "add", "-q", "-b", "run", wt);
    const adminLine = execFileSync("cat", [path.join(wt, ".git")], { encoding: "utf8" }).replace(/^gitdir:\s*/, "").trim();
    const res = run("git", ["log", "--oneline", "-1"], wt, [wt, adminLine], []);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("init");
  });
});
