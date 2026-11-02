// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { assertGraphDefinition, assertWireRequest, PROTOCOL_VERSION, TaskPlanError, validateTaskPlan, WireValidationError, type TaskPlanStep } from "./index.js";

const NS = "refs/graphloom/demo";

function plan(...steps: TaskPlanStep[]): unknown {
  return { summary: "demo", steps };
}
const write: TaskPlanStep = { kind: "writeTask", path: "t/task.yaml", fields: { request: "Do it." } };
const good = plan(
  { kind: "fetch", remote: "origin", refspec: "refs/pull/7/head", intoRef: `${NS}/7/head` },
  { kind: "resolve", name: "headSha", revParse: `${NS}/7/head` },
  { kind: "updateRef", from: "${headSha}", to: `${NS}/7/heads/\${headSha}` },
  { kind: "resolve", name: "mergeBase", mergeBase: [`${NS}/7/head`, `${NS}/7/base`] },
  { kind: "writeTask", path: "t/task.yaml", fields: { base: "${mergeBase}", request: "Report at ${headSha}." } },
);

function refusal(value: unknown): string {
  try {
    validateTaskPlan(value, "demo");
  } catch (err) {
    expect(err).toBeInstanceOf(TaskPlanError);
    return (err as Error).message;
  }
  throw new Error("expected the plan to be refused");
}

describe("validateTaskPlan", () => {
  it("accepts a well-formed plan and returns it", () => {
    expect(validateTaskPlan(good, "demo")).toEqual(good);
  });

  it("refuses a step that would run a command, and an extra property, naming the step", () => {
    expect(refusal(plan({ kind: "run", argv: ["sh", "-c", "id"] } as never, write))).toMatch(/step 1 \(run\).*unknown step kind.*no step that runs a command/);
    expect(refusal(plan({ kind: "fetch", remote: "origin", refspec: "refs/pull/7/head", intoRef: `${NS}/h`, argv: ["x"] } as never, write))).toMatch(/step 1 \(fetch\).*unexpected property "argv"/);
    expect(refusal({ summary: "x", steps: [write], hook: "x" })).toMatch(/unexpected property "hook"/);
  });

  it("keeps every written ref in the graph's own namespace, also after substitution", () => {
    const fetchInto = (intoRef: string) => plan({ kind: "fetch", remote: "origin", refspec: "refs/pull/7/head", intoRef }, write);
    expect(refusal(fetchInto("refs/heads/main"))).toMatch(/outside refs\/graphloom\/demo\//);
    expect(refusal(fetchInto("refs/graphloom/other/7/head"))).toMatch(/outside/);
    expect(refusal(fetchInto(`${NS}/../../heads/main`))).toMatch(/\.\./);
    expect(refusal(fetchInto(`${NS}/a b`))).toMatch(/space|control/);
    expect(refusal(fetchInto(NS))).toMatch(/outside/);
    expect(refusal(plan({ kind: "resolve", name: "x", revParse: `${NS}/h` }, { kind: "updateRef", from: "${x}", to: "refs/heads/${x}" }, write))).toMatch(/outside/);
    expect(refusal(plan({ kind: "resolve", name: "x", revParse: `${NS}/h` }, { kind: "updateRef", from: "${x}", to: `${NS}/\${x}/..` }, write))).toMatch(/\.\./);
    expect(refusal(plan({ kind: "updateRef", from: "refs/heads/main", to: `${NS}/h` }, write))).toMatch(/from.*outside/);
  });

  it("refuses a refspec that names a pattern, a source rewrite or a destination", () => {
    for (const refspec of ["refs/pull/*/head", "+refs/pull/7/head", "refs/pull/7/head:refs/heads/main", "main", "refs/heads/a..b", "refs/heads/a^", "refs/heads/a~1", "refs/heads/x@{1}"]) {
      expect(refusal(plan({ kind: "fetch", remote: "origin", refspec, intoRef: `${NS}/h` }, write)), refspec).toMatch(/refspec|\bref\b/);
    }
  });

  it("refuses an unbound, forward, malformed or duplicate name", () => {
    expect(refusal(plan({ kind: "updateRef", from: "${nope}", to: `${NS}/h` }, write))).toMatch(/\$\{nope\} is used before/);
    expect(refusal(plan({ kind: "updateRef", from: "${later}", to: `${NS}/h` }, { kind: "resolve", name: "later", revParse: `${NS}/h` }, write))).toMatch(/used before/);
    expect(refusal(plan({ kind: "resolve", name: "x", revParse: `${NS}/h` }, { kind: "resolve", name: "x", revParse: `${NS}/h` }, write))).toMatch(/already bound/);
    expect(refusal(plan({ kind: "resolve", name: "1bad", revParse: `${NS}/h` }, write))).toMatch(/name/);
    expect(refusal(plan({ kind: "resolve", name: "x", revParse: `${NS}/h${"$"}{` }, write))).toMatch(/malformed|reference/);
    expect(refusal(plan({ kind: "resolve", name: "x", revParse: `${NS}/h` }, { kind: "writeTask", path: "t/task.yaml", fields: { request: "${y}" } }))).toMatch(/\$\{y\}/);
  });

  it("requires exactly one writeTask, last, at a safe relative path ending in task.yaml, with only settable fields", () => {
    expect(refusal(plan())).toMatch(/at least one step/);
    expect(refusal(plan({ kind: "resolve", name: "x", revParse: `${NS}/h` }))).toMatch(/exactly one writeTask/);
    expect(refusal(plan(write, write))).toMatch(/writeTask must be the last step/);
    expect(refusal(plan(write, { kind: "resolve", name: "x", revParse: `${NS}/h` }))).toMatch(/last/);
    for (const p of ["/etc/task.yaml", "../task.yaml", "a/../../task.yaml", "a//task.yaml", "task.yml", "a\\task.yaml", "C:/task.yaml"]) {
      expect(refusal(plan({ kind: "writeTask", path: p, fields: { request: "x" } })), p).toMatch(/path/);
    }
    for (const field of ["graph", "repo", "config"]) {
      expect(refusal(plan({ kind: "writeTask", path: "task.yaml", fields: { [field]: "x" } }))).toMatch(/written by the CLI/);
    }
    expect(refusal(plan({ kind: "writeTask", path: "task.yaml", fields: { grants: "x" } }))).toMatch(/not a task field/);
    expect(refusal(plan({ kind: "writeTask", path: "task.yaml", fields: { request: "x".repeat(5000) } }))).toMatch(/4096 bytes/);
    expect(refusal(plan({ kind: "writeTask", path: "task.yaml", fields: { request: "a\u0000b" } }))).toMatch(/NUL/);
  });

  it("refuses a remote that is not https, or carries credentials", () => {
    for (const remote of ["file:///tmp/x", "ssh://git@host/x", "git://host/x", "http://host/x", "https://user:pw@host/x", "https://user@host/x", "/local/path", "-oProxy", "ext::sh"]) {
      expect(refusal(plan({ kind: "fetch", remote, refspec: "refs/pull/7/head", intoRef: `${NS}/h` }, write)), remote).toMatch(/remote/);
    }
    expect(() => validateTaskPlan(plan({ kind: "fetch", remote: "https://github.com/a/b.git", refspec: "refs/pull/7/head", intoRef: `${NS}/h` }, write), "demo")).not.toThrow();
  });

  it("holds its bounds: steps, names, plan size and summary", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ kind: "resolve", name: `n${i}`, revParse: `${NS}/h` }) as TaskPlanStep);
    expect(refusal(plan(...many.slice(0, 16), write))).toMatch(/17 steps, more than 16/);
    const nine = Array.from({ length: 9 }, (_, i) => ({ kind: "resolve", name: `n${i}`, revParse: `${NS}/h` }) as TaskPlanStep);
    expect(refusal(plan(...nine, write))).toMatch(/more than 8 names/);
    expect(refusal({ summary: "x".repeat(201), steps: [write] })).toMatch(/summary/);
    expect(refusal({ summary: "two\nlines", steps: [write] })).toMatch(/summary/);
    expect(refusal({ summary: "x", steps: [{ ...write, fields: { request: "y".repeat(4000) } }, ...Array.from({ length: 20 }, () => write)] })).toMatch(/steps|bytes/);
    expect(refusal("nope")).toMatch(/object/);
  });
});

describe("approvals and the prepare_task wire message", () => {
  const base = { graphId: "g", version: "1", stages: [{ id: "s", name: "S", requirementIds: [] }], requirements: [], defaultValidators: [] };
  it("checks an approvals declaration's shape", () => {
    expect(() => assertGraphDefinition({ ...base, approvals: [{ id: "review-layer", stageId: "review", unavailable: "no review yet" }] })).not.toThrow();
    for (const approvals of [[{ id: "Bad Id" }], [{ id: "a" }, { id: "a" }], [{ id: "a", extra: 1 }], [{ id: "a", files: ["../x"] }], [{ id: "a", unavailable: "" }], "x"]) {
      expect(() => assertGraphDefinition({ ...base, approvals }), JSON.stringify(approvals)).toThrow(WireValidationError);
    }
  });

  it("checks the operator inputs an approval declares: unique names, a valid pattern, at most eight", () => {
    const ok = [{ id: "review-layer", inputs: [{ name: "areas", description: "area ids", pattern: "A[0-9]+(,A[0-9]+)*" }] }];
    expect(() => assertGraphDefinition({ ...base, approvals: ok })).not.toThrow();
    const bad: unknown[] = [
      [{ id: "a", inputs: [{ name: "Areas" }] }],
      [{ id: "a", inputs: [{ name: "x" }, { name: "x" }] }],
      [{ id: "a", inputs: [{ name: "x", extra: 1 }] }],
      [{ id: "a", inputs: [{ name: "x", pattern: "(" }] }],
      [{ id: "a", inputs: [{ name: "x", pattern: "" }] }],
      [{ id: "a", inputs: [{ name: "x", description: " " }] }],
      [{ id: "a", inputs: Array.from({ length: 9 }, (_, i) => ({ name: `n${i}` })) }],
      [{ id: "a", inputs: "x" }],
    ];
    for (const approvals of bad) expect(() => assertGraphDefinition({ ...base, approvals }), JSON.stringify(approvals)).toThrow(WireValidationError);
  });

  it("accepts a prepare_task request and refuses one without arguments", () => {
    const envelope = { protocolVersion: PROTOCOL_VERSION, runId: "r", operationId: "o", generation: 1, expectedStateRevision: 0, activeVersion: "g@1" };
    expect(() => assertWireRequest({ ...envelope, kind: "prepare_task", input: { args: ["x"], repo: { remotes: [], head: "a" }, options: { dryRun: false } } })).not.toThrow();
    expect(() => assertWireRequest({ ...envelope, kind: "prepare_task", input: {} })).toThrow(WireValidationError);
  });
});
