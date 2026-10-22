import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import { confinementUnsupported, createBuiltinExecutorRunner } from "@graphloom/runner";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { revertPatchPaths, runInCheckout } from "./checkout.js";
import { matchFiles } from "./prepare-cache.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BEFORE = "package calc\n\nfunc Classify(x int) string {\n\treturn \"small\"\n}\n";
const CANDIDATE = [
  'package calc\n\nfunc Classify(x int, mode string) string {\n\tif mode == "strict" && x > 100 {\n\t\treturn "large"\n\t}\n\treturn "small"\n}\n',
].join("");

/** A real git repo pinned at `BEFORE`, with `CANDIDATE`'s edit sitting uncommitted in the worktree. */
async function candidateRepo(): Promise<{ dir: string; pinnedHead: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphloom-checkout-"));
  cleanup.push(dir);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(dir, "calc.go"), BEFORE);
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  const pinnedHead = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(dir, "calc.go"), CANDIDATE);
  return { dir, pinnedHead };
}

function catJob(path_: string): JobSpec & { checkout: { from: "candidate"; revertPatch?: string } } {
  return {
    stageId: "fix",
    kind: "command",
    purpose: "check",
    instruction: "cat",
    readOnly: true,
    checkout: { from: "candidate" },
    input: { commands: [{ id: "cat", argv: ["cat", path_] }] },
  };
}

async function run(dir: string, pinnedHead: string, job: JobSpec & { checkout: { from: "candidate"; revertPatch?: string } }, repoPath = dir, scratchDir?: string) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-checkout-state-"));
  cleanup.push(stateDir);
  const runner = createBuiltinExecutorRunner({
    packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
    fallback: {
      runJob() {
        throw new Error("no non-command job expected in this test");
      },
    },
  });
  return runInCheckout({
    job,
    operationId: "op-1",
    generation: 1,
    runId: "run-1",
    repoPath,
    worktreePath: dir,
    pinnedHead,
    stateDir,
    artifactDir: stateDir,
    checks: [],
    prepare: [],
    runner,
    signal: new AbortController().signal,
    ...(scratchDir !== undefined ? { scratchDir } : {}),
  });
}

function stdout(evidence: NonNullable<Awaited<ReturnType<typeof run>>["result"]["evidence"]>): string {
  const item = evidence.find((e) => e.kind === "command");
  const command = (item?.payload as { command?: { stdoutTail?: string } } | undefined)?.command;
  return command?.stdoutTail ?? "";
}

describe("revertPatchPaths", () => {
  it("collects both sides of every file header, deduplicated and sorted", () => {
    const patch = [
      "diff --git a/b.go b/b.go",
      "--- a/b.go",
      "+++ b/b.go",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/old-name.go b/a.go",
      "--- a/old-name.go",
      "+++ b/a.go",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    expect(revertPatchPaths(patch)).toEqual(["a.go", "b.go", "old-name.go"]);
  });

  it("finds nothing in an empty patch", () => {
    expect(revertPatchPaths("")).toEqual([]);
  });
});

// Real confinement needs bubblewrap and unprivileged user namespaces; hosts without them refuse such jobs.
const confinementUnavailable = await confinementUnsupported();

describe("runInCheckout: revertPatch", () => {
  it("runs the full candidate unchanged when no revertPatch is given", async () => {
    const { dir, pinnedHead } = await candidateRepo();
    const { result } = await run(dir, pinnedHead, catJob("calc.go"));
    expect(result.status).toBe("ok");
    expect(stdout(result.evidence ?? [])).toBe(CANDIDATE);
  });

  it.skipIf(confinementUnavailable !== undefined)("lets a confined checkout job read the source repository's objects, with the repository under /tmp (#165)", async () => {
    const { dir, pinnedHead } = await candidateRepo();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "graphloom-checkout-scratch-"));
    cleanup.push(scratch);
    const job = { ...catJob("calc.go"), input: { commands: [{ id: "log", argv: ["git", "log", "--oneline"] }] } };
    const { result } = await run(dir, pinnedHead, job, dir, scratch);
    expect(result.status, result.summary).toBe("ok");
    expect(stdout(result.evidence ?? [])).toContain("init");
  });

  it("clones the repository a run pinned as one of its subdirectories", async () => {
    const { dir, pinnedHead } = await candidateRepo();
    const sub = path.join(dir, "examples");
    await mkdir(sub);
    const { result } = await run(dir, pinnedHead, catJob("calc.go"), sub);
    expect(result.status).toBe("ok");
    expect(stdout(result.evidence ?? [])).toBe(CANDIDATE);
  });

  it("applies a revertPatch in reverse, keeping the rest of the candidate", async () => {
    const { dir, pinnedHead } = await candidateRepo();
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    // The patch undoing just the behavioral fix (the strict/large branch),
    // keeping the new `mode` parameter the fix itself does not own.
    const withoutFix = 'package calc\n\nfunc Classify(x int, mode string) string {\n\t_ = mode\n\treturn "small"\n}\n';
    // Commit `withoutFix` as a throwaway HEAD so `git diff` can express the
    // withoutFix -> CANDIDATE change as a patch, without touching `pinnedHead`
    // (already captured as a fixed sha) or the final on-disk candidate content
    // `runInCheckout` reads directly from the worktree.
    await writeFile(path.join(dir, "calc.go"), withoutFix);
    await git("commit", "-q", "-am", "throwaway: without the fix");
    await writeFile(path.join(dir, "calc.go"), CANDIDATE);
    const revertPatch = (await git("diff", "--no-color", "--", "calc.go")).stdout;

    const { result } = await run(dir, pinnedHead, { ...catJob("calc.go"), checkout: { from: "candidate", revertPatch } });
    expect(result.status, result.summary).toBe("ok");
    expect(stdout(result.evidence ?? [])).toBe(withoutFix);
    const item = (result.evidence ?? []).find((e) => e.kind === "command");
    const checkout = (item?.payload as { checkout?: { reverted?: boolean; revertedPaths?: string[] } } | undefined)?.checkout;
    expect(checkout?.reverted).toBe(true);
    expect(checkout?.revertedPaths).toEqual(["calc.go"]);
  });

  it("reports a revertPatch that does not apply as evidence, not a failed job", async () => {
    const { dir, pinnedHead } = await candidateRepo();
    const bogusPatch = [
      "diff --git a/calc.go b/calc.go",
      "--- a/calc.go",
      "+++ b/calc.go",
      "@@ -1,3 +1,3 @@",
      "-this line does not exist in calc.go",
      "+neither does this one",
      "",
    ].join("\n");
    const { result } = await run(dir, pinnedHead, { ...catJob("calc.go"), checkout: { from: "candidate", revertPatch: bogusPatch } });
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("revertPatch does not apply");
    const checkout = (result.evidence?.[0]?.payload as { checkout?: { revertError?: string; revertPatch?: string; reverted?: boolean } }).checkout;
    expect(checkout?.revertError).toBeTruthy();
    expect(checkout?.reverted).toBeUndefined();
    expect(checkout?.revertPatch).toBe(bogusPatch);
    expect(result.evidence).toHaveLength(1);
  });
});

function catOut(evidence: NonNullable<Awaited<ReturnType<typeof run>>["result"]["evidence"]>): string {
  return stdout(evidence.filter((e) => (e.payload as { command?: { id?: string } }).command?.id === "cat"));
}

describe("runInCheckout: prepare cache (#174)", () => {
  /** A repo whose preparation copies `in.txt` to the ignored `gen/out.txt` and counts its runs. */
  async function prepRepo() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "graphloom-prep-"));
    const counter = path.join(dir, "..", `${path.basename(dir)}.count`);
    cleanup.push(dir, counter);
    const sh = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    await sh("init", "-q");
    await sh("config", "user.email", "test@example.com");
    await sh("config", "user.name", "Test");
    await writeFile(path.join(dir, ".gitignore"), "gen/\n");
    await writeFile(path.join(dir, "in.txt"), "one\n");
    await sh("add", ".");
    await sh("commit", "-q", "-m", "init");
    const pinnedHead = (await sh("rev-parse", "HEAD")).stdout.trim();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-prep-state-"));
    cleanup.push(stateDir);
    const script = `echo run >> ${counter}; mkdir -p gen && cp in.txt gen/out.txt`;
    const declared = { id: "generate", argv: ["sh", "-c", script], inputs: ["in.txt"], outputs: ["gen/**"] };
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
      fallback: {
        runJob() {
          throw new Error("no non-command job expected in this test");
        },
      },
    });
    let n = 0;
    const checkout = async (prepare: Array<Record<string, unknown>>, command = ["cat", "gen/out.txt"]) => {
      n += 1;
      const job: JobSpec & { checkout: { from: "candidate" } } = {
        stageId: "fix",
        kind: "command",
        purpose: "check",
        instruction: "cat",
        readOnly: true,
        checkout: { from: "candidate" },
        input: { commands: [{ id: "cat", argv: command }] },
      };
      return runInCheckout({
        job,
        operationId: `op-${n}`,
        generation: 1,
        runId: "run-1",
        repoPath: dir,
        worktreePath: dir,
        pinnedHead,
        stateDir,
        artifactDir: stateDir,
        checks: [],
        prepare: prepare as never,
        runner,
        signal: new AbortController().signal,
      });
    };
    const runs = async () => ((await readFile(counter, "utf8").catch(() => "")).match(/run/g) ?? []).length;
    const restoredKeys = (r: Awaited<ReturnType<typeof checkout>>) =>
      (r.result.evidence ?? []).flatMap((e) => {
        const tail = (e.payload as { command?: { stdoutTail?: string } }).command?.stdoutTail ?? "";
        return tail.startsWith("restored from cache ") ? [tail.slice("restored from cache ".length)] : [];
      });
    return { dir, stateDir, script, declared, checkout, runs, restoredKeys };
  }

  it("runs the command once and restores it for a second checkout with unchanged inputs", async () => {
    const t = await prepRepo();
    const first = await t.checkout([t.declared]);
    const second = await t.checkout([t.declared]);
    expect(first.result.status, first.result.summary).toBe("ok");
    expect(second.result.status, second.result.summary).toBe("ok");
    expect(await t.runs()).toBe(1);
    expect(t.restoredKeys(first)).toEqual([]);
    expect(t.restoredKeys(second)).toHaveLength(1);
    expect(t.restoredKeys(second)[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(catOut(second.result.evidence ?? [])).toBe("one\n");
  });

  it("re-runs when a declared input changed, and refreshes the cache", async () => {
    const t = await prepRepo();
    await t.checkout([t.declared]);
    await writeFile(path.join(t.dir, "in.txt"), "two\n");
    const changed = await t.checkout([t.declared]);
    expect(await t.runs()).toBe(2);
    expect(t.restoredKeys(changed)).toEqual([]);
    expect(catOut(changed.result.evidence ?? [])).toBe("two\n");
    const again = await t.checkout([t.declared]);
    expect(await t.runs()).toBe(2);
    expect(t.restoredKeys(again)).toHaveLength(1);
    expect(catOut(again.result.evidence ?? [])).toBe("two\n");
  });

  it("caches nothing when the command fails", async () => {
    const t = await prepRepo();
    const failing = { ...t.declared, argv: ["sh", "-c", `${t.script}; exit 3`] };
    const first = await t.checkout([failing]);
    const second = await t.checkout([failing]);
    expect(first.result.status).toBe("failed");
    expect(second.result.status).toBe("failed");
    expect(await t.runs()).toBe(2);
    expect(t.restoredKeys(second)).toEqual([]);
    expect(await readdir(path.join(t.stateDir, "prepare-cache")).catch(() => [])).toEqual([]);
  });

  it("always runs a prepare command that declares no inputs and outputs", async () => {
    const t = await prepRepo();
    const plain = { id: "generate", argv: t.declared.argv };
    await t.checkout([plain]);
    await t.checkout([plain]);
    expect(await t.runs()).toBe(2);
    await expect(readdir(path.join(t.stateDir, "prepare-cache"))).rejects.toThrow();
  });

  it("restores by copying: a job that edits restored output cannot change the cache", async () => {
    const t = await prepRepo();
    await t.checkout([t.declared]);
    const tamper = await t.checkout([t.declared], ["sh", "-c", "echo tampered >> gen/out.txt"]);
    expect(tamper.result.status, tamper.result.summary).toBe("ok");
    const third = await t.checkout([t.declared]);
    expect(await t.runs()).toBe(1);
    expect(catOut(third.result.evidence ?? [])).toBe("one\n");
  });

  it("treats a cache entry whose content no longer matches its digest as a miss", async () => {
    const t = await prepRepo();
    await t.checkout([t.declared]);
    const cache = path.join(t.stateDir, "prepare-cache", "generate");
    const [key] = await readdir(cache);
    await writeFile(path.join(cache, key!, "files", "0"), "corrupt\n");
    const again = await t.checkout([t.declared]);
    expect(await t.runs()).toBe(2);
    expect(catOut(again.result.evidence ?? [])).toBe("one\n");
  });
});

describe("matchFiles", () => {
  it("selects by ** / * / ? globs, honours ! exclusions and never enters a symlinked directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graphloom-glob-"));
    cleanup.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "graphloom-glob-out-"));
    cleanup.push(outside);
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await writeFile(path.join(root, "a", "x.go"), "");
    await writeFile(path.join(root, "a", "x_test.go"), "");
    await writeFile(path.join(root, "a", "b", "y.go"), "");
    await writeFile(path.join(root, "top.go"), "");
    await writeFile(path.join(outside, "z.go"), "");
    await symlink(outside, path.join(root, "a", "link"));
    expect(await matchFiles(root, ["a/**/*.go", "!**/*_test.go"])).toEqual(["a/b/y.go", "a/x.go"]);
    expect(await matchFiles(root, ["**/*.go"])).toContain("top.go");
    expect(await matchFiles(root, ["a/?.go"])).toEqual(["a/x.go"]);
    expect(await matchFiles(root, ["a/link/z.go"])).toEqual([]);
    expect(await matchFiles(root, ["a/link/**"])).toEqual([]);
  });
});

describe("runInCheckout: prepare cache ordering and symlinks (#174)", () => {
  async function repo() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "graphloom-prep2-"));
    const counter = path.join(dir, "..", `${path.basename(dir)}.count`);
    cleanup.push(dir, counter);
    const sh = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    await sh("init", "-q");
    await sh("config", "user.email", "test@example.com");
    await sh("config", "user.name", "Test");
    await writeFile(path.join(dir, ".gitignore"), "gen/\n");
    await writeFile(path.join(dir, "in.txt"), "one\n");
    await sh("add", ".");
    await sh("commit", "-q", "-m", "init");
    const pinnedHead = (await sh("rev-parse", "HEAD")).stdout.trim();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-prep2-state-"));
    cleanup.push(stateDir);
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
      fallback: {
        runJob() {
          throw new Error("no non-command job expected in this test");
        },
      },
    });
    let n = 0;
    const checkout = async (prepare: Array<Record<string, unknown>>) => {
      n += 1;
      const job: JobSpec & { checkout: { from: "candidate" } } = {
        stageId: "fix",
        kind: "command",
        purpose: "check",
        instruction: "cat",
        readOnly: true,
        checkout: { from: "candidate" },
        input: { commands: [{ id: "cat", argv: ["cat", "gen/out.txt"] }] },
      };
      return runInCheckout({
        job,
        operationId: `op-${n}`,
        generation: 1,
        runId: "run-1",
        repoPath: dir,
        worktreePath: dir,
        pinnedHead,
        stateDir,
        artifactDir: stateDir,
        checks: [],
        prepare: prepare as never,
        runner,
        signal: new AbortController().signal,
      });
    };
    const runs = async () => ((await readFile(counter, "utf8").catch(() => "")).match(/run/g) ?? []).length;
    return { dir, counter, stateDir, checkout, runs };
  }

  it("processes prepare commands in declaration order: an uncached cleanup before a cached generator does not delete what was restored", async () => {
    const t = await repo();
    const clean = { id: "clean", argv: ["sh", "-c", "rm -rf gen"] };
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cp in.txt gen/out.txt`],
      inputs: ["in.txt"],
      outputs: ["gen/**"],
    };
    const first = await t.checkout([clean, generate]);
    const second = await t.checkout([clean, generate]);
    expect(first.result.status, first.result.summary).toBe("ok");
    expect(second.result.status, second.result.summary).toBe("ok");
    expect(await t.runs()).toBe(1);
    expect(catOut(second.result.evidence ?? [])).toBe("one\n");
    const ids = (second.result.evidence ?? []).map((e) => (e.payload as { command?: { id?: string } }).command?.id);
    expect(ids.indexOf("clean")).toBeLessThan(ids.indexOf("generate"));
  });

  it("bypasses the cache when a declared input is a symbolic link, and says why", async () => {
    const t = await repo();
    await symlink("in.txt", path.join(t.dir, "link.txt"));
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cp link.txt gen/out.txt`],
      inputs: ["link.txt"],
      outputs: ["gen/**"],
    };
    const first = await t.checkout([generate]);
    await writeFile(path.join(t.dir, "in.txt"), "two\n");
    const second = await t.checkout([generate]);
    expect(await t.runs()).toBe(2);
    expect(catOut(first.result.evidence ?? [])).toBe("one\n");
    expect(catOut(second.result.evidence ?? [])).toBe("two\n");
    const bypass = (second.result.evidence ?? []).map((e) => (e.payload as { cache?: { reason?: string } }).cache?.reason);
    expect(bypass.find((r) => r !== undefined)).toMatch(/link\.txt is a symbolic link/);
  });
  it("saves a cached command's outputs before a later uncached command modifies them", async () => {
    const t = await repo();
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cp in.txt gen/out.txt`],
      inputs: ["in.txt"],
      outputs: ["gen/**"],
    };
    const append = { id: "append", argv: ["sh", "-c", "echo extra >> gen/out.txt"] };
    const first = await t.checkout([generate, append]);
    const second = await t.checkout([generate, append]);
    expect(first.result.status, first.result.summary).toBe("ok");
    expect(second.result.status, second.result.summary).toBe("ok");
    expect(await t.runs()).toBe(1);
    expect(catOut(first.result.evidence ?? [])).toBe("one\nextra\n");
    expect(catOut(second.result.evidence ?? [])).toBe("one\nextra\n");
  });

  it("bypasses the cache when a declared input lies behind a symbolic-link directory", async () => {
    const t = await repo();
    await mkdir(path.join(t.dir, "real"));
    await writeFile(path.join(t.dir, "real", "input"), "a\n");
    await symlink("real", path.join(t.dir, "linked"));
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cat in.txt linked/input > gen/out.txt`],
      inputs: ["in.txt", "linked/input"],
      outputs: ["gen/**"],
    };
    const first = await t.checkout([generate]);
    await writeFile(path.join(t.dir, "real", "input"), "b\n");
    const second = await t.checkout([generate]);
    expect(await t.runs()).toBe(2);
    expect(catOut(first.result.evidence ?? [])).toBe("one\na\n");
    expect(catOut(second.result.evidence ?? [])).toBe("one\nb\n");
    const reasons = (second.result.evidence ?? []).map((e) => (e.payload as { cache?: { reason?: string } }).cache?.reason);
    expect(reasons.find((r) => r !== undefined)).toMatch(/linked is a symbolic link/);
  });
  it("does not cache outputs when a symbolic-link directory hides part of an output glob", async () => {
    const t = await repo();
    await mkdir(path.join(t.dir, "real"));
    await symlink("real", path.join(t.dir, "linked"));
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cp in.txt gen/out.txt`],
      inputs: ["in.txt"],
      outputs: ["gen/out.txt", "linked/**"],
    };
    const first = await t.checkout([generate]);
    const second = await t.checkout([generate]);
    expect(first.result.status, first.result.summary).toBe("ok");
    expect(second.result.status, second.result.summary).toBe("ok");
    expect(await t.runs()).toBe(2);
    expect(await readdir(path.join(t.stateDir, "prepare-cache")).catch(() => [])).toEqual([]);
    const reasons = (second.result.evidence ?? []).map((e) => (e.payload as { cache?: { reason?: string } }).cache?.reason);
    expect(reasons.find((r) => r !== undefined)).toMatch(/linked is behind a symbolic link/);
  });

  it("leaves exactly the snapshot on a hit: a stale file matching an output glob is removed", async () => {
    const t = await repo();
    const listing = `${t.counter}.ls`;
    cleanup.push(listing);
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cp in.txt gen/out.txt`],
      inputs: ["in.txt"],
      outputs: ["gen/**"],
    };
    const stale = { id: "stale", argv: ["sh", "-c", "mkdir -p gen && echo old > gen/stale.txt"] };
    const list = { id: "list", argv: ["sh", "-c", `ls gen >> ${listing}`] };
    await t.checkout([generate]);
    const second = await t.checkout([stale, generate, list]);
    expect(second.result.status, second.result.summary).toBe("ok");
    expect(await t.runs()).toBe(1);
    expect((await readFile(listing, "utf8")).trim()).toBe("out.txt");
  });

  it("treats a cached file whose destination is now a directory as a miss, and removes nothing under it", async () => {
    const t = await repo();
    const listing = `${t.counter}.ls`;
    cleanup.push(listing);
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen; [ -d gen/out ] || cp in.txt gen/out`],
      inputs: ["in.txt"],
      outputs: ["gen/out"],
    };
    const dir = { id: "dir", argv: ["sh", "-c", "mkdir -p gen/out && echo keep > gen/out/keep.txt"] };
    const list = { id: "list", argv: ["sh", "-c", `ls gen/out >> ${listing}`] };
    await t.checkout([generate]);
    const second = await t.checkout([dir, generate, list]);
    expect(second.result.status, second.result.summary).toBe("ok");
    expect(await t.runs()).toBe(2);
    expect((await readFile(listing, "utf8")).trim()).toBe("keep.txt");
  });

  it("treats a declared output that the repository tracks as uncacheable", async () => {
    const t = await repo();
    const generate = {
      id: "generate",
      argv: ["sh", "-c", `echo run >> ${t.counter}; mkdir -p gen && cp in.txt gen/out.txt`],
      inputs: ["in.txt"],
      outputs: ["in.txt", "gen/**"],
    };
    await t.checkout([generate]);
    const second = await t.checkout([generate]);
    expect(await t.runs()).toBe(2);
    const reasons = (second.result.evidence ?? []).map((e) => (e.payload as { cache?: { reason?: string } }).cache?.reason);
    expect(reasons.find((r) => r !== undefined)).toMatch(/in\.txt is tracked/);
  });
});
