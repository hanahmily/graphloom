// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import { defineExecutor, jsonSchemaProblem, type ExecutorContext, type ExecutorInputShape } from "@graphloom/sdk";
import {
  DEFAULT_GITHUB_API_URL,
  GITHUB_API_URL_ENV,
  GitHubHttpError,
  GitHubRateLimitError,
  githubGraphql,
  githubRequest,
  isAmbiguous,
  type GitHubClientOptions,
  type RateLimitSnapshot,
} from "./client.js";
import { GITHUB_CREDENTIAL } from "./package.js";

export const GITHUB_EXECUTOR_VERSION = "1";

const MAX_PAGES_PER_CALL = 10;
/** Pages scanned for an idempotency marker before reconciliation gives up. */
const MAX_RECONCILE_PAGES = 10;
const MAX_BODY_CHARS = 4_000;
/** Largest file `get-file` returns whole: what the contents API itself serves inline. */
export const MAX_FILE_BYTES = 1_000_000;

const packageIdentity = readPackageIdentity();

type JobOutput = {
  status: "ok" | "failed" | "conflict";
  summary: string;
  evidence?: { kind: "other"; payload: { github: Record<string, unknown> } }[];
  /** Wait the host should honor before running this executor again. */
  retryAfterMs?: number;
};

interface RepoInput {
  owner: string;
  repo: string;
}

interface ListIssuesInput extends RepoInput {
  state?: "open" | "closed" | "all";
  labels?: string[];
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface ListPullsInput extends RepoInput {
  state?: "open" | "closed" | "all";
  base?: string;
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface NumberInput extends RepoInput {
  number: number;
}

interface GetFileInput extends RepoInput {
  /** Repository-relative path of a text file. */
  path: string;
  /** Branch, tag or commit; the repository's default branch when absent. */
  ref?: string;
}

interface ListCommentsInput extends NumberInput {
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface CreateCommentInput extends RepoInput {
  issueNumber: number;
  body: string;
  idempotencyKey: string;
}

interface CreatePullInput extends RepoInput {
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  idempotencyKey: string;
}

interface ListMilestonesInput extends RepoInput {
  state?: "open" | "closed" | "all";
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface ReviewComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  body: string;
}

interface CreateReviewInput extends NumberInput {
  event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE";
  body: string;
  comments?: ReviewComment[];
  commitId?: string;
  idempotencyKey: string;
}

interface AddLabelsInput extends NumberInput {
  labels: string[];
  createMissing?: boolean;
  idempotencyKey: string;
}

interface RemoveLabelsInput extends NumberInput {
  labels: string[];
  idempotencyKey: string;
}

interface UpdateIssueInput extends NumberInput {
  title?: string;
  body?: string;
  milestone?: number | null;
  /**
   * Refuse the edit if the issue changed since this time. GitHub's REST API has
   * no conditional update, so an edit landing between this check and the PATCH
   * can still be overwritten; `previous` in the evidence allows recovery.
   */
  expectedUpdatedAt?: string;
  idempotencyKey: string;
}

interface RawMilestone {
  number: number;
  title: string;
  state?: string;
  due_on?: string | null;
  open_issues?: number;
  closed_issues?: number;
  html_url?: string;
}

interface RawLabel {
  name: string;
  color?: string;
  description?: string | null;
}

interface RawReview {
  id: number;
  body?: string | null;
  state?: string;
  commit_id?: string;
  html_url?: string;
  user?: { login?: string } | null;
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  user?: { login?: string } | null;
  labels?: ({ name?: string } | string)[];
  milestone?: RawMilestone | null;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

interface RawPull extends RawIssue {
  draft?: boolean;
  merged_at?: string | null;
  head?: { ref?: string; sha?: string; label?: string };
  base?: { ref?: string; sha?: string; label?: string };
}

interface RawContent {
  type?: string;
  sha?: string;
  size?: number;
  encoding?: string;
  content?: string;
}

interface RawComment {
  id: number;
  html_url: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
}

// Declared input shapes of the read executors, shown to whoever composes a job.
const REPO_PROPERTIES = {
  owner: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}$" },
  repo: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}$" },
};
const PAGE_PROPERTIES = {
  perPage: { type: "integer", minimum: 1, maximum: 100 },
  maxPages: { type: "integer", minimum: 1, maximum: MAX_PAGES_PER_CALL },
  cursor: { type: "string", pattern: "^[1-9][0-9]{0,6}$", description: "The nextCursor of an earlier incomplete page." },
};
const STATE = { type: "string", enum: ["open", "closed", "all"] };
const NUMBER = { type: "integer", minimum: 1 };
const EXAMPLE_REPO = { owner: "apache", repo: "skywalking-banyandb" };

function readShape(required: string[], properties: Record<string, unknown>, example: Record<string, unknown>): {
  inputShape: ExecutorInputShape;
  inputProblem: (v: unknown) => string | undefined;
} {
  const schema = { type: "object", required: ["owner", "repo", ...required], properties: { ...REPO_PROPERTIES, ...properties } };
  return { inputShape: { schema, example: { ...EXAMPLE_REPO, ...example } }, inputProblem: (v) => jsonSchemaProblem(schema, v) };
}

// ---------------------------------------------------------------------------
// Reads

export const listIssues = defineExecutor<ListIssuesInput, JobOutput>({
  id: "graphloom.github/list-issues",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape([], { state: STATE, labels: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } }, ...PAGE_PROPERTIES }, { state: "open" }),
  inputSchema: (v): v is ListIssuesInput =>
    isRepoInput(v) &&
    optionalEnum(v, "state", ["open", "closed", "all"]) &&
    optionalStringArray(v, "labels") &&
    isPageInput(v),
  async execute(input, ctx) {
    const query = {
      owner: input.owner,
      repo: input.repo,
      state: input.state ?? "open",
      labels: input.labels ?? [],
      perPage: input.perPage ?? 30,
    };
    return runRead(ctx, "list-issues", query, async (client) => {
      const params = new URLSearchParams({ state: query.state, per_page: String(query.perPage) });
      if (query.labels.length > 0) params.set("labels", query.labels.join(","));
      const pages = await fetchPages<RawIssue>(
        client,
        `/repos/${repoPath(input)}/issues`,
        params,
        input,
      );
      // The issues endpoint also returns pull requests; they are not issues.
      const items = pages.items.filter((i) => i.pull_request === undefined).map(summarizeIssue);
      const excludedPullRequests = pages.items.length - items.length;
      return {
        summary: `listed ${items.length} issues from ${pages.page.pagesFetched} page(s); ${
          pages.page.complete ? "complete" : `more after cursor ${pages.page.nextCursor}`
        }`,
        github: { items, page: { ...pages.page, excludedPullRequests }, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const listPulls = defineExecutor<ListPullsInput, JobOutput>({
  id: "graphloom.github/list-pulls",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape([], { state: STATE, base: { type: "string", maxLength: 255 }, ...PAGE_PROPERTIES }, { state: "open" }),
  inputSchema: (v): v is ListPullsInput =>
    isRepoInput(v) &&
    optionalEnum(v, "state", ["open", "closed", "all"]) &&
    optionalRef(v, "base") &&
    isPageInput(v),
  async execute(input, ctx) {
    const query = {
      owner: input.owner,
      repo: input.repo,
      state: input.state ?? "open",
      perPage: input.perPage ?? 30,
      ...(input.base !== undefined ? { base: input.base } : {}),
    };
    return runRead(ctx, "list-pulls", query, async (client) => {
      const params = new URLSearchParams({ state: query.state, per_page: String(query.perPage) });
      if (input.base !== undefined) params.set("base", input.base);
      const pages = await fetchPages<RawPull>(client, `/repos/${repoPath(input)}/pulls`, params, input);
      const items = pages.items.map(summarizePull);
      return {
        summary: `listed ${items.length} pull requests from ${pages.page.pagesFetched} page(s); ${
          pages.page.complete ? "complete" : `more after cursor ${pages.page.nextCursor}`
        }`,
        github: { items, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const getIssue = defineExecutor<NumberInput, JobOutput>({
  id: "graphloom.github/get-issue",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape(["number"], { number: NUMBER }, { number: 1 }),
  inputSchema: (v): v is NumberInput => isRepoInput(v) && isPositiveInt(field(v, "number")),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number };
    return runRead(ctx, "get-issue", query, async (client) => {
      const res = await githubRequest<RawIssue>(
        client,
        "GET",
        `/repos/${repoPath(input)}/issues/${input.number}`,
      );
      return {
        summary: `fetched issue #${res.data.number}`,
        github: { item: { ...summarizeIssue(res.data), body: boundBody(res.data.body) }, rateLimit: res.rateLimit },
      };
    });
  },
});

export const getPull = defineExecutor<NumberInput, JobOutput>({
  id: "graphloom.github/get-pull",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape(["number"], { number: NUMBER }, { number: 1 }),
  inputSchema: (v): v is NumberInput => isRepoInput(v) && isPositiveInt(field(v, "number")),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number };
    return runRead(ctx, "get-pull", query, async (client) => {
      const res = await githubRequest<RawPull>(
        client,
        "GET",
        `/repos/${repoPath(input)}/pulls/${input.number}`,
      );
      return {
        summary: `fetched pull request #${res.data.number}`,
        github: { item: { ...summarizePull(res.data), body: boundBody(res.data.body) }, rateLimit: res.rateLimit },
      };
    });
  },
});

/**
 * The login the credential authenticates as (`GET /user`): what a graph compares a review's author to, to tell its own
 * post from one somebody else made. Takes the repository like every read, which it does not use.
 */
export const getViewer = defineExecutor<RepoInput, JobOutput>({
  id: "graphloom.github/get-viewer",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape([], {}, {}),
  inputSchema: (v): v is RepoInput => isRepoInput(v),
  async execute(input, ctx) {
    return runRead(ctx, "get-viewer", { owner: input.owner, repo: input.repo }, async (client) => {
      const res = await githubRequest<{ login?: string }>(client, "GET", "/user");
      return { summary: `authenticated as ${res.data.login ?? "unknown"}`, github: { item: { login: res.data.login ?? null }, rateLimit: res.rateLimit } };
    });
  },
});

/**
 * One text file at a ref, whole, with its blob sha. A path that is not a
 * readable text file is an answer, not a failed read: the item says
 * `found: false` and why, so the caller can name the problem.
 */
export const getFile = defineExecutor<GetFileInput, JobOutput>({
  id: "graphloom.github/get-file",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape(
    ["path"],
    {
      path: { type: "string", minLength: 1, maxLength: 1_000, description: "Repository-relative path of a text file." },
      ref: { type: "string", pattern: "^[A-Za-z0-9_.\\/:-]{1,255}$", description: "Branch, tag or commit; the default branch when absent." },
    },
    { path: "docs/design.md", ref: "main" },
  ),
  inputSchema: (v): v is GetFileInput => isRepoInput(v) && isFilePath(field(v, "path")) && optionalRef(v, "ref"),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, path: input.path, ref: input.ref ?? null };
    return runRead(ctx, "get-file", query, async (client) => {
      const target = `/repos/${repoPath(input)}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`;
      const answer = (reason: string, why: string, rateLimit: RateLimitSnapshot = {}) => ({
        summary: `${input.path} was not read: ${why}`,
        github: { item: { found: false, path: input.path, ref: input.ref ?? null, reason }, rateLimit },
      });
      let res: Awaited<ReturnType<typeof githubRequest<RawContent | RawContent[]>>>;
      try {
        res = await githubRequest<RawContent | RawContent[]>(client, "GET", input.ref !== undefined ? `${target}?ref=${encodeURIComponent(input.ref)}` : target);
      } catch (err) {
        if ((err as { status?: unknown }).status === 404) return answer("not-found", "no such file at that ref");
        throw err;
      }
      const data = res.data;
      if (Array.isArray(data) || data === undefined || data.type !== "file") return answer("not-a-file", "the path is not a regular file", res.rateLimit);
      const size = data.size ?? 0;
      if (size > MAX_FILE_BYTES || data.encoding !== "base64" || typeof data.content !== "string") {
        return answer("too-large", `${size} bytes, more than the ${MAX_FILE_BYTES} the contents API returns inline`, res.rateLimit);
      }
      const bytes = Buffer.from(data.content, "base64");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return answer("not-text", "the file is not UTF-8 text", res.rateLimit);
      }
      return {
        summary: `read ${input.path} (${bytes.length} bytes, blob ${(data.sha ?? "").slice(0, 12)})`,
        github: { item: { found: true, path: input.path, ref: input.ref ?? null, sha: data.sha ?? null, size: bytes.length, text }, rateLimit: res.rateLimit },
      };
    });
  },
});

export const listIssueComments = defineExecutor<ListCommentsInput, JobOutput>({
  id: "graphloom.github/list-issue-comments",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape(["number"], { number: NUMBER, ...PAGE_PROPERTIES }, { number: 1 }),
  inputSchema: (v): v is ListCommentsInput =>
    isRepoInput(v) && isPositiveInt(field(v, "number")) && isPageInput(v),
  async execute(input, ctx) {
    const query = {
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      perPage: input.perPage ?? 30,
    };
    return runRead(ctx, "list-issue-comments", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      const pages = await fetchPages<RawComment>(
        client,
        `/repos/${repoPath(input)}/issues/${input.number}/comments`,
        params,
        input,
      );
      const items = pages.items.map((c) => ({
        id: c.id,
        url: c.html_url,
        author: c.user?.login ?? null,
        createdAt: c.created_at ?? null,
        body: boundBody(c.body),
      }));
      return {
        summary: `listed ${items.length} comments on #${input.number}; ${
          pages.page.complete ? "complete" : `more after cursor ${pages.page.nextCursor}`
        }`,
        github: { items, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Writes: each carries an idempotency marker and reconciles against observed
// remote state before (and after an ambiguous) POST. Remote effects are never
// promised exactly-once; an unestablished outcome is reported, not retried.

export const createIssueComment = defineExecutor<CreateCommentInput, JobOutput>({
  id: "graphloom.github/create-issue-comment",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "write",
  capabilities: ["network:github", "github:write"],
  inputSchema: (v): v is CreateCommentInput =>
    isRepoInput(v) &&
    isPositiveInt(field(v, "issueNumber")) &&
    isNonEmptyString(field(v, "body")) &&
    isIdempotencyKey(field(v, "idempotencyKey")),
  async execute(input, ctx) {
    const client = await writeClient(ctx);
    if (typeof client === "string") return failed(client);
    const marker = operationMarker(ctx, input.idempotencyKey);
    const target = { owner: input.owner, repo: input.repo, issueNumber: input.issueNumber };
    const commentsPath = `/repos/${repoPath(input)}/issues/${input.issueNumber}/comments`;
    const find = () => findMarked<RawComment>(client, commentsPath, marker, (c) => c.body);

    return runWrite("create-issue-comment", target, input.idempotencyKey, async () => {
      const existing = await find();
      if (existing.kind === "found") {
        return reconciled(`comment already posted (${existing.item.html_url})`, {
          comment: { id: existing.item.id, url: existing.item.html_url },
        });
      }
      if (existing.kind === "unknown") return failed(existing.reason);
      try {
        const res = await githubRequest<RawComment>(client, "POST", commentsPath, {
          body: `${input.body}\n\n${marker}`,
        });
        return created(`commented on #${input.issueNumber} (${res.data.html_url})`, {
          comment: { id: res.data.id, url: res.data.html_url },
          rateLimit: res.rateLimit,
        });
      } catch (err) {
        if (!isAmbiguous(err)) throw err;
        const after = await find().catch(() => ({ kind: "unknown" as const, reason: "recheck failed" }));
        if (after.kind === "found") {
          return reconciled(`comment POST outcome confirmed by marker (${after.item.html_url})`, {
            comment: { id: after.item.id, url: after.item.html_url },
          });
        }
        return ambiguous(
          `comment outcome unknown: ${errorText(err)}; no marked comment is visible, retry reconciles by idempotency key before posting`,
        );
      }
    });
  },
});

export const createPull = defineExecutor<CreatePullInput, JobOutput>({
  id: "graphloom.github/create-pull",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "write",
  capabilities: ["network:github", "github:write"],
  inputSchema: (v): v is CreatePullInput =>
    isRepoInput(v) &&
    isRef(field(v, "head")) &&
    isRef(field(v, "base")) &&
    isNonEmptyString(field(v, "title")) &&
    optionalString(v, "body") &&
    optionalBoolean(v, "draft") &&
    isIdempotencyKey(field(v, "idempotencyKey")),
  async execute(input, ctx) {
    const client = await writeClient(ctx);
    if (typeof client === "string") return failed(client);
    const marker = operationMarker(ctx, input.idempotencyKey);
    const head = input.head.includes(":") ? input.head : `${input.owner}:${input.head}`;
    const target = { owner: input.owner, repo: input.repo, head, base: input.base };
    const pullsPath = `/repos/${repoPath(input)}/pulls`;

    const inspect = async (): Promise<JobOutput | undefined> => {
      let foreign: RawPull | undefined;
      let page: number | undefined = 1;
      for (let fetched = 0; page !== undefined; fetched += 1) {
        if (fetched >= MAX_RECONCILE_PAGES) {
          return failed(
            `cannot reconcile: more than ${MAX_RECONCILE_PAGES} pages of pull requests for ${head} -> ${input.base}`,
          );
        }
        const params = new URLSearchParams({
          state: "all",
          head,
          base: input.base,
          per_page: "100",
          page: String(page),
        });
        const res: Awaited<ReturnType<typeof githubRequest<RawPull[]>>> = await githubRequest<RawPull[]>(
          client,
          "GET",
          `${pullsPath}?${params.toString()}`,
        );
        const ours = res.data.find((p) => (p.body ?? "").includes(marker));
        if (ours) {
          return reconciled(`pull request already created (#${ours.number})`, {
            pull: summarizePull(ours),
          });
        }
        foreign ??= res.data.find((p) => p.state === "open");
        page = res.nextPage;
      }
      if (foreign) {
        return {
          status: "conflict",
          summary: `open pull request #${foreign.number} for ${head} -> ${input.base} lacks this operation's marker; not creating a duplicate`,
          evidence: [evidence("write", { outcome: "conflict", pull: summarizePull(foreign) })],
        };
      }
      return undefined;
    };

    return runWrite("create-pull", target, input.idempotencyKey, async () => {
      const before = await inspect();
      if (before) return before;
      try {
        const res = await githubRequest<RawPull>(client, "POST", pullsPath, {
          title: input.title,
          head,
          base: input.base,
          body: `${input.body ?? ""}\n\n${marker}`.trimStart(),
          ...(input.draft !== undefined ? { draft: input.draft } : {}),
        });
        return created(`created pull request #${res.data.number}`, {
          pull: summarizePull(res.data),
          rateLimit: res.rateLimit,
        });
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (!isAmbiguous(err) && status !== 422) throw err;
        // A 422 can mean a concurrent create won the race; otherwise it is a definite rejection.
        const after = await inspect().catch(() => undefined);
        if (after && after.status !== "failed") return after;
        if (status === 422) throw err;
        return ambiguous(
          `pull request outcome unknown: ${errorText(err)}; none is visible for ${head} -> ${input.base}, retry reconciles before creating`,
        );
      }
    });
  },
});

export const createPullReview = defineExecutor<CreateReviewInput, JobOutput>({
  id: "graphloom.github/create-pull-review",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "write",
  capabilities: ["network:github", "github:write"],
  inputSchema: (v): v is CreateReviewInput =>
    isRepoInput(v) &&
    isPositiveInt(field(v, "number")) &&
    ["REQUEST_CHANGES", "COMMENT", "APPROVE"].includes(field(v, "event") as string) &&
    isNonEmptyString(field(v, "body")) &&
    isReviewComments(field(v, "comments")) &&
    (field(v, "commitId") === undefined || isSha(field(v, "commitId"))) &&
    isIdempotencyKey(field(v, "idempotencyKey")),
  async execute(input, ctx) {
    const client = await writeClient(ctx);
    if (typeof client === "string") return failed(client);
    const marker = operationMarker(ctx, input.idempotencyKey);
    const target = { owner: input.owner, repo: input.repo, number: input.number, event: input.event };
    const reviewsPath = `/repos/${repoPath(input)}/pulls/${input.number}/reviews`;
    const find = () => findMarked<RawReview>(client, reviewsPath, marker, (r) => r.body);

    return runWrite("create-pull-review", target, input.idempotencyKey, async () => {
      const existing = await find();
      if (existing.kind === "found") {
        return reconciled(`review already submitted (${existing.item.html_url})`, {
          review: summarizeReview(existing.item),
        });
      }
      if (existing.kind === "unknown") return failed(existing.reason);
      try {
        const res = await githubRequest<RawReview>(client, "POST", reviewsPath, {
          event: input.event,
          body: `${input.body}\n\n${marker}`,
          ...(input.commitId !== undefined ? { commit_id: input.commitId } : {}),
          ...(input.comments !== undefined && input.comments.length > 0
            ? { comments: input.comments.map(toApiReviewComment) }
            : {}),
        });
        return created(`submitted ${res.data.state ?? input.event} review on #${input.number} (${res.data.html_url})`, {
          review: summarizeReview(res.data),
          rateLimit: res.rateLimit,
        });
      } catch (err) {
        if (!isAmbiguous(err)) throw err;
        const after = await find().catch(() => ({ kind: "unknown" as const, reason: "recheck failed" }));
        if (after.kind === "found") {
          return reconciled(`review POST outcome confirmed by marker (${after.item.html_url})`, {
            review: summarizeReview(after.item),
          });
        }
        return ambiguous(
          `review outcome unknown: ${errorText(err)}; no marked review is visible, retry reconciles by idempotency key before posting`,
        );
      }
    });
  },
});

// Label and field edits converge on a desired state, so observed remote state
// (not a marker) decides whether a retry still has anything to do.

export const addLabels = defineExecutor<AddLabelsInput, JobOutput>({
  id: "graphloom.github/add-labels",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "write",
  capabilities: ["network:github", "github:write"],
  inputSchema: (v): v is AddLabelsInput =>
    isRepoInput(v) &&
    isPositiveInt(field(v, "number")) &&
    isLabelList(field(v, "labels")) &&
    optionalBoolean(v, "createMissing") &&
    isIdempotencyKey(field(v, "idempotencyKey")),
  async execute(input, ctx) {
    const client = await writeClient(ctx);
    if (typeof client === "string") return failed(client);
    const target = { owner: input.owner, repo: input.repo, number: input.number, labels: input.labels };
    const issuePath = `/repos/${repoPath(input)}/issues/${input.number}`;
    const missingFrom = (current: string[]) => {
      const have = new Set(current.map((l) => l.toLowerCase()));
      return input.labels.filter((l) => !have.has(l.toLowerCase()));
    };

    return runWrite("add-labels", target, input.idempotencyKey, async () => {
      const before = await githubRequest<RawIssue>(client, "GET", issuePath);
      const missing = missingFrom(labelNames(before.data));
      if (missing.length === 0) {
        return reconciled(`#${input.number} already has ${input.labels.join(", ")}`, {
          added: [],
          labels: labelNames(before.data),
        });
      }
      const createdLabels: string[] = [];
      for (const name of missing) {
        if (await labelExists(client, input, name)) continue;
        if (input.createMissing !== true) {
          return failed(
            `label "${name}" does not exist in ${input.owner}/${input.repo}; set createMissing to create it`,
          );
        }
        if (await createLabel(client, input, name)) createdLabels.push(name);
      }
      try {
        const res = await githubRequest<RawLabel[]>(client, "POST", `${issuePath}/labels`, { labels: missing });
        return updated(`added ${missing.join(", ")} to #${input.number}`, {
          added: missing,
          ...(createdLabels.length > 0 ? { createdLabels } : {}),
          labels: res.data.map((l) => l.name),
          rateLimit: res.rateLimit,
        });
      } catch (err) {
        if (!isAmbiguous(err)) throw err;
        const after = await githubRequest<RawIssue>(client, "GET", issuePath).catch(() => undefined);
        if (after && missingFrom(labelNames(after.data)).length === 0) {
          return updated(`label POST outcome confirmed by re-read of #${input.number}`, {
            added: missing,
            labels: labelNames(after.data),
          });
        }
        return ambiguous(`label outcome unknown: ${errorText(err)}; retry re-reads #${input.number} before adding`);
      }
    });
  },
});

export const removeLabels = defineExecutor<RemoveLabelsInput, JobOutput>({
  id: "graphloom.github/remove-labels",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "write",
  capabilities: ["network:github", "github:write"],
  inputSchema: (v): v is RemoveLabelsInput =>
    isRepoInput(v) &&
    isPositiveInt(field(v, "number")) &&
    isLabelList(field(v, "labels")) &&
    isIdempotencyKey(field(v, "idempotencyKey")),
  async execute(input, ctx) {
    const client = await writeClient(ctx);
    if (typeof client === "string") return failed(client);
    const target = { owner: input.owner, repo: input.repo, number: input.number, labels: input.labels };
    const issuePath = `/repos/${repoPath(input)}/issues/${input.number}`;
    const presentIn = (current: string[]) => {
      const wanted = new Set(input.labels.map((l) => l.toLowerCase()));
      return current.filter((l) => wanted.has(l.toLowerCase()));
    };

    return runWrite("remove-labels", target, input.idempotencyKey, async () => {
      const before = await githubRequest<RawIssue>(client, "GET", issuePath);
      const toRemove = presentIn(labelNames(before.data));
      if (toRemove.length === 0) {
        return reconciled(`#${input.number} has none of ${input.labels.join(", ")}`, {
          removed: [],
          labels: labelNames(before.data),
        });
      }
      const removed: string[] = [];
      let labels = labelNames(before.data);
      for (const name of toRemove) {
        try {
          const res = await githubRequest<RawLabel[]>(
            client,
            "DELETE",
            `${issuePath}/labels/${encodeURIComponent(name)}`,
          );
          labels = res.data.map((l) => l.name);
          removed.push(name);
        } catch (err) {
          // Someone else removed it between the read and the delete.
          if ((err as { status?: unknown }).status === 404) {
            labels = labels.filter((l) => l !== name);
            continue;
          }
          if (isAmbiguous(err)) {
            const after = await githubRequest<RawIssue>(client, "GET", issuePath).catch(() => undefined);
            if (after && presentIn(labelNames(after.data)).length === 0) {
              return updated(`label removal confirmed by re-read of #${input.number}`, {
                removed: toRemove,
                labels: labelNames(after.data),
              });
            }
            return ambiguous(
              `label removal outcome unknown: ${errorText(err)}; retry re-reads #${input.number} before removing`,
            );
          }
          if (removed.length === 0) throw err;
          return failed(
            `${errorText(err)}; already removed ${removed.join(", ")} from #${input.number}, retry re-reads before removing the rest`,
          );
        }
      }
      return updated(`removed ${toRemove.join(", ")} from #${input.number}`, { removed: toRemove, labels });
    });
  },
});

export const updateIssue = defineExecutor<UpdateIssueInput, JobOutput>({
  id: "graphloom.github/update-issue",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "write",
  capabilities: ["network:github", "github:write"],
  inputSchema: (v): v is UpdateIssueInput =>
    isRepoInput(v) &&
    isPositiveInt(field(v, "number")) &&
    (field(v, "title") === undefined || isTitle(field(v, "title"))) &&
    optionalString(v, "body") &&
    (field(v, "milestone") === undefined || field(v, "milestone") === null || isPositiveInt(field(v, "milestone"))) &&
    (field(v, "title") !== undefined || field(v, "body") !== undefined || field(v, "milestone") !== undefined) &&
    (field(v, "expectedUpdatedAt") === undefined || isTimestamp(field(v, "expectedUpdatedAt"))) &&
    isIdempotencyKey(field(v, "idempotencyKey")),
  async execute(input, ctx) {
    const client = await writeClient(ctx);
    if (typeof client === "string") return failed(client);
    const target = { owner: input.owner, repo: input.repo, number: input.number };
    const issuePath = `/repos/${repoPath(input)}/issues/${input.number}`;
    const pending = (current: RawIssue) => {
      const fields: ("title" | "body" | "milestone")[] = [];
      if (input.title !== undefined && current.title !== input.title) fields.push("title");
      if (input.body !== undefined && normalizeBody(current.body) !== normalizeBody(input.body)) fields.push("body");
      if (input.milestone !== undefined && (current.milestone?.number ?? null) !== input.milestone) {
        fields.push("milestone");
      }
      return fields;
    };

    return runWrite("update-issue", target, input.idempotencyKey, async () => {
      const before = await githubRequest<RawIssue>(client, "GET", issuePath);
      const changed = pending(before.data);
      if (changed.length === 0) {
        return reconciled(`#${input.number} already matches the requested edit`, {
          changed: [],
          item: summarizeIssue(before.data),
        });
      }
      if (
        input.expectedUpdatedAt !== undefined &&
        Date.parse(before.data.updated_at ?? "") !== Date.parse(input.expectedUpdatedAt)
      ) {
        return {
          status: "conflict",
          summary: `#${input.number} changed at ${before.data.updated_at} after the expected ${input.expectedUpdatedAt}; re-read it before editing`,
          evidence: [evidence("write", { outcome: "conflict", item: summarizeIssue(before.data) })],
        };
      }
      const previous: Record<string, unknown> = {};
      const patch: Record<string, unknown> = {};
      for (const f of changed) {
        if (f === "title") previous.title = before.data.title;
        if (f === "body") previous.body = boundBody(before.data.body);
        if (f === "milestone") previous.milestone = before.data.milestone?.number ?? null;
        patch[f] = input[f];
      }
      try {
        const res = await githubRequest<RawIssue>(client, "PATCH", issuePath, patch);
        return updated(`updated ${changed.join(", ")} of #${input.number}`, {
          changed,
          previous,
          item: summarizeIssue(res.data),
          rateLimit: res.rateLimit,
        });
      } catch (err) {
        if (!isAmbiguous(err)) throw err;
        const after = await githubRequest<RawIssue>(client, "GET", issuePath).catch(() => undefined);
        if (after && pending(after.data).length === 0) {
          return updated(`edit outcome confirmed by re-read of #${input.number}`, {
            changed,
            previous,
            item: summarizeIssue(after.data),
          });
        }
        return ambiguous(`edit outcome unknown: ${errorText(err)}; retry re-reads #${input.number} before editing`);
      }
    });
  },
});

export const listLabels = defineExecutor<RepoInput & PageInput, JobOutput>({
  id: "graphloom.github/list-labels",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape([], { ...PAGE_PROPERTIES }, {}),
  inputSchema: (v): v is RepoInput & PageInput => isRepoInput(v) && isPageInput(v),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, perPage: input.perPage ?? 100 };
    return runRead(ctx, "list-labels", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      const pages = await fetchPages<RawLabel>(client, `/repos/${repoPath(input)}/labels`, params, {
        ...input,
        perPage: query.perPage,
      });
      const items = pages.items.map((l) => ({ name: l.name, color: l.color ?? null, description: l.description ?? null }));
      return {
        summary: `listed ${items.length} labels; ${
          pages.page.complete ? "complete" : `more after cursor ${pages.page.nextCursor}`
        }`,
        github: { items, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const listMilestones = defineExecutor<ListMilestonesInput, JobOutput>({
  id: "graphloom.github/list-milestones",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape([], { state: STATE, ...PAGE_PROPERTIES }, { state: "open" }),
  inputSchema: (v): v is ListMilestonesInput =>
    isRepoInput(v) && optionalEnum(v, "state", ["open", "closed", "all"]) && isPageInput(v),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, state: input.state ?? "open", perPage: input.perPage ?? 30 };
    return runRead(ctx, "list-milestones", query, async (client) => {
      const params = new URLSearchParams({ state: query.state, per_page: String(query.perPage) });
      const pages = await fetchPages<RawMilestone>(client, `/repos/${repoPath(input)}/milestones`, params, input);
      const items = pages.items.map((m) => ({
        number: m.number,
        title: m.title,
        state: m.state ?? null,
        dueOn: m.due_on ?? null,
        openIssues: m.open_issues ?? 0,
        closedIssues: m.closed_issues ?? 0,
        url: m.html_url ?? null,
      }));
      return {
        summary: `listed ${items.length} ${query.state} milestones; ${
          pages.page.complete ? "complete" : `more after cursor ${pages.page.nextCursor}`
        }`,
        github: { items, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Pull request snapshot reads (docs/design-pr-review-graph.md, `pr-snapshot`).
// Same pagination and `complete` contract as the list reads above. GitHub caps
// some of these lists whatever the page size; when a list reaches its cap the
// result says so (`limitReached`) and is never `complete`.

/** GitHub serves at most this many files of a pull request, however many pages are asked for. */
const PULL_FILES_LIMIT = 3_000;
/** GitHub serves at most this many commits of a pull request. */
const PULL_COMMITS_LIMIT = 250;
const SNAPSHOT_PER_PAGE = 100;

interface PullPageInput extends NumberInput {
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface CheckRunsInput extends RepoInput {
  sha: string;
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface ThreadsInput extends NumberInput {
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

interface RawPullFile {
  filename: string;
  status?: string;
  previous_filename?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  sha?: string;
  patch?: string;
}

interface RawCommit {
  sha: string;
  html_url?: string;
  parents?: { sha: string }[];
  author?: { login?: string } | null;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
}

interface RawReviewFull extends RawReview {
  submitted_at?: string | null;
}

interface RawReviewComment {
  id: number;
  pull_request_review_id?: number | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  side?: string | null;
  start_side?: string | null;
  commit_id?: string;
  original_commit_id?: string;
  in_reply_to_id?: number | null;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  user?: { login?: string } | null;
}

interface RawCheckRun {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { slug?: string } | null;
}

const SNAPSHOT_EXAMPLE = { number: 1, perPage: SNAPSHOT_PER_PAGE, maxPages: MAX_PAGES_PER_CALL };
const pullSnapshotShape = () => readShape(["number"], { number: NUMBER, ...PAGE_PROPERTIES }, SNAPSHOT_EXAMPLE);
const isPullPageInput = (v: unknown): v is PullPageInput => isRepoInput(v) && isPositiveInt(field(v, "number")) && isPageInput(v);

/** Bound a free-text field and say so when it was cut, so a caller never mistakes a prefix for the whole. */
function boundText(text: string | null | undefined): { text: string | null; truncated: boolean } {
  const bounded = boundBody(text);
  return { text: bounded, truncated: text !== null && text !== undefined && bounded !== text };
}

/** Apply a service-side cap to a finished page: a list that reached it cannot be called complete. */
function capped<P extends { startCursor: string; perPage: number; complete: boolean }>(
  page: P,
  count: number,
  limit: number,
): P & { limitReached: boolean } {
  const total = (Number.parseInt(page.startCursor, 10) - 1) * page.perPage + count;
  const limitReached = page.complete && total >= limit;
  return { ...page, complete: page.complete && !limitReached, limitReached };
}

function describeComplete(page: { complete: boolean; nextCursor: string | null; limitReached?: boolean }): string {
  if (page.limitReached === true) return "incomplete: GitHub's list cap was reached";
  return page.complete ? "complete" : `more after cursor ${page.nextCursor}`;
}

export const listPullFiles = defineExecutor<PullPageInput, JobOutput>({
  id: "graphloom.github/list-pull-files",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...pullSnapshotShape(),
  inputSchema: isPullPageInput,
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number, perPage: input.perPage ?? SNAPSHOT_PER_PAGE };
    return runRead(ctx, "list-pull-files", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      const pages = await fetchPages<RawPullFile>(client, `/repos/${repoPath(input)}/pulls/${input.number}/files`, params, { ...input, perPage: query.perPage });
      const items = pages.items.map((f) => ({
        path: f.filename,
        status: f.status ?? null,
        previousPath: f.previous_filename ?? null,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        sha: f.sha ?? null,
        patch: f.patch ?? null,
        // GitHub drops the patch of a diff it will not render; a binary file or a pure rename has no changed lines to show.
        patchOmitted: f.patch === undefined && (f.additions ?? 0) + (f.deletions ?? 0) > 0,
      }));
      const page = capped(pages.page, items.length, PULL_FILES_LIMIT);
      return {
        summary: `listed ${items.length} files of #${input.number}; ${describeComplete(page)}`,
        github: { items, page, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const listPullCommits = defineExecutor<PullPageInput, JobOutput>({
  id: "graphloom.github/list-pull-commits",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...pullSnapshotShape(),
  inputSchema: isPullPageInput,
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number, perPage: input.perPage ?? SNAPSHOT_PER_PAGE };
    return runRead(ctx, "list-pull-commits", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      const pages = await fetchPages<RawCommit>(client, `/repos/${repoPath(input)}/pulls/${input.number}/commits`, params, { ...input, perPage: query.perPage });
      const items = pages.items.map((c) => {
        const message = boundText(c.commit?.message);
        return {
          sha: c.sha,
          parents: (c.parents ?? []).map((p) => p.sha),
          message: message.text,
          messageTruncated: message.truncated,
          author: c.author?.login ?? null,
          authorName: c.commit?.author?.name ?? null,
          authoredDate: c.commit?.author?.date ?? null,
          committedDate: c.commit?.committer?.date ?? null,
          url: c.html_url ?? null,
        };
      });
      const page = capped(pages.page, items.length, PULL_COMMITS_LIMIT);
      return {
        summary: `listed ${items.length} commits of #${input.number}; ${describeComplete(page)}`,
        github: { items, page, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const listPullReviews = defineExecutor<PullPageInput, JobOutput>({
  id: "graphloom.github/list-pull-reviews",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...pullSnapshotShape(),
  inputSchema: isPullPageInput,
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number, perPage: input.perPage ?? SNAPSHOT_PER_PAGE };
    return runRead(ctx, "list-pull-reviews", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      const pages = await fetchPages<RawReviewFull>(client, `/repos/${repoPath(input)}/pulls/${input.number}/reviews`, params, { ...input, perPage: query.perPage });
      const items = pages.items.map((r) => {
        const body = boundText(r.body);
        return {
          id: r.id,
          user: r.user?.login ?? null,
          state: r.state ?? null,
          body: body.text,
          bodyTruncated: body.truncated,
          commitId: r.commit_id ?? null,
          submittedAt: r.submitted_at ?? null,
          url: r.html_url ?? null,
        };
      });
      return {
        summary: `listed ${items.length} reviews of #${input.number}; ${describeComplete(pages.page)}`,
        github: { items, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const listPullReviewComments = defineExecutor<PullPageInput, JobOutput>({
  id: "graphloom.github/list-pull-review-comments",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...pullSnapshotShape(),
  inputSchema: isPullPageInput,
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number, perPage: input.perPage ?? SNAPSHOT_PER_PAGE };
    return runRead(ctx, "list-pull-review-comments", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      const pages = await fetchPages<RawReviewComment>(client, `/repos/${repoPath(input)}/pulls/${input.number}/comments`, params, { ...input, perPage: query.perPage });
      const items = pages.items.map((c) => {
        const body = boundText(c.body);
        return {
          id: c.id,
          reviewId: c.pull_request_review_id ?? null,
          path: c.path ?? null,
          // `line` is null once the commented line is gone from the head; `originalLine` stays.
          line: c.line ?? null,
          originalLine: c.original_line ?? null,
          side: c.side ?? null,
          startLine: c.start_line ?? null,
          originalStartLine: c.original_start_line ?? null,
          commitId: c.commit_id ?? null,
          originalCommitId: c.original_commit_id ?? null,
          inReplyTo: c.in_reply_to_id ?? null,
          body: body.text,
          bodyTruncated: body.truncated,
          user: c.user?.login ?? null,
          createdAt: c.created_at ?? null,
          url: c.html_url ?? null,
        };
      });
      return {
        summary: `listed ${items.length} review comments of #${input.number}; ${describeComplete(pages.page)}`,
        github: { items, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

export const listCheckRuns = defineExecutor<CheckRunsInput, JobOutput>({
  id: "graphloom.github/list-check-runs",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape(
    ["sha"],
    { sha: { type: "string", pattern: "^[0-9a-f]{7,64}$", description: "The commit whose check runs are listed." }, ...PAGE_PROPERTIES },
    { sha: "0123456789abcdef0123456789abcdef01234567", perPage: SNAPSHOT_PER_PAGE, maxPages: MAX_PAGES_PER_CALL },
  ),
  inputSchema: (v): v is CheckRunsInput => isRepoInput(v) && isSha(field(v, "sha")) && isPageInput(v),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, sha: input.sha, perPage: input.perPage ?? SNAPSHOT_PER_PAGE };
    return runRead(ctx, "list-check-runs", query, async (client) => {
      const params = new URLSearchParams({ per_page: String(query.perPage) });
      let totalCount: number | null = null;
      const pages = await fetchPages<RawCheckRun, { total_count?: number; check_runs?: RawCheckRun[] }>(
        client,
        `/repos/${repoPath(input)}/commits/${input.sha}/check-runs`,
        params,
        { ...input, perPage: query.perPage },
        (data) => {
          totalCount = data.total_count ?? totalCount;
          return data.check_runs ?? [];
        },
      );
      const items = pages.items.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status ?? null,
        conclusion: c.conclusion ?? null,
        detailsUrl: c.details_url ?? null,
        url: c.html_url ?? null,
        startedAt: c.started_at ?? null,
        completedAt: c.completed_at ?? null,
        app: c.app?.slug ?? null,
      }));
      return {
        summary: `listed ${items.length} check runs of ${input.sha.slice(0, 12)}; ${describeComplete(pages.page)}`,
        github: { items, totalCount, page: pages.page, rateLimit: pages.rateLimit },
      };
    });
  },
});

// Review threads exist only in GraphQL (resolution and outdated state are not in REST).
// Their cursors are GraphQL's opaque ones, unlike the page numbers of the REST lists.

const THREAD_CURSOR_PATTERN = "^[A-Za-z0-9+/=_:-]{1,200}$";
const THREAD_COMMENT_FIELDS = "id databaseId author { login } body createdAt path outdated replyTo { databaseId } commit { oid } originalCommit { oid }";
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine diffSide
          resolvedBy { login }
          comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;
const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT_FIELDS} } }
    }
  }
}`;

interface RawThreadComment {
  id: string;
  databaseId?: number | null;
  author?: { login?: string } | null;
  body?: string | null;
  createdAt?: string;
  path?: string;
  outdated?: boolean;
  replyTo?: { databaseId?: number | null } | null;
  commit?: { oid?: string } | null;
  originalCommit?: { oid?: string } | null;
}

interface RawThreadComments {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (RawThreadComment | null)[];
}

interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  diffSide?: string | null;
  resolvedBy?: { login?: string } | null;
  comments: RawThreadComments;
}

interface RawThreadsPage {
  repository: {
    pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawThread | null)[] } } | null;
  } | null;
}

function summarizeThreadComment(c: RawThreadComment) {
  const body = boundText(c.body);
  return {
    id: c.databaseId ?? null,
    nodeId: c.id,
    author: c.author?.login ?? null,
    body: body.text,
    bodyTruncated: body.truncated,
    path: c.path ?? null,
    outdated: c.outdated ?? false,
    inReplyTo: c.replyTo?.databaseId ?? null,
    commitId: c.commit?.oid ?? null,
    originalCommitId: c.originalCommit?.oid ?? null,
    createdAt: c.createdAt ?? null,
  };
}

function threadItem(thread: RawThread, comments: RawThreadComment[], commentsComplete: boolean) {
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    resolvedBy: thread.resolvedBy?.login ?? null,
    path: thread.path ?? null,
    line: thread.line ?? null,
    originalLine: thread.originalLine ?? null,
    startLine: thread.startLine ?? null,
    side: thread.diffSide ?? null,
    commentsComplete,
    comments: comments.map(summarizeThreadComment),
  };
}

export const listReviewThreads = defineExecutor<ThreadsInput, JobOutput>({
  id: "graphloom.github/list-review-threads",
  version: GITHUB_EXECUTOR_VERSION,
  effect: "read",
  capabilities: ["network:github"],
  ...readShape(
    ["number"],
    {
      number: NUMBER,
      perPage: PAGE_PROPERTIES.perPage,
      maxPages: PAGE_PROPERTIES.maxPages,
      cursor: { type: "string", pattern: THREAD_CURSOR_PATTERN, description: "The nextCursor of an earlier incomplete page." },
    },
    { number: 1, perPage: 50, maxPages: MAX_PAGES_PER_CALL },
  ),
  inputSchema: (v): v is ThreadsInput =>
    isRepoInput(v) &&
    isPositiveInt(field(v, "number")) &&
    isPageInput({ perPage: field(v, "perPage"), maxPages: field(v, "maxPages") }) &&
    (field(v, "cursor") === undefined || (typeof field(v, "cursor") === "string" && new RegExp(THREAD_CURSOR_PATTERN).test(field(v, "cursor") as string))),
  async execute(input, ctx) {
    const query = { owner: input.owner, repo: input.repo, number: input.number, perPage: input.perPage ?? 50 };
    return runRead(ctx, "list-review-threads", query, async (client) => {
      const maxPages = input.maxPages ?? 1;
      const items: ReturnType<typeof threadItem>[] = [];
      const incompleteThreads: string[] = [];
      let cursor: string | null = input.cursor ?? null;
      let pagesFetched = 0;
      let rateLimit: RateLimitSnapshot = {};
      let more = true;
      while (more && pagesFetched < maxPages) {
        const res = await githubGraphql<RawThreadsPage>(client, THREADS_QUERY, {
          owner: input.owner,
          name: input.repo,
          number: input.number,
          first: query.perPage,
          after: cursor,
        });
        rateLimit = res.rateLimit;
        const threads = res.data.repository?.pullRequest?.reviewThreads;
        if (threads === undefined) {
          throw new GitHubHttpError(`GitHub GraphQL returned 404: no pull request #${input.number} in ${input.owner}/${input.repo}`, 404);
        }
        for (const thread of threads.nodes) {
          if (thread === null) continue;
          const comments = thread.comments.nodes.filter((c): c is RawThreadComment => c !== null);
          let info = thread.comments.pageInfo;
          for (let extra = 0; info.hasNextPage && extra < MAX_PAGES_PER_CALL; extra += 1) {
            const next = await githubGraphql<{ node: { comments?: RawThreadComments } | null }>(client, THREAD_COMMENTS_QUERY, {
              id: thread.id,
              after: info.endCursor,
            });
            rateLimit = next.rateLimit;
            if (next.data.node?.comments === undefined) break;
            comments.push(...next.data.node.comments.nodes.filter((c): c is RawThreadComment => c !== null));
            info = next.data.node.comments.pageInfo;
          }
          if (info.hasNextPage) incompleteThreads.push(thread.id);
          items.push(threadItem(thread, comments, !info.hasNextPage));
        }
        pagesFetched += 1;
        more = threads.pageInfo.hasNextPage;
        cursor = threads.pageInfo.endCursor;
      }
      const page = {
        startCursor: input.cursor ?? "start",
        nextCursor: more ? cursor : null,
        pagesFetched,
        perPage: query.perPage,
        // Threads left to read, or a thread whose comments could not all be read, make this incomplete.
        complete: !more && incompleteThreads.length === 0,
        incompleteThreads,
      };
      return {
        summary: `listed ${items.length} review threads of #${input.number}; ${
          page.complete ? "complete" : more ? `more after cursor ${page.nextCursor}` : `incomplete: ${incompleteThreads.length} thread(s) with unread comments`
        }`,
        github: { items, page, rateLimit },
      };
    });
  },
});

export const executors = [
  listIssues,
  listPulls,
  getIssue,
  getPull,
  getViewer,
  getFile,
  listIssueComments,
  listLabels,
  listMilestones,
  listPullFiles,
  listPullCommits,
  listPullReviews,
  listPullReviewComments,
  listReviewThreads,
  listCheckRuns,
  createIssueComment,
  createPull,
  createPullReview,
  addLabels,
  removeLabels,
  updateIssue,
];

// ---------------------------------------------------------------------------
// Execution helpers

function clientFor(ctx: ExecutorContext, token: string | undefined): GitHubClientOptions {
  return {
    baseUrl: process.env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL,
    ...(token !== undefined ? { token } : {}),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
}

async function writeClient(ctx: ExecutorContext): Promise<GitHubClientOptions | string> {
  const token = await ctx.credentials?.get(GITHUB_CREDENTIAL);
  if (!token) return `GitHub writes require the "${GITHUB_CREDENTIAL}" credential binding`;
  return clientFor(ctx, token);
}

async function runRead(
  ctx: ExecutorContext,
  operation: string,
  query: Record<string, unknown>,
  read: (client: GitHubClientOptions) => Promise<{ summary: string; github: Record<string, unknown> }>,
): Promise<JobOutput> {
  const client = clientFor(ctx, await ctx.credentials?.get(GITHUB_CREDENTIAL));
  const retrievedAt = new Date().toISOString();
  try {
    const { summary, github } = await read(client);
    return {
      status: "ok",
      summary,
      evidence: [evidence(operation, { query, retrievedAt, ...github })],
    };
  } catch (err) {
    return failure(operation, err);
  }
}

/** Every write outcome records its operation, remote target, and idempotency key. */
async function runWrite(
  operation: string,
  target: Record<string, unknown>,
  idempotencyKey: string,
  write: () => Promise<JobOutput>,
): Promise<JobOutput> {
  let out: JobOutput;
  try {
    out = await write();
  } catch (err) {
    out = failure(operation, err);
  }
  if (!out.evidence) return out;
  return {
    ...out,
    evidence: out.evidence.map((e) => ({
      ...e,
      payload: { github: { ...e.payload.github, operation, target, idempotencyKey } },
    })),
  };
}

function failure(operation: string, err: unknown): JobOutput {
  if (err instanceof GitHubRateLimitError) {
    return {
      status: "failed",
      summary: err.message,
      evidence: [evidence(operation, { outcome: "rate-limited", rateLimit: err.rateLimit })],
      ...(err.rateLimit.retryAfterMs !== undefined ? { retryAfterMs: err.rateLimit.retryAfterMs } : {}),
    };
  }
  return failed(errorText(err));
}

function created(summary: string, github: Record<string, unknown>): JobOutput {
  return { status: "ok", summary, evidence: [evidence("write", { outcome: "created", ...github })] };
}

function reconciled(summary: string, github: Record<string, unknown>): JobOutput {
  return { status: "ok", summary, evidence: [evidence("write", { outcome: "reconciled", ...github })] };
}

function updated(summary: string, github: Record<string, unknown>): JobOutput {
  return { status: "ok", summary, evidence: [evidence("write", { outcome: "updated", ...github })] };
}

function ambiguous(summary: string): JobOutput {
  return { status: "failed", summary, evidence: [evidence("write", { outcome: "ambiguous" })] };
}

function failed(summary: string): JobOutput {
  return { status: "failed", summary };
}

function evidence(
  operation: string,
  github: Record<string, unknown>,
): { kind: "other"; payload: { github: Record<string, unknown> } } {
  return { kind: "other", payload: { github: { operation, executor: packageIdentity, ...github } } };
}

function operationMarker(ctx: ExecutorContext, idempotencyKey: string): string {
  return `<!-- graphloom-op: ${ctx.runId}/${idempotencyKey} -->`;
}

type MarkedLookup<T> =
  | { kind: "found"; item: T }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

async function findMarked<T>(
  client: GitHubClientOptions,
  listPath: string,
  marker: string,
  bodyOf: (item: T) => string | null | undefined,
): Promise<MarkedLookup<T>> {
  let page: number | undefined = 1;
  for (let fetched = 0; page !== undefined; fetched += 1) {
    if (fetched >= MAX_RECONCILE_PAGES) {
      return {
        kind: "unknown",
        reason: `cannot reconcile: more than ${MAX_RECONCILE_PAGES} pages to scan for the idempotency marker`,
      };
    }
    const res: Awaited<ReturnType<typeof githubRequest<T[]>>> = await githubRequest<T[]>(
      client,
      "GET",
      `${listPath}?per_page=100&page=${page}`,
    );
    const hit = res.data.find((item) => (bodyOf(item) ?? "").includes(marker));
    if (hit) return { kind: "found", item: hit };
    page = res.nextPage;
  }
  return { kind: "absent" };
}

interface PageInput {
  perPage?: number;
  cursor?: string;
  maxPages?: number;
}

async function fetchPages<T, R = T[]>(
  client: GitHubClientOptions,
  listPath: string,
  params: URLSearchParams,
  input: PageInput,
  /** Pick the items out of a response that wraps them (check runs). */
  pick: (data: R) => T[] = (data) => data as unknown as T[],
): Promise<{
  items: T[];
  rateLimit: RateLimitSnapshot;
  page: {
    startCursor: string;
    nextCursor: string | null;
    pagesFetched: number;
    perPage: number;
    complete: boolean;
  };
}> {
  const startPage = input.cursor !== undefined ? Number.parseInt(input.cursor, 10) : 1;
  const maxPages = input.maxPages ?? 1;
  const items: T[] = [];
  let page: number | undefined = startPage;
  let pagesFetched = 0;
  let rateLimit: RateLimitSnapshot = {};
  while (page !== undefined && pagesFetched < maxPages) {
    params.set("page", String(page));
    const res: Awaited<ReturnType<typeof githubRequest<R>>> = await githubRequest<R>(
      client,
      "GET",
      `${listPath}?${params.toString()}`,
    );
    items.push(...pick(res.data));
    rateLimit = res.rateLimit;
    pagesFetched += 1;
    page = res.nextPage;
  }
  return {
    items,
    rateLimit,
    page: {
      startCursor: String(startPage),
      nextCursor: page !== undefined ? String(page) : null,
      pagesFetched,
      perPage: input.perPage ?? 30,
      complete: page === undefined,
    },
  };
}

function summarizeIssue(issue: RawIssue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    author: issue.user?.login ?? null,
    labels: labelNames(issue),
    milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null,
    comments: issue.comments ?? 0,
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
    closedAt: issue.closed_at ?? null,
  };
}

function summarizePull(pull: RawPull) {
  return {
    ...summarizeIssue(pull),
    draft: pull.draft ?? false,
    merged: pull.merged_at !== undefined && pull.merged_at !== null,
    head: { ref: pull.head?.ref ?? null, sha: pull.head?.sha ?? null, label: pull.head?.label ?? null },
    base: { ref: pull.base?.ref ?? null, sha: pull.base?.sha ?? null, label: pull.base?.label ?? null },
  };
}

function labelNames(issue: RawIssue): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((n): n is string => typeof n === "string");
}

async function labelExists(client: GitHubClientOptions, input: RepoInput, name: string): Promise<boolean> {
  try {
    await githubRequest<RawLabel>(client, "GET", `/repos/${repoPath(input)}/labels/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if ((err as { status?: unknown }).status === 404) return false;
    throw err;
  }
}

/** Create a repository label; false when a concurrent writer created it first. */
async function createLabel(client: GitHubClientOptions, input: RepoInput, name: string): Promise<boolean> {
  try {
    await githubRequest<RawLabel>(client, "POST", `/repos/${repoPath(input)}/labels`, { name });
    return true;
  } catch (err) {
    if ((err as { status?: unknown }).status === 422 && (await labelExists(client, input, name))) return false;
    throw err;
  }
}

function summarizeReview(review: RawReview) {
  return {
    id: review.id,
    state: review.state ?? null,
    url: review.html_url ?? null,
    commitId: review.commit_id ?? null,
    author: review.user?.login ?? null,
  };
}

function toApiReviewComment(c: ReviewComment) {
  const side = c.side ?? "RIGHT";
  return {
    path: c.path,
    line: c.line,
    side,
    ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: side } : {}),
    body: c.body,
  };
}

/** GitHub stores bodies with CRLF line endings when edited in the browser. */
function normalizeBody(body: string | null | undefined): string {
  return (body ?? "").replace(/\r\n/g, "\n");
}

function boundBody(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body;
}

function repoPath(input: RepoInput): string {
  return `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPackageIdentity(): { package: string; version: string } {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name?: string; version?: string };
    return { package: pkg.name ?? "@graphloom/executor-github", version: pkg.version ?? "unknown" };
  } catch {
    return { package: "@graphloom/executor-github", version: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Input guards

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const REF = /^[A-Za-z0-9_.\/:-]{1,255}$/;
const KEY = /^[A-Za-z0-9._:-]{1,100}$/;

function field(v: unknown, key: string): unknown {
  return (v as Record<string, unknown>)[key];
}

function isRepoInput(v: unknown): v is RepoInput {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof field(v, "owner") === "string" &&
    NAME.test(field(v, "owner") as string) &&
    typeof field(v, "repo") === "string" &&
    NAME.test(field(v, "repo") as string)
  );
}

function isPageInput(v: unknown): boolean {
  const perPage = field(v, "perPage");
  const maxPages = field(v, "maxPages");
  const cursor = field(v, "cursor");
  return (
    (perPage === undefined || (isPositiveInt(perPage) && perPage <= 100)) &&
    (maxPages === undefined || (isPositiveInt(maxPages) && maxPages <= MAX_PAGES_PER_CALL)) &&
    (cursor === undefined || (typeof cursor === "string" && /^[1-9][0-9]{0,6}$/.test(cursor)))
  );
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 65_000;
}

/** A repository-relative file path: no leading slash, and no empty, `.` or `..` segment. */
function isFilePath(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 1_000 && !v.includes("\u0000") && v.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isRef(v: unknown): v is string {
  return typeof v === "string" && REF.test(v);
}

function isIdempotencyKey(v: unknown): v is string {
  return typeof v === "string" && KEY.test(v);
}

function optionalEnum(v: unknown, key: string, allowed: string[]): boolean {
  const value = field(v, key);
  return value === undefined || (typeof value === "string" && allowed.includes(value));
}

function optionalStringArray(v: unknown, key: string): boolean {
  const value = field(v, key);
  return (
    value === undefined ||
    (Array.isArray(value) && value.length <= 20 && value.every((s) => typeof s === "string" && s.length <= 100))
  );
}

function optionalRef(v: unknown, key: string): boolean {
  const value = field(v, key);
  return value === undefined || isRef(value);
}

function optionalString(v: unknown, key: string): boolean {
  const value = field(v, key);
  return value === undefined || (typeof value === "string" && value.length <= 65_000);
}

function optionalBoolean(v: unknown, key: string): boolean {
  const value = field(v, key);
  return value === undefined || typeof value === "boolean";
}

function isTitle(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 256;
}

function isSha(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{7,64}$/.test(v);
}

function isTimestamp(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function isLabelList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 20 &&
    v.every((l) => typeof l === "string" && l.trim().length > 0 && l.length <= 50 && !/[\u0000-\u001f,]/.test(l))
  );
}

function isReviewComments(v: unknown): boolean {
  if (v === undefined) return true;
  return (
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every((c) => {
      if (typeof c !== "object" || c === null) return false;
      const path = field(c, "path");
      const line = field(c, "line");
      const startLine = field(c, "startLine");
      const side = field(c, "side");
      return (
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 1_000 &&
        !path.startsWith("/") &&
        isPositiveInt(line) &&
        (startLine === undefined || (isPositiveInt(startLine) && startLine < line)) &&
        (side === undefined || side === "LEFT" || side === "RIGHT") &&
        isNonEmptyString(field(c, "body"))
      );
    })
  );
}
