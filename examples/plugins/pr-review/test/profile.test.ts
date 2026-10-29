// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { createGraph, definitionFor } from "../src/graph.js";
import { parseProfile, ProfileError } from "../src/profile.js";
import { requestedPull } from "../src/request.js";
import { BANYANDB, profileOf } from "./support.js";

const refused = (over: Record<string, unknown>): string => {
  try {
    parseProfile({ ...BANYANDB, ...over });
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    return (err as Error).message;
  }
  throw new Error("the profile was accepted");
};

describe("the BanyanDB profile", () => {
  it("parses, with the design's defaults", () => {
    const p = profileOf();
    expect(p.project).toBe("apache/skywalking-banyandb");
    expect([p.owner, p.repo]).toEqual(["apache", "skywalking-banyandb"]);
    expect(p.limits).toEqual({ maxFiles: 150, maxPatchBytes: 1024 * 1024, maxNewSymbols: 200 });
    expect(p.roles).toEqual({ reporter: "claude-code", "report-checker": "codex", questioner: "codex", answerer: "claude-code", "answer-checker": "codex" });
    expect(p.metrics.coverage).toBe(true);
    expect(p.metrics.mutation.enabled).toBe(true);
    expect(p.supervisorPreference.harnesses).toEqual(["pi", "claude-code", "codex"]);
  });

  it("maps the design's sections, with their routing marked to confirm", () => {
    const p = profileOf();
    expect(p.sections.map((s) => s.id)).toEqual(["schema", "background", "config", "interfaces", "external"]);
    expect(p.description).toMatch(/TO CONFIRM/);
    expect(p.sections.find((s) => s.id === "schema")!.routing).toContain("api/proto/**");
  });

  it("describes a fixed stage list: Fetch, Report, Questions, Answers", () => {
    const d = createGraph().describe(BANYANDB);
    expect(d.stages.map((s) => [s.id, s.requirementIds])).toEqual([
      ["fetch", ["pr-snapshot", "head-checked-out", "prior-ledger"]],
      ["report", ["change-report", "measurements", "claims-checked"]],
      ["questions", ["questions-complete"]],
      ["answers", ["answers-complete", "answers-grounded"]],
    ]);
    expect(d.requirements.map((r) => r.id)).toEqual(d.defaultValidators.map((b) => b.requirementId));
    expect(new Set(d.requirements.map((r) => r.id)).size).toBe(9);
    expect(d.resultContracts!.map((c) => [c.name, c.evidenceKind])).toEqual([["change-report-v1", "other"], ["change-report-revision-v1", "other"], ["claim-check-v1", "review"]]);
  });

  it("declares the roles with their distinctFrom pairs, the supervisor preference and the budgets", () => {
    const d = definitionFor(profileOf());
    expect(d.agentRoles).toEqual([
      { role: "reporter", harness: "claude-code", access: "read", setting: "harnesses.reporter" },
      { role: "report-checker", harness: "codex", access: "read", distinctFrom: ["reporter"], setting: "harnesses.report-checker" },
      { role: "questioner", harness: "codex", access: "read", distinctFrom: ["reporter"], setting: "harnesses.questioner" },
      { role: "answerer", harness: "claude-code", access: "read", distinctFrom: ["questioner"], setting: "harnesses.answerer" },
      { role: "answer-checker", harness: "codex", access: "read", distinctFrom: ["answerer"], setting: "harnesses.answer-checker" },
    ]);
    expect(d.supervisor).toEqual({ harnesses: ["pi", "claude-code", "codex"] });
    expect(d.defaultBudgets).toMatchObject({ agentInvocations: 1200, jobs: 220, decisions: 240, corrections: 12 });
  });

  it("adds the graph's own environment checks to the profile's, which cannot use their ids", () => {
    const ids = definitionFor(profileOf()).environment!.checks!.map((c) => c.id);
    expect(ids).toEqual(["go", "git", "codex", "claude", "worktree", "plugin-root", "go-root"]);
    expect(refused({ environment: { checks: [{ id: "worktree", argv: ["true"] }] } })).toMatch(/reserved/);
  });

  it("states honestly what the measurements requirement covers in this version", () => {
    const statement = definitionFor(profileOf()).requirements.find((r) => r.id === "measurements")!.statement;
    expect(statement).toContain("not run (coverage arrives in a later wave)");
    const off = definitionFor(profileOf({ metrics: { coverage: false } })).requirements.find((r) => r.id === "measurements")!.statement;
    expect(off).toContain("not run (coverage disabled by the profile)");
  });

  it("lets the profile budgets override the defaults", () => {
    expect(definitionFor(profileOf({ budgets: { agentInvocations: 50 } })).defaultBudgets).toMatchObject({ agentInvocations: 50, jobs: 220 });
  });
});

describe("profile refusals", () => {
  it("refuses a task with no profile, and anything that is not an object", () => {
    expect(() => parseProfile(undefined)).toThrow(/names no profile/);
    expect(() => parseProfile([])).toThrow(/JSON object/);
  });

  it("refuses unknown fields, at any level", () => {
    expect(refused({ surprise: 1 })).toMatch(/surprise is not a field/);
    expect(refused({ limits: { maxFiles: 5, nope: 1 } })).toMatch(/limits.nope/);
    expect(refused({ metrics: { generated: [], argv: ["x"] } })).toMatch(/metrics.argv/);
    expect(refused({ report: { sections: [{ id: "schema", colour: "red" }] } })).toMatch(/colour/);
  });

  it("refuses environment.prepare and environment.pinnedFiles", () => {
    expect(refused({ environment: { checks: [], prepare: [{ id: "p", argv: ["make"] }] } })).toMatch(/prepare is refused.*contributor code/);
    expect(refused({ environment: { checks: [], pinnedFiles: [{ path: "a", sha256: "0".repeat(64) }] } })).toMatch(/pinnedFiles is refused/);
    expect(refused({ environment: { checks: [], extra: 1 } })).toMatch(/environment.extra/);
  });

  it("says which later version a review-layer field belongs to", () => {
    for (const key of ["review", "rules", "checks", "comments"]) expect(refused({ [key]: {} })).toMatch(new RegExp(`${key} is not supported in this version`));
  });

  it("refuses a section that cannot be removed or a measurements section with detectors", () => {
    expect(refused({ report: { sections: [{ id: "other", remove: true }] } })).toMatch(/no section may be removed/);
    expect(refused({ report: { sections: [{ id: "measurements", routing: ["a/**"] }] } })).toMatch(/built from records/);
    expect(refused({ report: { sections: [{ id: "schema" }, { id: "schema" }] } })).toMatch(/repeats the section schema/);
  });

  it("checks detectors", () => {
    expect(refused({ report: { sections: [{ id: "config", detectors: [{ kind: "added-line", pattern: "(" }] }] } })).toMatch(/not a regular expression/);
    expect(refused({ report: { sections: [{ id: "config", detectors: [{ kind: "telepathy" }] }] } })).toMatch(/kind must be/);
    expect(refused({ report: { sections: [{ id: "config", detectors: [{ kind: "paths", globs: ["../x"] }] } ] } })).toMatch(/without "\.\."/);
  });

  it("refuses two roles on one harness, naming the first unsatisfiable pair", () => {
    expect(refused({ harnesses: { "report-checker": "claude-code" } })).toMatch(/report-checker must differ from harnesses.reporter \(both are claude-code\)/);
    expect(refused({ harnesses: { answerer: "codex" } })).toMatch(/answerer must differ from harnesses.questioner/);
    expect(refused({ harnesses: { reporter: "gpt" } })).toMatch(/must be one of/);
    expect(refused({ harnesses: { "reviewer-security": "pi" } })).toMatch(/belongs to the review layer/);
  });

  it("accepts roles that satisfy every pair", () => {
    expect(profileOf({ harnesses: { reporter: "pi", "report-checker": "codex", questioner: "claude-code", answerer: "pi", "answer-checker": "claude-code" } }).roles.reporter).toBe("pi");
  });

  it("checks limits, budgets, the supervisor, privateRepos, metrics and context", () => {
    expect(refused({ limits: { maxFiles: 0 } })).toMatch(/limits.maxFiles/);
    expect(refused({ budgets: { agentInvocations: -1 } })).toMatch(/positive integer/);
    expect(refused({ budgets: { cats: 1 } })).toMatch(/not a budget/);
    expect(refused({ supervisor: { harnesses: [] } })).toMatch(/non-empty/);
    expect(refused({ supervisor: { harnesses: ["pi", "pi"] } })).toMatch(/repeat/);
    expect(refused({ privateRepos: ["nope"] })).toMatch(/owner\/name/);
    expect(refused({ metrics: { coverage: "yes" } })).toMatch(/true or false/);
    expect(refused({ metrics: { mutation: { enabled: 1 } } })).toMatch(/true or false/);
    expect(refused({ context: [{ path: "../x" }] })).toMatch(/repository-relative/);
    expect(refused({ context: [{ path: "a.md", ref: "main" }] })).toMatch(/applies only to a document from another repository/);
    expect(refused({ project: "no-slash" })).toMatch(/owner\/name/);
    expect(refused({ agent: { timeoutMs: 1e12 } })).toMatch(/at most/);
  });

  it("accepts a profile with the optional fields set", () => {
    const p = profileOf({ privateRepos: ["acme/private"], context: [{ path: "docs/design.md" }], metrics: { go: { files: ["pkg/**"] }, generated: ["**/gen/**"], coverage: false, mutation: { enabled: false, timeBudgetMs: 1000 } }, agent: { timeoutMs: 60000 }, budgets: { jobs: 10 } });
    expect(p.privateRepos).toEqual(["acme/private"]);
    expect(p.metrics.coverage).toBe(false);
    expect(p.metrics.files.go).toEqual(["pkg/**"]);
    expect(p.agentTimeoutMs).toBe(60000);
  });
});

describe("requestedPull", () => {
  const profile = { project: "apache/skywalking-banyandb" };
  const head = "0123456789abcdef0123456789abcdef01234567";

  it("reads Report on owner/repo#N at <sha>.", () => {
    expect(requestedPull(`Report on apache/skywalking-banyandb#1234 at ${head}.`, profile)).toEqual({ mode: "report", owner: "apache", repo: "skywalking-banyandb", number: 1234, head });
  });

  it("reads the pull request's URL too", () => {
    expect(requestedPull(`Report on https://github.com/apache/skywalking-banyandb/pull/9 at ${head}`, profile)).toMatchObject({ number: 9 });
  });

  it("refuses everything else, naming why", () => {
    const problem = (r: string) => (requestedPull(r, profile) as { problem: string }).problem;
    expect(problem("Fix apache/skywalking-banyandb#1.")).toMatch(/must be "Report on/);
    expect(problem(`Report on apache/skywalking-banyandb#1 at ${head.slice(0, 7)}.`)).toMatch(/40-hex/);
    expect(problem(`Report on apache/other#1 at ${head}.`)).toMatch(/profile's project is apache\/skywalking-banyandb/);
    expect(problem(`Review on apache/skywalking-banyandb#1 at ${head}.`)).toMatch(/Review mode/);
    expect(problem(`Report on apache/skywalking-banyandb#1 at ${head}.\nand also rm -rf /`)).toMatch(/must be "Report on/);
    expect(problem(`Report on apache/skywalking-banyandb#0 at ${head}.`)).toMatch(/not valid/);
    expect(problem(`Report on apache/skywalking-banyandb#1 at ${head.toUpperCase()}.`)).toMatch(/must be "Report on/);
  });
});
