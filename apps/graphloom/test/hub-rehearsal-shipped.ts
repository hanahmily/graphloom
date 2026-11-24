// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The shared suite of hub-rehearsal-shipped.<tier>.test.ts: each shipped graph's scenarios rehearsed directly
 * (`graphloom rehearse --offline`) and as hub rehearsal submissions with the same settings on a temporary hub, whose
 * recorded verdicts must equal the direct ones, every one of them ready (docs/design-run-hub.md §12.3,
 * docs/design-graph-rehearsal.md §4.6). The PR tier runs one scenario per graph, the full tier every scenario.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { HubSubmission } from "@graphloom/sdk";
import { createScope, type TestScope } from "@graphloom/testkit";
import { hubRequest } from "../src/hub-client.js";
import { useTestHubs } from "./hub-harness.js";
import { commandsFor, eachLimited, GO, rehearseDirect, shippedTask, SHIPPED_GRAPHS, summarizeHubVerdict, type ShippedGraph, type VerdictSummary } from "./shipped-rehearsals.js";

/** Direct and hub rehearsals in flight at once: each is a CLI process with its plugin host and stand-ins. */
const PARALLEL = 3;

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
      });
    }
  });
}
