// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { qualifyRepair, returnToNormal } from "@graphloom/sdk";
import { createScriptedSupervisor } from "./types.js";
import { createPiSupervisor, type PiSupervisorSessionPort } from "./pi-supervisor.js";

describe("supervisor session identity across repair rounds", () => {
  it("reuses one scripted session id for every grantCandidateCoding round", async () => {
    const supervisor = createScriptedSupervisor({
      sessionId: "run-session-stable",
      decisions: [
        qualifyRepair({ target: "validator", reason: "r1" }, "q1"),
        qualifyRepair({ target: "validator", reason: "r2" }, "q2"),
      ],
    });
    const roots: string[] = [];
    await supervisor.grantCandidateCoding?.("/tmp/cand-a");
    roots.push(
      (supervisor as { getCandidateCodingRoot?: () => string | undefined }).getCandidateCodingRoot?.() ??
        "",
    );
    await supervisor.revokeCandidateCoding?.();
    await supervisor.grantCandidateCoding?.("/tmp/cand-b");
    roots.push(
      (supervisor as { getCandidateCodingRoot?: () => string | undefined }).getCandidateCodingRoot?.() ??
        "",
    );
    expect(supervisor.sessionId).toBe("run-session-stable");
    expect(roots).toEqual(["/tmp/cand-a", "/tmp/cand-b"]);
  });

  it("keeps PiSupervisor sessionId stable across coding grants", async () => {
    const session: PiSupervisorSessionPort = {
      runId: "r1",
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      sessionId: "pi-sess-1",
      sessionFile: "/tmp/pi.jsonl",
      credentialSource: "options",
      async prompt() {
        return JSON.stringify(returnToNormal({ summary: "ok" }, "ok"));
      },
      async setModel() {
        /* */
      },
      async grantCandidateCoding() {
        /* */
      },
      async revokeCandidateCoding() {
        /* */
      },
      async close() {
        /* */
      },
    };
    const supervisor = createPiSupervisor({ session });
    await supervisor.grantCandidateCoding("/tmp/c1");
    const id1 = supervisor.sessionId;
    await supervisor.revokeCandidateCoding();
    await supervisor.grantCandidateCoding("/tmp/c2");
    expect(supervisor.sessionId).toBe(id1);
    expect(supervisor.sessionId).toBe("pi-sess-1");
    expect(supervisor.candidateCodingRoot()).toBe("/tmp/c2");
  });
});
