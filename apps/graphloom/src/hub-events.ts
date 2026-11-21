// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import type { HubStatus } from "@graphloom/sdk";
import { stableHash } from "@graphloom/sdk";
import { boundedText, writePrivateJsonOrText } from "./hub-input.js";

export interface HubEvent {
  sequence: number;
  at: string;
  kind: string;
  submissionId?: string;
  runId?: string;
  controllerRevision?: number;
  message: string;
}
export interface HubEventPage { cursor: number; gap: boolean; events: HubEvent[]; }
interface State { version: 1; hubId: string; sequence: number; marks: Record<string, string>; events: HubEvent[]; }

/** A bounded event history, independent from scheduling durability and authority. */
export class HubEvents {
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(private file: string | undefined, private state: State) {}
  static volatile(hubId: string): HubEvents {
    // A new high watermark makes previous durable cursors request a fresh snapshot.
    return new HubEvents(undefined, { version: 1, hubId, sequence: Date.now(), marks: {}, events: [] });
  }
  static async open(directory: string, hubId: string): Promise<HubEvents> {
    const file = path.join(directory, "events.json");
    let state: State;
    try {
      state = JSON.parse(await boundedText(file, 2 * 1024 * 1024)) as State;
      if (state.version !== 1 || state.hubId !== hubId || !Number.isSafeInteger(state.sequence) || !Array.isArray(state.events) || state.events.length > 512 || !state.marks || typeof state.marks !== "object") throw new Error("invalid monitoring event history");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 1, hubId, sequence: 0, marks: {}, events: [] };
    }
    return new HubEvents(file, state);
  }
  capture(status: HubStatus): Promise<void> {
    const next = this.serial.then(async () => {
      const copy = structuredClone(this.state);
      const marks: Record<string, string> = {};
      const add = (event: Omit<HubEvent, "sequence" | "at">) => copy.events.push({ ...event, sequence: ++copy.sequence, at: new Date().toISOString() });
      marks.hub = stableHash({ limit: status.maxConcurrentRuns, occupied: status.occupiedSlots, fault: status.fault });
      if (marks.hub !== copy.marks.hub) add({ kind: "capacity", message: `Hub occupied ${status.occupiedSlots}/${status.maxConcurrentRuns}${status.fault ? `; ${status.fault}` : ""}` });
      for (const item of status.submissions) {
        const summary = { state: item.state, desired: item.desiredAction, progress: item.progressRevision, controllerRevision: item.observation?.stateRevision, blocker: item.blocker, eligibleAt: item.eligibleAt, generation: item.generation };
        marks[item.id] = stableHash(summary);
        if (marks[item.id] === copy.marks[item.id]) continue;
        add({ kind: item.state, submissionId: item.id, runId: item.runId,
          ...(item.observation !== undefined ? { controllerRevision: item.observation.stateRevision } : {}),
          message: `${item.id} · ${item.runId} · ${item.state}${item.eligibleAt ? `; eligible ${item.eligibleAt}` : ""}${item.blocker ? `; ${item.blocker}` : ""}`.slice(0, 1500) });
      }
      copy.marks = marks;
      copy.events = copy.events.slice(-512);
      if (copy.sequence !== this.state.sequence || Object.keys(copy.marks).length !== Object.keys(this.state.marks).length) {
        if (this.file !== undefined) await writePrivateJsonOrText(this.file, JSON.stringify(copy));
        this.state = copy;
      }
    });
    this.serial = next.catch(() => undefined);
    return next;
  }
  read(since?: number, submissionId?: string): HubEventPage {
    const cursor = this.state.sequence;
    if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new Error("event cursor must be a nonnegative integer");
    const first = this.state.events[0]?.sequence ?? cursor + 1;
    const gap = since !== undefined && (since > cursor || since < first - 1);
    return { cursor, gap, events: since === undefined || gap ? [] : this.state.events.filter((event) => event.sequence > since && (!submissionId || event.submissionId === submissionId || !event.submissionId)) };
  }
}
