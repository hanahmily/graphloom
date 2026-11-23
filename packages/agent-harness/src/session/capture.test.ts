// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { completeJsonl, sessionSaver } from "./capture.js";

describe("completeJsonl", () => {
  it("keeps only complete transcript records in a copy taken mid-write", () => {
    expect(completeJsonl('{"a":1}\n{"b":2}\n')).toBe('{"a":1}\n{"b":2}\n');
    expect(completeJsonl('{"a":1}\n{"b":')).toBe('{"a":1}\n');
    expect(completeJsonl('{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}');
    expect(completeJsonl('{"b":')).toBe("");
  });
});

describe("sessionSaver", () => {
  it("saves at once on the first activity, then at most once per interval, and reports the first restorable save once", async () => {
    const saves: number[] = [];
    let restorable = false;
    let reported = 0;
    const saver = sessionSaver(
      async () => {
        saves.push(Date.now());
        return restorable;
      },
      () => (reported += 1),
      50,
    );
    saver.poke();
    await new Promise((r) => setTimeout(r, 10));
    expect(saves).toHaveLength(1);
    expect(reported).toBe(0);
    restorable = true;
    // Activity inside the interval schedules one save at its end, not one per poke,
    // and that save is followed by one more an interval later.
    saver.poke();
    saver.poke();
    await new Promise((r) => setTimeout(r, 200));
    expect(saves).toHaveLength(3);
    expect(saves[1]! - saves[0]!).toBeGreaterThanOrEqual(45);
    expect(saves[2]! - saves[1]!).toBeGreaterThanOrEqual(45);
    expect(reported).toBe(1);
    saver.poke();
    await new Promise((r) => setTimeout(r, 200));
    expect(saves).toHaveLength(5);
    expect(saves[4]! - saves[3]!).toBeGreaterThanOrEqual(45);
    expect(reported).toBe(1);
    await saver.close();
  });

  it("saves once more an interval after the last activity, so what the agent wrote after a save read it is kept while it goes quiet", async () => {
    // The agent reports activity, then writes it to its transcript after the save has read it.
    let transcript = "prompt";
    let copy = "";
    let saves = 0;
    const saver = sessionSaver(
      async () => {
        saves += 1;
        copy = transcript;
        // The agent writes what it reported just after the first save read the transcript.
        transcript = "prompt\ncommand started";
        return true;
      },
      () => undefined,
      20,
    );
    saver.poke();
    // No further activity: the agent is quiet while its command runs.
    await expect.poll(() => copy).toBe("prompt\ncommand started");
    expect(saves).toBe(2);
    // The follow-up save saw no new activity, so nothing more is scheduled.
    await new Promise((r) => setTimeout(r, 100));
    expect(saves).toBe(2);
    await saver.close();
  });

  it("waits for a save in progress on close, and schedules nothing after it", async () => {
    let finish: (() => void) | undefined;
    let saves = 0;
    let reported = false;
    const saver = sessionSaver(
      () => {
        saves += 1;
        return new Promise<boolean>((resolve) => (finish = () => resolve(true)));
      },
      () => (reported = true),
      10,
    );
    saver.poke();
    await new Promise((r) => setTimeout(r, 5));
    let closed = false;
    const closing = saver.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(false);
    finish!();
    await closing;
    // A save that completes after close is not reported: the run's own final save reports the session.
    expect(reported).toBe(false);
    saver.poke();
    await new Promise((r) => setTimeout(r, 30));
    expect(saves).toBe(1);
  });

  it("treats a failed early save as best effort", async () => {
    let calls = 0;
    const saver = sessionSaver(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("transcript replaced");
        return true;
      },
      () => undefined,
      5,
    );
    // The failed save is followed by another, as any save after activity is.
    saver.poke();
    await expect.poll(() => calls).toBe(2);
    await expect(saver.close()).resolves.toBeUndefined();
  });
});
