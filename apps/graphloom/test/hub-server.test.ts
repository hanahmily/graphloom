// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubStatus, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import { HubHttpError, hubRequest } from "../src/hub-client.js";
import { socketEnvironment } from "./hub-test-env.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("hub Unix service with an injected execution driver", () => {
  it("admits twenty concurrent submissions under three shared slots and drains all twenty", async () => {
    const { service, socket, driver } = await socketEnvironment(cleanups);
    const submissions = await Promise.all(Array.from({ length: 20 }, (_, i) => hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: `/tasks/${i}.yaml`, key: `task-${i}` }, socket)));
    await service.hub.tick();
    let status = await hubRequest<HubStatus>("GET", "/v1/submissions", undefined, socket);
    expect(status.occupiedSlots).toBe(3);
    expect(status.submissions.filter(item => item.state === "queued")).toHaveLength(17);
    expect(new Set(submissions.map(item => item.id)).size).toBe(20);
    for (let round = 0; round < 8 && status.submissions.some(item => item.state !== "succeeded"); round++) {
      for (const item of status.submissions.filter(item => item.launch)) driver.complete(item);
      await service.hub.tick();
      status = await hubRequest<HubStatus>("GET", "/v1/submissions", undefined, socket);
      expect(status.occupiedSlots).toBeLessThanOrEqual(3);
    }
    expect(status.submissions.every(item => item.state === "succeeded")).toBe(true);
    expect(driver.grants).toHaveLength(20);
    expect(driver.peak).toBe(3);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
  });

  it("replays submission/command keys, rejects conflicting inputs, and preserves slots on a lower limit", async () => {
    const { service, socket, driver } = await socketEnvironment(cleanups);
    const request = { taskPath: "/tasks/a.yaml", key: "stable-key" };
    const first = await hubRequest<HubSubmission>("POST", "/v1/submissions", request, socket);
    const again = await hubRequest<HubSubmission>("POST", "/v1/submissions", request, socket);
    expect(again.id).toBe(first.id);
    await expect(hubRequest("POST", "/v1/submissions", { ...request, taskPath: "/tasks/changed.yaml" }, socket)).rejects.toMatchObject({ status: 409 });
    await hubRequest("POST", "/v1/submissions", { taskPath: "/tasks/b.yaml", key: "b" }, socket);
    await service.hub.tick();
    const limited = await hubRequest<HubStatus>("POST", "/v1/limit", { limit: 0 }, socket);
    expect(limited.occupiedSlots).toBe(2);
    await hubRequest("POST", "/v1/submissions", { taskPath: "/tasks/c.yaml", key: "c" }, socket);
    await service.hub.tick();
    expect(driver.grants).toHaveLength(2);
    const route = `/v1/submissions/${first.id}/pause`;
    const paused = await hubRequest<HubSubmission>("POST", route, { commandId: "pause-once" }, socket);
    const repeated = await hubRequest<HubSubmission>("POST", route, { commandId: "pause-once" }, socket);
    expect(paused.desiredAction).toBe("hold"); expect(repeated.desiredAction).toBe("hold");
  });

  it("returns read-only snapshots and rejects unknown fields before effects", async () => {
    const { service, socket, driver } = await socketEnvironment(cleanups, 0);
    const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml" }, socket);
    const snapshot = await hubRequest<MonitorSnapshot>("GET", `/v1/submissions/${item.id}/snapshot`, undefined, socket);
    expect(snapshot.run.status).toBe("not-created"); expect(snapshot.usage).toBeUndefined();
    expect(driver.grants).toHaveLength(0);
    for (const [route, body] of [["/v1/submissions", { taskPath: "/tasks/a.yaml", command: "sh" }], ["/v1/limit", { limit: 1, override: true }], [`/v1/submissions/${item.id}/resume`, { remedy: { pretendApproved: true } }]] as const) {
      await expect(hubRequest("POST", route, body, socket)).rejects.toBeInstanceOf(HubHttpError);
    }
    await expect(hubRequest("POST", "/v1/submissions", { taskPath: "relative.yaml" }, socket)).rejects.toMatchObject({ status: 400 });
    expect(service.hub.list().submissions).toHaveLength(1);
    expect(service.hub.list().maxConcurrentRuns).toBe(0);
  });

  it("keeps canceled archive retries idempotent through the HTTP surface", async () => {
    const { socket } = await socketEnvironment(cleanups, 0);
    const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml", key: "archived" }, socket);
    await hubRequest("POST", `/v1/submissions/${item.id}/cancel`, { commandId: "cancel" }, socket);
    const route = `/v1/submissions/${item.id}/archive`;
    const archived = await hubRequest("POST", route, { commandId: "archive" }, socket);
    expect(await hubRequest("POST", route, { commandId: "archive" }, socket)).toEqual(archived);
    expect(await hubRequest("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml", key: "archived" }, socket)).toMatchObject({ archived: true, id: item.id });
  });

  it("keeps admission available when event history is corrupt", async () => {
    const { service, socket, driver, directory } = await socketEnvironment(cleanups, 1, async directory => {
      await writeFile(path.join(directory, "events.json"), "{corrupt");
    });
    const health = await hubRequest<{ monitoringError?: string }>("GET", "/v1/health", undefined, socket);
    expect(health.monitoringError).toContain("unavailable");
    const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/recovery.yaml" }, socket);
    await service.hub.tick();
    expect(service.hub.inspect(item.id).state).toBe("running"); expect(driver.grants).toHaveLength(1);
    expect(await readFile(path.join(directory, "events.json"), "utf8")).toBe("{corrupt");
    expect(await hubRequest("GET", "/v1/events", undefined, socket)).toMatchObject({ events: expect.any(Array) });
  });

  it("ignores legacy chat delivery state and exposes no subscription endpoints", async () => {
    const { socket, directory } = await socketEnvironment(cleanups, 0, async directory => {
      await writeFile(path.join(directory, "subscriptions.json"), "{obsolete");
    });
    expect(await hubRequest("GET", "/v1/health", undefined, socket)).not.toHaveProperty("subscriptionsError");
    for (const [method, route, body] of [
      ["GET", "/v1/subscriptions", undefined],
      ["POST", "/v1/subscriptions", { sessionId: "session", wake: true }],
      ["DELETE", "/v1/subscriptions/old", undefined],
      ["POST", "/v1/subscriptions/old/reports/report", { outcome: "accepted" }],
    ] as const) await expect(hubRequest(method, route, body, socket)).rejects.toMatchObject({ status: 404 });
    expect(await readFile(path.join(directory, "subscriptions.json"), "utf8")).toBe("{obsolete");
  });
});
