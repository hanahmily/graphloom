#!/usr/bin/env node
/**
 * GraphLoom CLI: run | inspect | stop | resume | version
 */
import path from "node:path";
import { createController } from "@graphloom/controller";
import type { Runner } from "@graphloom/runner";

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
    const report = await controller.run({ taskPath, runner });
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
    const report = await controller.resume({
      runRef,
      runner,
      ...(stateRoot ? { stateRoot: path.resolve(stateRoot) } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "succeeded" ? 0 : 1;
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
  graphloom version
`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
