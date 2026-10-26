// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confineWorker, confinementUnsupported, operatorGoSettings } from "./confine.js";

const unsupported = await confinementUnsupported();
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gl-confine-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(unsupported !== undefined)("confinement when what the job needs lives under /tmp (#165)", () => {
  const run = (command: string, args: string[], cwd: string, writable: string[], readPaths: string[]) => {
    const launch = confineWorker({ command, args, env: { ...process.env }, cwd, scratchDir: path.join(root, "scratch"), writable, readPaths, keepUserState: false });
    return spawnSync(launch.command, launch.args, { env: launch.env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"] });
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
    const res = run("git", ["log", "--oneline", "-1"], wt, [wt, adminLine], [path.join(repo, ".git")]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("init");
  });
});

describe.skipIf(unsupported !== undefined)("a job cannot use what it leaves behind to make the next launch write outside the run (#165)", () => {
  it("replaces links a job planted in scratch instead of writing through them", () => {
    const scratch = path.join(root, "scratch-escape");
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const wt = path.join(root, "wt-escape");
    mkdirSync(wt);
    const launch = (script: string) => {
      const l = confineWorker({
        command: "sh", args: ["-c", script], env: { ...process.env }, cwd: wt, scratchDir: scratch, writable: [wt], keepUserState: false,
      });
      return spawnSync(l.command, l.args, { env: l.env, cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"] });
    };
    // Job 1 swaps scratch/go, scratch/tmp and the Go env file for links to a directory outside the run.
    const first = launch(`rm -rf "${scratch}/go" "${scratch}/tmp" "${scratch}/npm" && ln -s "${outside}" "${scratch}/go" && ln -s "${outside}" "${scratch}/tmp" && ln -s "${outside}/stolen" "${scratch}/npm"`);
    expect(first.status, first.stderr).toBe(0);
    expect(lstatSync(path.join(scratch, "go")).isSymbolicLink()).toBe(true);
    // Job 2's preparation runs on the host, outside the sandbox.
    const second = launch("true");
    expect(second.status, second.stderr).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    for (const rel of ["go", "tmp", "npm"]) expect(lstatSync(path.join(scratch, rel)).isSymbolicLink(), rel).toBe(false);
  });

  it("refuses a writable directory that is a link", () => {
    const real = path.join(root, "real-dir");
    const link = path.join(root, "linked-dir");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() =>
      confineWorker({ command: "true", args: [], env: {}, cwd: root, scratchDir: path.join(root, "scratch-link"), writable: [link], keepUserState: false }),
    ).toThrow(/is a symbolic link/);
  });
});

describe.skipIf(spawnSync("go", ["version"]).status !== 0)("the host-side Go probe writes nothing (#171)", () => {
  it("does not switch toolchains from a checkout that needs a newer Go, and still reports the settings", () => {
    const checkout = path.join(root, "newer-go");
    const cache = path.join(root, "probe-cache");
    mkdirSync(checkout);
    mkdirSync(cache);
    writeFileSync(path.join(checkout, "go.mod"), "module example.com/x\n\ngo 1.99\ntoolchain go1.99.0\n");
    const listing = () => spawnSync("find", [cache, "-mindepth", "1", "-printf", "%p %s %T@\\n"], { encoding: "utf8" }).stdout;
    const before = listing();
    const cwd = process.cwd();
    process.chdir(checkout);
    try {
      const settings = operatorGoSettings({ ...process.env, GOMODCACHE: cache, GOPROXY: "off", GOFLAGS: "-mod=mod", GOTOOLCHAIN: "auto", GOENV: "off" });
      expect(settings).toEqual({ modCache: cache, proxy: "off", flags: "-mod=mod", redirect: true });
    } finally {
      process.chdir(cwd);
    }
    expect(listing()).toBe(before);
    expect(before).toBe("");
  });
});

describe("a redirected module cache carries the operator's checksum evidence (#171)", () => {
  it("copies the sumdb tree, skips links in it, and replaces a link a job left at the destination", () => {
    const cache = path.join(root, "sumdb-op");
    const sumdb = path.join(cache, "cache", "download", "sumdb", "sum.golang.org");
    mkdirSync(path.join(sumdb, "lookup"), { recursive: true });
    mkdirSync(path.join(sumdb, "tile", "8", "0"), { recursive: true });
    writeFileSync(path.join(sumdb, "latest"), "go.sum database tree\n1\nhash\n");
    writeFileSync(path.join(sumdb, "tile", "8", "0", "000"), "tile");
    writeFileSync(path.join(sumdb, "lookup", "mod@v1.0.0"), "record");
    symlinkSync("/etc/hostname", path.join(sumdb, "lookup", "linked"));
    const scratch = path.join(root, "sumdb-scratch");
    const outside = path.join(root, "sumdb-outside");
    mkdirSync(outside);
    const seeded = path.join(scratch, "go", "mod", "cache", "download", "sumdb", "sum.golang.org");
    const wt = path.join(root, "sumdb-wt");
    mkdirSync(wt);
    const launch = () =>
      confineWorker({
        command: "true", args: [], env: { ...process.env }, cwd: wt, scratchDir: scratch, writable: [wt], keepUserState: false,
        operatorGo: { modCache: cache, proxy: "", flags: "", redirect: true },
      });
    expect(launch().env.GOMODCACHE).toBe(path.join(scratch, "go", "mod"));
    expect(readFileSync(path.join(seeded, "latest"), "utf8")).toBe(readFileSync(path.join(sumdb, "latest"), "utf8"));
    expect(readFileSync(path.join(seeded, "tile", "8", "0", "000"), "utf8")).toBe("tile");
    expect(readFileSync(path.join(seeded, "lookup", "mod@v1.0.0"), "utf8")).toBe("record");
    expect(existsSync(path.join(seeded, "lookup", "linked"))).toBe(false);
    // A job swaps a seeded file for a link out of the run; the next launch replaces it without writing through.
    rmSync(path.join(seeded, "latest"));
    symlinkSync(path.join(outside, "stolen"), path.join(seeded, "latest"));
    launch();
    expect(lstatSync(path.join(seeded, "latest")).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(outside, "stolen"))).toBe(false);
    expect(readFileSync(path.join(sumdb, "latest"), "utf8")).toContain("go.sum database");
  });
});
