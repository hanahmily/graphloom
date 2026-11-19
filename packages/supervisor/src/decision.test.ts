// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { WireValidationError } from "@graphloom/sdk";
import { parseSupervisorDecision } from "./decision.js";

describe("parseSupervisorDecision", () => {
  it("parses a fenced GraphDecision JSON block", () => {
    const text = `Here is my plan:
\`\`\`json
{
  "action": { "type": "return", "return": { "summary": "repaired" } },
  "reason": "write looks good"
}
\`\`\`
`;
    const decision = parseSupervisorDecision(text);
    expect(decision.action.type).toBe("return");
    expect(decision.reason).toBe("write looks good");
  });

  it("parses a raw JSON object when no fence is present", () => {
    const decision = parseSupervisorDecision(
      JSON.stringify({
        action: {
          type: "stop",
          stop: { reason: "budget", blocker: "corrections" },
        },
        reason: "no remaining corrections",
      }),
    );
    expect(decision.action.type).toBe("stop");
  });

  it("reads an action whose fields sit beside its type", () => {
    const decision = parseSupervisorDecision(
      JSON.stringify({ reason: "nothing left", action: { type: "stop", reason: "no authority", blocker: "corrections", evidenceRefs: ["ev-1"] } }),
    );
    expect(decision.action).toEqual({ type: "stop", stop: { reason: "no authority", blocker: "corrections", evidenceRefs: ["ev-1"] } });
    expect(parseSupervisorDecision(JSON.stringify({ reason: "retry", action: { type: "reenter", stageId: "fix", reason: "fresh" } })).action)
      .toEqual({ type: "reenter", reenter: { stageId: "fix", reason: "fresh" } });
  });

  it("reads an enter into a supervisor-only node, nested or with its fields beside its type, and a leave as reenter", () => {
    const nested = { reason: "a ruling is needed", action: { type: "enter", enter: { stageId: "arb", reason: "arbitrate", evidenceRefs: ["ev-1"] } }, evidence: ["ev-1"] };
    expect(parseSupervisorDecision(`Deciding.\n\`\`\`json\n${JSON.stringify(nested)}\n\`\`\``)).toEqual(nested);
    expect(parseSupervisorDecision(JSON.stringify({ reason: "r", action: { type: "enter", stageId: "arb", reason: "arbitrate" } })).action).toEqual({
      type: "enter",
      enter: { stageId: "arb", reason: "arbitrate" },
    });
    expect(parseSupervisorDecision(JSON.stringify({ reason: "ruled", action: { type: "reenter", stageId: "review", reason: "the ruling holds" } })).action).toEqual({
      type: "reenter",
      reenter: { stageId: "review", reason: "the ruling holds" },
    });
  });

  it("rejects an enter that names no node or gives no reason", () => {
    expect(() => parseSupervisorDecision(JSON.stringify({ reason: "r", action: { type: "enter", enter: { reason: "x" } } }))).toThrow(/enter.stageId must be a non-empty string/);
    expect(() => parseSupervisorDecision(JSON.stringify({ reason: "r", action: { type: "enter", stageId: "arb" } }))).toThrow(/enter.reason must be a non-empty string/);
  });

  it("rejects Accept even if wrapped as a decision", () => {
    expect(() =>
      parseSupervisorDecision(
        JSON.stringify({
          action: { type: "accept" },
          reason: "done",
        }),
      ),
    ).toThrow(WireValidationError);
  });

  it("rejects malformed or empty assistant text", () => {
    expect(() => parseSupervisorDecision("I think we should retry.")).toThrow(
      /neither a tool call nor GraphDecision JSON/i,
    );
    expect(() => parseSupervisorDecision("")).toThrow(/neither a tool call nor GraphDecision JSON/i);
  });
});
