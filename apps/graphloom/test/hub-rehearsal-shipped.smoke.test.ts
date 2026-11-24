// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// One scenario per shipped graph, direct and through a temporary hub, and a rehearsal submission's --stop-at
// (PR tier; the full tier runs every scenario: hub-rehearsal-shipped.full.test.ts).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubSubmission } from "@graphloom/sdk";
import { createScope, type TestScope } from "@graphloom/testkit";
import { hubRequest } from "../src/hub-client.js";
import { useTestHubs } from "./hub-harness.js";
import { shippedHubSuite } from "./hub-rehearsal-shipped.js";
import { rehearseDirect, shippedTask, summarizeHubVerdict } from "./shipped-rehearsals.js";

shippedHubSuite((_graph, scenarios) => scenarios.filter((name) => name === "happy"), 600_000);

describe("a rehearsal submission's --stop-at", () => {
  const { startHub, waitForState } = useTestHubs();
  let scope: TestScope | undefined;
  afterEach(async () => {
    await scope?.dispose();
    scope = undefined;
  });

  it("stops where rehearse --stop-at stops, with the stop's verdict, and hub resume continues it on the stand-ins", { timeout: 300_000 }, async () => {
    scope = createScope();
    const task = await shippedTask(scope, "hello");
    const hub = await startHub(task.runnerConfig, { env: task.env });
    // A stop point by id and by name; the run stops once the node is accepted, before the graph is asked for its next step.
    for (const [stopAt, resume] of [["write", true], ["Review", false]] as const) {
      const direct = await rehearseDirect(task, "happy", { stopAt });
      expect(direct.summary.verdict, JSON.stringify(direct.report)).toBe("ready");
      const submitted = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task.taskPath, key: `stop-${stopAt}`, rehearsal: { offline: true, stopAt } }, hub.socket);
      expect(submitted.input.rehearsal).toEqual({ offline: true, stopAt });
      const done = await waitForState(hub, submitted.id, ["succeeded", "failed", "blocked", "canceled"]);
      expect(done.rehearsalVerdict, hub.driver.log()).toBeDefined();
      expect(summarizeHubVerdict(done.rehearsalVerdict!)).toEqual(direct.summary);
      // The report beside the verdict is the stop report rehearse --stop-at prints.
      const report = JSON.parse(await readFile(path.join(hub.directory, "rehearsals", submitted.runId, "report.json"), "utf8")) as { stoppedAt: string; ok: boolean };
      expect(report).toMatchObject({ stoppedAt: direct.report.stoppedAt, ok: true });
      // Stopped at its own stop point: an operator stop the hub shows as blocked, and the verdict is recorded, not pending.
      expect(done).toMatchObject({ state: "blocked", rehearsalVerdict: { stoppedAt: direct.report.stoppedAt, runStatus: "stopped" } });
      if (!resume) continue;
      await hubRequest("POST", `/v1/submissions/${submitted.id}/resume`, { commandId: "c-continue" }, hub.socket);
      const finished = await waitForState(hub, submitted.id, ["succeeded", "failed", "blocked", "canceled"]);
      expect(finished.state, hub.driver.log()).toBe("succeeded");
      // The continuation keeps the verdict the stop recorded.
      expect(finished.rehearsalVerdict).toEqual(done.rehearsalVerdict);
    }
  });
});
