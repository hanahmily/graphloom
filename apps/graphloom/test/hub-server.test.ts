// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubHealth, HubInput, HubStatus, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import { HubHttpError, hubRequest } from "../src/hub-client.js";
import { fakeInput, socketEnvironment } from "./hub-test-env.js";

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

  it("reads the active launch's log while it runs, not an older launch's", async () => {
    const { service, socket, directory, driver } = await socketEnvironment(cleanups, 1);
    const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml" }, socket);
    await service.hub.tick();
    const first = service.hub.inspect(item.id).launch!.id;
    const logs = path.join(directory, "submissions", item.id, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, `${first}.stderr.log`), `graphloom: run ${item.runId} stopped: waiting on approval\n`);
    driver.executions.set(first, { execution: "drained", ownerGone: true, externalStopped: true, observation: { protocolVersion: 1, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 0, status: "stopped", continuation: { kind: "operator", cause: "approval", evidenceRefs: [] } } });
    await service.hub.tick();
    await hubRequest("POST", `/v1/submissions/${item.id}/resume`, {}, socket); await service.hub.tick();
    const second = service.hub.inspect(item.id).launch!.id;
    await writeFile(path.join(logs, `${second}.stderr.log`), `graphloom: run ${item.runId} resuming (launch ${second}, generation 2)\n`);
    // The older log was written last; the active launch's is still the one shown.
    await utimes(path.join(logs, `${first}.stderr.log`), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const page = await hubRequest<{ launchId: string; text: string }>("GET", `/v1/submissions/${item.id}/logs`, undefined, socket);
    expect(page).toMatchObject({ launchId: second, text: expect.stringContaining("resuming") });
    // Once nothing runs, the latest log written is shown again.
    driver.complete(service.hub.inspect(item.id)); await service.hub.tick();
    expect((await hubRequest<{ launchId: string }>("GET", `/v1/submissions/${item.id}/logs`, undefined, socket)).launchId).toBe(first);
  });

  it("names the captured task's graph and the hub's state in the overview before the run's state exists", async () => {
    const { service, socket } = await socketEnvironment(cleanups, 1, undefined, fakeInput, undefined, async () => { throw new Error("ENOENT: no such file or directory, open '/hub/runs/x/state.json'"); });
    const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml" }, socket);
    await service.hub.tick();
    await service.hub.pause(item.id); await service.hub.tick();
    const snapshot = await hubRequest<MonitorSnapshot>("GET", `/v1/submissions/${item.id}/snapshot`, undefined, socket);
    expect(snapshot.run).toMatchObject({ graph: "hello", status: "paused" });
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

/** Tasks named `/tasks/<graph>--<repo>--<words>.yaml`: graph, repository and request from the name. */
function namedInput(file: string): HubInput {
  const [graph, repo, words] = path.basename(file, ".yaml").split("--") as [string, string, string];
  const task = `graph: ${graph}\nrepo: ./repo\nrequest: |\n  ${words.replace(/-/g, " ")}\n  Second line about details.\n`;
  return { ...fakeInput(file), task, taskDigest: createHash("sha256").update(task).digest("hex"), repoPath: `/repos/${repo}` };
}

describe("hub history search and health", () => {
  async function seeded(cleanup = cleanups) {
    const env = await socketEnvironment(cleanup, 0, undefined, namedInput);
    const submit = async (name: string, key: string) => {
      const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: `/tasks/${name}.yaml`, key }, env.socket);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item;
    };
    const fix = await submit("issue-fix--widgets--Fix-the-widget-crash", "fix-widgets-42");
    const review = await submit("pr-review--widgets--Review-pull-request-7", "review-widgets-7");
    const other = await submit("issue-fix--gadgets--Speed-up-gadget-loading", "fix-gadgets-3");
    await hubRequest("POST", `/v1/submissions/${fix.id}/cancel`, { commandId: "cancel-fix" }, env.socket);
    await hubRequest("POST", `/v1/submissions/${review.id}/pause`, { commandId: "pause-review" }, env.socket);
    return { ...env, fix, review, other };
  }
  const search = (socket: string, query: string) => hubRequest<HubStatus>("GET", `/v1/submissions?${query}`, undefined, socket);
  const ids = (status: HubStatus) => [...status.submissions.map((item) => item.id), ...(status.archived ?? []).map((entry) => entry.id)];

  it("filters live submissions by state, graph, repository, key, time, text and limit, newest first", async () => {
    const { socket, fix, review, other } = await seeded();
    expect(ids(await search(socket, "limit=10"))).toEqual([other.id, review.id, fix.id]);
    expect(ids(await search(socket, "state=canceled&state=paused"))).toEqual([review.id, fix.id]);
    expect(ids(await search(socket, "graph=issue-fix"))).toEqual([other.id, fix.id]);
    expect(ids(await search(socket, "repo=widgets"))).toEqual([review.id, fix.id]);
    expect(ids(await search(socket, `repo=${encodeURIComponent("/repos/gadgets")}`))).toEqual([other.id]);
    expect(ids(await search(socket, `repo=${encodeURIComponent("/repos")}`))).toEqual([]);
    expect(ids(await search(socket, "key=widgets"))).toEqual([review.id, fix.id]);
    expect(ids(await search(socket, "grep=WIDGET%20crash"))).toEqual([fix.id]);
    expect(ids(await search(socket, "grep=details"))).toHaveLength(3);
    expect(ids(await search(socket, `since=${encodeURIComponent(review.acceptedAt)}`))).toEqual([other.id, review.id]);
    expect(ids(await search(socket, `until=${encodeURIComponent(review.acceptedAt)}`))).toEqual([review.id, fix.id]);
    const limited = await search(socket, "limit=1");
    expect(ids(limited)).toEqual([other.id]); expect(limited.matched).toBe(3);
    expect(limited.summaries?.[other.id]).toMatchObject({ graph: "issue-fix", firstLine: "Speed up gadget loading" });
    // The plain listing is unchanged: queue order, no summaries.
    const plain = await hubRequest<HubStatus>("GET", "/v1/submissions", undefined, socket);
    expect(plain.submissions.map((item) => item.id)).toEqual([fix.id, review.id, other.id]); expect(plain).not.toHaveProperty("summaries");
    for (const bad of ["state=bogus", "limit=0", "since=yesterday", "archived=maybe", "nope=1", "graph=a&graph=b"]) {
      await expect(search(socket, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("finds archived submissions only with archived=true, under the same filters", async () => {
    const { socket, fix, review, other, directory } = await seeded();
    await hubRequest("POST", `/v1/submissions/${fix.id}/archive`, { commandId: "archive-fix" }, socket);
    expect(ids(await search(socket, "limit=10"))).toEqual([other.id, review.id]);
    const found = await search(socket, "archived=true&key=fix-widgets");
    expect(found.submissions).toEqual([]);
    expect(found.archived).toEqual([expect.objectContaining({
      archived: true, id: fix.id, runId: fix.runId, key: "fix-widgets-42", graph: "issue-fix", repoPath: "/repos/widgets", taskPath: "/tasks/issue-fix--widgets--Fix-the-widget-crash.yaml",
      request: expect.objectContaining({ firstLine: "Fix the widget crash", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      state: "canceled", stateDir: path.join(directory, "runs", fix.runId), acceptedAt: fix.acceptedAt,
    })]);
    expect(ids(await search(socket, "archived=true&grep=widget%20crash"))).toEqual([fix.id]);
    expect(ids(await search(socket, "archived=true&state=canceled"))).toEqual([fix.id]);
    expect(ids(await search(socket, "archived=true&state=paused"))).toEqual([review.id]);
    expect(ids(await search(socket, "archived=true&repo=widgets"))).toEqual([review.id, fix.id]);
    expect(ids(await search(socket, "archived=true&limit=2"))).toEqual([other.id, review.id]);
    expect(ids(await search(socket, "archived=true&graph=pr-review"))).toEqual([review.id]);
  });

  it("reports health with version, socket, counts and the archive index size", async () => {
    const { socket, fix } = await seeded();
    await hubRequest("POST", `/v1/submissions/${fix.id}/archive`, { commandId: "archive-fix" }, socket);
    const health = await hubRequest<HubHealth>("GET", "/v1/health", undefined, socket);
    expect(health).toMatchObject({ socket, counts: { paused: 1, queued: 1 }, archivedEntries: 1, closing: false, maxConcurrentRuns: 0 });
    expect(health).not.toHaveProperty("fault");
  });
});
