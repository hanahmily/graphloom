// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkoutCommand, GIT_ENV, GUARD_REFUSED, guardCommand, headTreeCommand, ledgerReadCommand, parseHeadTree, parseLedger, reviewDirCommand } from "../src/commands.js";
import { BANYANDB, root } from "./support.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gl-pr-${prefix}-`));
  dirs.push(dir);
  return dir;
};

/** git with an identity and no global configuration of its own. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=A", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env } });
}
const out = (cwd: string, args: string[]): string => {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir: string, files: Record<string, string>): void => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), text);
  }
};
const commit = (dir: string, message: string): string => {
  out(dir, ["add", "-A", "-f"]);
  out(dir, ["commit", "-q", "--allow-empty", "-m", message]);
  return out(dir, ["rev-parse", "HEAD"]);
};

/** Markers a hook, filter or monitor writes when it runs. */
const MARKERS = ["hook", "smudge", "fsmonitor"];
function markers(dir: string): string[] {
  return MARKERS.filter((m) => existsSync(path.join(dir, `ran-${m}`)));
}

/** A home with global Git configuration that would run code on a checkout: a hooks directory, a smudge filter, a filesystem monitor. */
function booby(markerDir: string): string {
  const home = tmp("home");
  const hooks = path.join(home, "hooks");
  mkdirSync(hooks);
  for (const name of ["post-checkout", "reference-transaction", "post-merge", "pre-commit"]) {
    writeFileSync(path.join(hooks, name), `#!/bin/sh\ntouch ${markerDir}/ran-hook\n`);
    chmodSync(path.join(hooks, name), 0o755);
  }
  writeFileSync(path.join(home, "monitor.sh"), `#!/bin/sh\ntouch ${markerDir}/ran-fsmonitor\n`);
  chmodSync(path.join(home, "monitor.sh"), 0o755);
  writeFileSync(path.join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n\tfsmonitor = ${path.join(home, "monitor.sh")}\n[filter "mark"]\n\tsmudge = touch ${markerDir}/ran-smudge; cat\n\tclean = cat\n`);
  return home;
}

describe("scripts/prepare.sh (design 3.1)", () => {
  const script = path.join(root, "scripts", "prepare.sh");

  /** An upstream with a pull request (refs/pull/7/head), a base branch that moved on, and a review clone that has neither fetched. */
  function setup() {
    const base = tmp("prepare");
    const upstream = path.join(base, "upstream");
    mkdirSync(upstream);
    out(upstream, ["init", "-q", "-b", "main"]);
    write(upstream, { "a.txt": "one\n", "pkg/x.go": "package x\n" });
    const fork = commit(upstream, "base");
    out(upstream, ["checkout", "-q", "-b", "feature"]);
    write(upstream, { "a.txt": "one\ntwo\n", "new.go": "package n\n" });
    const head = commit(upstream, "head");
    out(upstream, ["update-ref", "refs/pull/7/head", head]);
    out(upstream, ["checkout", "-q", "main"]);
    write(upstream, { "later.txt": "later\n" });
    const tip = commit(upstream, "main moves on");
    const clone = path.join(base, "clone");
    out(base, ["clone", "-q", upstream, clone]);
    return { base, upstream, clone, fork, head, tip };
  }

  const run = (args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) => spawnSync("sh", [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

  it("fetches the pull request's head and the base branch into the ledger namespace, computes the merge base, and writes the task", () => {
    const s = setup();
    const outDir = path.join(s.base, "reviews");
    const r = run([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone]);
    expect(r.status, r.stderr).toBe(0);
    const task = r.stdout.trim();
    expect(task).toBe(path.join(outDir, "banyandb-7", "task.yaml"));
    const ns = "refs/graphloom/pr-review-pulls/apache/skywalking-banyandb/7";
    expect(out(s.clone, ["rev-parse", `${ns}/heads/${s.head}`])).toBe(s.head);
    expect(out(s.clone, ["rev-parse", `${ns}/base`])).toBe(s.tip);
    expect(readFileSync(task, "utf8")).toBe(
      ["graph: pr-review", `repo: ${path.join(s.base, "clone")}`, `base: ${s.fork}`, "config: profile.json", `request: "Report on apache/skywalking-banyandb#7 at ${s.head}."`, ""].join("\n"),
    );
    expect(r.stderr).toContain(`merge base ${s.fork}`);
    // The profile is copied (a run pins its bytes), the plugin linked, where a task looks for them.
    expect(readFileSync(path.join(outDir, "banyandb-7", "profile.json"), "utf8")).toBe(readFileSync(path.join(root, "profiles", "banyandb.json"), "utf8"));
    expect(lstatSync(path.join(outDir, "banyandb-7", "plugins", "pr-review")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(outDir, "banyandb-7", "plugins", "pr-review"))).toBe(root);
  });

  it("checks nothing out: the clone's branch, index and files are exactly as they were", () => {
    const s = setup();
    const before = [out(s.clone, ["rev-parse", "HEAD"]), out(s.clone, ["status", "--porcelain"]), readdirSync(s.clone).sort().join()];
    expect(run([path.join(s.base, "r"), "apache/skywalking-banyandb#7", "--repo", s.clone]).status).toBe(0);
    expect([out(s.clone, ["rev-parse", "HEAD"]), out(s.clone, ["status", "--porcelain"]), readdirSync(s.clone).sort().join()]).toEqual(before);
  });

  it("runs no hook, no filesystem monitor and no filter: only fetch, ls-remote, merge-base, update-ref, rev-parse and file writes", () => {
    const s = setup();
    const marks = tmp("marks");
    // Hooks in the clone itself, and global configuration that would run code on any ref update or file operation.
    for (const name of ["reference-transaction", "post-fetch", "post-checkout", "post-merge", "pre-auto-gc", "post-update"]) {
      writeFileSync(path.join(s.clone, ".git", "hooks", name), `#!/bin/sh\ntouch ${marks}/ran-hook\n`);
      chmodSync(path.join(s.clone, ".git", "hooks", name), 0o755);
    }
    out(s.clone, ["config", "core.fsmonitor", path.join(booby(marks), "monitor.sh")]);
    const r = run([path.join(s.base, "r"), "apache/skywalking-banyandb#7", "--repo", s.clone], { HOME: booby(marks) });
    expect(r.status, r.stderr).toBe(0);
    expect(markers(marks)).toEqual([]);
    expect(out(s.clone, ["rev-parse", `refs/graphloom/pr-review-pulls/apache/skywalking-banyandb/7/base`])).toBe(s.tip);
  });

  it("proves its own test: a plain fetch and ref update in the same clone does run the hook (the control)", () => {
    const s = setup();
    const marks = tmp("marks");
    writeFileSync(path.join(s.clone, ".git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch ${marks}/ran-hook\n`);
    chmodSync(path.join(s.clone, ".git", "hooks", "reference-transaction"), 0o755);
    out(s.clone, ["update-ref", "refs/x/y", s.head.length === 40 ? out(s.clone, ["rev-parse", "HEAD"]) : ""]);
    expect(markers(marks)).toEqual(["hook"]);
  });

  it("lives beside an existing ledger ref, in either order (a Git ref cannot be a leaf and a directory)", () => {
    const s = setup();
    const ledger = "refs/graphloom/pr-review/apache/skywalking-banyandb/7";
    out(s.clone, ["update-ref", ledger, s.fork]);
    const r = run([path.join(s.base, "r"), "apache/skywalking-banyandb#7", "--repo", s.clone]);
    expect(r.status, r.stderr).toBe(0);
    expect(out(s.clone, ["rev-parse", ledger])).toBe(s.fork);
    const fresh = setup();
    expect(run([path.join(fresh.base, "r"), "apache/skywalking-banyandb#7", "--repo", fresh.clone]).status).toBe(0);
    out(fresh.clone, ["update-ref", ledger, fresh.fork]);
    expect(out(fresh.clone, ["rev-parse", ledger])).toBe(fresh.fork);
  });

  it("takes the pull request's URL, and an explicit base branch and remote", () => {
    const s = setup();
    out(s.upstream, ["branch", "release", s.fork]);
    out(s.clone, ["remote", "add", "up", s.upstream]);
    const r = run([path.join(s.base, "r"), "https://github.com/apache/skywalking-banyandb/pull/7", "--repo", s.clone, "--remote", "up", "--base", "release"]);
    expect(r.status, r.stderr).toBe(0);
    const task = readFileSync(r.stdout.trim(), "utf8");
    expect(task).toContain(`base: ${s.fork}`);
    expect(out(s.clone, ["rev-parse", "refs/graphloom/pr-review-pulls/apache/skywalking-banyandb/7/base"])).toBe(s.fork);
  });

  it("keeps earlier heads alive: a second head gets its own ref beside the first", () => {
    const s = setup();
    const outDir = path.join(s.base, "r");
    expect(run([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone]).status).toBe(0);
    out(s.upstream, ["checkout", "-q", "feature"]);
    write(s.upstream, { "more.go": "package m\n" });
    const second = commit(s.upstream, "push again");
    out(s.upstream, ["update-ref", "refs/pull/7/head", second]);
    out(s.upstream, ["checkout", "-q", "main"]);
    expect(run([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone]).status).toBe(0);
    const refs = out(s.clone, ["for-each-ref", "--format=%(refname)", "refs/graphloom/pr-review-pulls/apache/skywalking-banyandb/7/heads"]).split("\n");
    expect(refs).toEqual([`refs/graphloom/pr-review-pulls/apache/skywalking-banyandb/7/heads/${s.head}`, `refs/graphloom/pr-review-pulls/apache/skywalking-banyandb/7/heads/${second}`].sort());
    expect(readFileSync(path.join(outDir, "banyandb-7", "task.yaml"), "utf8")).toContain(`at ${second}.`);
  });

  it("refuses what it cannot use, with a message and a non-zero exit, and writes no task", () => {
    const s = setup();
    const outDir = path.join(s.base, "r");
    const failure = (args: string[]) => {
      const r = run(args);
      expect(r.status, `${args.join(" ")}: ${r.stdout}`).not.toBe(0);
      return r.stderr;
    };
    expect(failure([outDir])).toMatch(/usage/);
    expect(failure([outDir, "apache/skywalking-banyandb", "--repo", s.clone])).toMatch(/usage/);
    expect(failure([outDir, "apache/skywalking-banyandb#x", "--repo", s.clone])).toMatch(/bad pull request number/);
    expect(failure([outDir, "apache/skywalking-banyandb#07", "--repo", s.clone])).toMatch(/bad pull request number/);
    expect(failure([outDir, "../evil/skywalking-banyandb#7", "--repo", s.clone])).toMatch(/bad repository owner/);
    expect(failure([outDir, "apache/skywalking-banyandb#8", "--repo", s.clone])).toMatch(/could not fetch refs\/pull\/8\/head/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--repo", path.join(s.base, "nowhere")])).toMatch(/is not a directory/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--repo", s.base])).toMatch(/not a Git repository/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone, "--base", "-x"])).toMatch(/bad base branch/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone, "--base", "nope"])).toMatch(/could not fetch the base branch nope/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone, "--config", path.join(s.base, "none.json")])).toMatch(/no profile at/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--repo", s.clone, "--remote", "--upload-pack=x"])).toMatch(/bad remote name/);
    expect(failure([outDir, "apache/skywalking-banyandb#7", "--bogus"])).toMatch(/usage/);
    expect(existsSync(path.join(outDir, "banyandb-7", "task.yaml"))).toBe(false);
  });
});

describe("materialization (design 4)", () => {
  /** A worktree on the base commit of a pull request that modifies, adds and deletes files and carries a filter in its .gitattributes. */
  function worktree() {
    const dir = tmp("wt");
    out(dir, ["init", "-q", "-b", "main"]);
    write(dir, { "keep.txt": "keep\n", "mod.txt": "before\n", "gone.go": "package gone\n", "sub/deep/old.go": "package old\n" });
    const base = commit(dir, "base");
    out(dir, ["checkout", "-q", "-b", "pr"]);
    out(dir, ["rm", "-q", "gone.go", "sub/deep/old.go"]);
    write(dir, { "mod.txt": "after\n", "new/added.go": "package added\n", ".gitattributes": "*.txt filter=mark\n" });
    const head = commit(dir, "head");
    out(dir, ["checkout", "-q", "--detach", base]);
    return { dir, base, head };
  }

  /** Runs the graph's commands as the command executor would: the job's env added, one command after another. */
  function materialize(dir: string, head: string, home: string, env: Record<string, string> = { ...GIT_ENV }) {
    const results = [checkoutCommand(head), headTreeCommand(head), reviewDirCommand()].map((c) => {
      const r = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
      return { id: c.id, code: r.status, stdout: r.stdout, stderr: r.stderr };
    });
    return results;
  }

  it("holds exactly the head's tree afterwards: files modified, added and deleted, on the pinned base", () => {
    const { dir, base, head } = worktree();
    const marks = tmp("marks");
    const results = materialize(dir, head, booby(marks));
    expect(results.map((r) => [r.id, r.code, r.stderr])).toEqual([["head-checkout", 0, ""], ["head-tree", 0, ""], ["review-dir", 0, ""]]);
    expect(readFileSync(path.join(dir, "mod.txt"), "utf8")).toBe("after\n");
    expect(existsSync(path.join(dir, "new/added.go"))).toBe(true);
    expect(existsSync(path.join(dir, "gone.go"))).toBe(false);
    expect(existsSync(path.join(dir, "sub/deep/old.go"))).toBe(false);
    const tree = parseHeadTree(results[1]!.stdout)!;
    expect(tree).toEqual({ head: out(dir, ["rev-parse", `${head}^{tree}`]), index: out(dir, ["rev-parse", `${head}^{tree}`]), base, clean: true });
    expect(out(dir, ["rev-parse", "HEAD"])).toBe(base);
    expect(out(dir, ["status", "--porcelain", "--untracked-files=all"]).split("\n").map((l) => l.slice(3)).sort()).toEqual([".gitattributes", "gone.go", "mod.txt", "new/added.go", "sub/deep/old.go"]);
  });

  it("runs no hook, no filter and no filesystem monitor, though the user's global configuration names all three", () => {
    const { dir, head } = worktree();
    const marks = tmp("marks");
    materialize(dir, head, booby(marks));
    expect(markers(marks)).toEqual([]);
  });

  it("proves its own test: the same checkout without the fixed environment and options does run the filter and the monitor", () => {
    const { dir, head } = worktree();
    const marks = tmp("marks");
    const home = booby(marks);
    // Another clone of the same state, so the control starts where the real run did.
    const control = spawnSync("git", ["checkout", "--no-overlay", head, "--", "."], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
    expect(control.status, control.stderr).toBe(0);
    spawnSync("git", ["diff", "--quiet", head, "--"], { cwd: dir, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
    expect(markers(marks)).toEqual(expect.arrayContaining(["smudge"]));
  });

  it("is not fooled by the review clone's own configuration: a filter it defines cannot be activated by the pull request's .gitattributes, and its filesystem monitor does not run", () => {
    const { dir, head } = worktree();
    const marks = tmp("marks");
    out(dir, ["config", "filter.mark.smudge", `touch ${marks}/ran-smudge; cat`]);
    out(dir, ["config", "filter.mark.clean", "cat"]);
    out(dir, ["config", "core.fsmonitor", path.join(booby(marks), "monitor.sh")]);
    const results = materialize(dir, head, tmp("home"));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(markers(marks)).toEqual([]);
    expect(parseHeadTree(results[1]!.stdout)).toMatchObject({ clean: true });
    expect(readFileSync(path.join(dir, "mod.txt"), "utf8")).toBe("after\n");
  });

  it("proves that test too: with only the global configuration and the hooks switched off, the clone's own filter and monitor do run on the pull request's attributes", () => {
    const { dir, head } = worktree();
    const marks = tmp("marks");
    out(dir, ["config", "filter.mark.smudge", `touch ${marks}/ran-smudge; cat`]);
    out(dir, ["config", "filter.mark.clean", "cat"]);
    const partial = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    materialize(dir, head, tmp("home"), partial);
    expect(markers(marks)).toEqual(["smudge"]);
  });

  it("is not fooled by hooks in the repository itself (core.hooksPath is switched off for the checkout)", () => {
    const { dir, head } = worktree();
    const marks = tmp("marks");
    for (const name of ["post-checkout", "reference-transaction", "post-merge"]) {
      writeFileSync(path.join(dir, ".git", "hooks", name), `#!/bin/sh\ntouch ${marks}/ran-hook\n`);
      chmodSync(path.join(dir, ".git", "hooks", name), 0o755);
    }
    materialize(dir, head, tmp("home"));
    expect(markers(marks)).toEqual([]);
  });

  it("reports a worktree that differs from the head's tree (a file the checkout cannot have left behind)", () => {
    const { dir, head } = worktree();
    materialize(dir, head, tmp("home"));
    writeFileSync(path.join(dir, "mod.txt"), "tampered\n");
    const r = spawnSync("sh", headTreeCommand(head).argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    expect(parseHeadTree(r.stdout)).toMatchObject({ clean: false });
  });

  it("writes .graphloom/review/.gitignore, which keeps the directory out of the candidate", () => {
    const { dir, head } = worktree();
    materialize(dir, head, tmp("home"));
    expect(readFileSync(path.join(dir, ".graphloom/review/.gitignore"), "utf8")).toBe("*\n");
    write(dir, { ".graphloom/review/review.md": "# r\n" });
    expect(out(dir, ["status", "--porcelain", "--untracked-files=all"])).not.toContain(".graphloom");
  });

  it("parses the tree comparison, and nothing else", () => {
    expect(parseHeadTree("head=a\nindex=b\nbase=c\nworktree=dirty\n")).toEqual({ head: "a", index: "b", base: "c", clean: false });
    expect(parseHeadTree("head=a\nindex=b\n")).toBeUndefined();
    expect(parseHeadTree("")).toBeUndefined();
  });
});

describe("the .graphloom/ guard (design 4)", () => {
  function repo() {
    const dir = tmp("guard");
    out(dir, ["init", "-q", "-b", "main"]);
    write(dir, { "a.txt": "a\n", ".graphloom/old/keep.json": "{}\n" });
    const base = commit(dir, "base");
    return { dir, base, head: (files: Record<string, string>, remove: string[] = []) => {
      out(dir, ["checkout", "-q", "--detach", base]);
      for (const r of remove) out(dir, ["rm", "-q", "-r", r]);
      write(dir, files);
      return commit(dir, "head");
    } };
  }
  const guard = (dir: string, head: string) => {
    const c = guardCommand(head);
    return spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  };

  it("lets a head that leaves .graphloom/ alone through, from Git objects, with nothing checked out", () => {
    const { dir, base, head } = repo();
    const h = head({ "b.go": "package b\n" });
    out(dir, ["checkout", "-q", "--detach", base]);
    const r = guard(dir, h);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("clear");
    expect(existsSync(path.join(dir, "b.go"))).toBe(false);
  });

  it("refuses an added, changed or deleted file under .graphloom/, with exit 3 and the first paths on stderr", () => {
    for (const change of [{ add: { ".graphloom/review/review.md": "x\n" }, remove: [] }, { add: { ".graphloom/old/keep.json": "{ }\n" }, remove: [] }, { add: {}, remove: [".graphloom"] }]) {
      const { dir, base, head } = repo();
      const h = head(change.add, change.remove);
      out(dir, ["checkout", "-q", "--detach", base]);
      const r = guard(dir, h);
      expect(r.status, JSON.stringify(change)).toBe(GUARD_REFUSED);
      expect(r.stderr).toContain(".graphloom/");
    }
  });

  it("refuses a file renamed out of .graphloom/ (the old name is a change too) and a symlink named .graphloom", () => {
    const a = repo();
    const renamed = a.head({ "moved.json": "{}\n" }, [".graphloom/old/keep.json"]);
    out(a.dir, ["checkout", "-q", "--detach", a.base]);
    expect(guard(a.dir, renamed).status).toBe(GUARD_REFUSED);
    const b = tmp("guard-link");
    out(b, ["init", "-q", "-b", "main"]);
    write(b, { "a.txt": "a\n" });
    const base = commit(b, "base");
    spawnSync("ln", ["-s", "elsewhere", path.join(b, ".graphloom")]);
    const linked = commit(b, "link");
    out(b, ["checkout", "-q", "--detach", base]);
    expect(guard(b, linked).status).toBe(GUARD_REFUSED);
  });

  it("fails some other way, not with the refusal, when the head's objects are missing", () => {
    const { dir } = repo();
    const r = guard(dir, "0".repeat(39) + "1");
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(GUARD_REFUSED);
  });
});

describe("the ledger read", () => {
  it("records a missing ledger ref as absent, and an existing one by its commit", () => {
    const dir = tmp("ledger");
    out(dir, ["init", "-q", "-b", "main"]);
    write(dir, { "a.txt": "a\n" });
    const sha = commit(dir, "one");
    const command = ledgerReadCommand("apache", "skywalking-banyandb", 7);
    const read = () => spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    expect(parseLedger(read().stdout)).toEqual({ present: false });
    out(dir, ["update-ref", "refs/graphloom/pr-review/apache/skywalking-banyandb/7", sha]);
    expect(parseLedger(read().stdout)).toEqual({ present: true, sha });
    expect(read().status).toBe(0);
  });

  it("refuses anything else", () => {
    expect(parseLedger("present zzz")).toBeUndefined();
    expect(parseLedger("")).toBeUndefined();
    void BANYANDB;
  });
});
