// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { DEFAULT_TS_IMAGE, resolveSandbox } from "../src/coverage.js";
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
    expect(d.resultContracts!.map((c) => [c.name, c.evidenceKind])).toEqual([["change-report-v1", "other"], ["change-report-revision-v1", "other"], ["claim-check-v1", "review"], ["questions-v1", "other"], ["answers-v1", "other"], ["answers-revision-v1", "other"], ["necessity-v1", "other"], ["necessity-revision-v1", "other"], ["answer-check-v1", "review"]]);
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
    expect(ids).toEqual(["go", "git", "codex", "claude", "worktree", "plugin-root", "go-root", "docker-go", "docker-typescript"]);
    expect(refused({ environment: { checks: [{ id: "worktree", argv: ["true"] }] } })).toMatch(/reserved/);
    expect(refused({ environment: { checks: [{ id: "docker-go", argv: ["true"] }] } })).toMatch(/reserved/);
    // With coverage off there is no sandbox to report on.
    expect(definitionFor(profileOf({ metrics: { coverage: false } })).environment!.checks!.map((c) => c.id)).not.toContain("docker-go");
  });

  it("states honestly what the measurements requirement covers in this version", () => {
    const statement = definitionFor(profileOf()).requirements.find((r) => r.id === "measurements")!.statement;
    expect(statement).toContain("runs only in the Docker sandbox");
    expect(statement).toContain("attributed by line range from the sandbox's report");
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
    expect(refused({ harnesses: { answerer: "pi" } })).toMatch(/answerer must be claude-code or codex/);
  });

  it("checks symbol packs: patterns must compile and name the symbol, and a profile pack overrides only the fields it names", () => {
    const pack = (over: object) => ({ symbols: { packs: [{ language: "go", globs: ["**/*.go"], ...over }] } });
    expect(refused(pack({ definitions: ["^func (?<name>"] }))).toMatch(/not a regular expression/);
    expect(refused(pack({ definitions: ["^func\\s+(\\w+)"] }))).toMatch(/must name the symbol with a \(\?<name>…\) group/);
    expect(refused(pack({ members: ["^\\s+(\\w+)\\("] }))).toMatch(/must name the symbol/);
    expect(refused(pack({ grep: 3 }))).toMatch(/grep must be a POSIX extended regular expression/);
    expect(refused({ symbols: { packs: [{ language: "go", globs: ["../x"] }] } })).toMatch(/without "\.\."/);
    expect(profileOf(pack({ definitions: ["^fn\\s+(?<name>\\w+)"], testFiles: ["**/*_spec.go"] })).symbols[0]).toMatchObject({ language: "go", testFiles: ["**/*_spec.go"] });
  });

  it("accepts roles that satisfy every pair", () => {
    expect(profileOf({ harnesses: { reporter: "pi", "report-checker": "codex", questioner: "claude-code", answerer: "codex", "answer-checker": "claude-code" } }).roles.reporter).toBe("pi");
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

describe("metrics.sandbox", () => {
  const digest = `golang@sha256:${"a".repeat(64)}`;

  it("pins the BanyanDB Go image by digest, and resolves the defaults the banyandb-ql bench-gates use", () => {
    const p = profileOf();
    expect(p.metrics.sandbox!.go!.image).toMatch(/^golang@sha256:[0-9a-f]{64}$/);
    expect(resolveSandbox(p, "go")).toMatchObject({ cpus: 4, memory: "8g", pids: 512, tmp: "1g", wallClockMs: 1_800_000 });
    // TypeScript has a default image, by digest; Go has none unless the profile pins one (it follows the repository's go.mod).
    expect(resolveSandbox(p, "typescript")).toMatchObject({ image: DEFAULT_TS_IMAGE, cpus: 4, memory: "8g" });
    expect(resolveSandbox(profileOf({ metrics: {} }), "go").image).toBeUndefined();
  });

  it("refuses an image that is a tag, and anything that is not a limit", () => {
    expect(refused({ metrics: { sandbox: { go: { image: "golang:1.26" } } } })).toMatch(/metrics\.sandbox\.go\.image: must be pinned by digest/);
    expect(refused({ metrics: { sandbox: { go: { image: `${digest}x` } } } })).toMatch(/pinned by digest/);
    expect(refused({ metrics: { sandbox: { go: { image: digest, cpus: 0 } } } })).toMatch(/metrics\.sandbox\.go\.cpus/);
    expect(refused({ metrics: { sandbox: { go: { image: digest, memory: "lots" } } } })).toMatch(/metrics\.sandbox\.go\.memory/);
    expect(refused({ metrics: { sandbox: { go: { image: digest, network: true } } } })).toMatch(/network is not a field/);
    expect(refused({ metrics: { sandbox: { rust: { image: digest } } } })).toMatch(/not a language with a sandbox/);
    expect(refused({ metrics: { sandbox: [] } })).toMatch(/object of per-language/);
  });

  it("accepts a limit or two over the defaults", () => {
    const p = profileOf({ metrics: { sandbox: { typescript: { image: `node@sha256:${"b".repeat(64)}`, memory: "2g", wallClockMs: 60_000 } } } });
    expect(resolveSandbox(p, "typescript")).toMatchObject({ image: `node@sha256:${"b".repeat(64)}`, memory: "2g", wallClockMs: 60_000, cpus: 4 });
  });
});

describe("metrics.sandbox.go.readOnly and setup", () => {
  const digest = `golang@sha256:${"a".repeat(64)}`;
  const go = (extra: Record<string, unknown>) => ({ metrics: { sandbox: { go: { image: digest, ...extra } } } });
  const step = { id: "gen", argv: ["sh", "-c", "echo hi"] };

  it("ships the BanyanDB profile with its tools and buf cache mounts and its two sandboxed setup commands", () => {
    const go = profileOf().metrics.sandbox!.go!;
    expect(go.readOnly).toEqual([{ name: "tools", path: "~/.graphloom/tools/banyandb/bin" }, { name: "buf-cache", path: "~/.cache/buf" }]);
    expect(go.setup!.map((s) => s.id)).toEqual(["proto", "mocks"]);
    expect(go.setup![0]!.argv.join(" ")).toMatch(/buf" generate/);
    // Generation and mocks both come from the mounted tools and the module cache: nothing is fetched.
    expect(go.setup!.map((s) => s.argv.join(" ")).join("\n")).not.toMatch(/https?:|go install|go get|git /);
    expect(resolveSandbox(profileOf(), "go").setup).toHaveLength(2);
    expect(resolveSandbox(profileOf({ metrics: { sandbox: { go: { image: digest } } } }), "go")).toMatchObject({ readOnly: [], setup: [] });
  });

  it("accepts absolute and ~/ mounts and setup commands, and keeps them in order", () => {
    const p = profileOf(go({ readOnly: [{ name: "a-b1", path: "/opt/tools" }, { name: "c", path: "~/x/y/" }], setup: [step, { id: "two", argv: ["true"] }] }));
    expect(resolveSandbox(p, "go").readOnly.map((m) => m.path)).toEqual(["/opt/tools", "~/x/y/"]);
    expect(resolveSandbox(p, "go").setup.map((s) => s.id)).toEqual(["gen", "two"]);
  });

  it("refuses mounts that are relative (the checkout), parent-relative, the root, unnamed or twice named, or that Docker could not take", () => {
    const m = (path: string, name = "t") => refused(go({ readOnly: [{ name, path }] }));
    expect(m("tools/bin")).toMatch(/readOnly\[0\]\.path .* must be absolute or start with ~\//);
    expect(m(".")).toMatch(/must be absolute/);
    expect(m("~tools")).toMatch(/must be absolute/);
    expect(m("/opt/../etc")).toMatch(/must not contain \.\./);
    expect(m("~/a/../../b")).toMatch(/must not contain \.\./);
    expect(m("/")).toMatch(/not be the filesystem root/);
    expect(m("~/")).toMatch(/not be the filesystem root/);
    expect(m("/a:b")).toMatch(/must not contain :/);
    expect(m("/a,b")).toMatch(/must not contain :/);
    expect(m("/a\nb")).toMatch(/must not contain :/);
    expect(m("/ok", "Bad Name")).toMatch(/name must match/);
    expect(m("/ok", "")).toMatch(/name must match/);
    expect(refused(go({ readOnly: [{ name: "t", path: "/a" }, { name: "t", path: "/b" }] }))).toMatch(/used twice/);
    expect(refused(go({ readOnly: [{ name: "t", path: "/a", extra: 1 }] }))).toMatch(/extra is not a field/);
    expect(refused(go({ readOnly: "/a" }))).toMatch(/must be a list/);
    expect(refused(go({ readOnly: Array.from({ length: 9 }, (_, i) => ({ name: `m${i}`, path: `/m${i}` })) }))).toMatch(/at most 8/);
  });

  it("refuses setup that is empty, has no program, repeats an id, or is for another language", () => {
    expect(refused(go({ setup: [] }))).toMatch(/setup must be a list of 1 to 8/);
    expect(refused(go({ setup: [{ id: "x", argv: [] }] }))).toMatch(/setup\[0\]\.argv must be a list of 1 to 32 strings/);
    expect(refused(go({ setup: [{ id: "x", argv: [""] }] }))).toMatch(/argv needs a program/);
    expect(refused(go({ setup: [{ id: "x", argv: [1] }] }))).toMatch(/argv must be a list/);
    expect(refused(go({ setup: [{ id: "X", argv: ["a"] }] }))).toMatch(/id must match/);
    expect(refused(go({ setup: [step, step] }))).toMatch(/used twice/);
    expect(refused(go({ setup: [{ ...step, cwd: "." }] }))).toMatch(/cwd is not a field/);
    expect(refused(go({ setup: [{ id: "x", argv: ["a".repeat(2_001)] }] }))).toMatch(/at most 2000 characters/);
    expect(refused({ metrics: { sandbox: { typescript: { image: `node@sha256:${"b".repeat(64)}`, setup: [step] } } } })).toMatch(/setup: sandboxed setup is supported for go only/);
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
