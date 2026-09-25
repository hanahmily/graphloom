import { describe, expect, it } from "vitest";
import type { JobResult, Runner } from "@graphloom/runner";
import { githubEvidence as github, githubRunner as runner, runGitHub } from "./github-runner.js";

// Opt-in live checks against api.github.com. Reads need only
// GRAPHLOOM_GITHUB_LIVE_TOKEN; issue writes also need GRAPHLOOM_GITHUB_LIVE_ISSUE,
// and the review needs GRAPHLOOM_GITHUB_LIVE_PULL.
const token = process.env.GRAPHLOOM_GITHUB_LIVE_TOKEN;
const [owner, repo] = (process.env.GRAPHLOOM_GITHUB_LIVE_REPO ?? "hanahmily/graphloom").split("/") as [
  string,
  string,
];
const writeIssue = process.env.GRAPHLOOM_GITHUB_LIVE_ISSUE;

function run(r: Runner, id: string, input: unknown, runId = "live-run"): Promise<JobResult> {
  return runGitHub(r, id, input, { runId });
}

describe.skipIf(token === undefined)("graphloom.github live reads", () => {
  it("pages real issues with cursors, rate-limit headers, and no pull requests", async () => {
    const r = runner({ token: token! });
    const first = await run(r, "list-issues", { owner, repo, state: "all", perPage: 3, maxPages: 2 });
    expect(first.status, first.summary).toBe("ok");
    const g = github(first);
    const items = g.items as { number: number; url: string }[];
    const page = g.page as {
      nextCursor?: string;
      pagesFetched: number;
      complete: boolean;
      excludedPullRequests: number;
    };
    expect(page.pagesFetched).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => !i.url.includes("/pull/"))).toBe(true);
    expect(items.length + page.excludedPullRequests).toBe(page.pagesFetched * 3);
    expect((g.rateLimit as { limit?: number }).limit).toBeGreaterThan(60);

    if (page.nextCursor !== undefined) {
      expect(page.complete).toBe(false);
      const next = await run(r, "list-issues", {
        owner,
        repo,
        state: "all",
        perPage: 3,
        cursor: page.nextCursor,
      });
      expect(next.status, next.summary).toBe("ok");
      const nextItems = github(next).items as { number: number }[];
      const seen = new Set(items.map((i) => i.number));
      expect(nextItems.some((i) => seen.has(i.number))).toBe(false);
    }
  });

  it("fetches a single issue and pull request and lists pulls", async () => {
    const r = runner({ token: token! });
    const pulls = await run(r, "list-pulls", { owner, repo, state: "all", perPage: 5 });
    expect(pulls.status, pulls.summary).toBe("ok");
    const pullItems = github(pulls).items as { number: number }[];
    expect(pullItems.length).toBeGreaterThan(0);

    const pull = await run(r, "get-pull", { owner, repo, number: pullItems[0]!.number });
    expect(pull.status, pull.summary).toBe("ok");

    const issues = await run(r, "list-issues", { owner, repo, state: "all", perPage: 100, maxPages: 3 });
    expect(issues.status, issues.summary).toBe("ok");
    const issueItems = github(issues).items as { number: number }[];
    expect(issueItems.length).toBeGreaterThan(0);
    const issue = await run(r, "get-issue", { owner, repo, number: issueItems[0]!.number });
    expect(issue.status, issue.summary).toBe("ok");
    const comments = await run(r, "list-issue-comments", { owner, repo, number: issueItems[0]!.number });
    expect(comments.status, comments.summary).toBe("ok");
  });

  it("lists labels and milestones", async () => {
    const r = runner({ token: token! });
    const labels = await run(r, "list-labels", { owner, repo });
    expect(labels.status, labels.summary).toBe("ok");
    expect(Array.isArray(github(labels).items)).toBe(true);
    const milestones = await run(r, "list-milestones", { owner, repo, state: "all" });
    expect(milestones.status, milestones.summary).toBe("ok");
    expect(Array.isArray(github(milestones).items)).toBe(true);
  });

  it("refuses a label that does not exist without creating it", async () => {
    const result = await run(runner({ token: token!, allowWrites: true }), "add-labels", {
      owner,
      repo,
      number: 1,
      labels: ["graphloom-live-nonexistent-label"],
      idempotencyKey: "never-created",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/does not exist/);
  });

  it("fails a rejected token without echoing it", async () => {
    const bogus = "ghp_graphloomLiveBogusToken0000000000000";
    const result = await run(runner({ token: bogus }), "get-issue", { owner, repo, number: 1 });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(bogus);
  });

  it("never sends a write without the operator grant", async () => {
    const result = await run(runner({ token: token! }), "create-issue-comment", {
      owner,
      repo,
      issueNumber: 1,
      body: "must not be posted",
      idempotencyKey: "never-granted",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not granted");
  });
});

describe.skipIf(token === undefined || writeIssue === undefined)("graphloom.github live writes", () => {
  it("posts one marked comment and reconciles the retry to it", async () => {
    const r = runner({ token: token!, allowWrites: true });
    const runId = `live-${Date.now()}`;
    const input = {
      owner,
      repo,
      issueNumber: Number(writeIssue),
      body: `GraphLoom live executor check (${runId}); safe to delete.`,
      idempotencyKey: "live-comment",
    };
    const first = await run(r, "create-issue-comment", input, runId);
    expect(first.status, first.summary).toBe("ok");
    expect(github(first).outcome).toBe("created");
    const url = (github(first).comment as { url: string }).url;

    const retry = await run(r, "create-issue-comment", input, runId);
    expect(retry.status, retry.summary).toBe("ok");
    expect(github(retry).outcome).toBe("reconciled");
    expect((github(retry).comment as { url: string }).url).toBe(url);
  });

  it("labels the issue, and edits and restores its title", async () => {
    const r = runner({ token: token!, allowWrites: true });
    const labels = github(await run(r, "list-labels", { owner, repo })).items as { name: string }[];
    const label = process.env.GRAPHLOOM_GITHUB_LIVE_LABEL ?? labels[0]?.name;
    expect(label, "repository needs at least one label").toBeDefined();
    const number = Number(writeIssue);

    const labelled = await run(r, "add-labels", { owner, repo, number, labels: [label!], idempotencyKey: "live-label" });
    expect(labelled.status, labelled.summary).toBe("ok");
    const again = await run(r, "add-labels", { owner, repo, number, labels: [label!], idempotencyKey: "live-label" });
    expect(github(again).outcome).toBe("reconciled");
    if (github(labelled).outcome === "updated") {
      const unlabelled = await run(r, "remove-labels", { owner, repo, number, labels: [label!], idempotencyKey: "live-unlabel" });
      expect(unlabelled.status, unlabelled.summary).toBe("ok");
      expect(github(unlabelled)).toMatchObject({ outcome: "updated", removed: [label] });
      const gone = await run(r, "remove-labels", { owner, repo, number, labels: [label!], idempotencyKey: "live-unlabel" });
      expect(github(gone).outcome).toBe("reconciled");
    }

    const original = (github(await run(r, "get-issue", { owner, repo, number })).item as { title: string; updatedAt: string });
    const renamed = await run(r, "update-issue", {
      owner,
      repo,
      number,
      title: `${original.title} [graphloom live check]`,
      expectedUpdatedAt: original.updatedAt,
      idempotencyKey: "live-rename",
    });
    expect(renamed.status, renamed.summary).toBe("ok");
    expect(github(renamed)).toMatchObject({ outcome: "updated", changed: ["title"], previous: { title: original.title } });

    const restored = await run(r, "update-issue", { owner, repo, number, title: original.title, idempotencyKey: "live-restore" });
    expect(restored.status, restored.summary).toBe("ok");
    expect(github(restored)).toMatchObject({ outcome: "updated", changed: ["title"] });
  });
});

const writePull = process.env.GRAPHLOOM_GITHUB_LIVE_PULL;

describe.skipIf(token === undefined || writePull === undefined)("graphloom.github live reviews", () => {
  it("submits one marked review and reconciles the retry to it", async () => {
    const r = runner({ token: token!, allowWrites: true });
    const runId = `live-${Date.now()}`;
    const input = {
      owner,
      repo,
      number: Number(writePull),
      event: process.env.GRAPHLOOM_GITHUB_LIVE_REVIEW_EVENT ?? "COMMENT",
      body: `GraphLoom live review check (${runId}).`,
      idempotencyKey: "live-review",
    };
    const first = await run(r, "create-pull-review", input, runId);
    expect(first.status, first.summary).toBe("ok");
    expect(github(first).outcome).toBe("created");
    const retry = await run(r, "create-pull-review", input, runId);
    expect(github(retry).outcome).toBe("reconciled");
    expect((github(retry).review as { id: number }).id).toBe((github(first).review as { id: number }).id);
  });
});
