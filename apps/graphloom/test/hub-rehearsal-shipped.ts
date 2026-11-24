// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The shared suite of hub-rehearsal-shipped.<tier>.test.ts: each shipped graph's scenarios rehearsed directly
 * (`graphloom rehearse --offline`) and as hub rehearsal submissions with the same settings on a temporary hub, whose
 * recorded verdicts must equal the direct ones, every one of them ready (docs/design-run-hub.md §12.3,
 * docs/design-graph-rehearsal.md §4.6). The PR tier runs one scenario per graph, the full tier every scenario.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubSubmission } from "@graphloom/sdk";
import { createScope, type TestScope } from "@graphloom/testkit";
import { hubRequest } from "../src/hub-client.js";
import { useTestHubs } from "./hub-harness.js";
import { execFileAsync } from "./cli-env.js";
import { CLI, commandsFor, eachLimited, GO, rehearseDirect, shippedTask, SHIPPED_GRAPHS, summarizeHubVerdict, type ShippedGraph, type ShippedTask, type VerdictSummary } from "./shipped-rehearsals.js";

/** Direct and hub rehearsals in flight at once: each is a CLI process with its plugin host and stand-ins. */
const PARALLEL = 3;

/** One operator answer: as `resume` flags (direct) and as a hub resume remedy. */
interface OperatorAnswer { name: string; flags: string[]; remedy: Record<string, unknown> }

/** The answers each operator-stop scenario's blocker names, by graph and scenario. */
const OPERATOR_ANSWERS: Partial<Record<ShippedGraph, Record<string, OperatorAnswer[]>>> = {
  "issue-fix": {
    "arbitrate-operator": [
      ...(["review-stands", "implementation-stands"] as const).map((ruling) => ({
        name: ruling,
        flags: ["--approve", "design-ruling", "--input", "finding=F1", "--input", `ruling=${ruling}`, "--input", "note=The operator rules."],
        remedy: { approve: "design-ruling", inputs: { finding: "F1", ruling, note: "The operator rules." } },
      })),
      { name: "decline", flags: ["--decline", "design-ruling", "--reason", "Leave it open."], remedy: { decline: "design-ruling", reason: "Leave it open." } },
    ],
  },
};

/**
 * `graphloom rehearse <task> --scenario <name> --keep`, then `graphloom resume <run> --rehearsal <answer>` on the kept
 * run, through the compiled CLI. The kept scratch is found under the task environment's TMPDIR, and removed after.
 */
async function answerDirect(task: ShippedTask, scenario: string, flags: string[]): Promise<{ status: string; stderr: string }> {
  const tmp = task.env.TMPDIR!;
  const before = new Set(await readdir(tmp));
  const stopped = await rehearseDirect(task, scenario, { keep: true });
  expect(stopped.summary.verdict, JSON.stringify(stopped.summary)).toBe("ready");
  const kept = (await readdir(tmp)).filter((name) => name.startsWith("graphloom-rehearsal-") && !before.has(name));
  expect(kept).toHaveLength(1);
  const root = path.join(tmp, kept[0]!);
  try {
    const [run] = (await readdir(path.join(root, "state"))).filter((name) => name.startsWith("rehearsal-"));
    const stateDir = path.join(root, "state", run!);
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, [CLI, "resume", stateDir, "--rehearsal", ...flags], { cwd: task.dir, env: task.env, maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      if (!e.stdout) throw err;
      stdout = e.stdout;
      stderr = e.stderr ?? "";
    }
    return { status: String((JSON.parse(stdout) as { status?: unknown }).status), stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Registers one test per shipped graph that compares the direct and hub verdicts of the scenarios `select` picks. */
export function shippedHubSuite(select: (graph: ShippedGraph, scenarios: string[]) => string[], timeoutMs: number): void {
  const { startHub, waitForState } = useTestHubs();
  let scope: TestScope | undefined;
  afterEach(async () => {
    await scope?.dispose();
    scope = undefined;
  });

  describe("shipped graphs' rehearsal scenarios through the hub, offline", () => {
    for (const graph of SHIPPED_GRAPHS) {
      // The Go graphs' tasks are Go modules; their environment checks need the toolchain.
      const needsGo = graph !== "hello" && graph !== "release";
      it.skipIf(needsGo && GO === undefined)(`${graph}: every scenario is ready, and a hub rehearsal submission records the direct verdict`, { timeout: timeoutMs }, async () => {
        scope = createScope();
        const task = await shippedTask(scope, graph);
        const scenarios = select(graph, task.scenarios);
        expect(scenarios.length).toBeGreaterThan(0);
        const commands = commandsFor(graph);

        const direct: Record<string, VerdictSummary> = {};
        await eachLimited(scenarios, PARALLEL, async (scenario) => {
          direct[scenario] = (await rehearseDirect(task, scenario)).summary;
        });

        // The hub's launches run in the task's environment: its stand-in tools on PATH, a temporary HOME.
        const hub = await startHub(task.runnerConfig, { env: task.env, maxConcurrentRuns: PARALLEL });
        const submitted = new Map<string, HubSubmission>();
        for (const scenario of scenarios) {
          submitted.set(scenario, await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task.taskPath, key: scenario, rehearsal: { scenario, commands, offline: true } }, hub.socket));
        }
        const viaHub: Record<string, VerdictSummary> = {};
        for (const [scenario, submission] of submitted) {
          const done = await waitForState(hub, submission.id, ["succeeded", "failed", "blocked", "canceled"], timeoutMs);
          expect(done.rehearsalVerdict, `${scenario}: ${hub.driver.log().slice(-4000)}`).toBeDefined();
          viaHub[scenario] = summarizeHubVerdict(done.rehearsalVerdict!);
        }

        expect(viaHub).toEqual(direct);
        const notReady = Object.entries(direct).filter(([, summary]) => summary.verdict !== "ready");
        expect(notReady, JSON.stringify(notReady, null, 2)).toEqual([]);

        // A scenario that stops for the operator rehearses each answer its blocker names: answered directly
        // (`resume --rehearsal`) and through the hub (`hub resume`), every one runs to a ready verdict.
        for (const [scenario, answers] of Object.entries(OPERATOR_ANSWERS[graph] ?? {})) {
          if (!scenarios.includes(scenario)) continue;
          for (const answer of answers) {
            const label = `${scenario} ${answer.name}`;
            const resumed = await answerDirect(task, scenario, answer.flags);
            expect(resumed.status, `${label}: ${resumed.stderr.slice(-4000)}`).toBe("succeeded");
            expect(resumed.stderr, label).toContain("graphloom: rehearsal verdict ready");
          }
          const waiting = new Map<string, HubSubmission>();
          for (const answer of answers) {
            waiting.set(answer.name, await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task.taskPath, key: `${scenario}-${answer.name}`, rehearsal: { scenario, commands, offline: true } }, hub.socket));
          }
          for (const answer of answers) {
            const label = `${scenario} ${answer.name}`;
            const submission = waiting.get(answer.name)!;
            const stopped = await waitForState(hub, submission.id, ["succeeded", "failed", "blocked", "canceled"], timeoutMs);
            expect(stopped, `${label}: ${hub.driver.log().slice(-4000)}`).toMatchObject({ state: "blocked", rehearsalVerdict: { verdict: "ready", runStatus: "stopped" } });
            await hubRequest("POST", `/v1/submissions/${submission.id}/resume`, { commandId: `c-${answer.name}`, remedy: answer.remedy }, hub.socket);
          }
          for (const answer of answers) {
            const label = `${scenario} ${answer.name}`;
            const finished = await waitForState(hub, waiting.get(answer.name)!.id, ["succeeded", "failed", "blocked", "canceled"], timeoutMs);
            expect(finished.state, `${label}: ${finished.blocker ?? ""} ${hub.driver.log().slice(-4000)}`).toBe("succeeded");
            // The verdict judges the answer's continuation, not the stop it answered.
            expect(finished.rehearsalVerdict, label).toMatchObject({ verdict: "ready", runStatus: "succeeded", convergence: true });
          }
        }
      });
    }
  });
}
