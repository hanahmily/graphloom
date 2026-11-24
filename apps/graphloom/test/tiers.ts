// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The CLI suite's test tiers, in one place (docs/design-typescript-core.md §11.1, "CI test tiers").
 *
 * The **full tier** is every test file. The **PR tier** is every test file except the groups below: a pull request runs
 * the PR tier, plus each group whose `paths` its change touches; the full tier runs after every merge to main, daily,
 * and on demand. `vitest.config.ts` reads:
 *
 *   GRAPHLOOM_TEST_TIER    `pr` drops the full-tier groups; unset or `full` runs everything (local `npm test`).
 *   GRAPHLOOM_TEST_GROUPS  comma-separated group names the PR tier runs anyway (CI: the groups a change touches).
 *   GRAPHLOOM_TEST_DOCKER  `exclude` drops DOCKER_FILES, `only` runs nothing else; unset runs both.
 *
 * This module has no imports, so the CI step that picks groups from a diff (`scripts/ci/test-groups.mjs`) loads it
 * directly with Node's type stripping. `tiers.test.ts` checks every listed file exists and that the PR tier and the
 * groups partition the suite.
 */

export interface FullTierGroup {
  /** Test files, relative to apps/graphloom, that run only in the full tier. */
  files: string[];
  /** Repository paths (a trailing `/` covers a directory, a trailing `*` a name prefix) whose change pulls the group into a pull request's run. */
  paths: string[];
}

const REVIEW_KIT = "examples/plugins/review-kit/";

export const FULL_TIER_GROUPS: Record<string, FullTierGroup> = {
  "pr-design-review": {
    files: [
      "test/pr-design-review-rehearsal.answers.test.ts",
      "test/pr-design-review-rehearsal.necessity.test.ts",
      "test/pr-design-review-rehearsal.publish.test.ts",
      "test/pr-design-review-rehearsal.report.test.ts",
    ],
    paths: ["examples/plugins/pr-design-review/", REVIEW_KIT],
  },
  "pr-review": {
    files: [
      "test/pr-review-coverage-docker.test.ts",
      "test/pr-review-rehearsal.context.test.ts",
      "test/pr-review-rehearsal.leads.test.ts",
      "test/pr-review-rehearsal.robustness.test.ts",
    ],
    paths: ["examples/plugins/pr-review/", REVIEW_KIT],
  },
  "issue-fix": {
    files: [
      "test/issue-fix-rehearsal.arbitrate.test.ts",
      "test/issue-fix-rehearsal.boundaries.test.ts",
      "test/issue-fix-rehearsal.probe.test.ts",
      "test/matrix/issue-fix-supervisor.test.ts",
      "test/matrix/issue-fix.test.ts",
    ],
    paths: ["examples/plugins/issue-fix/"],
  },
  "hub-rehearsal": {
    files: ["test/hub-rehearsal-shipped.full.test.ts"],
    paths: [
      // Every shipped graph's rehearsal entry and the scenario data beside it.
      ...["hello", "release", "issue-fix", "pr-design-review", "pr-review"].map((plugin) => `examples/plugins/${plugin}/src/rehearsal*`),
      "executors/github/src/rehearsal/",
      "executors/command/src/rehearsal/",
      "apps/graphloom/src/rehearsal*",
      "apps/graphloom/src/hub-rehearsal*",
      "packages/sdk/src/rehearsal*",
    ],
  },
  session: {
    files: ["test/session.test.ts"],
    paths: ["apps/graphloom/src/session*", "packages/agent-harness/"],
  },
  topology: {
    files: ["test/topology-e2e.test.ts"],
    paths: ["packages/controller/src/traversal*", "packages/controller/src/supervisor-node*", "packages/sdk/src/topology*"],
  },
  "doctor-task": {
    files: ["test/doctor-task.test.ts"],
    paths: ["apps/graphloom/src/doctor*"],
  },
  "matrix-hello": {
    files: ["test/matrix/hello.test.ts"],
    paths: [],
  },
};

/** The files that need Docker, the warmed coverage caches and GRAPHLOOM_REQUIRE_DOCKER_TESTS=1; CI runs them in their own job. */
export const DOCKER_FILES = ["test/pr-review-coverage-docker.test.ts", "test/sandbox.test.ts"];

/** True when a changed repository path is one of the patterns. */
export function pathMatches(changed: string, pattern: string): boolean {
  if (pattern.endsWith("/") || pattern.endsWith("*")) return changed.startsWith(pattern.replace(/\*$/, ""));
  return changed === pattern;
}

/** The groups a change to these repository paths pulls into a pull request's run, in declaration order. */
export function groupsFor(changed: readonly string[]): string[] {
  return Object.entries(FULL_TIER_GROUPS)
    .filter(([, group]) => changed.some((file) => group.paths.some((pattern) => pathMatches(file, pattern))))
    .map(([name]) => name);
}

export interface TierSelection {
  tier: "pr" | "full";
  groups: string[];
  docker: "include" | "exclude" | "only";
}

/** Reads the selection from the environment, refusing values it does not know. */
export function selectionFromEnv(env: Record<string, string | undefined>): TierSelection {
  const tier = env.GRAPHLOOM_TEST_TIER || "full";
  if (tier !== "pr" && tier !== "full") throw new Error(`GRAPHLOOM_TEST_TIER must be pr or full, not ${JSON.stringify(tier)}`);
  const groups = (env.GRAPHLOOM_TEST_GROUPS ?? "").split(",").map((g) => g.trim()).filter(Boolean);
  for (const group of groups) {
    if (!(group in FULL_TIER_GROUPS)) throw new Error(`GRAPHLOOM_TEST_GROUPS names an unknown group ${JSON.stringify(group)}; known: ${Object.keys(FULL_TIER_GROUPS).join(", ")}`);
  }
  const docker = env.GRAPHLOOM_TEST_DOCKER || "include";
  if (docker !== "include" && docker !== "exclude" && docker !== "only") throw new Error(`GRAPHLOOM_TEST_DOCKER must be include, exclude or only, not ${JSON.stringify(docker)}`);
  return { tier, groups, docker };
}

/** The test files (relative to apps/graphloom) a selection leaves out. */
export function excludedFiles(selection: TierSelection): string[] {
  const out = new Set<string>();
  if (selection.tier === "pr") {
    for (const [name, group] of Object.entries(FULL_TIER_GROUPS)) {
      if (!selection.groups.includes(name)) for (const file of group.files) out.add(file);
    }
  }
  if (selection.docker === "exclude") for (const file of DOCKER_FILES) out.add(file);
  return [...out].sort();
}

/** The files a selection is limited to, or undefined for the whole suite. */
export function onlyFiles(selection: TierSelection): string[] | undefined {
  return selection.docker === "only" ? [...DOCKER_FILES] : undefined;
}
