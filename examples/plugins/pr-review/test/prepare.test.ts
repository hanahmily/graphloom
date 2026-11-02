// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateTaskPlan, type PrepareTaskInput } from "@graphloom/sdk";
import { definitionFor, parsePullArgument, parseProfile, prepareTask } from "../src/index.js";

const banyandb = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "profiles", "banyandb.json"), "utf8")) as unknown;

const input = (args: string[], over: Partial<PrepareTaskInput> = {}): PrepareTaskInput => ({
  args,
  repo: { remotes: [{ name: "origin", url: "https://github.com/apache/skywalking-banyandb.git" }], head: "a".repeat(40) },
  profile: banyandb,
  options: { dryRun: false },
  ...over,
});

describe("prepareTask", () => {
  it("plans the six steps of design 3.1, which validate, for owner/repo#N and for the URL", () => {
    const R = "refs/graphloom/pr-review/apache/skywalking-banyandb/1234";
    for (const arg of ["apache/skywalking-banyandb#1234", "https://github.com/apache/skywalking-banyandb/pull/1234"]) {
      const plan = prepareTask(input([arg]));
      expect(plan).toEqual({
        summary: "review of apache/skywalking-banyandb#1234 against main",
        steps: [
          { kind: "fetch", remote: "origin", refspec: "refs/pull/1234/head", intoRef: `${R}/head` },
          { kind: "fetch", remote: "origin", refspec: "refs/heads/main", intoRef: `${R}/base` },
          { kind: "resolve", name: "headSha", revParse: `${R}/head` },
          { kind: "updateRef", from: "${headSha}", to: `${R}/heads/\${headSha}` },
          { kind: "resolve", name: "mergeBase", mergeBase: [`${R}/head`, `${R}/base`] },
          { kind: "writeTask", path: "reviews/skywalking-banyandb-1234/task.yaml", fields: { base: "${mergeBase}", request: "Review on apache/skywalking-banyandb#1234 at ${headSha}." } },
        ],
      });
      expect(() => validateTaskPlan(plan, "pr-review")).not.toThrow();
    }
  });

  it("falls back to the project's URL without a matching remote, honors --base, accepts the redundant --review, and the profile's baseBranch", () => {
    const plan = prepareTask(input(["apache/skywalking-banyandb#7", "--base", "release-0.9", "--review"], { repo: { remotes: [{ name: "fork", url: "https://github.com/me/skywalking-banyandb.git" }], head: "b".repeat(40) } })) as { summary: string; steps: Array<Record<string, unknown>> };
    expect(plan.steps[0]).toMatchObject({ remote: "https://github.com/apache/skywalking-banyandb.git" });
    expect(plan.steps[1]).toMatchObject({ refspec: "refs/heads/release-0.9" });
    expect(plan.steps[5]).toMatchObject({ fields: { request: "Review on apache/skywalking-banyandb#7 at ${headSha}." } });
    expect(plan.summary).toBe("review of apache/skywalking-banyandb#7 against release-0.9");
    const withBranch = prepareTask(input(["apache/skywalking-banyandb#7"], { profile: { ...(banyandb as object), baseBranch: "develop" } })) as { steps: Array<Record<string, unknown>> };
    expect(withBranch.steps[1]).toMatchObject({ refspec: "refs/heads/develop" });
  });

  it("writes --all-questions into the request, which asks every follow-up question even when N1 judges the change unnecessary (design 7.5), and validates", () => {
    const plan = prepareTask(input(["apache/skywalking-banyandb#7", "--all-questions"])) as { summary: string; steps: Array<Record<string, unknown>> };
    expect(plan.steps[5]).toMatchObject({ fields: { request: "Review on apache/skywalking-banyandb#7 at ${headSha}, asking every question." } });
    expect(plan.summary).toBe("review of apache/skywalking-banyandb#7 against main, asking every question even if the change is judged unnecessary");
    expect(() => validateTaskPlan(plan as never, "pr-review")).not.toThrow();
    const both = prepareTask(input(["apache/skywalking-banyandb#7", "--review", "--all-questions"])) as { steps: Array<Record<string, unknown>> };
    expect(both.steps[5]).toMatchObject({ fields: { request: "Review on apache/skywalking-banyandb#7 at ${headSha}, asking every question." } });
    const plain = prepareTask(input(["apache/skywalking-banyandb#7"])) as { steps: Array<Record<string, unknown>> };
    expect(plain.steps[5]).toMatchObject({ fields: { request: "Review on apache/skywalking-banyandb#7 at ${headSha}." } });
  });

  it("matches a remote's URL literally: a dot in the repository name is not a wildcard", () => {
    const profile = { name: "p", project: "org/foo.bar", environment: { checks: [] } };
    const plan = prepareTask(input(["org/foo.bar#1"], { profile, repo: { remotes: [{ name: "wrong", url: "https://github.com/org/foo-bar.git" }, { name: "right", url: "https://github.com/org/foo.bar" }], head: "c".repeat(40) } })) as { steps: Array<Record<string, unknown>> };
    expect(plan.steps[0]).toMatchObject({ remote: "right" });
    const only = prepareTask(input(["org/foo.bar#1"], { profile, repo: { remotes: [{ name: "wrong", url: "https://github.com/org/foo-bar.git" }], head: "c".repeat(40) } })) as { steps: Array<Record<string, unknown>> };
    expect(only.steps[0]).toMatchObject({ remote: "https://github.com/org/foo.bar.git" });
  });

  it("refuses another project, a missing profile and malformed arguments, naming the problem", () => {
    const refused = (i: PrepareTaskInput): string => (prepareTask(i) as { refused: string }).refused;
    expect(refused(input(["other/repo#1"]))).toMatch(/not this profile's project \(apache\/skywalking-banyandb\)/);
    expect(refused(input(["apache/skywalking-banyandb#1"], { profile: undefined }))).toMatch(/needs a profile/);
    expect(refused(input(["apache/skywalking-banyandb#1"], { profile: { name: "x" } }))).toMatch(/profile is not usable/);
    for (const bad of [[], ["a/b"], ["apache/skywalking-banyandb#0"], ["apache/skywalking-banyandb#1", "x"], ["apache/skywalking-banyandb#1", "--bogus"], ["apache/skywalking-banyandb#1", "--base"], ["http://github.com/apache/skywalking-banyandb/pull/1"]]) {
      expect(refused(input(bad)), JSON.stringify(bad)).toMatch(/pull request|usage|--base|unknown/);
    }
    expect(parsePullArgument("apache/skywalking-banyandb#12")).toEqual({ owner: "apache", repo: "skywalking-banyandb", number: 12 });
    expect(() => parseProfile({ name: "p", project: "a/b", environment: { checks: [] }, baseBranch: "a..b" })).toThrow(/baseBranch/);
  });
});

describe("no human in the flow", () => {
  it("declares no approval: the pinned definition has none, and the stages end with Publish", () => {
    const definition = definitionFor(parseProfile(banyandb));
    expect(definition.approvals).toBeUndefined();
    expect(definition.stages.map((s) => s.id)).toEqual(["fetch", "report", "questions", "answers", "round1", "review", "draft", "publish"]);
  });
});
