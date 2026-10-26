#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * GraphLoom CLI: run | inspect | stats | wait | stop | resume | switch-model | delete | version
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createController, resolveStateDir } from "@graphloom/controller";
import type { GraphRehearsal } from "@graphloom/sdk";
import type { RunReport } from "@graphloom/controller";
import { createCliRunner } from "./cli-runner.js";
import { piRepairDeps, resolveBundlePath, resolveBundlePathForResume } from "./repair-config.js";
import { check, probe, recordScenario, rehearse, replay } from "./rehearsal.js";
import { requireRunnerConfig } from "./runner-config.js";
import { onceStopHook, parseDuration, waitForRun, type StopNotice } from "./notify.js";
import { formatRunStats, loadRunStats } from "./stats.js";
import { formatVersion, installRoot } from "./version.js";
import { JOB_TIMEOUT_MS, killActiveChildren, runAutoUpdate } from "./auto-update.js";
import {
  loadSupervisorConfig,
  parseModelRef,
  piSupervisorFactory,
  piSupervisorRestore,
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

  const controller = createController();

  if (cmd === "run") {
    const taskPath = path.resolve(args[1] ?? "task.yaml");
    const stateRootFlag = flagValue(args, "--state-root");
    const stateRoot = stateRootFlag ? path.resolve(stateRootFlag) : undefined;
    const stopHook = armStopHook(args);
    const runnerConfig = await requireRunnerConfig(process.env, (loaded) => stopHook.useConfig(loaded.notify));
    const runner = createCliRunner(runnerConfig);
    const config = await loadSupervisorConfig();
    const report = await controller.run({
      taskPath,
      onRunCreated: ({ runId, stateDir }) => { crashContext = { runId, stateDir }; },
      runner,
      ...(stateRoot !== undefined ? { stateRoot } : {}),
      ...(config !== undefined
        ? { supervisorFactory: piSupervisorFactory(config), repair: piRepairDeps(config, await resolveBundlePath(taskPath)) }
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
    const usage = "wait <stateDir|runId> [--state-root <dir>] [--timeout <dur>] [--json]";
    const runRef = requireRunRef(args[1], usage);
    const stateRootFlag = flagValue(args, "--state-root");
    const stateRoot = stateRootFlag ? path.resolve(stateRootFlag) : undefined;
    const timeout = flagValue(args, "--timeout");
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
    const runRef = requireRunRef(args[1], "resume <stateDir|runId> [--state-root <dir>] [--update-plugin] [--update-executors] [--reconciled] [--on-stop <command>]");
    const stateRoot = flagValue(args, "--state-root");
    const stopHook = armStopHook(args, {
      runId: path.basename(runRef),
      stateDir: resolveStateDir(runRef, stateRoot ? path.resolve(stateRoot) : undefined).catch(() => ""),
    });
    const runnerConfig = await requireRunnerConfig(process.env, (loaded) => stopHook.useConfig(loaded.notify));
    const runner = createCliRunner(runnerConfig);
    const config = await loadSupervisorConfig();
    const report = await controller.resume({
      runRef,
      runner,
      ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
      ...(args.includes("--update-plugin") ? { updatePlugin: true } : {}),
      ...(args.includes("--update-executors") ? { updateExecutors: true } : {}),
      ...(args.includes("--reconciled") ? { reconciled: true } : {}),
      ...(config !== undefined
        ? {
            restoreSupervisor: piSupervisorRestore(config),
            supervisorFactory: piSupervisorFactory(config),
            repair: piRepairDeps(config, await resolveBundlePathForResume(runRef, stateRoot ? path.resolve(stateRoot) : undefined)),
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
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "switch-model") {
    const usage = "switch-model <stateDir|runId> <provider/model> --reason <text> [--state-root <dir>]";
    const runRef = requireRunRef(args[1], usage);
    const reason = flagValue(args, "--reason");
    if (!args[2] || !reason) {
      console.error(`usage: graphloom ${usage}`);
      process.exitCode = 1;
      return;
    }
    const target = parseModelRef(args[2]);
    const config = await loadSupervisorConfig();
    if (
      config !== undefined &&
      !config.models.some((m) => m.provider === target.provider && m.modelId === target.modelId)
    ) {
      throw new Error(`${args[2]} is not in the operator supervisor config's models`);
    }
    const stateRoot = flagValue(args, "--state-root");
    await controller.switchModel(
      runRef,
      { ...target, reason },
      stateRoot ? { stateRoot: path.resolve(stateRoot) } : undefined,
    );
    console.log(`switch to ${args[2]} requested; applied before the run's next supervisor prompt`);
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
  graphloom run <task.yaml> [--state-root <dir>] [--on-stop <command>]
  graphloom check <task.yaml>
  graphloom rehearse <task.yaml> [--scenario <name>] [--commands <stub|run>] [--offline] [--synthesized] [--adversarial] [--keep]
  graphloom rehearse --record-from <stateDir|runId> [--state-root <dir>] [--name <name>] [--out <path>]
  graphloom replay <stateDir|runId> [--state-root <dir>]
  graphloom probe <task.yaml> --contract <name> [--scenario <name>] [--commands <stub|run>] [--offline]
  graphloom inspect <stateDir|runId> [--state-root <dir>]
  graphloom stats <stateDir|runId> [--state-root <dir>] [--json]
  graphloom wait <stateDir|runId> [--state-root <dir>] [--timeout <dur>] [--json]
  graphloom stop <stateDir|runId> [--state-root <dir>]
  graphloom resume <stateDir|runId> [--state-root <dir>] [--update-plugin] [--update-executors] [--reconciled] [--on-stop <command>]
  graphloom switch-model <stateDir|runId> <provider/model> --reason <text> [--state-root <dir>]
  graphloom delete <stateDir|runId> [--state-root <dir>] [--force]
  graphloom version [--json | --root]

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

Resume --reconciled acknowledges a job a harness usage limit cut off after possible
effects whose agent session could not be continued. With a supervisor, a plain
resume opens a quota_partial recovery episode for it; without one, a plain resume
stops again ("harness quota hit after possible effects; reconcile before resuming")
until you have reconciled the worktree and external state yourself and pass
--reconciled, which lets the graph run again.

Agent runner: run and resume refuse to start without $GRAPHLOOM_RUNNER_CONFIG or
~/.config/graphloom/runner.json:
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

Supervisor: run and resume use a Pi supervisor when an operator config exists at
$GRAPHLOOM_SUPERVISOR_CONFIG or ~/.config/graphloom/supervisor.json:
  { "provider": "minimax-cn", "modelId": "MiniMax-M3",
    "models": ["deepseek/deepseek-chat"], "agentDir": "~/.pi/agent" }
Credentials come from Pi's agent dir or the provider's environment variable.
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
