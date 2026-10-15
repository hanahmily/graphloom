import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import { createBuiltinExecutorRunner } from "@graphloom/runner";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { revertPatchPaths, runInCheckout } from "./checkout.js";

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

async function run(dir: string, pinnedHead: string, job: JobSpec & { checkout: { from: "candidate"; revertPatch?: string } }) {
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
    repoPath: dir,
    worktreePath: dir,
    pinnedHead,
    stateDir,
    artifactDir: stateDir,
    checks: [],
    prepare: [],
    runner,
    signal: new AbortController().signal,
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

describe("runInCheckout: revertPatch", () => {
  it("runs the full candidate unchanged when no revertPatch is given", async () => {
    const { dir, pinnedHead } = await candidateRepo();
    const { result } = await run(dir, pinnedHead, catJob("calc.go"));
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
