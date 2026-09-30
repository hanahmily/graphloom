import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunState } from "@graphloom/controller";
import { candidateDiff, parseRepairVerdict, piRepairDeps, repairReviewPrompt, resolveBundlePath, resolveBundlePathForResume } from "../src/repair-config.js";
import type { SupervisorConfig } from "../src/supervisor-config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rootTsc = path.join(repoRoot, "node_modules", ".bin", "tsc");

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-repair-config-"));
  temps.push(dir);
  return dir;
}

const CONFIG: SupervisorConfig = { provider: "minimax-cn", modelId: "MiniMax-M3", models: [{ provider: "minimax-cn", modelId: "MiniMax-M3" }] };

describe("the reviewer's verdict line", () => {
  it("parses an approval or a rejection, case-insensitively, with the rest as the reason", () => {
    expect(parseRepairVerdict("VERDICT: approved\nThe patch fixes the defect and adds a regression test.")).toEqual({
      approved: true,
      reason: "The patch fixes the defect and adds a regression test.",
    });
    expect(parseRepairVerdict("verdict: REJECTED\nIt weakens the qualification cases.")).toEqual({
      approved: false,
      reason: "It weakens the qualification cases.",
    });
  });

  it("fails closed when the reviewer gives no VERDICT line", () => {
    const result = parseRepairVerdict("I think this looks fine.");
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("gave no VERDICT line");
  });
});

describe("the reviewer's assignment", () => {
  it("carries the original task and defect, the patch, its evidence and diff, and asks for a read-only, plain-text verdict", () => {
    const prompt = repairReviewPrompt({
      candidateRoot: "/repairs/r1/candidate",
      target: "validator",
      reason: "the changelog validator rejects a dated heading",
      task: "Release version 1.2.0",
      requirement: "the changelog entry matches the release heading pattern",
      patchSummary: "loosened the heading pattern to allow an optional date suffix",
      evidence: [{ ref: "e1", kind: "review", payload: { verdict: "request_changes" } }],
      diff: "--- a/src/validators.ts\n+++ b/src/validators.ts\n",
    });
    expect(prompt).toContain("/repairs/r1/candidate");
    expect(prompt).toContain("Target: validator");
    expect(prompt).toContain("Release version 1.2.0");
    expect(prompt).toContain("the changelog entry matches the release heading pattern");
    expect(prompt).toContain("the changelog validator rejects a dated heading");
    expect(prompt).toContain("loosened the heading pattern");
    expect(prompt).toContain("request_changes");
    expect(prompt).toContain("--- a/src/validators.ts");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("VERDICT: approved");
  });

  it("omits the requirement and patch summary lines when there is none", () => {
    const prompt = repairReviewPrompt({
      candidateRoot: "/repairs/r1/candidate",
      target: "plugin",
      reason: "the CONTRIBUTING.md digest no longer matches the pinned checklist",
      task: "Fix apache/skywalking#14111.",
      evidence: [],
      diff: "(no textual difference)",
    });
    expect(prompt).not.toContain("The disputed requirement:");
    expect(prompt).not.toContain("The patch author's own summary");
    expect(prompt).not.toContain("Evidence the supervisor cited");
  });
});

describe("resolving the installed bundle path", () => {
  it("resolves the plugins/<graph> directory beside the task file, the same way intake does", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "plugins", "hello"), { recursive: true });
    await writeFile(path.join(dir, "task.yaml"), 'graph: hello\nrepo: .\nrequest: "hi"\n', "utf8");
    const bundlePath = await resolveBundlePath(path.join(dir, "task.yaml"));
    expect(bundlePath).toBe(path.join(dir, "plugins", "hello"));
  });

  it("resolves a resuming run's bundle path from its own pinned intake", async () => {
    const dir = await tempDir();
    const stateDir = path.join(dir, "state", "run-1");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        runId: "run-1",
        status: "paused",
        mode: "normal",
        definition: { graphId: "hello", version: "0.1.0", stages: [], requirements: [], defaultValidators: [] },
        current: { stageId: "fix", attempt: 1 },
        receipts: [],
        evidence: [],
        outstanding: [],
        budgets: { agentInvocations: 1, jobs: 1, decisions: 1, corrections: 1, waitMs: 0, activeMs: 0 },
        generation: 1,
        activeVersion: "hello@0.1.0",
        intake: {
          taskPath: path.join(dir, "task.yaml"),
          taskDir: dir,
          task: { graph: "hello", repo: ".", request: "hi" },
          repoPath: dir,
          pinnedHead: "0".repeat(40),
          bundle: { graphId: "hello", version: "0.1.0", bundlePath: path.join(dir, "plugins", "hello"), sdkProtocol: 1, digests: {}, manifestRaw: "{}", manifestDigest: "d", entryDigest: "e" },
          grants: { sourceRepair: false, validatorSubstitution: false },
          budgets: { agentInvocations: 1, jobs: 1, decisions: 1, corrections: 1, waitMs: 0, activeMs: 0 },
        },
      }),
      "utf8",
    );
    expect(await loadRunState(stateDir)).toMatchObject({ runId: "run-1" });
    const bundlePath = await resolveBundlePathForResume(stateDir);
    expect(bundlePath).toBe(path.join(dir, "plugins", "hello"));
  });
});

describe("the repair preflight", () => {
  async function fakeBundle(): Promise<string> {
    const bundlePath = await tempDir();
    await mkdir(path.join(bundlePath, "node_modules", ".bin"), { recursive: true });
    await symlink(rootTsc, path.join(bundlePath, "node_modules", ".bin", "tsc"));
    return bundlePath;
  }

  async function candidate(source: string): Promise<string> {
    const root = await tempDir();
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "es2022", target: "es2022" }, include: ["*.ts"] }), "utf8");
    await writeFile(path.join(root, "index.ts"), source, "utf8");
    return root;
  }

  it("builds the candidate with the installed bundle's own tsc", async () => {
    const bundlePath = await fakeBundle();
    const deps = piRepairDeps(CONFIG, bundlePath);
    const ok = await candidate("export const x: number = 1;\n");
    await expect(deps.preflight({ candidateRoot: ok, target: "validator", baseDefinition: { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] } })).resolves.toMatchObject({ ok: true });

    const broken = await candidate("export const x: number = 'not a number';\n");
    const result = await deps.preflight({ candidateRoot: broken, target: "validator", baseDefinition: { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] } });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("does not build");
  });

  it("runs the installed bundle's scripts/qualify.mjs against the candidate, when it has one", async () => {
    const bundlePath = await fakeBundle();
    await mkdir(path.join(bundlePath, "scripts"), { recursive: true });
    await writeFile(
      path.join(bundlePath, "scripts", "qualify.mjs"),
      "const root = process.argv[2];\nconsole.log(`qualified ${root}`);\nprocess.exit(root.includes('candidate-b') ? 1 : 0);\n",
      "utf8",
    );
    const deps = piRepairDeps(CONFIG, bundlePath);
    const passing = await candidate("export const x: number = 1;\n");
    const passingResult = await deps.preflight({ candidateRoot: passing, target: "validator", baseDefinition: { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] } });
    expect(passingResult).toMatchObject({ ok: true });
    expect(passingResult.summary).toContain("qualified");
  });

  it("reports a candidate that fails qualification as not ok", async () => {
    const bundlePath = await fakeBundle();
    await mkdir(path.join(bundlePath, "scripts"), { recursive: true });
    await writeFile(path.join(bundlePath, "scripts", "qualify.mjs"), "console.error('the candidate reproduces no defect');\nprocess.exit(1);\n", "utf8");
    const deps = piRepairDeps(CONFIG, bundlePath);
    const root = await candidate("export const x: number = 1;\n");
    const result = await deps.preflight({ candidateRoot: root, target: "validator", baseDefinition: { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] } });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("qualification failed");
  });

  it("fails clearly when the installed bundle has no node_modules/.bin/tsc", async () => {
    const bundlePath = await tempDir();
    const deps = piRepairDeps(CONFIG, bundlePath);
    const root = await candidate("export const x = 1;\n");
    const result = await deps.preflight({ candidateRoot: root, target: "validator", baseDefinition: { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] } });
    expect(result).toMatchObject({ ok: false });
    expect(result.summary).toContain("npm ci");
  });

  it("skips scripts/qualify.mjs for a plugin or executor repair, since its validator-regression contract does not apply", async () => {
    const bundlePath = await fakeBundle();
    await mkdir(path.join(bundlePath, "scripts"), { recursive: true });
    // Mirrors the real qualify.mjs contract: rejects whenever the installed (unpatched)
    // validators already pass every case, which is always true for a patch that changes
    // no validator (an environment/checklist-only repair, for example).
    await writeFile(path.join(bundlePath, "scripts", "qualify.mjs"), "console.error('the old version passes all cases, so no defect is reproduced');\nprocess.exit(1);\n", "utf8");
    const deps = piRepairDeps(CONFIG, bundlePath);
    const root = await candidate("export const x: number = 1;\n");
    const baseDefinition = { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [] };

    const pluginResult = await deps.preflight({ candidateRoot: root, target: "plugin", baseDefinition });
    expect(pluginResult).toMatchObject({ ok: true });
    expect(pluginResult.summary).toContain("skipped for this target");

    const executorResult = await deps.preflight({ candidateRoot: root, target: "executor", baseDefinition });
    expect(executorResult).toMatchObject({ ok: true });

    const validatorResult = await deps.preflight({ candidateRoot: root, target: "validator", baseDefinition });
    expect(validatorResult.ok).toBe(false);
    expect(validatorResult.summary).toContain("qualification failed");
  });
});

describe("the candidate diff", () => {
  it("shows a unified diff from the installed bundle to the candidate, excluding node_modules, dist and .git", async () => {
    const bundlePath = await tempDir();
    await writeFile(path.join(bundlePath, "validator.ts"), "export const ok = false;\n", "utf8");
    await mkdir(path.join(bundlePath, "node_modules", "noise"), { recursive: true });
    await writeFile(path.join(bundlePath, "node_modules", "noise", "index.js"), "junk\n", "utf8");

    const candidateRoot = await tempDir();
    await writeFile(path.join(candidateRoot, "validator.ts"), "export const ok = true;\n", "utf8");
    await mkdir(path.join(candidateRoot, "node_modules", "noise"), { recursive: true });
    await writeFile(path.join(candidateRoot, "node_modules", "noise", "index.js"), "junk\n", "utf8");

    const diff = await candidateDiff(bundlePath, candidateRoot);
    expect(diff).toContain("-export const ok = false;");
    expect(diff).toContain("+export const ok = true;");
    // node_modules/noise/index.js is identical on both sides; excluding it means diff never
    // reads it at all, so its content ("junk") never appears, even though the invocation's
    // own --exclude flags (naming node_modules) show up in diff's per-file header line.
    expect(diff).not.toContain("junk");
  });

  it("reports no textual difference when the candidate matches the installed bundle", async () => {
    const bundlePath = await tempDir();
    await writeFile(path.join(bundlePath, "validator.ts"), "export const ok = false;\n", "utf8");
    const candidateRoot = await tempDir();
    await writeFile(path.join(candidateRoot, "validator.ts"), "export const ok = false;\n", "utf8");
    expect(await candidateDiff(bundlePath, candidateRoot)).toBe("(no textual difference)");
  });
});

describe("the reviewer's budget", () => {
  it("refuses to review without prompting when no agentInvocations allowance remains", async () => {
    const bundlePath = await tempDir();
    const deps = piRepairDeps(CONFIG, bundlePath);
    const result = await deps.reviewer.review({
      candidateRoot: "/repairs/r1/candidate",
      baseDigest: "base",
      candidateDigest: "candidate",
      target: "plugin",
      reason: "test",
      task: "test",
      evidence: [],
      maxProviderCalls: 0,
    });
    expect(result).toEqual({ approved: false, reason: "no agentInvocations budget remains for independent review" });
  });
});
