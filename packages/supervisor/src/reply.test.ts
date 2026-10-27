// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { MAX_INSPECT_REQUESTS, parseSupervisorReply } from "./reply.js";

describe("parseSupervisorReply", () => {
  it("reads a decision, bare or in a json fence after prose, with its findings taken off", () => {
    const decision = { reason: "retry", action: { type: "reenter", reenter: { stageId: "fix", reason: "flaky" } }, evidence: ["ev-1", "inv-3"] };
    expect(parseSupervisorReply(JSON.stringify(decision))).toEqual({ kind: "decision", decision, findings: [] });
    const finding = { kind: "fact", text: "the build needs go 1.23", evidence: ["inv-3"], dependsOn: ["candidate"] };
    const fenced = `I ran the tests.\n\n\`\`\`json\n${JSON.stringify({ ...decision, findings: [finding] })}\n\`\`\``;
    expect(parseSupervisorReply(fenced)).toEqual({ kind: "decision", decision, findings: [finding] });
  });

  it("nests flattened action fields and refuses accept, as the JSON fallback does", () => {
    const flat = parseSupervisorReply(JSON.stringify({ reason: "r", action: { type: "validate", stageId: "fix" } }));
    expect(flat).toMatchObject({ kind: "decision", decision: { action: { type: "validate", validate: { stageId: "fix" } } } });
    expect(() => parseSupervisorReply(JSON.stringify({ reason: "r", action: { type: "accept", accept: {} } }))).toThrow(/unsupported action type: accept|Accept/);
  });

  it("recognizes inspect requests and model switches", () => {
    expect(parseSupervisorReply('{"inspect": [{"tool": "check_validate", "args": {"stageId": "fix"}}, {"tool": "list_receipts"}]}')).toEqual({
      kind: "inspect",
      requests: [
        { tool: "check_validate", args: { stageId: "fix" } },
        { tool: "list_receipts", args: {} },
      ],
    });
    expect(parseSupervisorReply('```json\n{"switch_model": {"provider": "claude-code", "modelId": "opus", "reason": "harder"}}\n```')).toEqual({
      kind: "switch_model",
      provider: "claude-code",
      modelId: "opus",
      reason: "harder",
    });
  });

  it("refuses malformed requests, switches, and prose as malformed", () => {
    expect(() => parseSupervisorReply('{"inspect": []}')).toThrow(/non-empty array/);
    expect(() => parseSupervisorReply(JSON.stringify({ inspect: Array.from({ length: MAX_INSPECT_REQUESTS + 1 }, () => ({ tool: "list_receipts" })) }))).toThrow(/at most/);
    expect(() => parseSupervisorReply('{"inspect": [{"args": {}}]}')).toThrow(/tool name/);
    expect(() => parseSupervisorReply('{"switch_model": {"provider": "x"}}')).toThrow(/switch_model.modelId/);
    expect(() => parseSupervisorReply("I would retry the stage.")).toThrow(/neither a tool call nor GraphDecision JSON/);
  });

  it("keeps a decision whose findings are not findings, saying why each was left out", () => {
    const decision = { reason: "r", action: { type: "return", return: { summary: "s" } } };
    const good = { kind: "fact", text: "x.go lacks the check", evidence: ["inv-1"] };
    expect(parseSupervisorReply(JSON.stringify({ ...decision, findings: [{ kind: "guess", text: "t" }, "the script has a typo", good] }))).toEqual({
      kind: "decision",
      decision,
      findings: [good],
      refusedFindings: ["findings[0].kind must be fact, refuted, or open", "findings[1] must be an object: the script has a typo"],
    });
    expect(parseSupervisorReply(JSON.stringify({ ...decision, findings: "typo" }))).toMatchObject({ findings: [], refusedFindings: [expect.stringMatching(/must be an array/)] });
  });
});
