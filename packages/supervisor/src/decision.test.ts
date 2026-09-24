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
      /no GraphDecision JSON/i,
    );
    expect(() => parseSupervisorDecision("")).toThrow(/no GraphDecision JSON/i);
  });
});
