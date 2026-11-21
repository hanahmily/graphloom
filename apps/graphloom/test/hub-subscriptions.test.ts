// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubStatus } from "@graphloom/sdk";
import { deliverHapiReport, openSubscriptions } from "../src/hub-subscriptions.js";
import type { HubDelivery, HubDeliveryResult, HubSubscription } from "../src/hub-subscriptions.js";
import type { HubEventPage } from "../src/hub-events.js";

const fakeSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: fakeSpawn }));
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); vi.clearAllMocks(); });
const status: HubStatus = { hubId: "hub-1", occupiedSlots: 1, maxConcurrentRuns: 2, submissions: [] };
const empty: HubEventPage = { cursor: 0, gap: false, events: [] };
function page(sequence: number, kind = "running", submissionId?: string): HubEventPage {
  return { cursor: sequence, gap: false, events: [{ sequence, at: new Date(100000 + sequence).toISOString(), kind, message: `event ${sequence}`, ...(submissionId ? { submissionId } : {}) }] };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "graphloom-subscriptions-")); folders.push(directory);
  let now = 100000;
  let result: HubDeliveryResult = { state: "accepted" };
  const deliveries: HubDelivery[] = [];
  const deliver = async (delivery: HubDelivery): Promise<HubDeliveryResult> => { deliveries.push(delivery); return result; };
  const options = { deliver, now: () => now };
  const subscriptions = await openSubscriptions(directory, options);
  return { directory, subscriptions, deliveries, options, advance: (ms: number) => { now += ms; }, result: (value: HubDeliveryResult) => { result = value; } };
}

describe("explicit durable HAPI subscriptions", () => {
  it("sends nothing without an explicit subscription and deduplicates repeated registrations", async () => {
    const f = await fixture(); await f.subscriptions.tick(page(1, "blocked"), status);
    expect(f.deliveries).toHaveLength(0);
    await expect(f.subscriptions.add({ sessionId: "" })).rejects.toThrow(/explicit/);
    const a = await f.subscriptions.add({ sessionId: "session-123" });
    const b = await f.subscriptions.add({ sessionId: "session-123", wake: false });
    expect(a.id).toBe(b.id);
    await f.subscriptions.tick(empty, status);
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]).toMatchObject({ sessionId: "session-123", wake: false });
    expect(f.deliveries[0]!.text).toContain("static status snapshot");
    expect(f.subscriptions.list()[0]!.reports[0]!.state).toBe("accepted");
    await f.subscriptions.remove(a.id); await f.subscriptions.tick(page(2, "failed"), status);
    expect(f.deliveries).toHaveLength(1);
    expect(fakeSpawn).not.toHaveBeenCalled();
  });
  it("coalesces ordinary changes for 60 seconds, emits blockers immediately, and heartbeats at 15 minutes", async () => {
    const f = await fixture(); await f.subscriptions.add({ sessionId: "session" }); await f.subscriptions.tick(empty, status);
    await f.subscriptions.tick(page(1), status); f.advance(30000); await f.subscriptions.tick(page(2), status);
    expect(f.deliveries).toHaveLength(1);
    f.advance(30000); await f.subscriptions.tick(page(2), status);
    expect(f.deliveries).toHaveLength(2); expect(f.deliveries[1]!.text).toContain("event 2");
    await f.subscriptions.tick(page(3, "blocked"), status); expect(f.deliveries).toHaveLength(3);
    f.advance(15 * 60000 - 1); await f.subscriptions.tick(page(3), status); expect(f.deliveries).toHaveLength(3);
    f.advance(1); await f.subscriptions.tick(page(3), status); expect(f.deliveries).toHaveLength(4);
  });
  it("filters unrelated submissions, advances cursor, and reports history gaps honestly", async () => {
    const f = await fixture(); const id = "s-00000000-0000-0000-0000-000000000000";
    await f.subscriptions.add({ sessionId: "session", submissionId: id }); await f.subscriptions.tick(empty, status);
    await f.subscriptions.tick(page(1, "blocked", "s-11111111-1111-1111-1111-111111111111"), status);
    expect(f.deliveries).toHaveLength(1); expect(f.subscriptions.cursor()).toBe(1);
    await f.subscriptions.tick({ cursor: 20, gap: true, events: [] }, status);
    expect(f.deliveries[1]!.text).toContain("Event history gap");
    expect(f.subscriptions.cursor()).toBe(20);
  });
  it("uses the explicit panel renderer and caps/escapes report text", async () => {
    const f = await fixture();
    const render = vi.fn(async (_subscription: HubSubscription) => "\x1b[31mColor\x1b[0m\n```\n" + "大".repeat(2000));
    const manager = await openSubscriptions(f.directory, { ...f.options, render });
    await manager.add({ sessionId: "session", panels: ["topology", "usage"], wake: true }); await manager.tick(empty, status);
    expect(render.mock.calls[0]?.[0]).toMatchObject({ panels: ["topology", "usage"] });
    const delivery = f.deliveries[0]!;
    expect(delivery.wake).toBe(true); expect(Buffer.byteLength(delivery.text)).toBeLessThanOrEqual(1024);
    expect(delivery.text).not.toContain("\x1b"); expect(delivery.text).toContain("report shortened");
    expect(delivery.text).not.toContain("\ufffd");
  });
  it("retries explicit delivery failures with the same report ID and stops after five attempts", async () => {
    const f = await fixture(); f.result({ state: "failed", reason: "hapi executable absent" });
    await f.subscriptions.add({ sessionId: "session" }); await f.subscriptions.tick(empty, status);
    const reportId = f.deliveries[0]!.reportId;
    for (const delay of [30000, 60000, 120000, 240000]) { f.advance(delay); await f.subscriptions.tick(empty, status); }
    expect(f.deliveries).toHaveLength(5); expect(new Set(f.deliveries.map((d) => d.reportId))).toEqual(new Set([reportId]));
    expect(f.subscriptions.list()[0]!.reports[0]).toMatchObject({ state: "failed", attempts: 5 });
    f.advance(1); await f.subscriptions.tick(empty, status); expect(f.deliveries).toHaveLength(5);
  });
  it("persists the sending state before delivery and never retries an uncertain outcome", async () => {
    const f = await fixture();
    const manager = await openSubscriptions(f.directory, { ...f.options, deliver: async () => {
      const saved = JSON.parse(await readFile(path.join(f.directory, "subscriptions.json"), "utf8"));
      expect(saved.subscriptions[0].reports[0].state).toBe("sending");
      return { state: "uncertain", reason: "response lost" };
    } });
    await manager.add({ sessionId: "session" }); await manager.tick(empty, status);
    const reopened = await openSubscriptions(f.directory, f.options);
    f.advance(1000000); await reopened.tick(page(1, "blocked"), status);
    expect(f.deliveries).toHaveLength(0);
    expect(reopened.list()[0]!.reports[0]!.state).toBe("uncertain");
  });
  it("treats a restart during delivery as uncertain and bounds queued reports during outages", async () => {
    const f = await fixture(); f.result({ state: "uncertain", reason: "unknown" });
    await f.subscriptions.add({ sessionId: "session" }); await f.subscriptions.tick(empty, status);
    const file = path.join(f.directory, "subscriptions.json"); const saved = JSON.parse(await readFile(file, "utf8"));
    saved.subscriptions[0].reports[0].state = "sending"; await writeFile(file, JSON.stringify(saved));
    const next = await openSubscriptions(f.directory, f.options);
    expect(next.list()[0]!.reports[0]).toMatchObject({ state: "uncertain" });
    for (let i = 1; i <= 30; i++) { f.advance(1000); await next.tick(page(i, "blocked"), status); }
    expect(next.list()[0]!.reports).toHaveLength(8);
    expect(next.list()[0]!.reports[0]!.state).toBe("uncertain");
    expect(next.list()[0]!.droppedReports).toBeGreaterThan(0);
    expect(f.deliveries).toHaveLength(1);
  });
  it("refuses malformed durable subscription data", async () => {
    const f = await fixture(); await writeFile(path.join(f.directory, "subscriptions.json"), '{"version":9}');
    await expect(openSubscriptions(f.directory, f.options)).rejects.toThrow(/invalid/);
  });
});

describe("HAPI argv transport", () => {
  it("uses fixed argv, stdin text, queue delivery, and only explicitly requested wake", async () => {
    let body = "";
    fakeSpawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      child.stdin.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      process.nextTick(() => child.emit("close", 0));
      return child;
    });
    expect(await deliverHapiReport({ sessionId: "session-1", wake: false, reportId: "report", text: "hello `$(danger)`" })).toEqual({ state: "accepted" });
    expect(fakeSpawn.mock.calls[0]).toEqual(["hapi", ["ping-peer", "session-1", "--message-file", "-", "--delivery-mode", "queue"], { stdio: ["pipe", "pipe", "pipe"] }]);
    expect(body).toBe("hello `$(danger)`");
    await deliverHapiReport({ sessionId: "session-1", wake: true, reportId: "report2", text: "hello" });
    expect(fakeSpawn.mock.calls[1]![1]).toContain("--wake");
  });
  it("does not claim a nonzero exit is a safely retryable delivery rejection", async () => {
    fakeSpawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      process.nextTick(() => child.emit("close", 1)); return child;
    });
    expect(await deliverHapiReport({ sessionId: "session-1", wake: false, reportId: "report", text: "hello" })).toMatchObject({ state: "uncertain" });
  });
});
