// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HubStatus } from "@graphloom/sdk";
import { HubEvents } from "../src/hub-events.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "hub-events-")); roots.push(root); return root; }
const status = (limit = 3): HubStatus => ({ hubId: "hub-events-test", maxConcurrentRuns: limit, occupiedSlots: 0, submissions: [] });

it("persists a stable cursor, excludes polling noise, and replays only later changes after restart", async () => {
  const root = await directory(); const events = await HubEvents.open(root, status().hubId);
  await events.capture(status()); const cursor = events.read().cursor;
  await Promise.all(Array.from({ length: 10 }, () => events.capture(status())));
  expect(events.read(cursor)).toEqual({ cursor, gap: false, events: [] });
  await events.capture(status(1));
  const restored = await HubEvents.open(root, status().hubId);
  const page = restored.read(cursor);
  expect(page.gap).toBe(false); expect(page.events).toHaveLength(1);
  expect(page.events[0]?.message).toContain("0/1");
  expect(page.events[0]?.sequence).toBe(cursor + 1);
});

it("bounds retained events and explicitly reports expired or future cursors", async () => {
  const root = await directory(); const events = await HubEvents.open(root, status().hubId);
  for (let index = 0; index < 515; index++) await events.capture(status(index % 2));
  const stored = JSON.parse(await readFile(path.join(root, "events.json"), "utf8")) as { events: unknown[] };
  expect(stored.events).toHaveLength(512);
  expect(events.read(0)).toMatchObject({ gap: true, events: [] });
  expect(events.read(events.read().cursor + 1)).toMatchObject({ gap: true, events: [] });
  expect(events.read(events.read().cursor - 1).events).toHaveLength(1);
});

it("volatile monitoring resumes with an explicit history gap after durable history is unavailable", async () => {
  const events = HubEvents.volatile(status().hubId);
  await events.capture(status());
  expect(events.read(123)).toMatchObject({ gap: true, events: [] });
  const cursor = events.read().cursor;
  await events.capture(status(4));
  expect(events.read(cursor)).toMatchObject({ gap: false, events: [expect.objectContaining({ kind: "capacity" })] });
});
