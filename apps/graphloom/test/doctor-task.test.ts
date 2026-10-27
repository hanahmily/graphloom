// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom doctor --task` (docs/design-release.md §4.4): the plugin's
 * environment checks, the supervisor selection `run` would make, and each
 * agent role the plugin declares in `GraphDefinition.agentRoles`, on a
 * fixture plugin and on issue-fix, with stub agents on a stubbed PATH.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createScope, copyBundle, type TestScope } from "@graphloom/testkit";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "../src/doctor.js";
import { STUB_SECRETS, makeDoctorEnv, removeDoctorBase, repoRoot, type DoctorEnv } from "./doctor-env.js";

afterAll(removeDoctorBase);
let scope: TestScope = createScope();
afterEach(async () => {
  await scope.dispose();
  scope = createScope();
});

const row = (report: DoctorReport, name: string): DoctorCheck => {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no ${name} check in ${JSON.stringify(report.checks.map((c) => c.name))}`);
  return found;
};

async function repo(env: DoctorEnv): Promise<void> {
  const dir = path.join(env.root, "test-repo");
  await mkdir(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: env.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: env.env });
  await mkdir(path.join(env.root, "plugins"));
}

/** A copy of hello whose describe() declares `roles` and two environment checks, one failing. */
async function fixturePlugin(roles: unknown[]): Promise<string> {
  const bundle = await copyBundle(scope, path.join(repoRoot, "examples", "plugins", "hello"));
  await writeFile(
    path.join(bundle, "dist", "doctor-fixture.js"),
    `import { createGraph as base } from "./index.js";
export * from "./index.js";
export function createGraph() {
  const graph = base();
  const wrapped = Object.create(graph);
  wrapped.describe = async (config) => ({
    ...(await graph.describe(config)),
    environment: { checks: [{ id: "has-sh", argv: ["sh", "-c", "echo ok"] }, { id: "needs-docker", argv: ["sh", "-c", "echo docker is required >&2; exit 3"] }] },
    agentRoles: ${JSON.stringify(roles)},
  });
  return wrapped;
}
`,
  );
  const manifestFile = path.join(bundle, "graphloom.manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { entryPoints: Record<string, string> };
  manifest.entryPoints.createGraph = "./dist/doctor-fixture.js";
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  return bundle;
}

async function doctorTask(env: DoctorEnv, task: string): Promise<{ report: DoctorReport; code: number; text: string }> {
  const json = await env.run(["doctor", "--task", task, "--json"]);
  const text = await env.run(["doctor", "--task", task]);
  for (const secret of Object.values(STUB_SECRETS)) expect(json.stdout + text.stdout).not.toContain(secret);
  expect(json.stdout, json.stderr).not.toBe("");
  return { report: JSON.parse(json.stdout) as DoctorReport, code: json.code, text: text.stdout };
}

describe("graphloom doctor --task", () => {
  it("on a fixture plugin: environment checks, the supervisor selection, and each role with its alternatives", async () => {
    const env = await makeDoctorEnv({ codex: "loggedout", piEnv: true });
    await repo(env);
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", harnesses: ["claude-code", "pi"], allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } }));
    await writeFile(env.supervisorFile, JSON.stringify({ provider: "minimax-cn", modelId: "MiniMax-M3" }));
    const bundle = await fixturePlugin([
      { role: "writer", harness: "codex", access: "write", setting: "roles.writer" },
      { role: "grader", harness: "codex", access: "read", setting: "roles.grader" },
      { role: "checker", harness: "claude-code", access: "read", setting: "roles.checker" },
      { role: "auditor", harness: "claude-code", access: "read", distinctFrom: ["checker"], setting: "roles.auditor" },
      { role: "builder", harness: "pi", access: "write" },
    ]);
    await symlink(bundle, path.join(env.root, "plugins", "hello"));
    await writeFile(path.join(env.root, "task.yaml"), `graph: hello\nrepo: ./test-repo\nrequest: "Create GREETING.txt"\n`);

    const { report, code, text } = await doctorTask(env, "task.yaml");
    expect(code).toBe(1);
    expect(row(report, "plugin")).toMatchObject({ status: "pass", detail: "hello@0.1.0" });
    expect(row(report, "environment has-sh")).toMatchObject({ status: "pass" });
    expect(row(report, "environment needs-docker")).toMatchObject({ status: "fail", detail: expect.stringContaining("docker is required"), fix: expect.stringContaining("graphloom check") });
    expect(row(report, "supervisor selection")).toMatchObject({ status: "pass", detail: expect.stringContaining("pi (minimax-cn/MiniMax-M3") });

    // A read-only harness on a write role.
    expect(row(report, "role writer")).toMatchObject({
      status: "fail",
      detail: "writer: codex (write): codex serves read-only jobs only; alternatives: claude-code, pi",
      fix: `set roles.writer to "claude-code" or "pi" in the task's config`,
    });
    // An unavailable role harness.
    expect(row(report, "role grader")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("codex is not available: not logged in (codex login status); alternatives: claude-code, pi"),
      fix: `set roles.grader to "claude-code" or "pi" in the task's config, or codex login`,
    });
    expect(row(report, "role checker").status).toBe("pass");
    // A distinctFrom conflict.
    expect(row(report, "role auditor")).toMatchObject({
      status: "fail",
      detail: "auditor: claude-code (read): it must not share its harness with checker; alternatives: pi",
      fix: `set roles.auditor to "pi" in the task's config`,
    });
    expect(row(report, "role builder")).toMatchObject({ status: "pass", detail: "builder: pi (write); enabled and available; alternatives: claude-code" });
    expect(text).toMatch(/^Task$/m);
    expect(text).toContain('fix: set roles.auditor to "pi" in the task\'s config');
  });

  it("on issue-fix on a host with only Claude Code: the reviewer needs Codex (codex login) or a profile change", async () => {
    const env = await makeDoctorEnv({ codex: "loggedout" });
    await repo(env);
    await symlink(path.join(repoRoot, "examples", "plugins", "issue-fix"), path.join(env.root, "plugins", "issue-fix"));
    await mkdir(path.join(env.root, "profiles"));
    await copyFile(path.join(repoRoot, "examples", "plugins", "issue-fix", "profiles", "graphloom.json"), path.join(env.root, "profiles", "graphloom.json"));
    await writeFile(path.join(env.root, "issue-fix-task.yaml"), `graph: issue-fix\nrepo: ./test-repo\nconfig: profiles/graphloom.json\nrequest: "Fix hanahmily/graphloom#1"\n`);
    await mkdir(path.dirname(env.runnerFile), { recursive: true });
    await writeFile(env.runnerFile, JSON.stringify({ harness: "claude-code", allowUnrestricted: true }));

    const { report, code } = await doctorTask(env, "issue-fix-task.yaml");
    expect(code).toBe(1);
    expect(row(report, "plugin").detail).toBe("issue-fix@0.15.0");
    // The plugin's own checks: GraphLoom runs on its bundled Node, but this target repository needs one.
    expect(row(report, "environment node")).toMatchObject({ status: "fail", detail: expect.stringContaining("Node.js >= 22 is required") });
    expect(row(report, "environment ocr").status).toBe("pass");
    expect(row(report, "environment claude").status).toBe("pass");
    expect(row(report, "environment codex")).toMatchObject({ status: "fail", detail: expect.stringContaining("Codex is not logged in") });
    expect(row(report, "supervisor selection")).toMatchObject({ status: "warn", fix: "graphloom setup" });
    expect(row(report, "role implementer")).toMatchObject({ status: "pass" });
    expect(row(report, "role reviewer")).toMatchObject({
      status: "fail",
      detail: "reviewer: codex (read): codex is not available: not logged in (codex login status); alternatives: none",
      fix: "codex login",
    });
    expect(row(report, "role verifier")).toMatchObject({ status: "pass" });
  });

  it("names a plugin that cannot be loaded", async () => {
    const env = await makeDoctorEnv({});
    await repo(env);
    await writeFile(path.join(env.root, "task.yaml"), `graph: nowhere\nrepo: ./test-repo\nrequest: "x"\n`);
    const { report, code } = await doctorTask(env, "task.yaml");
    expect(code).toBe(1);
    expect(row(report, "plugin")).toMatchObject({ status: "fail", fix: expect.stringContaining("graphloom check") });
  });
});
