// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The shipped graphs' rehearsal scenarios, each on a task a user could write
 * for it: hello and release on an empty repository, issue-fix on the banyandb
 * profile's fixture module and its issue, pr-design-review and pr-review on the
 * banyandb profile and the pull request their scenarios replay. Each task runs
 * as the operator runs it, through the compiled CLI in its own process, on a
 * temporary HOME, with no GitHub at all: `--offline` replays every read the
 * scenario recorded (docs/design-graph-rehearsal.md §4.6).
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HubRehearsalVerdict } from "@graphloom/sdk";
import { createGitRepo, createTaskWorkspace, exampleBundle, goVersion, issueFixRepoFiles, repoRoot, type TestScope } from "@graphloom/testkit";
import { execFileAsync } from "./cli-env.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

export const GO = goVersion();
export const CLI = path.join(repoRoot, "apps/graphloom/dist/main.js");

/** A shipped graph's rehearsal task, the environment its rehearsals run in, and its scenarios. */
export interface ShippedTask {
  graph: ShippedGraph;
  dir: string;
  taskPath: string;
  runnerConfig: string;
  /** The whole environment of a rehearsal's process: the caller's PATH with the stand-in tools first, a temporary HOME, no GraphLoom setting but the runner config. */
  env: NodeJS.ProcessEnv;
  scenarios: string[];
}

export const SHIPPED_GRAPHS = ["hello", "release", "issue-fix", "pr-design-review", "pr-review"] as const;
export type ShippedGraph = (typeof SHIPPED_GRAPHS)[number];

/** The environment without GraphLoom or Claude settings, on `home`, with `bins` first on PATH. */
export function rehearsalEnvironment(home: string, bins: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GRAPHLOOM_") && !name.startsWith("CLAUDE_") && !name.startsWith("VITEST")));
  return { ...inherited, HOME: home, TMPDIR: home, PATH: [...bins, process.env.PATH ?? ""].join(":"), ...extra };
}

/** Stand-ins for open-code-review and a `node` new enough for issue-fix's environment checks. */
async function issueFixTools(dir: string): Promise<string> {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "ocr"), ["#!/bin/sh", '[ "$1 $2" = "delegate preview" ] || exit 1', '[ "$3" = --help ] && exit 0', 'echo \'{"mode":"workspace","reviewable_files":[]}\'', ""].join("\n"), { mode: 0o755 });
  await writeFile(path.join(bin, "node"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "v24.6.0"; exit 0; }\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** The scenario names the plugin's built rehearsal entry declares for `config`. */
async function scenarioNames(graph: string, config?: unknown): Promise<string[]> {
  const module = (await import(pathToFileURL(path.join(exampleBundle(graph), "dist", "rehearsal.js")).href)) as { rehearsal: { scenarios: object } | ((config: unknown) => { scenarios: object }) };
  const rehearsal = typeof module.rehearsal === "function" ? module.rehearsal(config) : module.rehearsal;
  return Object.keys(rehearsal.scenarios);
}

/** A rehearsal task for one shipped graph, in a scope directory. */
export async function shippedTask(scope: TestScope, graph: ShippedGraph): Promise<ShippedTask> {
  let dir: string;
  let taskPath: string;
  let config: unknown;
  const bins: string[] = [];
  const extra: NodeJS.ProcessEnv = {};
  if (graph === "hello" || graph === "release") {
    dir = await scope.tempDir(`gl-shipped-${graph}-`);
    await createGitRepo(path.join(dir, "repo"), {});
    await mkdir(path.join(dir, "plugins"));
    await symlink(exampleBundle(graph), path.join(dir, "plugins", graph));
    taskPath = path.join(dir, "task.yaml");
    const request = graph === "hello" ? "Create GREETING.txt." : "Release version 1.0.0: record it in VERSION and add a CHANGELOG.md entry.";
    await writeFile(taskPath, `graph: ${graph}\nrepo: ./repo\nrequest: ${JSON.stringify(request)}\n`);
  } else if (graph === "issue-fix") {
    // The testkit's module shaped like BanyanDB with the real CONTRIBUTING.md (the shipped profile pins its digest), the
    // shipped profile unmodified, and the issue the scenarios replay, as the plugin names it.
    const contributing = await readFile(path.join(repoRoot, "examples/skywalking-banyandb/CONTRIBUTING.md"));
    config = JSON.parse(await readFile(path.join(exampleBundle(graph), "profiles", "banyandb.json"), "utf8"));
    const plugin = (await import(pathToFileURL(path.join(exampleBundle(graph), "dist", "rehearsal.js")).href)) as { rehearsalRequest(config: unknown): string };
    const env = await createTaskWorkspace(scope, {
      graph,
      repoName: "banyandb",
      files: issueFixRepoFiles(GO!, contributing),
      config: { name: "plugins/issue-fix/profiles/banyandb.json" },
      request: plugin.rehearsalRequest(config),
    });
    dir = env.dir;
    taskPath = env.taskPath;
    const tools = await issueFixTools(dir);
    bins.push(tools);
    extra.GRAPHLOOM_OCR_BIN = path.join(tools, "ocr");
  } else {
    const bundle = exampleBundle(graph);
    const fixture = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal.js")).href)) as { REHEARSAL_REQUEST: string; REHEARSAL_HEAD_FILES: Record<string, string> };
    config = JSON.parse(await readFile(path.join(bundle, "profiles", "banyandb.json"), "utf8"));
    const env = await createTaskWorkspace(scope, {
      graph,
      repoName: "banyandb",
      files: { "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`, ...fixture.REHEARSAL_HEAD_FILES },
      config: { name: "profile.json", value: config },
      request: fixture.REHEARSAL_REQUEST,
      bundle,
    });
    dir = env.dir;
    taskPath = env.taskPath;
  }
  // B2 probes the operator's agent CLIs named in the runner config: fakes that answer it, never a real login.
  const agents = await writeFakeCodingAgents(dir);
  bins.unshift(agents.bin);
  const runnerConfig = path.join(dir, "runner.json");
  await writeFile(runnerConfig, JSON.stringify(fakeRunnerConfig(agents)));
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const env = rehearsalEnvironment(home, bins, { ...extra, GRAPHLOOM_RUNNER_CONFIG: runnerConfig });
  return { graph, dir, taskPath, runnerConfig, env, scenarios: await scenarioNames(graph, config) };
}

/**
 * The commands mode a graph's scenarios are designed for. issue-fix's are `run`: its Fix stage judges RED and GREEN
 * from the regression test's own `go test -json` report on the base and on the candidate checkout, and its findings
 * ledger (issues-write, issues-read), design points and delivery are command jobs whose output the graph reads back;
 * quick mode answers each command id with one canned result and cannot stand in for them. The others are `stub`.
 */
export function commandsFor(graph: ShippedGraph): "stub" | "run" {
  return graph === "issue-fix" ? "run" : "stub";
}

/** What a rehearsal's verdict is compared on, direct and through the hub: the verdict, each boundary's status, the convergence, the run's end, and the blocking boundary. */
export interface VerdictSummary {
  verdict: string;
  boundaries: Record<string, string>;
  convergence: boolean;
  runStatus: string;
  stopReason?: string;
  stoppedAt?: string;
  blocker?: string;
}

/** `graphloom rehearse <task> --scenario <name> --offline --commands <mode> [--stop-at <stage>]` through the compiled CLI. */
export async function rehearseDirect(
  task: ShippedTask,
  scenario: string,
  options: { stopAt?: string; keep?: boolean; commands?: "stub" | "run" } = {},
): Promise<{ summary: VerdictSummary; report: Record<string, unknown>; code: number; stderr: string }> {
  const args = [CLI, "rehearse", task.taskPath, "--scenario", scenario, "--offline", "--commands", options.commands ?? commandsFor(task.graph), ...(options.stopAt !== undefined ? ["--stop-at", options.stopAt] : []), ...(options.keep === true ? ["--keep"] : [])];
  let stdout: string;
  let stderr: string;
  let code = 0;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: task.dir, env: task.env, maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    if (e.stdout === undefined || e.stdout === "") throw err;
    stdout = e.stdout;
    stderr = e.stderr ?? "";
    code = typeof e.code === "number" ? e.code : 1;
  }
  const report = JSON.parse(stdout) as Record<string, unknown>;
  return { summary: summarize(report), report, code, stderr };
}

/** The comparable part of a `rehearse` report, or of a `--stop-at` report, whose verdict is ready exactly when the run stopped there. */
export function summarize(report: Record<string, unknown>): VerdictSummary {
  if (typeof report.stoppedAt === "string") {
    const ok = report.ok === true;
    return {
      verdict: ok ? "ready" : "not-ready",
      boundaries: {},
      convergence: ok,
      runStatus: String(report.status),
      ...(typeof report.stopReason === "string" ? { stopReason: report.stopReason } : {}),
      stoppedAt: report.stoppedAt,
      ...(!ok ? { blocker: "stop-at" } : {}),
    };
  }
  const boundaries = Object.fromEntries(Object.entries((report.boundaries ?? {}) as Record<string, { status: string }>).map(([b, r]) => [b, r.status]));
  const convergence = report.convergence as { met?: boolean; actual?: { status?: string; stopReason?: string } } | undefined;
  const blocker = report.blocker as { boundary?: string } | undefined;
  return {
    verdict: String(report.verdict),
    boundaries,
    convergence: convergence?.met === true,
    runStatus: String(convergence?.actual?.status),
    ...(convergence?.actual?.stopReason !== undefined ? { stopReason: convergence.actual.stopReason } : {}),
    ...(blocker?.boundary !== undefined ? { blocker: blocker.boundary } : {}),
  };
}

/** The same summary of the verdict a hub recorded for a rehearsal submission. */
export function summarizeHubVerdict(verdict: HubRehearsalVerdict): VerdictSummary {
  return {
    verdict: verdict.verdict,
    boundaries: verdict.boundaries,
    convergence: verdict.convergence,
    runStatus: verdict.runStatus,
    ...(verdict.stopReason !== undefined ? { stopReason: verdict.stopReason } : {}),
    ...(verdict.stoppedAt !== undefined ? { stoppedAt: verdict.stoppedAt } : {}),
    ...(verdict.blocker !== undefined ? { blocker: verdict.blocker.boundary } : {}),
  };
}

/** Runs `work` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
