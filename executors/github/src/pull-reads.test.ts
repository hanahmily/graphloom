// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutorDefinition } from "@graphloom/sdk";
import { GITHUB_API_URL_ENV } from "./client.js";
import { executors } from "./executors.js";
import { GITHUB_CREDENTIAL } from "./package.js";
import { startFakeGitHub, type FakeGitHub } from "./testing/fake-github.js";

const TOKEN = "ghp_fake_secret_token_value";
const HEAD = "1111111111111111111111111111111111111111";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(): Promise<FakeGitHub> {
  const server = await startFakeGitHub({
    pulls: [
      {
        number: 7,
        title: "Add feature",
        state: "open",
        head: "acme:feature",
        base: "main",
        body: "Adds the feature",
        author: "alice",
        labels: ["enhancement"],
        headSha: HEAD,
        baseSha: "2222222222222222222222222222222222222222",
        draft: true,
      },
    ],
  });
  cleanups.push(() => server.close());
  return server;
}

interface Output {
  status: "ok" | "failed" | "conflict";
  summary: string;
  evidence?: { kind: string; payload: unknown }[];
  retryAfterMs?: number;
}

let opSeq = 0;
async function run(server: FakeGitHub, id: string, input: unknown, token: string | undefined = TOKEN): Promise<Output> {
  const def = executors.find((e) => e.id === `graphloom.github/${id}`) as ExecutorDefinition | undefined;
  if (!def) throw new Error(`no executor ${id}`);
  if (def.inputSchema && !def.inputSchema(input)) {
    return { status: "failed", summary: `executor ${def.id}: input failed schema validation` };
  }
  opSeq += 1;
  process.env[GITHUB_API_URL_ENV] = server.baseUrl;
  return (await def.execute(input, {
    runId: "run-1",
    operationId: `op-${opSeq}`,
    generation: 1,
    worktreePath: os.tmpdir(),
    artifactDir: os.tmpdir(),
    credentials: { get: async (name) => (name === GITHUB_CREDENTIAL ? token : undefined) },
  })) as Output;
}

function github(result: Output): Record<string, any> {
  return (result.evidence?.[0]?.payload as { github: Record<string, any> }).github;
}

const pull = { owner: "acme", repo: "app", number: 7 };

describe("graphloom.github/get-pull", () => {
  it("returns title, body, refs and shas, author, labels and draft", async () => {
    const server = await fake();
    const result = await run(server, "get-pull", pull);
    expect(result.status).toBe("ok");
    expect(github(result).item).toMatchObject({
      number: 7,
      title: "Add feature",
      body: "Adds the feature",
      state: "open",
      author: "alice",
      labels: ["enhancement"],
      draft: true,
      head: { ref: "feature", sha: HEAD },
      base: { ref: "main", sha: "2222222222222222222222222222222222222222" },
    });
  });

  it("maps a missing pull request to the 404 the other reads report", async () => {
    const server = await fake();
    const result = await run(server, "get-pull", { ...pull, number: 99 });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/returned 404: Not Found/);
  });
});

describe("graphloom.github/list-pull-files", () => {
  it("lists path, status, previous path, counts and patch, flagging a patch GitHub omitted", async () => {
    const server = await fake();
    server.pullFiles.set(7, [
      { filename: "src/a.ts", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-x\n+y\n+z" },
      { filename: "src/new-name.ts", previousFilename: "src/old-name.ts", status: "renamed", additions: 0, deletions: 0 },
      { filename: "dist/huge.json", additions: 5000, deletions: 0 },
      { filename: "logo.png", additions: 0, deletions: 0 },
    ]);
    const result = await run(server, "list-pull-files", pull);
    expect(result.status).toBe("ok");
    const items = github(result).items;
    expect(items[0]).toMatchObject({ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-x\n+y\n+z", patchOmitted: false });
    expect(items[1]).toMatchObject({ path: "src/new-name.ts", status: "renamed", previousPath: "src/old-name.ts", patch: null, patchOmitted: false });
    expect(items[2]).toMatchObject({ path: "dist/huge.json", patch: null, patchOmitted: true });
    expect(items[3]).toMatchObject({ path: "logo.png", patchOmitted: false });
    expect(github(result).page).toMatchObject({ complete: true, nextCursor: null, limitReached: false });
    expect(server.requests.every((r) => r.method === "GET")).toBe(true);
    expect(server.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("paginates, and is complete only once the last page was read", async () => {
    const server = await fake();
    server.pullFiles.set(7, Array.from({ length: 5 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0, patch: "+x" })));
    const first = await run(server, "list-pull-files", { ...pull, perPage: 2, maxPages: 2 });
    expect(github(first).items.map((f: { path: string }) => f.path)).toEqual(["f0.ts", "f1.ts", "f2.ts", "f3.ts"]);
    expect(github(first).page).toMatchObject({ startCursor: "1", nextCursor: "3", pagesFetched: 2, perPage: 2, complete: false });
    expect(first.summary).toMatch(/more after cursor 3/);
    const rest = await run(server, "list-pull-files", { ...pull, perPage: 2, cursor: "3" });
    expect(github(rest).items.map((f: { path: string }) => f.path)).toEqual(["f4.ts"]);
    expect(github(rest).page).toMatchObject({ nextCursor: null, complete: true });
  });

  it("is never complete when the list reached GitHub's 3000-file cap", async () => {
    const server = await fake();
    server.pullFiles.set(7, Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}`, additions: 1, deletions: 0, patch: "+x" })));
    const result = await run(server, "list-pull-files", { ...pull, perPage: 100, cursor: "30" });
    expect(github(result).items).toHaveLength(100);
    expect(github(result).page).toMatchObject({ nextCursor: null, complete: false, limitReached: true });
    expect(result.summary).toMatch(/cap was reached/);
  });

  it("maps 404 and rate limits like the other reads", async () => {
    const server = await fake();
    const missing = await run(server, "list-pull-files", { ...pull, number: 99 });
    expect(missing.status).toBe("failed");
    expect(missing.summary).toMatch(/returned 404/);
    server.rateLimitNext(1, 120);
    const limited = await run(server, "list-pull-files", pull);
    expect(limited.status).toBe("failed");
    expect(limited.summary).toMatch(/rate limited GET \/repos\/acme\/app\/pulls\/7\/files; retry after/);
    expect(github(limited)).toMatchObject({ outcome: "rate-limited" });
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("graphloom.github/list-pull-commits", () => {
  it("lists sha, parents, message, author and committed date, and flags a cut message", async () => {
    const server = await fake();
    server.pullCommits.set(7, [
      { sha: "c1", parents: ["p0"], message: "first\n\nbody", author: "alice", committedDate: "2026-09-01T10:00:00Z" },
      { sha: "c2", parents: ["c1", "m1"], message: "x".repeat(5000) },
    ]);
    const result = await run(server, "list-pull-commits", pull);
    const items = github(result).items;
    expect(items[0]).toMatchObject({ sha: "c1", parents: ["p0"], message: "first\n\nbody", messageTruncated: false, author: "alice", committedDate: "2026-09-01T10:00:00Z" });
    expect(items[1]).toMatchObject({ sha: "c2", parents: ["c1", "m1"], messageTruncated: true });
    expect(items[1].message.length).toBeLessThan(5000);
    expect(github(result).page).toMatchObject({ complete: true, limitReached: false });
  });

  it("paginates across pages", async () => {
    const server = await fake();
    server.pullCommits.set(7, Array.from({ length: 3 }, (_, i) => ({ sha: `c${i}`, message: `m${i}` })));
    const first = await run(server, "list-pull-commits", { ...pull, perPage: 2 });
    expect(github(first).items).toHaveLength(2);
    expect(github(first).page).toMatchObject({ complete: false, nextCursor: "2" });
    const second = await run(server, "list-pull-commits", { ...pull, perPage: 2, cursor: "2" });
    expect(github(second).items.map((c: { sha: string }) => c.sha)).toEqual(["c2"]);
    expect(github(second).page.complete).toBe(true);
  });

  it("is never complete at GitHub's 250-commit cap", async () => {
    const server = await fake();
    server.pullCommits.set(7, Array.from({ length: 250 }, (_, i) => ({ sha: `c${i}`, message: "m" })));
    const result = await run(server, "list-pull-commits", { ...pull, perPage: 100, maxPages: 3 });
    expect(github(result).items).toHaveLength(250);
    expect(github(result).page).toMatchObject({ nextCursor: null, complete: false, limitReached: true });
  });
});

describe("graphloom.github/list-pull-reviews", () => {
  it("lists id, user, state, body, commit and submitted time across pages", async () => {
    const server = await fake();
    server.reviews.set(7, [
      { id: 1, user: "bob", body: "needs work", state: "CHANGES_REQUESTED", commitId: "c1", comments: [] },
      { id: 2, user: "carol", body: "lgtm", state: "APPROVED", commitId: "c2", comments: [] },
      { id: 3, body: "y".repeat(5000), state: "COMMENTED", commitId: "c2", comments: [] },
    ]);
    const first = await run(server, "list-pull-reviews", { ...pull, perPage: 2 });
    expect(github(first).items[0]).toMatchObject({ id: 1, user: "bob", state: "CHANGES_REQUESTED", body: "needs work", commitId: "c1", submittedAt: "2026-09-04T00:00:00Z" });
    expect(github(first).page).toMatchObject({ complete: false, nextCursor: "2" });
    const second = await run(server, "list-pull-reviews", { ...pull, perPage: 2, cursor: "2" });
    expect(github(second).items[0]).toMatchObject({ id: 3, bodyTruncated: true });
    expect(github(second).page.complete).toBe(true);
  });

  it("maps 404", async () => {
    const result = await run(await fake(), "list-pull-reviews", { ...pull, number: 99 });
    expect(result.summary).toMatch(/returned 404/);
  });
});

describe("graphloom.github/list-pull-review-comments", () => {
  it("lists anchors, side, commit, reply parent, body and user, keeping the original line of an outdated comment", async () => {
    const server = await fake();
    server.reviewComments.set(7, [
      { id: 11, path: "src/a.ts", line: 4, side: "RIGHT", startLine: 2, commitId: "c1", body: "why?", user: "bob" },
      { id: 12, path: "src/a.ts", line: null, originalLine: 9, side: "LEFT", inReplyTo: 11, body: "because", user: "alice" },
    ]);
    const result = await run(server, "list-pull-review-comments", pull);
    const [a, b] = github(result).items;
    expect(a).toMatchObject({ id: 11, path: "src/a.ts", line: 4, originalLine: 4, side: "RIGHT", startLine: 2, commitId: "c1", inReplyTo: null, body: "why?", user: "bob" });
    expect(b).toMatchObject({ id: 12, line: null, originalLine: 9, side: "LEFT", inReplyTo: 11, user: "alice" });
    expect(github(result).page.complete).toBe(true);
  });

  it("paginates", async () => {
    const server = await fake();
    server.reviewComments.set(7, Array.from({ length: 3 }, (_, i) => ({ id: i + 1, path: "p", line: 1, body: "b" })));
    const first = await run(server, "list-pull-review-comments", { ...pull, perPage: 2 });
    expect(github(first).page).toMatchObject({ complete: false, nextCursor: "2" });
    const second = await run(server, "list-pull-review-comments", { ...pull, perPage: 2, cursor: "2" });
    expect(github(second).items.map((c: { id: number }) => c.id)).toEqual([3]);
  });
});

describe("graphloom.github/list-check-runs", () => {
  it("lists name, status, conclusion and details url, with the total, across pages", async () => {
    const server = await fake();
    server.checkRuns.set(HEAD, [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure", detailsUrl: "https://ci.example/test/1" },
      { name: "lint", status: "in_progress" },
    ]);
    const first = await run(server, "list-check-runs", { owner: "acme", repo: "app", sha: HEAD, perPage: 2 });
    expect(github(first).items[1]).toMatchObject({ name: "test", status: "completed", conclusion: "failure", detailsUrl: "https://ci.example/test/1" });
    expect(github(first).totalCount).toBe(3);
    expect(github(first).page).toMatchObject({ complete: false, nextCursor: "2" });
    const second = await run(server, "list-check-runs", { owner: "acme", repo: "app", sha: HEAD, perPage: 2, cursor: "2" });
    expect(github(second).items).toMatchObject([{ name: "lint", status: "in_progress", conclusion: null }]);
    expect(github(second).page.complete).toBe(true);
    expect(server.requests[0]!.path).toMatch(new RegExp(`^/repos/acme/app/commits/${HEAD}/check-runs\\?`));
  });

  it("reports GitHub's refusal of an unknown commit and requires a hex sha", async () => {
    const server = await fake();
    const unknown = await run(server, "list-check-runs", { owner: "acme", repo: "app", sha: "abcdef0" });
    expect(unknown.status).toBe("failed");
    expect(unknown.summary).toMatch(/returned 422: No commit found/);
    const bad = await run(server, "list-check-runs", { owner: "acme", repo: "app", sha: "main" });
    expect(bad.summary).toMatch(/input failed schema validation/);
  });
});

describe("graphloom.github/list-review-threads", () => {
  const threads = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `PRRT_${i}`,
      isResolved: i % 2 === 0,
      isOutdated: i === 1,
      path: `src/f${i}.ts`,
      line: i + 1,
      comments: [
        { id: 100 + i * 2, author: "bob", body: `thread ${i}` },
        { id: 101 + i * 2, author: "alice", body: "reply" },
      ],
    }));

  it("lists resolution, outdated state, anchor and comments with ids, authors and bodies", async () => {
    const server = await fake();
    server.reviewThreads.set(7, threads(2));
    const result = await run(server, "list-review-threads", pull);
    expect(result.status).toBe("ok");
    const [t0, t1] = github(result).items;
    expect(t0).toMatchObject({ id: "PRRT_0", isResolved: true, isOutdated: false, resolvedBy: "maintainer", path: "src/f0.ts", line: 1, commentsComplete: true });
    expect(t0.comments).toMatchObject([
      { id: 100, author: "bob", body: "thread 0" },
      { id: 101, author: "alice", body: "reply" },
    ]);
    expect(t1).toMatchObject({ isResolved: false, isOutdated: true });
    expect(github(result).page).toMatchObject({ complete: true, nextCursor: null, incompleteThreads: [] });
    expect(server.requests.map((r) => r.path)).toEqual(["/graphql"]);
    expect(server.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("paginates threads with GraphQL cursors", async () => {
    const server = await fake();
    server.reviewThreads.set(7, threads(5));
    const first = await run(server, "list-review-threads", { ...pull, perPage: 2, maxPages: 2 });
    expect(github(first).items.map((t: { id: string }) => t.id)).toEqual(["PRRT_0", "PRRT_1", "PRRT_2", "PRRT_3"]);
    const page = github(first).page;
    expect(page).toMatchObject({ startCursor: "start", pagesFetched: 2, complete: false });
    expect(typeof page.nextCursor).toBe("string");
    expect(first.summary).toMatch(/more after cursor/);
    const rest = await run(server, "list-review-threads", { ...pull, perPage: 2, cursor: page.nextCursor });
    expect(github(rest).items.map((t: { id: string }) => t.id)).toEqual(["PRRT_4"]);
    expect(github(rest).page).toMatchObject({ complete: true, nextCursor: null });
  });

  it("reads every comment of a thread that has more than one GraphQL page of them", async () => {
    const server = await fake();
    server.reviewThreads.set(7, [
      { id: "PRRT_big", isResolved: false, isOutdated: false, path: "a.ts", comments: Array.from({ length: 230 }, (_, i) => ({ id: i + 1, author: "bob", body: `c${i}` })) },
    ]);
    const result = await run(server, "list-review-threads", pull);
    const [thread] = github(result).items;
    expect(thread.comments).toHaveLength(230);
    expect(thread.commentsComplete).toBe(true);
    expect(github(result).page.complete).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it("is incomplete, naming the thread, when a thread's comments cannot all be read", async () => {
    const server = await fake();
    server.reviewThreads.set(7, [
      { id: "PRRT_huge", isResolved: false, isOutdated: false, path: "a.ts", comments: Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, author: "bob", body: "c" })) },
    ]);
    const result = await run(server, "list-review-threads", pull);
    const [thread] = github(result).items;
    expect(thread.commentsComplete).toBe(false);
    expect(thread.comments).toHaveLength(1100);
    expect(github(result).page).toMatchObject({ complete: false, nextCursor: null, incompleteThreads: ["PRRT_huge"] });
    expect(result.summary).toMatch(/1 thread\(s\) with unread comments/);
  });

  it("maps a missing pull request to 404 and a rate limit to retry timing", async () => {
    const server = await fake();
    const missing = await run(server, "list-review-threads", { ...pull, number: 99 });
    expect(missing.status).toBe("failed");
    expect(missing.summary).toMatch(/returned 404/);
    server.rateLimitNext(1, 90);
    const limited = await run(server, "list-review-threads", pull);
    expect(limited.status).toBe("failed");
    expect(limited.summary).toMatch(/rate limited POST \/graphql; retry after/);
    expect(github(limited)).toMatchObject({ outcome: "rate-limited" });
  });

  it("refuses a malformed cursor before any request", async () => {
    const server = await fake();
    const result = await run(server, "list-review-threads", { ...pull, cursor: "bad cursor!" });
    expect(result.summary).toMatch(/input failed schema validation/);
    expect(server.requests).toHaveLength(0);
  });
});

describe("snapshot read input shapes", () => {
  const ids = ["list-pull-files", "list-pull-commits", "list-pull-reviews", "list-pull-review-comments", "list-review-threads", "list-check-runs"];
  const defs = ids.map((id) => executors.find((e) => e.id === `graphloom.github/${id}`) as ExecutorDefinition);

  it("declares read effect, a shape whose example the predicate accepts, and no write capability", () => {
    for (const def of defs) {
      expect(def.effect, def.id).toBe("read");
      expect(def.capabilities, def.id).toEqual(["network:github"]);
      expect(def.inputSchema!(def.inputShape!.example), def.id).toBe(true);
      expect(def.inputProblem!(def.inputShape!.example), def.id).toBeUndefined();
    }
  });

  it("names the failing field of a refused input", () => {
    const files = defs[0]!;
    expect(files.inputProblem!({ owner: "o", repo: "r" })).toBe("number: required");
    expect(files.inputProblem!({ owner: "o", repo: "r", number: 0 })).toMatch(/^number:/);
    expect(files.inputProblem!({ owner: "o", repo: "r", number: 1, maxPages: 11 })).toMatch(/^maxPages:/);
    expect(files.inputSchema!({ owner: "o", repo: "r", number: 1, cursor: "0" })).toBe(false);
    const checks = defs[5]!;
    expect(checks.inputProblem!({ owner: "o", repo: "r" })).toBe("sha: required");
    expect(checks.inputProblem!({ owner: "o", repo: "r", sha: "HEAD" })).toMatch(/^sha:/);
    expect(defs[4]!.inputProblem!({ owner: "o", repo: "r", number: 1, cursor: "a b" })).toMatch(/^cursor:/);
  });

  it("never reaches GitHub on a refused input and keeps the token out of results", async () => {
    const server = await fake();
    const refused = await run(server, "list-pull-files", { owner: "acme", repo: "../x", number: 1 });
    expect(refused.status).toBe("failed");
    expect(server.requests).toHaveLength(0);
    server.pullFiles.set(7, [{ filename: "a", additions: 1, deletions: 0, patch: "+x" }]);
    const ok = await run(server, "list-pull-files", pull);
    expect(JSON.stringify(ok)).not.toContain(TOKEN);
  });
});
