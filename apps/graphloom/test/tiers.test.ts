// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCKER_FILES, excludedFiles, FULL_TIER_GROUPS, groupsFor, onlyFiles, selectionFromEnv } from "./tiers.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file the CLI suite's include glob (test/**\/*.test.ts) matches, relative to apps/graphloom. */
function allTestFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(app, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".test.ts")) out.push(child);
    }
  };
  walk("test");
  return out.sort();
}

const grouped = Object.values(FULL_TIER_GROUPS).flatMap((g) => g.files);

/** The files a selection runs, as vitest.config.ts resolves them. */
function selected(env: Record<string, string>): string[] {
  const selection = selectionFromEnv(env);
  const excluded = new Set(excludedFiles(selection));
  const only = onlyFiles(selection);
  return allTestFiles().filter((f) => !excluded.has(f) && (only === undefined || only.includes(f)));
}

describe("CLI test tiers", () => {
  it("lists only real test files, each in one group at most", () => {
    const all = new Set(allTestFiles());
    for (const file of [...grouped, ...DOCKER_FILES]) expect(all.has(file), file).toBe(true);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("partitions the suite: the PR tier and the full-tier groups are disjoint and together are every file", () => {
    const all = allTestFiles();
    const pr = selected({ GRAPHLOOM_TEST_TIER: "pr" });
    expect(pr.filter((f) => grouped.includes(f))).toEqual([]);
    expect([...pr, ...grouped].sort()).toEqual(all);
    // The default (local npm test) and the full tier both run everything.
    expect(selected({})).toEqual(all);
    expect(selected({ GRAPHLOOM_TEST_TIER: "full" })).toEqual(all);
  });

  it("keeps each rehearsal's smoke set in the PR tier and every other rehearsal group in the full tier", () => {
    const pr = selected({ GRAPHLOOM_TEST_TIER: "pr" });
    for (const graph of ["pr-design-review", "pr-review", "issue-fix"]) {
      const files = allTestFiles().filter((f) => f.startsWith(`test/${graph}-rehearsal.`));
      expect(files, graph).toContain(`test/${graph}-rehearsal.smoke.test.ts`);
      for (const file of files) expect(pr.includes(file), file).toBe(file.endsWith(".smoke.test.ts"));
    }
  });

  it("splits the suite between the Docker job and the other jobs with no file lost, in either tier", () => {
    for (const tier of ["pr", "full"]) {
      const docker = selected({ GRAPHLOOM_TEST_TIER: tier, GRAPHLOOM_TEST_DOCKER: "only" });
      const rest = selected({ GRAPHLOOM_TEST_TIER: tier, GRAPHLOOM_TEST_DOCKER: "exclude" });
      expect(docker.every((f) => DOCKER_FILES.includes(f))).toBe(true);
      expect(rest.filter((f) => DOCKER_FILES.includes(f))).toEqual([]);
      expect([...docker, ...rest].sort()).toEqual(selected({ GRAPHLOOM_TEST_TIER: tier }));
    }
    expect(selected({ GRAPHLOOM_TEST_TIER: "pr", GRAPHLOOM_TEST_DOCKER: "only" })).toEqual(["test/sandbox.test.ts"]);
    expect(selected({ GRAPHLOOM_TEST_TIER: "pr", GRAPHLOOM_TEST_DOCKER: "only", GRAPHLOOM_TEST_GROUPS: "pr-review" })).toEqual(DOCKER_FILES);
  });

  it("adds a touched group's files to the PR tier and nothing else", () => {
    const pr = selected({ GRAPHLOOM_TEST_TIER: "pr" });
    const withGroups = selected({ GRAPHLOOM_TEST_TIER: "pr", GRAPHLOOM_TEST_GROUPS: "session,issue-fix" });
    expect(withGroups.filter((f) => !pr.includes(f))).toEqual([...FULL_TIER_GROUPS.session!.files, ...FULL_TIER_GROUPS["issue-fix"]!.files].sort());
  });

  it("picks the groups a change touches", () => {
    expect(groupsFor(["examples/plugins/review-kit/src/ledger.ts"])).toEqual(["pr-design-review", "pr-review"]);
    expect(groupsFor(["examples/plugins/pr-design-review/src/graph.ts"])).toEqual(["pr-design-review"]);
    expect(groupsFor(["examples/plugins/pr-review/src/graph.ts"])).toEqual(["pr-review"]);
    expect(groupsFor(["examples/plugins/issue-fix/profiles/banyandb.json"])).toEqual(["issue-fix"]);
    expect(groupsFor(["apps/graphloom/src/session.ts", "packages/agent-harness/src/claude.ts"])).toEqual(["session"]);
    expect(groupsFor(["packages/controller/src/traversal.ts"])).toEqual(["topology"]);
    expect(groupsFor(["packages/controller/src/supervisor-node.ts"])).toEqual(["topology"]);
    expect(groupsFor(["packages/sdk/src/topology-view.ts"])).toEqual(["topology"]);
    expect(groupsFor(["apps/graphloom/src/doctor-task.ts"])).toEqual(["doctor-task"]);
    expect(groupsFor(["apps/graphloom/src/main.ts", "docs/design-typescript-core.md", "examples/plugins/hello/src/graph.ts"])).toEqual([]);
    // A directory pattern covers that directory only, not a sibling whose name starts the same.
    expect(groupsFor(["examples/plugins/pr-review-extra/x.ts"])).toEqual([]);
  });

  it("refuses an unknown tier, group or Docker setting", () => {
    expect(() => selectionFromEnv({ GRAPHLOOM_TEST_TIER: "fast" })).toThrow(/GRAPHLOOM_TEST_TIER/);
    expect(() => selectionFromEnv({ GRAPHLOOM_TEST_GROUPS: "nope" })).toThrow(/unknown group "nope"/);
    expect(() => selectionFromEnv({ GRAPHLOOM_TEST_DOCKER: "yes" })).toThrow(/GRAPHLOOM_TEST_DOCKER/);
  });
});
