// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Opt-in live reads of a small public pull request. Skipped unless
 * GRAPHLOOM_LIVE_GITHUB=1, so `npm test` never touches the network. GitHub's
 * GraphQL API requires a token even for public data: set GRAPHLOOM_LIVE_GITHUB_TOKEN
 * (or GITHUB_TOKEN) to include the review-thread read; without one it is skipped.
 *
 *   GRAPHLOOM_LIVE_GITHUB=1 GITHUB_TOKEN=... npx vitest run src/live
 *   GRAPHLOOM_LIVE_GITHUB_PULL=<number> picks another pull request of apache/skywalking-banyandb (default 1429, one commit, one file).
 */
import os from "node:os";
import { describe, expect, it } from "vitest";
import type { ExecutorDefinition } from "@graphloom/sdk";
import { executors } from "../executors.js";
import { GITHUB_CREDENTIAL } from "../package.js";

const live = process.env.GRAPHLOOM_LIVE_GITHUB === "1";
const token = process.env.GRAPHLOOM_LIVE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
const number = Number(process.env.GRAPHLOOM_LIVE_GITHUB_PULL ?? "1429");
const repo = { owner: "apache", repo: "skywalking-banyandb" };

async function read(id: string, input: Record<string, unknown>) {
  const def = executors.find((e) => e.id === `graphloom.github/${id}`) as ExecutorDefinition;
  expect(def.inputSchema!(input)).toBe(true);
  const out = (await def.execute(input, {
    runId: "live",
    operationId: `live-${id}`,
    generation: 1,
    worktreePath: os.tmpdir(),
    artifactDir: os.tmpdir(),
    credentials: { get: async (name) => (name === GITHUB_CREDENTIAL ? token : undefined) },
  })) as { status: string; summary: string; evidence?: { payload: { github: Record<string, any> } }[] };
  expect(out.status, out.summary).toBe("ok");
  return out.evidence![0]!.payload.github;
}

describe.skipIf(!live)("live GitHub snapshot reads (apache/skywalking-banyandb)", () => {
  it("reads a public pull request's metadata, files, commits, reviews, comments and check runs", async () => {
    const pull = (await read("get-pull", { ...repo, number })).item;
    expect(pull.number).toBe(number);
    expect(pull.head.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pull.base.sha).toMatch(/^[0-9a-f]{40}$/);

    const files = await read("list-pull-files", { ...repo, number });
    expect(files.items.length).toBeGreaterThan(0);
    expect(files.page.complete).toBe(true);
    const commits = await read("list-pull-commits", { ...repo, number });
    expect(commits.items[0].parents.length).toBeGreaterThan(0);
    await read("list-pull-reviews", { ...repo, number });
    await read("list-pull-review-comments", { ...repo, number });
    const checks = await read("list-check-runs", { ...repo, sha: pull.head.sha });
    expect(checks.page.complete).toBe(true);
  });

  it.skipIf(token === undefined)("reads review threads through GraphQL", async () => {
    const threads = await read("list-review-threads", { ...repo, number });
    expect(threads.page.complete).toBe(true);
    for (const t of threads.items) expect(typeof t.isResolved).toBe("boolean");
  });
});
