#!/usr/bin/env node
/**
 * GraphLoom CLI: run | inspect | stop | resume | switch-model | version
 */
import path from "node:path";
import { createController } from "@graphloom/controller";
import type { Runner } from "@graphloom/runner";
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
  const runner = unsupportedCliRunner();

  if (cmd === "run") {
    const taskPath = path.resolve(args[1] ?? "task.yaml");
    const config = await loadSupervisorConfig();
    const report = await controller.run({
      taskPath,
      runner,
      ...(config !== undefined ? { supervisorFactory: piSupervisorFactory(config) } : {}),
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
    const runRef = requireRunRef(args[1], "resume <stateDir|runId>");
    const stateRoot = flagValue(args, "--state-root");
    const config = await loadSupervisorConfig();
    const report = await controller.resume({
      runRef,
      runner,
      ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
      ...(config !== undefined ? { restoreSupervisor: piSupervisorRestore(config) } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "succeeded" ? 0 : 1;
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

  console.error(`unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 1;
}

function unsupportedCliRunner(): Runner {
  return {
    async runJob(_job, ctx) {
      return {
        status: "failed",
        summary:
          "CLI agent runner not configured yet; drive runs through the controller API with a scripted runner",
        runId: ctx.runId,
        operationId: ctx.operationId,
        generation: ctx.generation,
      };
    },
  };
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

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function printHelp(): void {
  console.log(`graphloom — TypeScript harness

Usage:
  graphloom run <task.yaml>
  graphloom inspect <stateDir|runId> [--state-root <dir>]
  graphloom stop <stateDir|runId> [--state-root <dir>]
  graphloom resume <stateDir|runId> [--state-root <dir>]
  graphloom switch-model <stateDir|runId> <provider/model> --reason <text> [--state-root <dir>]
  graphloom version

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
