#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * GraphLoom CLI: run | inspect | stats | wait | stop | resume | switch-model | delete | version | doctor | setup | skills
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createController, loadRunState, resolveStateDir } from "@graphloom/controller";
import type { GraphRehearsal } from "@graphloom/sdk";
import type { RunReport } from "@graphloom/controller";
import { createCliRunner } from "./cli-runner.js";
import { harnessRepairDeps, resolveBundlePath, resolveBundlePathForResume } from "./repair-config.js";
import { switchModelTarget } from "./switch-model.js";
import { check, probe, recordScenario, rehearse, rehearseStopAt, replay, resumeRehearsal } from "./rehearsal.js";
import { dispatchToOwner, installHome, recordOwnership, removeOwnershipRecord, selfInstall } from "./ownership.js";
import { requireRunnerConfig, runnerConfigPath } from "./runner-config.js";
import { discover, probeEnabledSupervisors } from "./discovery.js";
import { doctorReport, formatDoctor, taskProfile, type TaskInputs } from "./doctor.js";
import { describeTask } from "./rehearsal.js";
import { SANDBOX_USAGE, sandboxCommand } from "./sandbox.js";
import { isInteractive, runSetup, terminalPrompter } from "./setup.js";
import { onceStopHook, parseDuration, waitForRun, type StopNotice } from "./notify.js";
import { formatRunStats, loadRunStats } from "./stats.js";
import { formatProgress, waitForProgress } from "./progress.js";
import { formatSkillsStatus, installSkills, parseSkillAgent, removeSkills, skillsStatus, updateSkills, type SkillAgent } from "./skills.js";
import { formatVersion, installRoot } from "./version.js";
import { JOB_TIMEOUT_MS, killActiveChildren, runAutoUpdate } from "./auto-update.js";
import {
  loadSupervisorConfig,
  resumeSupervisorPlan,
  type ResumeSupervisorPlan,
  supervisorChooser,
  supervisorFactoryFor,
  supervisorRestore,
} from "./supervisor-config.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "version" || cmd === "--version" || cmd === "-V") {
    console.log(formatVersion(installRoot(), args.slice(1)));
    return;
  }

  // The detached daily update check the shim starts (docs/design-release.md §5.4); hidden from help.
  if (cmd === "__auto-update") {
    setTimeout(() => {
      console.log(`${new Date().toISOString()} auto-update: stopped after ${JOB_TIMEOUT_MS} ms`);
      killActiveChildren();
      process.exit(1);
    }, JOB_TIMEOUT_MS).unref();
    await runAutoUpdate();
    return;
  }

  if (cmd === "upgrade" || cmd === "self") {
    console.error(`graphloom ${cmd} is handled by the installed shim (~/.local/bin/graphloom), which runs install.sh in sh; this tree was started directly`);
    process.exitCode = 2;
    return;
  }

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exitCode = cmd ? 0 : 1;
    return;
  }

  if (cmd === "doctor") {
    const taskFlag = flagValue(args, "--task");
    if (args.includes("--task") && (taskFlag === undefined || taskFlag.startsWith("--"))) throw new Error("--task needs a task file");
    const discovery = await discover();
    let task: TaskInputs | undefined;
    if (taskFlag !== undefined) {
      const taskPath = path.resolve(taskFlag);
      task = await describeTask(taskPath).then(
        (t) => ({ taskPath, definition: t.definition, environment: t.environment, ...(t.config !== undefined ? { profile: taskProfile(taskPath, t.config)! } : {}) }),
        (err: unknown) => ({ taskPath, environment: [], error: err instanceof Error ? err.message : String(err) }),
      );
      // Probe the enabled supervisors as run would for this task: on the models its plugin's hints put first.
      const preference = task.definition?.supervisor;
      if (preference?.models !== undefined && discovery.supervisor.config !== undefined) {
        task.supervisorEnabled = await probeEnabledSupervisors(discovery.supervisor.config, discovery.pi, discovery.env, preference);
      }
    }
    const report = doctorReport(discovery, task);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctor(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (cmd === "setup") {
    const yes = args.includes("--yes") || args.includes("-y");
    if (!yes && !isInteractive(args)) {
      console.error("graphloom setup asks its questions on a terminal; in scripts, run graphloom setup --yes to accept the recommendations");
      process.exitCode = 1;
      return;
    }
    const prompter = yes ? undefined : terminalPrompter();
    try {
      const result = await runSetup({ yes, ...(prompter !== undefined ? { prompter } : {}) });
      process.exitCode = result.exitCode;
    } finally {
      prompter?.close();
    }
    return;
  }

  if (cmd === "skills") {
    process.exitCode = await skillsCommand(args.slice(1));
    return;
  }

  if (cmd === "sandbox") {
    process.exitCode = await sandboxCommand(args.slice(1));
    return;
  }

  // A run-scoped command on a run another installed version owns runs there (docs/design-release.md §5.1).
  const self = selfInstall();
  const dispatched = await dispatchToOwner(cmd, args, self);
  if (dispatched !== undefined) {
    process.exitCode = dispatched;
    return;
  }

  await firstRunSetup(cmd, args);

  const controller = createController();

  if (cmd === "run") {
    const taskPath = path.resolve(args[1] ?? "task.yaml");
    const stateRootFlag = flagValue(args, "--state-root");
    const stateRoot = stateRootFlag ? path.resolve(stateRootFlag) : undefined;
    const stopHook = armStopHook(args);
    const runnerConfig = await requireRunnerConfig(process.env, (loaded) => stopHook.useConfig(loaded.notify));
    const runner = createCliRunner(runnerConfig);
    const config = await loadSupervisorConfig();
    // design-supervisor-harnesses.md §7.3: --supervisor, then the operator's select, then the plugin's
    // preference, then the operator's order; resolved once the plugin described itself, and pinned at intake.
    const supervisorFlag = flagValue(args, "--supervisor");
    if (args.includes("--supervisor") && (supervisorFlag === undefined || supervisorFlag.startsWith("--"))) throw new Error("--supervisor needs a harness");
    if (supervisorFlag !== undefined && config === undefined) {
      throw new Error(`--supervisor ${supervisorFlag} needs an operator supervisor config that enables it ($GRAPHLOOM_SUPERVISOR_CONFIG or ~/.config/graphloom/supervisor.json)`);
    }
    const bundlePath = await resolveBundlePath(taskPath).catch(() => undefined);
    const report = await controller.run({
      taskPath,
      install: self.record,
      onRunCreated: async ({ runId, stateDir }) => {
        crashContext = { runId, stateDir };
        // A run started in the background is found by this line (wait, stats and inspect take either).
        console.error(`graphloom: run ${runId} started; state ${stateDir}`);
        await recordOwnership(self, { runId, stateDir, ...(bundlePath !== undefined ? { plugin: bundlePath } : {}) });
      },
      runner,
      ...(stateRoot !== undefined ? { stateRoot } : {}),
      ...(config !== undefined
        ? {
            selectSupervisor: supervisorChooser(config, {
              ...(supervisorFlag !== undefined ? { flag: supervisorFlag } : {}),
              bundlePath: async () => bundlePath ?? (await resolveBundlePath(taskPath)),
              onSelected: (selection, warnings) => {
                console.error(`supervisor: ${selection.harness} (${selection.source}: ${selection.reason})`);
                for (const w of warnings) console.error(`supervisor: ${w}`);
              },
            }),
          }
        : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "succeeded" ? 0 : 1;
    await stopHook.fire(stopNotice(report));
    return;
  }

  if (cmd === "inspect") {
    const runRef = requireRunRef(args[1], "inspect <stateDir|runId>");
    const stateRoot = flagValue(args, "--state-root");
    const report = await controller.inspect(
      runRef,
      stateRoot ? { stateRoot: path.resolve(stateRoot) } : undefined,
    );
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "stats") {
    const runRef = requireRunRef(args[1], "stats <stateDir|runId> [--state-root <dir>] [--json]");
    const stateRoot = flagValue(args, "--state-root");
    const stats = await loadRunStats(runRef, stateRoot ? path.resolve(stateRoot) : undefined);
    console.log(args.includes("--json") ? JSON.stringify(stats, null, 2) : formatRunStats(stats));
    return;
  }

  if (cmd === "wait") {
    const usage = "wait <stateDir|runId> [--state-root <dir>] [--until stop|progress] [--since <cursor>] [--timeout <dur>] [--json]";
    const runRef = requireRunRef(args[1], usage);
    const stateRootFlag = flagValue(args, "--state-root");
    const stateRoot = stateRootFlag ? path.resolve(stateRootFlag) : undefined;
    const timeout = flagValue(args, "--timeout");
    const until = flagValue(args, "--until") ?? "stop";
    if (until !== "stop" && until !== "progress") throw new Error(`--until must be "stop" or "progress", not ${JSON.stringify(until)}`);
    // An empty cursor (a watcher's first wait, `--since "$(cat cursor)"`) is no cursor.
    const sinceFlag = flagValue(args, "--since");
    if (args.includes("--since") && (sinceFlag === undefined || sinceFlag.startsWith("--"))) throw new Error("--since needs a cursor");
    const since = sinceFlag === "" ? undefined : sinceFlag;
    if (since !== undefined && until !== "progress") throw new Error("--since needs --until progress");
    if (until === "progress") {
      const progress = await waitForProgress(runRef, {
        ...(stateRoot !== undefined ? { stateRoot } : {}),
        ...(timeout !== undefined ? { timeoutMs: parseDuration(timeout) } : {}),
        ...(since !== undefined ? { since } : {}),
      });
      console.log(args.includes("--json") ? JSON.stringify(progress, null, 2) : formatProgress(progress));
      if (progress.outcome === "timeout") process.exitCode = 2;
      if (progress.outcome === "orphaned") {
        console.error(`run is recorded as running but ${progress.detail}; the controller died without recording a stop. \`graphloom resume\` takes it over.`);
        process.exitCode = 3;
      }
      return;
    }
    const result = await waitForRun(runRef, {
      ...(stateRoot !== undefined ? { stateRoot } : {}),
      ...(timeout !== undefined ? { timeoutMs: parseDuration(timeout) } : {}),
    });
    if (result.outcome === "timeout") {
      console.error(`timed out: run is still running (${result.stateDir})`);
      process.exitCode = 2;
      return;
    }
    const stats = await loadRunStats(result.stateDir);
    console.log(args.includes("--json") ? JSON.stringify(stats, null, 2) : formatRunStats(stats));
    if (result.outcome === "orphaned") {
      console.error(`run is recorded as running but ${result.detail}; the controller died without recording a stop. \`graphloom resume\` takes it over.`);
      process.exitCode = 3;
    }
    return;
  }

  if (cmd === "stop") {
    const runRef = requireRunRef(args[1], "stop <stateDir|runId>");
    const stateRoot = flagValue(args, "--state-root");
    const report = await controller.stop(
      runRef,
      stateRoot ? { stateRoot: path.resolve(stateRoot) } : undefined,
    );
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "resume") {
    const runRef = requireRunRef(args[1], "resume <stateDir|runId> [--state-root <dir>] [--supervisor <harness> [--reason <text>]] [--upgrade] [--update-plugin] [--update-executors] [--reconciled] [--rehearsal] [--on-stop <command>]");
    const stateRoot = flagValue(args, "--state-root");
    // `--upgrade` moves the run to this GraphLoom first (§5.2), and moves its ownership record with it.
    const upgrade = args.includes("--upgrade")
      ? {
          install: self.record,
          onMoved: async (moved: { runId: string; stateDir: string; bundlePath: string }) => {
            if (self.home !== undefined) await recordOwnership(self, { runId: moved.runId, stateDir: moved.stateDir, plugin: moved.bundlePath });
            else await removeOwnershipRecord(installHome(self), moved.runId, moved.stateDir).catch(() => undefined);
          },
        }
      : undefined;
    if (args.includes("--rehearsal")) {
      // A rehearsal's kept run continues on its own stand-ins (docs/design-release.md §6 step 8.7); no runner config is read.
      const report = await resumeRehearsal(runRef, {
        ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
        ...(upgrade !== undefined ? { upgrade } : {}),
        ...(args.includes("--update-plugin") ? { updatePlugin: true } : {}),
        ...(args.includes("--update-executors") ? { updateExecutors: true } : {}),
        ...(args.includes("--reconciled") ? { reconciled: true } : {}),
      });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "succeeded" ? 0 : 1;
      return;
    }
    const stopHook = armStopHook(args, {
      runId: path.basename(runRef),
      stateDir: resolveStateDir(runRef, stateRoot ? path.resolve(stateRoot) : undefined).catch(() => ""),
    });
    const runnerConfig = await requireRunnerConfig(process.env, (loaded) => stopHook.useConfig(loaded.notify));
    const runner = createCliRunner(runnerConfig);
    const config = await loadSupervisorConfig();
    const resolvedRoot = stateRoot ? path.resolve(stateRoot) : undefined;
    const supervisorFlag = flagValue(args, "--supervisor");
    if (args.includes("--supervisor") && (supervisorFlag === undefined || supervisorFlag.startsWith("--"))) throw new Error("--supervisor needs a harness");
    const transitionReason = flagValue(args, "--reason");
    // The supervisor and its repair reviewer run on the harness the run is pinned to (§7.4, §7.5);
    // --supervisor moves the pin, recorded as a transition.
    const current = await loadRunState(await resolveStateDir(runRef, resolvedRoot));
    // A finished run only reports itself on resume; its supervisor is not consulted.
    const finished = current.status === "succeeded" || current.status === "failed";
    const plan: ResumeSupervisorPlan = finished
      ? {}
      : await resumeSupervisorPlan(config, current, {
          ...(supervisorFlag !== undefined ? { flag: supervisorFlag } : {}),
          ...(transitionReason !== undefined ? { reason: transitionReason } : {}),
        });
    if (plan.pin?.transition !== undefined) console.error(`supervisor: ${plan.pin.transition.from} -> ${plan.pin.transition.to} (${plan.pin.transition.reason})`);
    const report = await controller.resume({
      runRef,
      runner,
      ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
      ...(args.includes("--update-plugin") ? { updatePlugin: true } : {}),
      ...(args.includes("--update-executors") || upgrade !== undefined ? { updateExecutors: true } : {}),
      ...(upgrade !== undefined ? { upgrade } : {}),
      ...(args.includes("--reconciled") ? { reconciled: true } : {}),
      // The controller has no restore of its own: a run's supervisor binding
      // is restored on the harness it is pinned to, with or without a config.
      restoreSupervisor: supervisorRestore(plan.config ?? config),
      ...(plan.pin !== undefined ? { supervisorPin: plan.pin } : {}),
      ...(plan.config !== undefined && plan.harness !== undefined
        ? {
            supervisorFactory: supervisorFactoryFor(plan.config, plan.harness),
            repair: harnessRepairDeps(plan.harness, plan.config, await resolveBundlePathForResume(runRef, resolvedRoot)),
          }
        : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "succeeded" ? 0 : 1;
    await stopHook.fire(stopNotice(report));
    return;
  }

  if (cmd === "delete") {
    const runRef = requireRunRef(args[1], "delete <stateDir|runId> [--state-root <dir>] [--force]");
    const stateRoot = flagValue(args, "--state-root");
    const report = await controller.delete(runRef, {
      ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
      force: args.includes("--force"),
    });
    await removeOwnershipRecord(installHome(self), report.runId, report.stateDir).catch(() => undefined);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "switch-model") {
    const usage = "switch-model <stateDir|runId> <model> --reason <text> [--state-root <dir>]";
    const runRef = requireRunRef(args[1], usage);
    const reason = flagValue(args, "--reason");
    if (!args[2] || !reason) {
      console.error(`usage: graphloom ${usage}`);
      process.exitCode = 1;
      return;
    }
    const stateRoot = flagValue(args, "--state-root");
    const resolvedRoot = stateRoot ? path.resolve(stateRoot) : undefined;
    // Only a model of the harness the run is pinned to (design-supervisor-harnesses.md §4.4).
    const target = switchModelTarget(args[2], await loadSupervisorConfig(), await loadRunState(await resolveStateDir(runRef, resolvedRoot)));
    await controller.switchModel(runRef, { ...target, reason }, resolvedRoot !== undefined ? { stateRoot: resolvedRoot } : undefined);
    console.log(`switch to ${target.provider}/${target.modelId} requested; applied before the run's next supervisor prompt`);
    return;
  }

  if (cmd === "check") {
    const taskPath = path.resolve(args[1] ?? "task.yaml");
    const report = await check(taskPath);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (cmd === "rehearse") {
    const recordFrom = flagValue(args, "--record-from");
    if (recordFrom !== undefined) {
      const stateRoot = flagValue(args, "--state-root");
      const recorded = await recordScenario(recordFrom, stateRoot ? { stateRoot: path.resolve(stateRoot) } : {});
      const name = flagValue(args, "--name") ?? recorded.name;
      const rehearsal: GraphRehearsal = { scenarios: { [name]: recorded.scenario } };
      const out = JSON.stringify(rehearsal, null, 2);
      const outPath = flagValue(args, "--out");
      if (outPath !== undefined) await writeFile(path.resolve(outPath), `${out}\n`, "utf8");
      console.log(out);
      return;
    }
    const taskPath = path.resolve(args[1] ?? "task.yaml");
    const scenario = flagValue(args, "--scenario");
    const commands = requireCommandsMode(args);
    const stopAt = flagValue(args, "--stop-at");
    if (args.includes("--stop-at")) {
      if (stopAt === undefined || stopAt.startsWith("--")) throw new Error("--stop-at needs a stage name or id");
      const plugin = await resolveBundlePath(taskPath).catch(() => undefined);
      const stopped = await rehearseStopAt(taskPath, stopAt, {
        ...(scenario !== undefined ? { scenario } : {}),
        ...(commands !== undefined ? { commands } : {}),
        offline: args.includes("--offline"),
        synthesized: args.includes("--synthesized"),
        adversarial: args.includes("--adversarial"),
        install: self.record,
        onRunCreated: ({ runId, stateDir }) => recordOwnership(self, { runId, stateDir, ...(plugin !== undefined ? { plugin } : {}) }),
      });
      console.log(JSON.stringify(stopped, null, 2));
      process.exitCode = stopped.ok ? 0 : 1;
      return;
    }
    const report = await rehearse(taskPath, {
      ...(scenario !== undefined ? { scenario } : {}),
      ...(commands !== undefined ? { commands } : {}),
      keep: args.includes("--keep"),
      offline: args.includes("--offline"),
      synthesized: args.includes("--synthesized"),
      adversarial: args.includes("--adversarial"),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.verdict === "not-ready" ? 1 : 0;
    return;
  }

  if (cmd === "replay") {
    const runRef = requireRunRef(args[1], "replay <stateDir|runId> [--state-root <dir>]");
    const stateRoot = flagValue(args, "--state-root");
    const report = await replay(runRef, stateRoot ? { stateRoot: path.resolve(stateRoot) } : {});
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "probe") {
    const usage = "probe <task.yaml> --contract <name> [--scenario <name>] [--commands <stub|run>]";
    const taskPath = path.resolve(args[1] ?? "task.yaml");
    const contract = flagValue(args, "--contract");
    if (!contract) {
      console.error(`usage: graphloom ${usage}`);
      process.exitCode = 1;
      return;
    }
    const scenario = flagValue(args, "--scenario");
    const commands = requireCommandsMode(args);
    const report = await probe(taskPath, {
      contract,
      ...(scenario !== undefined ? { scenario } : {}),
      ...(commands !== undefined ? { commands } : {}),
      offline: args.includes("--offline"),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "ok" && report.check?.status !== "invalid" ? 0 : 1;
    return;
  }

  console.error(`unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 1;
}

/** The commands that look for the runner config first (docs/design-release.md §4.5). */
const FIRST_RUN_COMMANDS: ReadonlySet<string> = new Set(["run", "resume", "probe", "check", "rehearse"]);

/**
 * Automatic first run (§4.5): with no runner config at the default path, an
 * interactive invocation starts the guided setup and then continues with the
 * new configuration; if setup is declined or fails, the command continues as
 * it would with none. A non-interactive one never prompts: `check` and
 * `rehearse` say so on stderr and continue, and `run`, `resume`, and `probe`
 * refuse when they read the config. A missing file named by
 * `GRAPHLOOM_RUNNER_CONFIG` is an error and never starts setup.
 */
async function firstRunSetup(cmd: string, args: string[]): Promise<void> {
  if (!FIRST_RUN_COMMANDS.has(cmd)) return;
  // These forms read no runner config.
  if (cmd === "resume" && args.includes("--rehearsal")) return;
  if (cmd === "rehearse" && args.includes("--record-from")) return;
  const { file, explicit } = runnerConfigPath();
  if (explicit || existsSync(file)) return;
  if (!isInteractive(args)) {
    if (cmd === "check" || cmd === "rehearse") {
      console.error(`graphloom: no runner config at ${file}; harness capabilities are not checked. Run graphloom setup (graphloom setup --yes in scripts).`);
    }
    return;
  }
  console.log(`graphloom: no runner config at ${file}; starting graphloom setup, then ${cmd} continues.`);
  const prompter = terminalPrompter();
  try {
    const result = await runSetup({ prompter });
    console.log(result.exitCode === 0 && existsSync(file) ? `graphloom: setup done; continuing with ${cmd}.` : `graphloom: setup did not write a runner config; ${cmd} continues without one.`);
  } catch (err) {
    console.error(`graphloom: setup failed (${err instanceof Error ? err.message : String(err)}); ${cmd} continues without a runner config.`);
  } finally {
    prompter.close();
  }
}

interface CrashContext {
  runId: string;
  stateDir: string | Promise<string>;
}

let crashHook: ReturnType<typeof onceStopHook> | undefined;
let crashContext: CrashContext | undefined;

/**
 * The hook for this `run`/`resume`, armed before any config is read so an
 * explicit `--on-stop` also covers a config failure; `notify.onStop` fills in
 * through `useConfig` once the config validates. Also armed for a crash.
 */
function armStopHook(args: string[], context?: CrashContext): ReturnType<typeof onceStopHook> {
  const flag = flagValue(args, "--on-stop");
  if (args.includes("--on-stop") && (flag === undefined || flag.startsWith("--") || flag.trim() === "")) {
    throw new Error("--on-stop needs a command");
  }
  const hook = onceStopHook(flag);
  crashHook = hook;
  crashContext = context;
  return hook;
}

function stopNotice(report: RunReport): StopNotice {
  return {
    runId: report.runId,
    status: report.status,
    ...(report.stopReason !== undefined ? { stopReason: report.stopReason } : report.blocker !== undefined ? { stopReason: report.blocker } : {}),
    ...(report.stopRetryable !== undefined ? { stopRetryable: report.stopRetryable } : {}),
    stateDir: report.stateDir,
    report,
  };
}

/** Best effort: tell the on-stop hook the CLI died. Never throws. */
async function notifyCrash(err: unknown): Promise<void> {
  if (crashHook === undefined) return;
  const message = err instanceof Error ? err.message : String(err);
  const stateDir = (await Promise.resolve(crashContext?.stateDir).catch(() => "")) ?? "";
  const runId = crashContext?.runId ?? "";
  await crashHook.fire({
    runId,
    status: "crashed",
    stopReason: message,
    stateDir,
    report: { runId, status: "crashed", stopReason: message, ...(stateDir ? { stateDir } : {}) },
  });
}

/** Bare run IDs stay bare so --state-root is honored; path-like refs are resolved. */
function requireRunRef(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`usage: graphloom ${usage}`);
    process.exitCode = 1;
    throw new Error(`usage: graphloom ${usage}`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("/") || value.includes("\\")) {
    return path.resolve(value);
  }
  return value;
}

/** `graphloom skills list|install|update|remove` (docs/design-agent-skills.md §3). */
async function skillsCommand(args: string[]): Promise<number> {
  const usage = "usage: graphloom skills list|install|update|remove [<name>...] [--agent claude-code|codex|opencode] [--dir <dir>] [--force] [--quiet] [--json]";
  const sub = args[0];
  const valued = new Set(["--agent", "--dir"]);
  const agents: SkillAgent[] = [];
  const names: string[] = [];
  let dir: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (valued.has(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      if (a === "--agent") agents.push(parseSkillAgent(v));
      else dir = v;
    } else if (a === "--force" || a === "--quiet" || a === "--json") {
      continue;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option ${a}; ${usage}`);
    } else {
      names.push(a);
    }
  }
  const options = { agents, ...(dir !== undefined ? { dir } : {}), names, force: args.includes("--force") };
  if (sub === "list") {
    const status = await skillsStatus(options);
    console.log(args.includes("--json") ? JSON.stringify(status, null, 2) : formatSkillsStatus(status));
    return 0;
  }
  if (sub === "install") {
    await installSkills(options);
    return 0;
  }
  if (sub === "update") {
    if (names.length > 0) throw new Error("graphloom skills update refreshes every installed copy; it takes no names");
    await updateSkills({ ...options, quiet: args.includes("--quiet") });
    return 0;
  }
  if (sub === "remove") {
    await removeSkills(options);
    return 0;
  }
  console.error(usage);
  return 1;
}

function requireCommandsMode(args: string[]): "stub" | "run" | undefined {
  const value = flagValue(args, "--commands");
  if (value === undefined) return undefined;
  if (value !== "stub" && value !== "run") throw new Error(`--commands must be "stub" or "run", not ${JSON.stringify(value)}`);
  return value;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function printHelp(): void {
  console.log(`graphloom — TypeScript harness

Usage:
  graphloom run <task.yaml> [--state-root <dir>] [--supervisor <harness>] [--on-stop <command>]
  graphloom check <task.yaml>
  graphloom rehearse <task.yaml> [--scenario <name>] [--commands <stub|run>] [--offline] [--synthesized] [--adversarial] [--keep] [--stop-at <stage>]
  graphloom rehearse --record-from <stateDir|runId> [--state-root <dir>] [--name <name>] [--out <path>]
  graphloom replay <stateDir|runId> [--state-root <dir>]
  graphloom probe <task.yaml> --contract <name> [--scenario <name>] [--commands <stub|run>] [--offline]
  graphloom inspect <stateDir|runId> [--state-root <dir>]
  graphloom stats <stateDir|runId> [--state-root <dir>] [--json]
  graphloom wait <stateDir|runId> [--state-root <dir>] [--until stop|progress] [--since <cursor>] [--timeout <dur>] [--json]
  graphloom stop <stateDir|runId> [--state-root <dir>]
  graphloom resume <stateDir|runId> [--state-root <dir>] [--supervisor <harness> [--reason <text>]] [--upgrade] [--update-plugin] [--update-executors] [--reconciled] [--rehearsal] [--on-stop <command>]
  graphloom switch-model <stateDir|runId> <model> --reason <text> [--state-root <dir>]
  graphloom delete <stateDir|runId> [--state-root <dir>] [--force]
  graphloom version [--json | --root]
  graphloom doctor [--task <task.yaml>] [--json]
  graphloom setup [--yes]
  ${SANDBOX_USAGE}
  graphloom skills list [--agent <claude-code|codex|opencode>] [--dir <dir>] [--json]
  graphloom skills install [<name>...] [--agent <claude-code|codex|opencode>] [--dir <dir>] [--force]
  graphloom skills update [--agent <claude-code|codex|opencode>] [--dir <dir>] [--quiet]
  graphloom skills remove [<name>...] [--agent <claude-code|codex|opencode>] [--dir <dir>] [--force]

sandbox pull puts a docker sandbox image, pinned by digest, in the local image
store before a run; a graph's environment check calls it for the image its
profile names, since a sandboxed job runs with --pull never and never pulls.
--check only reports whether the image is present (exit 1 when it is not).
graphloom doctor reports the docker CLI, the daemon, and whether it is rootless.

Installed releases (handled by the shim in ~/.local/bin, docs/design-release.md §4.3):
  graphloom upgrade [<version>] [--no-switch]
  graphloom self list | use <version> | rollback | prune [--dry-run] [--force] | uninstall [--purge-config]

check, rehearse, replay and probe verify a graph can run before spending a
live run's budget (docs/design-graph-rehearsal.md): check is a static check
of the declared data and the environment's tools, for free; rehearse runs the
real controller and harness adapters against stand-in models (Pi, Claude Code
and Codex all have one) answering from the bundle's declared rehearsal
scenario (default "happy"), for zero provider calls; replay re-checks a
recorded run's real evidence against the bundle's *current* code
(reclassifying it, re-running its validators, and asking what advance()
would do next), also for zero provider calls; probe spends real (but
bounded, at most 10) provider calls on the real configured harness, judging
its result against the contract with the real assignment a rehearsal's own
dispatch rendered. check, rehearse and replay need no
$GRAPHLOOM_RUNNER_CONFIG; probe does, same as run.

rehearse and probe default to quick mode (--commands stub): command jobs
answer from the scenario's own stubs instead of actually running (so
make test-ci and friends never execute); environment checks always run for
real in both modes, since they are the graph's own statement of what the
machine must have. --commands run executes every command job for real
instead, verifying the toolchain, build and tests too — slower, but the
full verdict. A plugin whose validators need the same command id to behave
differently per checkout (RED failing, GREEN passing) cannot be fully
rehearsed in quick mode; run it with --commands run. Commands a rehearsal runs
never see the variables that configure its stand-ins (GRAPHLOOM_REHEARSAL_*).

A rehearsal's scratch directory is /tmp/graphloom-rehearsal-<random> (under
$TMPDIR): the scenario, the stand-ins' home, and the rehearsal run's state
(<dir>/state/rehearsal-<id>, with its git worktree on the repository). --keep
leaves it after a ready verdict; not-ready and inconclusive verdicts leave it
too, for inspection. Remove one with
  graphloom delete <dir>/state/rehearsal-<id> --force && rm -rf <dir>
(delete also removes the worktree; plain rm leaves it registered, and
git worktree prune clears that). To clear every kept rehearsal:
  for d in "\${TMPDIR:-/tmp}"/graphloom-rehearsal-*; do
    graphloom delete "$d"/state/rehearsal-* --force; rm -rf "$d"; done

Stats reports what a run used, per stage and in total: agent calls, jobs,
budgets (used, left, the run's budget with operator raises, and intake's),
generations, supervisor episodes and remedies. Runs saved before the usage
ledger existed are estimated, and say so (docs/budgets.md).

Notifications: run and resume --on-stop <command> (or "notify": { "onStop":
"<command>", "timeoutMs": 60000 } in the runner config; the flag wins) run the
command through sh -c once, when the run leaves running (succeeded, stopped or
failed), or with status "crashed" when the CLI itself dies with an error. It
gets GRAPHLOOM_RUN_ID, GRAPHLOOM_STATUS, GRAPHLOOM_STOP_REASON,
GRAPHLOOM_STOP_RETRYABLE ("true", "false", or empty) and GRAPHLOOM_STATE_DIR in
its environment and the report JSON on stdin; its stdout goes to stderr. It is
killed after 60s. Its failure is logged to stderr and never changes the run
or the exit code. A SIGKILLed or power-lost CLI cannot fire it.

Wait blocks until the run's durable state is no longer running (it reads the
state and the controller's owner claim, never the process table), then prints
what stats prints. --timeout takes 90s, 10m, 2h (bare numbers are seconds).
Exit 0: the run left running, whatever it became (read the status line). Exit
2: timed out, still running. Exit 3: the state says running but its controller
died without recording a stop (resume takes it over).

Wait --until progress (docs/design-agent-skills.md §2) also returns when
something meaningful happens: a stage entered, receipts accepted or
invalidated, a supervisor episode started or ended (with its one-line reason),
a quota or usage-limit pause (with resetAt), a budget reaching 80% of the run's
budget, a resume, or the stop. --json prints the events, a summary of the run
(status, stage, budgets, waiting states) and a cursor; wait --since <cursor>
reports only what happened after it, so nothing is reported twice or lost.
Exit 0: events, or the run is not running. Exit 2: the timeout elapsed with
nothing to report (--json still prints the unchanged cursor). Exit 3: orphaned,
as above. Exit 1: an error, such as another run's cursor.

Version prints the product version: an installed release's version and commit
from its release.json, or <version>-dev+<short sha> in a clone. --json prints
the whole release.json; --root prints the real path of the installation.

Delete removes a stopped or finished run's worktree, graphloom/<runId> branch, and
state directory. --force also discards uncommitted changes and branch commits.

Resume --update-plugin pins the installed plugin bundle when its bytes changed
since the run started, including a new version of the same graph (the run's
active version moves with it). It is refused unless the graph keeps its id, stages,
requirements, validator bindings and private-state schema. Each accepted receipt
is rechecked with the updated validators on the evidence it was accepted on; the
first that no longer passes sends the run back to its stage.

Resume --update-executors pins the installed executors whose bytes changed since
the run started (a GraphLoom upgrade that touches a built-in executor, say),
recording each old -> new digest and the generation in the run (graphloom inspect
shows executorTransitions). It is refused, naming the executor, when one is no
longer installed, its isolation or built-in status changed, or the installed bytes
moved past an active run-local repair of it. Accepted receipts and evidence are
not changed. Without it, a changed executor stops the run with "executor pin
mismatch". It combines with --update-plugin.

Installed releases own their runs (docs/design-release.md §5): a run belongs to
the version that created it. resume, stop, wait, inspect, stats, replay,
switch-model and delete on a run another installed version owns run on that
version, saying so on stderr; one whose owner was pruned is refused until
graphloom upgrade <v> --no-switch restores it. A run from a clone has no
installed owner and runs where it is invoked, under its executor pins.

Resume --upgrade moves a stopped run to this GraphLoom: it migrates the run's
state format (keeping the original files under <stateDir>/migrations/), re-pins
its executors as --update-executors does, and moves its owner, all recorded in
the run (inspect: install, installHistory, stateMigrations). It is refused, with
the run unchanged, for a downgrade, a different major version (0.x to 1.0
included), an unknown state format, a missing migrator, an unsettled repair, a
run that is not stopped, a plugin protocol change without --update-plugin, and
an executor re-pin --update-executors would refuse.

Rehearse --stop-at <stage> keeps the rehearsal's run stopped once that stage is
complete and prints how to continue it; resume <stateDir> --rehearsal continues
a kept rehearsal run on its own stand-ins (with --upgrade, on this version).
Both are hooks for the release upgrade matrix (docs/design-release.md §6).

Resume --reconciled acknowledges a job a harness usage limit cut off after possible
effects whose agent session could not be continued. With a supervisor, a plain
resume opens a quota_partial recovery episode for it; without one, a plain resume
stops again ("harness quota hit after possible effects; reconcile before resuming")
until you have reconciled the worktree and external state yourself and pass
--reconciled, which lets the graph run again.

Doctor reports what this machine can run (docs/design-release.md §4.4): git,
flock, bubblewrap confinement and install integrity; Claude Code, Codex, Pi and
gh, each found, probed and logged in or not (presence only, never a secret, no
model call); the runner and supervisor configs as run reads them; automatic
updates; and the setups the available harnesses allow. Every warn and fail
carries a "fix:" line with the next command; it exits 1 on any fail. --task
<task.yaml> adds the plugin's environment checks, the supervisor selection run
would make, and each agent role the plugin declares (GraphDefinition.agentRoles).

Setup writes the runner config and supervisor.json from what doctor finds,
offering only choices that work here, each with a recommendation, and asks for
your consent to allowUnrestricted. Files are mode 0600; a rerun offers each
change and keeps the old file as <name>.bak-<UTC time>. It never asks for or
writes a token. --yes accepts the recommendations (and counts as consent) and
leaves existing files unchanged. run, resume, probe, check and rehearse start
it on a terminal when no runner config exists at the default path.

Skills (docs/design-agent-skills.md §3): GraphLoom ships agent skills for
driving it from Claude Code ($CLAUDE_CONFIG_DIR/skills, default ~/.claude/skills),
Codex ($CODEX_HOME/skills, default ~/.codex/skills) or opencode
($XDG_CONFIG_HOME/opencode/skills, default ~/.config/opencode/skills);
GRAPHLOOM_CLAUDE_SKILLS_DIR, GRAPHLOOM_CODEX_SKILLS_DIR and
GRAPHLOOM_OPENCODE_SKILLS_DIR override them, --dir names one directory. Each
copy carries .graphloom-skill.json (version and digest). install writes missing
and outdated copies for the agents found here (or --agent); an edited copy only
with --force, and never a directory GraphLoom did not write. update refreshes
the copies GraphLoom installed, skipping edited ones; upgrade and automatic
updates run it. remove deletes unedited copies (edited ones with --force); self
uninstall runs it. setup offers to install them; doctor reports them, and
warns when copies in a shared directory an agent also reads (~/.agents/skills
for Codex and opencode, ~/.claude/skills for opencode) duplicate its own.

Agent runner: run and resume refuse to start without $GRAPHLOOM_RUNNER_CONFIG or
~/.config/graphloom/runner.json (graphloom setup writes it):
  { "harness": "claude-code", "allowUnrestricted": true }
Use "pi" for the Pi harness, or "codex" for Codex, which runs read-only jobs
only. The agent runs with your user permissions; credentials come from the
harness login. Optional claude/codex/pi settings select the executable, model,
provider, agent or Codex home directory, and environment names. "timeoutMs"
bounds one agent job (default 1h); "maxTimeoutMs" is the most a job may ask for
with its own timeoutMs (default 4h).
"harnesses": ["claude-code", "pi", "codex"] lets a job choose any of them with
input.harness. Command jobs run as you in the job's workspace ("command":
{ "timeoutMs": ... } bounds one job). "github": { "tokenEnv": "GITHUB_TOKEN" }
serves read-only GitHub executors with the token from that variable.

Supervisor: run and resume use a supervisor on Pi, Claude Code, or Codex when an
operator config exists at $GRAPHLOOM_SUPERVISOR_CONFIG or
~/.config/graphloom/supervisor.json. The flat form is Pi alone; its model is
any <provider>/<modelId> Pi knows (anthropic, openai, google, deepseek,
moonshotai, minimax-cn, ..., or a custom provider in Pi's models.json):
  { "provider": "deepseek", "modelId": "deepseek-v4-pro",
    "models": ["anthropic/claude-sonnet-5"], "agentDir": "~/.pi/agent" }
Credentials come from Pi's agent dir or the provider's environment variable
(DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, ...); graphloom doctor lists them.
The per-harness form enables Claude Code and Codex too, each with your own CLI
login (never an API key: OpenAI by key is the Pi route), confined by bwrap:
  { "harnesses": ["pi", "claude-code", "codex"], "pi": { "provider": "deepseek", "modelId": "deepseek-v4-pro" },
    "claude": { "models": ["opus", "sonnet"], "configDir": "~/.claude" },
    "codex": { "models": [{ "modelId": "gpt-5-codex", "thinkingLevel": "high" }], "codexHome": "~/.codex" } }
A run uses --supervisor <harness>, else "select", else the first harness in
the plugin's preference (GraphDefinition.supervisor) that is enabled and
available, else the first enabled harness that is available (a plugin that
sets "required" refuses instead); check and doctor --task report the choice.
The harness is pinned when the run starts (inspect: supervisorSelection), and
the repair reviewer uses the same one. resume keeps the pin and refuses when
the pinned harness is no longer enabled or available; resume --supervisor
<harness> [--reason <text>] moves the run to another enabled, available
harness, keeping its logical session, budgets, and case file (inspect:
supervisorTransitions). switch-model takes a model of the pinned harness:
provider/model for Pi, the model name (or claude-code/<name>, codex/<name>)
for Claude Code and Codex, each one the operator configured. doctor probes
each enabled harness; stats shows supervisor use (episodes, turns, provider
calls, tokens where the harness reports them) per harness.
`);
}

function crash(err: unknown): void {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  void notifyCrash(err).finally(() => process.exit(1));
}

process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  return notifyCrash(err);
});
