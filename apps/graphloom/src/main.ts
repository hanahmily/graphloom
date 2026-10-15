#!/usr/bin/env node
/**
 * GraphLoom CLI: run | inspect | stop | resume | switch-model | delete | version
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createController } from "@graphloom/controller";
import type { GraphRehearsal } from "@graphloom/sdk";
import { createCliRunner } from "./cli-runner.js";
import { piRepairDeps, resolveBundlePath, resolveBundlePathForResume } from "./repair-config.js";
import { check, probe, recordScenario, rehearse, replay } from "./rehearsal.js";
import { requireRunnerConfig } from "./runner-config.js";
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
    console.log("graphloom 0.0.0");
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
    const runner = createCliRunner(await requireRunnerConfig());
    const config = await loadSupervisorConfig();
    const report = await controller.run({
      taskPath,
      runner,
      ...(stateRoot !== undefined ? { stateRoot } : {}),
      ...(config !== undefined
        ? { supervisorFactory: piSupervisorFactory(config), repair: piRepairDeps(config, await resolveBundlePath(taskPath)) }
        : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "succeeded" ? 0 : 1;
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
    const runner = createCliRunner(await requireRunnerConfig());
    const runRef = requireRunRef(args[1], "resume <stateDir|runId> [--state-root <dir>] [--update-plugin]");
    const stateRoot = flagValue(args, "--state-root");
    const config = await loadSupervisorConfig();
    const report = await controller.resume({
      runRef,
      runner,
      ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
      ...(args.includes("--update-plugin") ? { updatePlugin: true } : {}),
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
  graphloom run <task.yaml> [--state-root <dir>]
  graphloom check <task.yaml>
  graphloom rehearse <task.yaml> [--scenario <name>] [--commands <stub|run>] [--offline] [--synthesized] [--adversarial] [--keep]
  graphloom rehearse --record-from <stateDir|runId> [--state-root <dir>] [--name <name>] [--out <path>]
  graphloom replay <stateDir|runId> [--state-root <dir>]
  graphloom probe <task.yaml> --contract <name> [--scenario <name>] [--commands <stub|run>] [--offline]
  graphloom inspect <stateDir|runId> [--state-root <dir>]
  graphloom stop <stateDir|runId> [--state-root <dir>]
  graphloom resume <stateDir|runId> [--state-root <dir>] [--update-plugin]
  graphloom switch-model <stateDir|runId> <provider/model> --reason <text> [--state-root <dir>]
  graphloom delete <stateDir|runId> [--state-root <dir>] [--force]
  graphloom version

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
rehearsed in quick mode; run it with --commands run.

Delete removes a stopped or finished run's worktree, graphloom/<runId> branch, and
state directory. --force also discards uncommitted changes and branch commits.

Resume --update-plugin pins the installed plugin bundle when its bytes changed
since the run started. It is refused unless the graph keeps its stages,
requirements, validator bindings and private-state schema. Each accepted receipt
is rechecked with the updated validators on the evidence it was accepted on; the
first that no longer passes sends the run back to its stage.

Agent runner: run and resume refuse to start without $GRAPHLOOM_RUNNER_CONFIG or
~/.config/graphloom/runner.json:
  { "harness": "claude-code", "allowUnrestricted": true }
Use "pi" for the Pi harness, or "codex" for Codex, which runs read-only jobs
only. The agent runs with your user permissions; credentials come from the
harness login. Optional claude/codex/pi settings select the executable, model,
provider, agent or Codex home directory, and environment names.
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
