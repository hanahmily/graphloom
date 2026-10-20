import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutorDefinition } from "@graphloom/sdk";
import { GITHUB_API_URL_ENV } from "./client.js";
import { executors, GITHUB_EXECUTOR_VERSION } from "./executors.js";
import { GITHUB_CREDENTIAL, GITHUB_EXECUTOR_IDS, githubBinding, githubExecutorPackage } from "./package.js";
import { FAKE_VIEWER, startFakeGitHub, type FakeGitHub, type FakeIssue } from "./testing/fake-github.js";

// Executors are exercised through the SDK contract only. Process isolation,
// effect grants, and credential redaction belong to the host and are tested there.

const TOKEN = "ghp_fake_secret_token_value";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(seed?: Parameters<typeof startFakeGitHub>[0]): Promise<FakeGitHub> {
  const server = await startFakeGitHub(seed);
  cleanups.push(() => server.close());
  return server;
}

interface Harness {
  baseUrl: string;
  token?: string;
  /** Abort in-flight requests after this long, as if the executor process died. */
  abortAfterMs?: number;
}

function runner(server: FakeGitHub, opts: { token?: string; abortAfterMs?: number } = {}): Harness {
  return { baseUrl: server.baseUrl, ...opts };
}

interface Output {
  status: "ok" | "failed" | "conflict";
  summary: string;
  evidence?: { kind: string; payload: unknown }[];
}

let opSeq = 0;
async function run(h: Harness, id: string, input: unknown, opts: { runId?: string } = {}): Promise<Output> {
  const def = executors.find((e) => e.id === `graphloom.github/${id}`) as ExecutorDefinition | undefined;
  if (!def) throw new Error(`no executor ${id}`);
  if (def.inputSchema && !def.inputSchema(input)) {
    return { status: "failed", summary: `executor ${def.id}: input failed schema validation` };
  }
  opSeq += 1;
  process.env[GITHUB_API_URL_ENV] = h.baseUrl;
  return (await def.execute(input, {
    runId: opts.runId ?? "run-1",
    operationId: `op-${opSeq}`,
    generation: 1,
    worktreePath: os.tmpdir(),
    artifactDir: os.tmpdir(),
    credentials: { get: async (name) => (name === GITHUB_CREDENTIAL ? h.token : undefined) },
    ...(h.abortAfterMs !== undefined ? { signal: AbortSignal.timeout(h.abortAfterMs) } : {}),
  })) as Output;
}

function github(result: Output): Record<string, unknown> {
  return (result.evidence?.[0]?.payload as { github: Record<string, unknown> }).github;
}

describe("package manifest", () => {
  it("declares exactly the executors the entry module serves", () => {
    expect([...GITHUB_EXECUTOR_IDS].sort()).toEqual(executors.map((e) => e.id).sort());
    expect(new Set(executors.map((e) => e.version))).toEqual(new Set([GITHUB_EXECUTOR_VERSION]));
    expect(githubExecutorPackage.entryModule).toMatch(/executors\.js$/);
  });

  it("binds reads by default and writes only when asked", () => {
    expect(githubBinding()).toEqual({ allowedEffects: ["read"] });
    expect(githubBinding({ token: "t", allowWrites: true, baseUrl: "http://gh" })).toEqual({
      allowedEffects: ["read", "write"],
      credentials: { github: "t" },
      env: { [GITHUB_API_URL_ENV]: "http://gh" },
    });
  });
});

const issues: FakeIssue[] = [
  ...Array.from({ length: 7 }, (_, i) => ({
    number: i + 1,
    title: `issue ${i + 1}`,
    state: "open" as const,
    labels: i % 2 === 0 ? ["bug"] : ["docs"],
  })),
  { number: 8, title: "a pull request", state: "open", labels: ["bug"], pullRequest: true },
];

describe("graphloom.github reads", () => {
  it("returns bounded pages with cursors and never presents a page as complete", async () => {
    const server = await fake({ issues });
    const r = runner(server);

    const first = await run(r, "list-issues", { owner: "acme", repo: "app", perPage: 2, maxPages: 2 });
    expect(first.status).toBe("ok");
    const firstPage = github(first);
    expect((firstPage.items as { number: number }[]).map((i) => i.number)).toEqual([1, 2, 3, 4]);
    expect(firstPage.page).toEqual({
      startCursor: "1",
      nextCursor: "3",
      pagesFetched: 2,
      perPage: 2,
      complete: false,
      excludedPullRequests: 0,
    });
    expect(firstPage.query).toEqual({ owner: "acme", repo: "app", state: "open", labels: [], perPage: 2 });
    expect(typeof firstPage.retrievedAt).toBe("string");
    expect(first.summary).toMatch(/more after cursor 3/);

    const rest = await run(r, "list-issues", {
      owner: "acme",
      repo: "app",
      perPage: 2,
      cursor: "3",
      maxPages: 10,
    });
    const restPage = github(rest);
    expect((restPage.items as { number: number }[]).map((i) => i.number)).toEqual([5, 6, 7]);
    expect(restPage.page).toMatchObject({ nextCursor: null, pagesFetched: 2, complete: true, excludedPullRequests: 1 });
    expect(server.requests.filter((q) => q.method === "GET")).toHaveLength(4);
  });

  it("surfaces rate limits with retry timing instead of retrying", async () => {
    const server = await fake({ issues });
    server.rateLimitNext(1, 120);
    const result = await run(runner(server), "list-issues", { owner: "acme", repo: "app" });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/GitHub rate limited GET \/repos\/acme\/app\/issues; retry after 1[12][0-9]s, limit resets at /);
    expect(github(result)).toMatchObject({ outcome: "rate-limited", rateLimit: { limit: 60, remaining: 0 } });
    expect(server.requests).toHaveLength(1);
  });

  it("rejects malformed input in the executor process before any request", async () => {
    const server = await fake({ issues });
    const result = await run(runner(server), "list-issues", { owner: "acme", repo: "../etc", maxPages: 50 });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/input failed schema validation/);
    expect(server.requests).toHaveLength(0);
  });

  it("sends the bound token to GitHub as a bearer credential", async () => {
    const server = await fake({ issues });
    const result = await run(runner(server, { token: TOKEN }), "get-issue", { owner: "acme", repo: "app", number: 1 });
    expect(result.status).toBe("ok");
    expect(server.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("graphloom.github writes", () => {
  const comment = { owner: "acme", repo: "app", issueNumber: 3, body: "Triage: needs repro", idempotencyKey: "triage-3" };

  it("requires a credential binding for writes", async () => {
    const server = await fake({ issues });
    const result = await run(runner(server), "create-issue-comment", comment);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/require the "github" credential binding/);
    expect(server.requests).toHaveLength(0);
  });

  it("reconciles a comment after the executor dies mid-POST instead of duplicating it", async () => {
    const server = await fake({ issues });
    server.hangAfterNextWrite();
    const crashed = await run(runner(server, { token: TOKEN, abortAfterMs: 500 }), "create-issue-comment", comment);
    expect(crashed.status).toBe("failed");
    expect(crashed.summary).toMatch(/comment outcome unknown/);
    expect(server.comments.get(3)).toHaveLength(1);

    // A new attempt (new operation id) for the same idempotency key.
    const retried = await run(runner(server, { token: TOKEN }), "create-issue-comment", comment);
    expect(retried.status).toBe("ok");
    expect(github(retried)).toMatchObject({
      operation: "create-issue-comment",
      outcome: "reconciled",
      idempotencyKey: "triage-3",
      target: { owner: "acme", repo: "app", issueNumber: 3 },
    });
    expect(server.comments.get(3)).toHaveLength(1);
    expect(server.comments.get(3)?.[0]?.body).toContain("<!-- graphloom-op: run-1/triage-3 -->");
    expect(server.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("confirms an interrupted POST by its marker within the same attempt", async () => {
    const server = await fake({ issues });
    server.dropAfterNextWrite();
    const result = await run(runner(server, { token: TOKEN }), "create-issue-comment", comment);
    expect(result.status).toBe("ok");
    expect(github(result)).toMatchObject({ outcome: "reconciled" });
    expect(server.comments.get(3)).toHaveLength(1);
  });

  it("keys reconciliation to the run so another run posts its own comment", async () => {
    const server = await fake({ issues });
    const r = runner(server, { token: TOKEN });
    await run(r, "create-issue-comment", comment, { runId: "run-a" });
    const second = await run(r, "create-issue-comment", comment, { runId: "run-b" });
    expect(github(second)).toMatchObject({ outcome: "created" });
    expect(server.comments.get(3)).toHaveLength(2);
  });

  it("creates a pull request once and refuses to shadow a foreign open one", async () => {
    const server = await fake({
      pulls: [{ number: 1, title: "manual", state: "open", head: "acme:manual", base: "main", body: "by hand" }],
    });
    const r = runner(server, { token: TOKEN });
    const pull = { owner: "acme", repo: "app", base: "main", title: "Fix greeting", idempotencyKey: "fix-1" };

    const foreign = await run(r, "create-pull", { ...pull, head: "manual" });
    expect(foreign.status).toBe("conflict");
    expect(foreign.summary).toMatch(/open pull request #1 .* lacks this operation's marker/);

    const created = await run(r, "create-pull", { ...pull, head: "graphloom/fix-1" });
    expect(created.status).toBe("ok");
    expect(github(created)).toMatchObject({ outcome: "created", target: { head: "acme:graphloom/fix-1", base: "main" } });

    const again = await run(r, "create-pull", { ...pull, head: "graphloom/fix-1" });
    expect(github(again)).toMatchObject({ outcome: "reconciled" });
    expect(server.pulls).toHaveLength(2);
    expect(server.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("finds its marked pull request past the first page of a reused branch", async () => {
    const reused = Array.from({ length: 150 }, (_, i) => ({
      number: i + 1,
      title: `old ${i + 1}`,
      state: "closed" as const,
      head: "acme:reuse",
      base: "main",
      body: "earlier attempt",
    }));
    const server = await fake({
      pulls: [
        ...reused,
        { number: 151, title: "ours", state: "open", head: "acme:reuse", base: "main", body: "x\n\n<!-- graphloom-op: run-1/fix-2 -->" },
      ],
    });
    const result = await run(runner(server, { token: TOKEN }), "create-pull", {
      owner: "acme",
      repo: "app",
      head: "reuse",
      base: "main",
      title: "Fix",
      idempotencyKey: "fix-2",
    });
    expect(github(result)).toMatchObject({ outcome: "reconciled", pull: { number: 151 } });
    expect(server.requests.filter((q) => q.method === "GET")).toHaveLength(2);
    expect(server.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("reports a definite 422 with GitHub's reason instead of an unknown outcome", async () => {
    const server = await fake();
    const result = await run(runner(server, { token: TOKEN }), "create-pull", {
      owner: "acme",
      repo: "app",
      head: "empty",
      base: "main",
      title: "Nothing",
      idempotencyKey: "fix-3",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toBe(
      "GitHub POST /repos/acme/app/pulls returned 422: Validation Failed (No commits between main and empty)",
    );
  });
});

describe("graphloom.github reviews", () => {
  const pulls = [
    { number: 20, title: "Add greeting", state: "open" as const, head: "octo:greet", base: "main", body: "", author: "octo" },
    { number: 21, title: "Ours", state: "open" as const, head: "acme:ours", base: "main", body: "", author: FAKE_VIEWER },
  ];
  const review = {
    owner: "acme",
    repo: "app",
    number: 20,
    event: "REQUEST_CHANGES",
    body: "Please handle the empty-name case.",
    comments: [{ path: "src/greet.ts", line: 12, body: "Guard against an empty name here." }],
    idempotencyKey: "review-20",
  };

  it("requests changes with inline comments once, and reconciles the retry", async () => {
    const server = await fake({ pulls });
    const r = runner(server, { token: TOKEN });

    const first = await run(r, "create-pull-review", review);
    expect(first.status, first.summary).toBe("ok");
    expect(github(first)).toMatchObject({
      operation: "create-pull-review",
      outcome: "created",
      review: { state: "CHANGES_REQUESTED" },
      target: { owner: "acme", repo: "app", number: 20, event: "REQUEST_CHANGES" },
    });
    const posted = server.reviews.get(20)!;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("<!-- graphloom-op: run-1/review-20 -->");
    expect(posted[0]!.comments).toEqual([{ path: "src/greet.ts", line: 12, side: "RIGHT", body: "Guard against an empty name here." }]);

    const again = await run(r, "create-pull-review", review);
    expect(github(again)).toMatchObject({ outcome: "reconciled" });
    expect(server.reviews.get(20)).toHaveLength(1);
  });

  it("confirms an interrupted review POST by its marker", async () => {
    const server = await fake({ pulls });
    server.dropAfterNextWrite();
    const result = await run(runner(server, { token: TOKEN }), "create-pull-review", review);
    expect(result.status, result.summary).toBe("ok");
    expect(github(result)).toMatchObject({ outcome: "reconciled" });
    expect(server.reviews.get(20)).toHaveLength(1);
  });

  it("reports GitHub's reason when it refuses the review", async () => {
    const server = await fake({ pulls });
    const result = await run(runner(server, { token: TOKEN }), "create-pull-review", {
      ...review,
      number: 21,
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/422: Unprocessable Entity \(Can not request changes on your own pull request\)/);
    expect(server.reviews.get(21)).toBeUndefined();
  });

  it("rejects reviews without a body or with malformed inline comments", async () => {
    const server = await fake({ pulls });
    const r = runner(server, { token: TOKEN });
    const noBody = await run(r, "create-pull-review", { ...review, body: " " });
    const badLine = await run(r, "create-pull-review", { ...review, comments: [{ path: "a.ts", line: 0, body: "x" }] });
    const badEvent = await run(r, "create-pull-review", { ...review, event: "DISMISS" });
    for (const result of [noBody, badLine, badEvent]) {
      expect(result.summary).toMatch(/input failed schema validation/);
    }
    expect(server.requests).toHaveLength(0);
  });
});

describe("graphloom.github labels and edits", () => {
  const seed = () => ({
    issues: [{ number: 5, title: "Crash on start", state: "open" as const, labels: ["bug"], body: "It crashes." }],
    pulls: [{ number: 30, title: "wip", state: "open" as const, head: "acme:fix", base: "main", body: "draft notes" }],
    labels: ["bug", "needs-fix", "p1"],
    milestones: [
      { number: 1, title: "v0.1", state: "open" as const },
      { number: 2, title: "v0.2", state: "closed" as const },
    ],
  });

  it("lists labels and milestones for the supervisor to choose from", async () => {
    const server = await fake(seed());
    const r = runner(server);
    const labels = await run(r, "list-labels", { owner: "acme", repo: "app" });
    expect((github(labels).items as { name: string }[]).map((l) => l.name)).toEqual(["bug", "needs-fix", "p1"]);
    const open = await run(r, "list-milestones", { owner: "acme", repo: "app" });
    expect(github(open).items).toEqual([expect.objectContaining({ number: 1, title: "v0.1", state: "open" })]);
    const all = await run(r, "list-milestones", { owner: "acme", repo: "app", state: "all" });
    expect(github(all).items).toHaveLength(2);
  });

  it("adds only missing labels to issues and pull requests, and treats present labels as done", async () => {
    const server = await fake(seed());
    const r = runner(server, { token: TOKEN });

    const issue = await run(r, "add-labels", { owner: "acme", repo: "app", number: 5, labels: ["bug", "p1"], idempotencyKey: "label-5" });
    expect(issue.status, issue.summary).toBe("ok");
    expect(github(issue)).toMatchObject({ outcome: "updated", added: ["p1"], labels: ["bug", "p1"] });
    expect(server.issues[0]!.labels).toEqual(["bug", "p1"]);

    const pull = await run(r, "add-labels", { owner: "acme", repo: "app", number: 30, labels: ["needs-fix"], idempotencyKey: "label-30" });
    expect(github(pull)).toMatchObject({ outcome: "updated", added: ["needs-fix"] });
    expect(server.pulls[0]!.labels).toEqual(["needs-fix"]);

    const posts = server.requests.filter((q) => q.method === "POST").length;
    const again = await run(r, "add-labels", { owner: "acme", repo: "app", number: 5, labels: ["p1"], idempotencyKey: "label-5" });
    expect(github(again)).toMatchObject({ outcome: "reconciled", added: [] });
    expect(server.requests.filter((q) => q.method === "POST")).toHaveLength(posts);
  });

  it("removes only labels that are present, from issues and pull requests", async () => {
    const server = await fake(seed());
    server.issues[0]!.labels = ["bug", "needs-fix", "p1"];
    server.pulls[0]!.labels = ["needs-fix"];
    const r = runner(server, { token: TOKEN });

    const issue = await run(r, "remove-labels", {
      owner: "acme",
      repo: "app",
      number: 5,
      labels: ["Needs-Fix", "p1", "wontfix"],
      idempotencyKey: "unlabel-5",
    });
    expect(issue.status, issue.summary).toBe("ok");
    expect(github(issue)).toMatchObject({
      operation: "remove-labels",
      outcome: "updated",
      removed: ["needs-fix", "p1"],
      labels: ["bug"],
    });
    expect(server.issues[0]!.labels).toEqual(["bug"]);

    const pull = await run(r, "remove-labels", { owner: "acme", repo: "app", number: 30, labels: ["needs-fix"], idempotencyKey: "unlabel-30" });
    expect(github(pull)).toMatchObject({ outcome: "updated", removed: ["needs-fix"], labels: [] });

    const deletes = server.requests.filter((q) => q.method === "DELETE").length;
    const again = await run(r, "remove-labels", { owner: "acme", repo: "app", number: 5, labels: ["p1"], idempotencyKey: "unlabel-5" });
    expect(github(again)).toMatchObject({ outcome: "reconciled", removed: [] });
    expect(server.requests.filter((q) => q.method === "DELETE")).toHaveLength(deletes);
  });

  it("finishes a label removal interrupted by an executor crash", async () => {
    const server = await fake(seed());
    server.issues[0]!.labels = ["bug", "needs-fix", "p1"];
    server.hangAfterNextWrite();
    const unlabel = { owner: "acme", repo: "app", number: 5, labels: ["needs-fix", "p1"], idempotencyKey: "unlabel-5" };
    const crashed = await run(runner(server, { token: TOKEN, abortAfterMs: 500 }), "remove-labels", unlabel);
    expect(crashed.summary).toMatch(/label removal outcome unknown/);
    expect(server.issues[0]!.labels).toEqual(["bug", "p1"]);

    const retried = await run(runner(server, { token: TOKEN }), "remove-labels", unlabel);
    expect(github(retried)).toMatchObject({ outcome: "updated", removed: ["p1"], labels: ["bug"] });
    expect(server.requests.filter((q) => q.method === "DELETE")).toHaveLength(2);
  });

  it("treats removing an absent milestone as done", async () => {
    const server = await fake(seed());
    const result = await run(runner(server, { token: TOKEN }), "update-issue", {
      owner: "acme",
      repo: "app",
      number: 5,
      milestone: null,
      idempotencyKey: "clear-5",
    });
    expect(github(result)).toMatchObject({ outcome: "reconciled", changed: [] });
    expect(server.requests.filter((q) => q.method === "PATCH")).toHaveLength(0);
  });

  it("refuses unknown labels unless creation is requested", async () => {
    const server = await fake(seed());
    const r = runner(server, { token: TOKEN });
    const typo = await run(r, "add-labels", { owner: "acme", repo: "app", number: 5, labels: ["bgu"], idempotencyKey: "l" });
    expect(typo.status).toBe("failed");
    expect(typo.summary).toBe('label "bgu" does not exist in acme/app; set createMissing to create it');
    expect(server.labels).not.toContain("bgu");

    const created = await run(r, "add-labels", {
      owner: "acme",
      repo: "app",
      number: 5,
      labels: ["triaged"],
      createMissing: true,
      idempotencyKey: "l",
    });
    expect(created.status, created.summary).toBe("ok");
    expect(github(created)).toMatchObject({ added: ["triaged"], createdLabels: ["triaged"] });
    expect(server.requests.filter((q) => q.method === "POST").map((q) => q.path)).toEqual([
      "/repos/acme/app/labels",
      "/repos/acme/app/issues/5/labels",
    ]);
    expect(server.issues[0]!.labels).toContain("triaged");
  });

  it("edits title, body, and milestone on issues and pull requests, recording prior values", async () => {
    const server = await fake(seed());
    const r = runner(server, { token: TOKEN });

    const issue = await run(r, "update-issue", {
      owner: "acme",
      repo: "app",
      number: 5,
      title: "Crash on start with empty config",
      body: "Steps: run with an empty config.",
      milestone: 1,
      idempotencyKey: "edit-5",
    });
    expect(issue.status, issue.summary).toBe("ok");
    expect(github(issue)).toMatchObject({
      outcome: "updated",
      changed: ["title", "body", "milestone"],
      previous: { title: "Crash on start", body: "It crashes.", milestone: null },
      item: { title: "Crash on start with empty config", milestone: { number: 1, title: "v0.1" } },
    });
    expect(server.issues[0]).toMatchObject({ title: "Crash on start with empty config", milestone: 1 });

    const pull = await run(r, "update-issue", {
      owner: "acme",
      repo: "app",
      number: 30,
      title: "Fix startup crash",
      body: "Fixes #5.",
      milestone: 1,
      idempotencyKey: "edit-30",
    });
    expect(github(pull)).toMatchObject({ outcome: "updated", changed: ["title", "body", "milestone"] });
    expect(server.pulls[0]).toMatchObject({ title: "Fix startup crash", body: "Fixes #5.", milestone: 1 });

    const cleared = await run(r, "update-issue", { owner: "acme", repo: "app", number: 30, milestone: null, idempotencyKey: "clear-30" });
    expect(github(cleared)).toMatchObject({ outcome: "updated", changed: ["milestone"], previous: { milestone: 1 } });
    expect(server.pulls[0]!.milestone).toBeNull();
  });

  it("treats an already-applied edit as done, even after the executor died mid-PATCH", async () => {
    const server = await fake(seed());
    server.hangAfterNextWrite();
    const edit = { owner: "acme", repo: "app", number: 5, title: "Renamed", idempotencyKey: "edit-5" };
    const crashed = await run(runner(server, { token: TOKEN, abortAfterMs: 500 }), "update-issue", edit);
    expect(crashed.summary).toMatch(/edit outcome unknown/);
    expect(server.issues[0]!.title).toBe("Renamed");

    const retried = await run(runner(server, { token: TOKEN }), "update-issue", edit);
    expect(github(retried)).toMatchObject({ outcome: "reconciled", changed: [] });
    expect(server.requests.filter((q) => q.method === "PATCH")).toHaveLength(1);
  });

  it("refuses to overwrite an edit made after the supervisor read the issue", async () => {
    const server = await fake(seed());
    const r = runner(server, { token: TOKEN });
    const read = await run(r, "get-issue", { owner: "acme", repo: "app", number: 5 });
    const seenAt = (github(read).item as { updatedAt: string }).updatedAt;
    server.issues[0]!.body = "Edited by a human.";
    server.issues[0]!.updatedAt = "2026-09-10T00:00:00Z";

    const result = await run(r, "update-issue", {
      owner: "acme",
      repo: "app",
      number: 5,
      body: "Supervisor rewrite.",
      expectedUpdatedAt: seenAt,
      idempotencyKey: "edit-5",
    });
    expect(result.status).toBe("conflict");
    expect(result.summary).toBe(
      `#5 changed at 2026-09-10T00:00:00Z after the expected ${seenAt}; re-read it before editing`,
    );
    expect(server.issues[0]!.body).toBe("Edited by a human.");
    expect(server.requests.filter((q) => q.method === "PATCH")).toHaveLength(0);
  });

  it("surfaces an unknown milestone as GitHub's validation failure", async () => {
    const server = await fake(seed());
    const result = await run(runner(server, { token: TOKEN }), "update-issue", {
      owner: "acme",
      repo: "app",
      number: 5,
      milestone: 99,
      idempotencyKey: "edit-5",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/422: Validation Failed \(milestone invalid\)/);
  });

  it("requires at least one field to change", async () => {
    const server = await fake(seed());
    const result = await run(runner(server, { token: TOKEN }), "update-issue", {
      owner: "acme",
      repo: "app",
      number: 5,
      idempotencyKey: "edit-5",
    });
    expect(result.summary).toMatch(/input failed schema validation/);
    expect(server.requests).toHaveLength(0);
  });
});
describe("read executors declare their input shape", () => {
  const reads = executors.filter((e) =>
    ["list-issues", "list-pulls", "get-issue", "get-pull", "list-issue-comments", "list-labels", "list-milestones"].includes(e.id.split("/")[1]!),
  ) as ExecutorDefinition[];

  it("declares a shape, with an example its predicate accepts, for every read", () => {
    expect(reads).toHaveLength(7);
    for (const def of reads) {
      expect(def.inputShape?.schema, def.id).toBeDefined();
      expect(def.inputSchema!(def.inputShape!.example), def.id).toBe(true);
      expect(def.inputProblem!(def.inputShape!.example), def.id).toBeUndefined();
    }
  });

  it("names the failing field of a refused input", () => {
    const get = reads.find((e) => e.id === "graphloom.github/get-issue")!;
    expect(get.inputProblem!({ owner: "o", repo: "r", number: "7" })).toBe("number: must be an integer");
    expect(get.inputProblem!({ owner: "o" })).toBe("repo: required");
    const list = reads.find((e) => e.id === "graphloom.github/list-issues")!;
    expect(list.inputProblem!({ owner: "o", repo: "r", state: "merged" })).toBe('state: must be one of "open", "closed", "all"');
    expect(list.inputProblem!({ owner: "o", repo: "r", labels: ["a", 1] })).toBe("labels[1]: must be a string");
  });
});
