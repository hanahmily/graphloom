import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedRunner } from "@graphloom/runner";
import { createController, IntakeError, intakeTask, loadRunState, MAX_TASK_CONFIG_BYTES, parseTaskYaml, saveRunState, taskConfigValue } from "./index.js";

const execFileAsync = promisify(execFile);

/**
 * A bundle whose definition depends on its config, and which reports what it
 * received: describe pins it into a requirement statement, advance stops with
 * it as the blocker, and the validator returns it as its reason.
 */
const ECHO_PLUGIN = `
export function createGraph() {
  return {
    describe(config) {
      return {
        graphId: "configured",
        version: "1.0.0",
        stages: [{ id: "s", name: "S", requirementIds: ["r"] }],
        requirements: [{ id: "r", statement: "described with " + JSON.stringify(config ?? null), evidenceSchema: "x-v1" }],
        defaultValidators: [{ requirementId: "r", validatorId: "echo", version: "1" }],
      };
    },
    advance(view) {
      return { action: { type: "stop", stop: { reason: "echo", blocker: JSON.stringify(view.config ?? null) } }, reason: "echo the config" };
    },
  };
}
export function validatorById(id) {
  return id === "echo" ? { evaluate: (input) => ({ status: "passed", reason: JSON.stringify(input.config ?? null) }) } : undefined;
}
`;

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function makeEnv(options: { config?: string; taskConfig?: string; manifest?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-task-config-"));
  temps.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  const bundle = path.join(dir, "plugins", "configured");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  await writeFile(path.join(bundle, "dist", "index.js"), ECHO_PLUGIN);
  await writeFile(
    path.join(bundle, "graphloom.manifest.json"),
    JSON.stringify({ graphId: "configured", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./dist/index.js" }, ...options.manifest }),
  );
  if (options.config !== undefined) await writeFile(path.join(dir, "profile.json"), options.config);
  const taskPath = path.join(dir, "task.yaml");
  const configLine = options.taskConfig ?? (options.config !== undefined ? "config: profile.json\n" : "");
  await writeFile(taskPath, `graph: configured\nrepo: ./repo\n${configLine}request: "Echo the config."\n`);
  return { dir, repo, taskPath, configPath: path.join(dir, "profile.json"), stateRoot: path.join(dir, "state") };
}

const runner = () => createScriptedRunner({ jobs: [] });

describe("task config", () => {
  it("parses a config path from the task file", () => {
    expect(parseTaskYaml("graph: g\nrepo: r\nconfig: profiles/a.json\nrequest: go\n").config).toBe("profiles/a.json");
    expect(parseTaskYaml("graph: g\nrepo: r\nrequest: go\n").config).toBeUndefined();
  });

  it("pins the config's bytes and digest at intake, and hands the plugin exactly that JSON", async () => {
    const text = '{\n  "issue": {"owner": "o", "repo": "r"},\n  "list": [1, 2, 3]\n}\n';
    const env = await makeEnv({ config: text });
    const intake = await intakeTask(env.taskPath);
    expect(intake.config).toEqual({ path: "profile.json", sha256: createHash("sha256").update(text).digest("hex"), text });
    expect(taskConfigValue(intake)).toEqual({ issue: { owner: "o", repo: "r" }, list: [1, 2, 3] });
  });

  it("passes the config to describe, advance and every validator, and pins the definition it produced", async () => {
    const config = { label: "A" };
    const env = await makeEnv({ config: JSON.stringify(config) });
    const report = await createController().run({ taskPath: env.taskPath, runner: runner(), stateRoot: env.stateRoot, runId: "cfg-run" });
    expect(report).toMatchObject({ status: "stopped", stopReason: "echo", blocker: JSON.stringify(config) });
    const state = await loadRunState(report.stateDir);
    expect(state.definition.requirements[0]!.statement).toBe(`described with ${JSON.stringify(config)}`);
    expect(state.intake.config?.sha256).toBe(createHash("sha256").update(JSON.stringify(config)).digest("hex"));
    const inspected = await createController().inspect(report.stateDir);
    expect(inspected.config).toEqual({ path: "profile.json", sha256: state.intake.config!.sha256 });
  });

  it("resumes with the pinned config even after the file on disk changes", async () => {
    const env = await makeEnv({ config: JSON.stringify({ label: "A" }) });
    const first = await createController().run({ taskPath: env.taskPath, runner: runner(), stateRoot: env.stateRoot, runId: "cfg-resume" });
    expect(first.blocker).toBe('{"label":"A"}');
    await writeFile(env.configPath, JSON.stringify({ label: "B" }));
    const resumed = await createController().resume({ runRef: first.stateDir, runner: runner() });
    // A config read from disk would describe a different requirement and stop as a pin mismatch.
    expect(resumed).toMatchObject({ status: "stopped", stopReason: "echo", blocker: '{"label":"A"}' });
  });

  it("refuses a run whose pinned config was edited in its state file", async () => {
    const env = await makeEnv({ config: JSON.stringify({ label: "A" }) });
    const first = await createController().run({ taskPath: env.taskPath, runner: runner(), stateRoot: env.stateRoot, runId: "cfg-tamper" });
    const state = await loadRunState(first.stateDir);
    await saveRunState({ ...state, intake: { ...state.intake, config: { ...state.intake.config!, text: JSON.stringify({ label: "B" }) } } });
    const resumed = await createController().resume({ runRef: first.stateDir, runner: runner() });
    expect(resumed).toMatchObject({ status: "stopped", stopReason: "pin mismatch" });
    expect(resumed.blocker).toMatch(/pinned task config profile.json does not match its digest/);
  });

  it("runs a plugin without a config exactly as before", async () => {
    const env = await makeEnv();
    const intake = await intakeTask(env.taskPath);
    expect(intake.config).toBeUndefined();
    expect(taskConfigValue(intake)).toBeUndefined();
    const report = await createController().run({ taskPath: env.taskPath, runner: runner(), stateRoot: env.stateRoot, runId: "cfg-none" });
    expect(report).toMatchObject({ status: "stopped", stopReason: "echo", blocker: "null" });
    expect((await loadRunState(report.stateDir)).definition.requirements[0]!.statement).toBe("described with null");
  });

  it("never takes task settings from the config: its fields reach only the plugin", async () => {
    const config = { graph: "other", repo: "../elsewhere", request: "Do something else.", budgets: { agentInvocations: 1 }, grants: { sourceRepair: true } };
    const env = await makeEnv({ config: JSON.stringify(config) });
    const intake = await intakeTask(env.taskPath);
    expect(intake.task).toMatchObject({ graph: "configured", repo: "./repo", request: "Echo the config." });
    expect(intake.budgets.agentInvocations).toBe(64);
    expect(intake.grants).toEqual({ sourceRepair: false, validatorSubstitution: false });
    const report = await createController().run({ taskPath: env.taskPath, runner: runner(), stateRoot: env.stateRoot, runId: "cfg-opaque" });
    expect(JSON.parse(report.blocker!)).toEqual(config);
  });

  it("refuses a config that is not JSON, too large, missing, or outside the task directory", async () => {
    await expect(intakeTask((await makeEnv({ config: "{ not json" })).taskPath)).rejects.toThrow(/not valid JSON/);
    await expect(intakeTask((await makeEnv({ config: JSON.stringify({ pad: "x".repeat(MAX_TASK_CONFIG_BYTES) }) })).taskPath)).rejects.toThrow(/more than/);
    await expect(intakeTask((await makeEnv({ taskConfig: "config: absent.json\n" })).taskPath)).rejects.toThrow(/missing file/);
    await expect(intakeTask((await makeEnv({ taskConfig: "config: ../profile.json\n" })).taskPath)).rejects.toThrow(IntakeError);
  });

  it("refuses a task without a config when the manifest says the graph needs one", async () => {
    const env = await makeEnv({ manifest: { taskConfig: "required" } });
    await expect(intakeTask(env.taskPath)).rejects.toThrow(/needs a task config/);
    const configured = await makeEnv({ manifest: { taskConfig: "required" }, config: "{}" });
    expect((await intakeTask(configured.taskPath)).config?.text).toBe("{}");
  });

  it("keeps the config pin in the saved state", async () => {
    const env = await makeEnv({ config: '{"label":"A"}' });
    const report = await createController().run({ taskPath: env.taskPath, runner: runner(), stateRoot: env.stateRoot, runId: "cfg-saved" });
    const saved = JSON.parse(await readFile(path.join(report.stateDir, "state.json"), "utf8")) as { intake: { config?: { path: string; text: string } } };
    expect(saved.intake.config).toMatchObject({ path: "profile.json", text: '{"label":"A"}' });
  });

  it("pins the repository's top level when repo names a directory inside it", async () => {
    const env = await makeEnv();
    await mkdir(path.join(env.repo, "examples"));
    await writeFile(env.taskPath, `graph: configured\nrepo: ./repo/examples\nrequest: "Echo the config."\n`);
    const intake = await intakeTask(env.taskPath);
    expect(intake.repoPath).toBe(await realpath(env.repo));
  });

  it("refuses a repo that is not inside a git repository", async () => {
    const env = await makeEnv();
    await mkdir(path.join(env.dir, "plain"));
    await writeFile(env.taskPath, `graph: configured\nrepo: ./plain\nrequest: "Echo the config."\n`);
    await expect(intakeTask(env.taskPath)).rejects.toThrow(/not inside a git repository/);
  });
});
