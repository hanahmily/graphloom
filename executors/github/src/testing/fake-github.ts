// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface FakeIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  pullRequest?: boolean;
  body?: string;
  milestone?: number | null;
  updatedAt?: string;
}

export interface FakeComment {
  id: number;
  body: string;
}

export interface FakePull {
  number: number;
  title: string;
  state: "open" | "closed";
  head: string;
  base: string;
  body: string;
  author?: string;
  labels?: string[];
  milestone?: number | null;
  updatedAt?: string;
  /** Head commit; "abc123" when absent. */
  headSha?: string;
  baseSha?: string;
  draft?: boolean;
}

export interface FakePullFile {
  filename: string;
  status?: "added" | "modified" | "removed" | "renamed";
  previousFilename?: string;
  additions: number;
  deletions: number;
  /** Absent, as GitHub omits it for a diff too large to render or a binary file. */
  patch?: string;
}

export interface FakeCommit {
  sha: string;
  parents?: string[];
  message: string;
  author?: string;
  committedDate?: string;
}

export interface FakeReviewComment {
  id: number;
  path: string;
  /** null when the commented line is gone from the head. */
  line?: number | null;
  originalLine?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  commitId?: string;
  inReplyTo?: number;
  body: string;
  user?: string;
}

export interface FakeThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line?: number | null;
  comments: { id: number; author: string; body: string }[];
}

export interface FakeCheckRun {
  id?: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | null;
  detailsUrl?: string;
}

export interface FakeReview {
  id: number;
  user?: string;
  body: string;
  state: "CHANGES_REQUESTED" | "COMMENTED" | "APPROVED";
  commitId: string;
  comments: { path: string; line: number; side?: string; body: string }[];
}

export interface FakeMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
}

export interface FakeFile {
  /** `owner/name`; any repository when absent. */
  repo?: string;
  path: string;
  /** The ref the file exists at; every ref when absent. A request without a ref reads "main". */
  ref?: string;
  content: string | Buffer;
  /** Report this size instead of the real one, as GitHub does for a file too large to return inline. */
  size?: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeGitHub {
  baseUrl: string;
  requests: FakeRequest[];
  issues: FakeIssue[];
  comments: Map<number, FakeComment[]>;
  pulls: FakePull[];
  reviews: Map<number, FakeReview[]>;
  /** Per pull request number. */
  pullFiles: Map<number, FakePullFile[]>;
  pullCommits: Map<number, FakeCommit[]>;
  reviewComments: Map<number, FakeReviewComment[]>;
  /** Served through GraphQL, which the fake answers at `/graphql`. */
  reviewThreads: Map<number, FakeThread[]>;
  /** Per commit sha. */
  checkRuns: Map<string, FakeCheckRun[]>;
  labels: string[];
  milestones: FakeMilestone[];
  files: FakeFile[];
  /** Answer the next N requests with a primary rate-limit 403. */
  rateLimitNext(count: number, resetInSeconds: number): void;
  /** Apply the next write, then drop the connection before responding. */
  dropAfterNextWrite(): void;
  /** Apply the next write and never respond (the caller dies mid-request). */
  hangAfterNextWrite(): void;
  close(): Promise<void>;
}

/** Login the fake treats as the token's user; it cannot review its own pull requests. */
export const FAKE_VIEWER = "graphloom-bot";

/** Minimal GitHub REST stand-in for repeatable pagination, rate-limit, and crash tests. */
export async function startFakeGitHub(
  seed: {
    issues?: FakeIssue[];
    pulls?: FakePull[];
    labels?: string[];
    milestones?: FakeMilestone[];
    files?: FakeFile[];
  } = {},
): Promise<FakeGitHub> {
  const issues = [...(seed.issues ?? [])];
  const pulls = [...(seed.pulls ?? [])];
  const labels = [...(seed.labels ?? [])];
  const milestones = [...(seed.milestones ?? [])];
  const files = [...(seed.files ?? [])];
  const comments = new Map<number, FakeComment[]>();
  const reviews = new Map<number, FakeReview[]>();
  const pullFiles = new Map<number, FakePullFile[]>();
  const pullCommits = new Map<number, FakeCommit[]>();
  const reviewComments = new Map<number, FakeReviewComment[]>();
  const reviewThreads = new Map<number, FakeThread[]>();
  const checkRuns = new Map<string, FakeCheckRun[]>();
  const requests: FakeRequest[] = [];
  let rateLimited = 0;
  let resetIn = 60;
  let dropNextWrite = false;
  let hangNextWrite = false;
  let nextId = 1000;
  let clock = Date.parse("2026-09-02T00:00:00Z");

  function touch(): string {
    clock += 1000;
    return new Date(clock).toISOString().replace(".000Z", "Z");
  }

  /** True when the write was applied but the response must not be sent. */
  function interruptWrite(req: IncomingMessage): boolean {
    if (hangNextWrite) {
      hangNextWrite = false;
      return true;
    }
    if (dropNextWrite) {
      dropNextWrite = false;
      req.socket.destroy();
      return true;
    }
    return false;
  }

  /** Issues and pull requests share numbers and the issues endpoints, as on GitHub. */
  function issueLike(n: number): FakeIssue | FakePull | undefined {
    return issues.find((i) => i.number === n) ?? pulls.find((p) => p.number === n);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { message: err instanceof Error ? err.message : String(err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", baseUrl);
    const method = req.method ?? "GET";
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
    });
    const body = method === "POST" || method === "PATCH" ? await readJson(req) : undefined;

    if (rateLimited > 0) {
      rateLimited -= 1;
      res.setHeader("x-ratelimit-limit", "60");
      res.setHeader("x-ratelimit-remaining", "0");
      res.setHeader("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + resetIn));
      send(res, 403, { message: "API rate limit exceeded" });
      return;
    }
    res.setHeader("x-ratelimit-limit", "5000");
    res.setHeader("x-ratelimit-remaining", "4999");
    res.setHeader("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 3600));

    if (url.pathname === "/graphql" && method === "POST") {
      graphql(res, body as { query?: string; variables?: Record<string, unknown> }, pulls, reviewThreads);
      return;
    }

    if (url.pathname === "/user" && method === "GET") {
      send(res, 200, { login: FAKE_VIEWER });
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // /repos/:owner/:repo/...
    if (parts[0] !== "repos" || parts.length < 4) {
      send(res, 404, { message: "Not Found" });
      return;
    }
    const [, owner, repo, resource, id, sub] = parts as [string, string, string, string, string?, string?];
    const milestoneOf = (n: number | null | undefined) => rawMilestone(milestones, n);

    if (resource === "labels") {
      if (id === undefined && method === "POST") {
        const name = String((body as { name?: unknown }).name ?? "");
        if (labels.includes(name)) {
          send(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] });
          return;
        }
        labels.push(name);
        send(res, 201, rawLabel(name));
        return;
      }
      if (id === undefined) {
        paginate(res, url, labels.map(rawLabel));
        return;
      }
      if (!labels.includes(id)) return send(res, 404, { message: "Not Found" });
      send(res, 200, rawLabel(id));
      return;
    }
    if (resource === "contents" && method === "GET") {
      const wanted = parts.slice(4).join("/");
      const ref = url.searchParams.get("ref") ?? "main";
      const here = files.filter((f) => (f.repo === undefined || f.repo === `${owner}/${repo}`) && (f.ref === undefined || f.ref === ref));
      const file = here.find((f) => f.path === wanted);
      if (file !== undefined) {
        const bytes = Buffer.from(file.content);
        const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        const size = file.size ?? bytes.length;
        send(res, 200, { type: "file", path: file.path, sha, size, encoding: size > 1_000_000 ? "none" : "base64", content: size > 1_000_000 ? "" : bytes.toString("base64") });
        return;
      }
      const inside = here.filter((f) => f.path.startsWith(`${wanted}/`));
      if (inside.length > 0) return send(res, 200, inside.map((f) => ({ type: "file", path: f.path })));
      return send(res, 404, { message: "Not Found" });
    }
    if (resource === "milestones" && id === undefined) {
      const state = url.searchParams.get("state") ?? "open";
      paginate(
        res,
        url,
        milestones.filter((m) => state === "all" || m.state === state).map((m) => rawMilestone(milestones, m.number)),
      );
      return;
    }
    if (resource === "issues" && id === undefined && method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const wanted = url.searchParams.get("labels")?.split(",").filter(Boolean) ?? [];
      const matching = issues.filter(
        (i) => (state === "all" || i.state === state) && wanted.every((l) => i.labels.includes(l)),
      );
      paginate(res, url, matching.map((i) => rawIssue(owner, repo, i, milestoneOf)));
      return;
    }
    if (resource === "issues" && id === "401") {
      // Misbehaving endpoint that echoes the caller's credential.
      send(res, 401, { message: `Bad credentials: ${req.headers.authorization ?? "none"}` });
      return;
    }
    if (resource === "issues" && id !== undefined && sub === undefined) {
      const item = issueLike(Number(id));
      if (!item) return send(res, 404, { message: "Not Found" });
      if (method === "PATCH") {
        const patch = body as { title?: string; body?: string; milestone?: number | null };
        if (patch.milestone !== undefined && patch.milestone !== null && !milestones.some((m) => m.number === patch.milestone)) {
          send(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "milestone", code: "invalid" }] });
          return;
        }
        if (patch.title !== undefined) item.title = patch.title;
        if (patch.body !== undefined) item.body = patch.body;
        if (patch.milestone !== undefined) item.milestone = patch.milestone;
        item.updatedAt = touch();
        if (interruptWrite(req)) return;
      }
      send(res, 200, rawIssueLike(owner, repo, item, milestoneOf));
      return;
    }
    if (resource === "issues" && sub === "labels" && method === "POST") {
      const item = issueLike(Number(id));
      if (!item) return send(res, 404, { message: "Not Found" });
      const added = ((body as { labels?: string[] }).labels ?? []);
      const unknown = added.find((name) => !labels.includes(name));
      if (unknown !== undefined) {
        send(res, 422, { message: "Validation Failed", errors: [{ message: `Label ${unknown} does not exist` }] });
        return;
      }
      item.labels = [...new Set([...(item.labels ?? []), ...added])];
      item.updatedAt = touch();
      if (interruptWrite(req)) return;
      send(res, 200, item.labels.map(rawLabel));
      return;
    }
    if (resource === "issues" && sub === "labels" && method === "DELETE") {
      const item = issueLike(Number(id));
      const name = parts[6];
      if (!item || name === undefined) return send(res, 404, { message: "Not Found" });
      const current = item.labels ?? [];
      if (!current.some((l) => l.toLowerCase() === name.toLowerCase())) {
        send(res, 404, { message: "Label does not exist" });
        return;
      }
      item.labels = current.filter((l) => l.toLowerCase() !== name.toLowerCase());
      item.updatedAt = touch();
      if (interruptWrite(req)) return;
      send(res, 200, item.labels.map(rawLabel));
      return;
    }
    if (resource === "issues" && sub === "comments") {
      const list = comments.get(Number(id)) ?? [];
      if (method === "GET") {
        paginate(res, url, list.map((c) => rawComment(owner, repo, Number(id), c)));
        return;
      }
      const comment = { id: nextId++, body: String((body as { body?: unknown }).body ?? "") };
      comments.set(Number(id), [...list, comment]);
      if (interruptWrite(req)) return;
      send(res, 201, rawComment(owner, repo, Number(id), comment));
      return;
    }
    if (resource === "pulls" && id === undefined) {
      if (method === "GET") {
        const state = url.searchParams.get("state") ?? "open";
        const head = url.searchParams.get("head");
        const base = url.searchParams.get("base");
        const matching = pulls.filter(
          (p) =>
            (state === "all" || p.state === state) &&
            (head === null || p.head === head) &&
            (base === null || p.base === base),
        );
        paginate(res, url, matching.map((p) => rawPull(owner, repo, p, milestoneOf)));
        return;
      }
      const input = body as { title: string; head: string; base: string; body?: string };
      if (input.head.endsWith(":empty")) {
        send(res, 422, {
          message: "Validation Failed",
          errors: [{ message: `No commits between ${input.base} and ${input.head.split(":").pop()}` }],
        });
        return;
      }
      if (pulls.some((p) => p.state === "open" && p.head === input.head && p.base === input.base)) {
        send(res, 422, { message: "A pull request already exists" });
        return;
      }
      const pull: FakePull = {
        number: nextId++,
        title: input.title,
        state: "open",
        head: input.head,
        base: input.base,
        body: input.body ?? "",
        author: FAKE_VIEWER,
      };
      pulls.push(pull);
      if (interruptWrite(req)) return;
      send(res, 201, rawPull(owner, repo, pull, milestoneOf));
      return;
    }
    if (resource === "pulls" && id !== undefined && sub === "reviews") {
      const pull = pulls.find((p) => p.number === Number(id));
      if (!pull) return send(res, 404, { message: "Not Found" });
      const list = reviews.get(pull.number) ?? [];
      if (method === "GET") {
        paginate(res, url, list.map((r) => rawReview(owner, repo, pull.number, r)));
        return;
      }
      const input = body as {
        body?: string;
        event?: string;
        commit_id?: string;
        comments?: FakeReview["comments"];
      };
      if ((pull.author ?? "octo") === FAKE_VIEWER && input.event !== "COMMENT") {
        const verb = input.event === "APPROVE" ? "approve" : "request changes on";
        send(res, 422, { message: "Unprocessable Entity", errors: [`Can not ${verb} your own pull request`] });
        return;
      }
      const state =
        input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : input.event === "APPROVE" ? "APPROVED" : "COMMENTED";
      const review: FakeReview = {
        id: nextId++,
        body: input.body ?? "",
        state,
        commitId: input.commit_id ?? "abc123",
        comments: input.comments ?? [],
      };
      reviews.set(pull.number, [...list, review]);
      if (interruptWrite(req)) return;
      send(res, 200, rawReview(owner, repo, pull.number, review));
      return;
    }
    if (resource === "pulls" && id !== undefined && method === "GET" && ["files", "commits", "comments"].includes(sub ?? "")) {
      const pull = pulls.find((p) => p.number === Number(id));
      if (!pull) return send(res, 404, { message: "Not Found" });
      if (sub === "files") return paginate(res, url, (pullFiles.get(pull.number) ?? []).map(rawPullFile));
      if (sub === "commits") return paginate(res, url, (pullCommits.get(pull.number) ?? []).map((c) => rawCommit(owner, repo, c)));
      return paginate(res, url, (reviewComments.get(pull.number) ?? []).map((c) => rawReviewComment(owner, repo, pull.number, c)));
    }
    if (resource === "commits" && sub === "check-runs" && method === "GET") {
      const runs = checkRuns.get(id ?? "");
      if (runs === undefined) return send(res, 422, { message: `No commit found for SHA: ${id}` });
      paginate(res, url, runs.map(rawCheckRun), (slice) => ({ total_count: runs.length, check_runs: slice }));
      return;
    }
    if (resource === "pulls" && id !== undefined && method === "GET") {
      const pull = pulls.find((p) => p.number === Number(id));
      if (!pull) return send(res, 404, { message: "Not Found" });
      send(res, 200, rawPull(owner, repo, pull, milestoneOf));
      return;
    }
    send(res, 404, { message: "Not Found" });
  }

  return {
    baseUrl,
    requests,
    issues,
    comments,
    pulls,
    reviews,
    pullFiles,
    pullCommits,
    reviewComments,
    reviewThreads,
    checkRuns,
    labels,
    milestones,
    files,
    rateLimitNext(count, resetInSeconds) {
      rateLimited = count;
      resetIn = resetInSeconds;
    },
    dropAfterNextWrite() {
      dropNextWrite = true;
    },
    hangAfterNextWrite() {
      hangNextWrite = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function paginate(res: ServerResponse, url: URL, items: unknown[], wrap: (slice: unknown[]) => unknown = (slice) => slice): void {
  const perPage = Number(url.searchParams.get("per_page") ?? "30");
  const page = Number(url.searchParams.get("page") ?? "1");
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (page * perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    res.setHeader("link", `<${next.toString()}>; rel="next"`);
  }
  send(res, 200, wrap(slice));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

type MilestoneOf = (n: number | null | undefined) => ReturnType<typeof rawMilestone>;

function rawIssueLike(owner: string, repo: string, item: FakeIssue | FakePull, milestoneOf: MilestoneOf) {
  return "head" in item ? rawPull(owner, repo, item, milestoneOf) : rawIssue(owner, repo, item, milestoneOf);
}

function rawIssue(owner: string, repo: string, issue: FakeIssue, milestoneOf: MilestoneOf) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body ?? "issue body",
    html_url: `https://github.com/${owner}/${repo}/issues/${issue.number}`,
    user: { login: "octo" },
    labels: issue.labels.map(rawLabel),
    milestone: milestoneOf(issue.milestone),
    comments: 0,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: issue.updatedAt ?? "2026-09-02T00:00:00Z",
    closed_at: null,
    ...(issue.pullRequest ? { pull_request: { url: "x" } } : {}),
  };
}

function rawComment(owner: string, repo: string, issue: number, comment: FakeComment) {
  return {
    id: comment.id,
    html_url: `https://github.com/${owner}/${repo}/issues/${issue}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: FAKE_VIEWER },
    created_at: "2026-09-03T00:00:00Z",
  };
}

function rawPull(owner: string, repo: string, pull: FakePull, milestoneOf: MilestoneOf) {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    body: pull.body,
    html_url: `https://github.com/${owner}/${repo}/pull/${pull.number}`,
    user: { login: pull.author ?? "octo" },
    labels: (pull.labels ?? []).map(rawLabel),
    milestone: milestoneOf(pull.milestone),
    updated_at: pull.updatedAt ?? "2026-09-02T00:00:00Z",
    draft: pull.draft ?? false,
    merged_at: null,
    head: { ref: pull.head.split(":").pop(), label: pull.head, sha: pull.headSha ?? "abc123" },
    base: { ref: pull.base, label: `${owner}:${pull.base}`, sha: pull.baseSha ?? "def456" },
  };
}

function rawReview(owner: string, repo: string, pull: number, review: FakeReview) {
  return {
    id: review.id,
    body: review.body,
    state: review.state,
    commit_id: review.commitId,
    html_url: `https://github.com/${owner}/${repo}/pull/${pull}#pullrequestreview-${review.id}`,
    user: { login: review.user ?? FAKE_VIEWER },
    submitted_at: "2026-09-04T00:00:00Z",
  };
}

function rawLabel(name: string) {
  return { name, color: "ededed", description: null };
}

function rawMilestone(milestones: FakeMilestone[], n: number | null | undefined) {
  const m = n === null || n === undefined ? undefined : milestones.find((x) => x.number === n);
  if (!m) return null;
  return {
    number: m.number,
    title: m.title,
    state: m.state,
    due_on: null,
    open_issues: 0,
    closed_issues: 0,
    html_url: `https://github.com/acme/app/milestone/${m.number}`,
  };
}

function rawPullFile(f: FakePullFile) {
  return {
    sha: createHash("sha1").update(f.filename).digest("hex"),
    filename: f.filename,
    status: f.status ?? "modified",
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    ...(f.previousFilename !== undefined ? { previous_filename: f.previousFilename } : {}),
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
  };
}

function rawCommit(owner: string, repo: string, c: FakeCommit) {
  const date = c.committedDate ?? "2026-09-01T00:00:00Z";
  return {
    sha: c.sha,
    html_url: `https://github.com/${owner}/${repo}/commit/${c.sha}`,
    parents: (c.parents ?? []).map((sha) => ({ sha })),
    author: { login: c.author ?? "octo" },
    commit: { message: c.message, author: { name: c.author ?? "octo", date }, committer: { name: c.author ?? "octo", date } },
  };
}

function rawReviewComment(owner: string, repo: string, pull: number, c: FakeReviewComment) {
  return {
    id: c.id,
    pull_request_review_id: 1,
    path: c.path,
    line: c.line === undefined ? c.originalLine ?? 1 : c.line,
    original_line: c.originalLine ?? c.line ?? 1,
    side: c.side ?? "RIGHT",
    ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
    commit_id: c.commitId ?? "abc123",
    original_commit_id: c.commitId ?? "abc123",
    ...(c.inReplyTo !== undefined ? { in_reply_to_id: c.inReplyTo } : {}),
    body: c.body,
    html_url: `https://github.com/${owner}/${repo}/pull/${pull}#discussion_r${c.id}`,
    created_at: "2026-09-05T00:00:00Z",
    user: { login: c.user ?? FAKE_VIEWER },
  };
}

function rawCheckRun(c: FakeCheckRun, i: number) {
  return {
    id: c.id ?? 9000 + i,
    name: c.name,
    status: c.status,
    conclusion: c.conclusion ?? null,
    details_url: c.detailsUrl ?? `https://ci.example/${encodeURIComponent(c.name)}`,
    html_url: `https://github.com/acme/app/runs/${c.id ?? 9000 + i}`,
    started_at: "2026-09-06T00:00:00Z",
    completed_at: c.status === "completed" ? "2026-09-06T00:05:00Z" : null,
    app: { slug: "github-actions" },
  };
}

const COMMENT_PAGE = 100;

function cursorOf(index: number): string {
  return Buffer.from(`c:${index}`).toString("base64");
}

function indexOf(cursor: unknown): number {
  if (typeof cursor !== "string") return 0;
  const m = /^c:(\d+)$/.exec(Buffer.from(cursor, "base64").toString("utf8"));
  return m ? Number(m[1]) : 0;
}

function threadComment(c: FakeThread["comments"][number], thread: FakeThread) {
  return {
    id: `PRRC_${c.id}`,
    databaseId: c.id,
    author: { login: c.author },
    body: c.body,
    createdAt: "2026-09-05T00:00:00Z",
    path: thread.path,
    outdated: thread.isOutdated,
    replyTo: null,
    commit: { oid: "abc123" },
    originalCommit: { oid: "abc123" },
  };
}

function commentConnection(thread: FakeThread, after: unknown) {
  const start = indexOf(after);
  const slice = thread.comments.slice(start, start + COMMENT_PAGE);
  const end = start + slice.length;
  return {
    pageInfo: { hasNextPage: end < thread.comments.length, endCursor: cursorOf(end) },
    nodes: slice.map((c) => threadComment(c, thread)),
  };
}

/** The two review-thread queries the executor sends; anything else is a GraphQL error. */
function graphql(
  res: ServerResponse,
  body: { query?: string; variables?: Record<string, unknown> },
  pulls: FakePull[],
  threads: Map<number, FakeThread[]>,
): void {
  const query = body.query ?? "";
  const vars = body.variables ?? {};
  if (query.includes("reviewThreads")) {
    const number = Number(vars.number);
    if (!pulls.some((p) => p.number === number)) {
      send(res, 200, { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a PullRequest with the number of ${number}.` }] });
      return;
    }
    const all = threads.get(number) ?? [];
    const start = indexOf(vars.after);
    const first = Number(vars.first ?? 30);
    const slice = all.slice(start, start + first);
    const end = start + slice.length;
    send(res, 200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: end < all.length, endCursor: cursorOf(end) },
              nodes: slice.map((t) => ({
                id: t.id,
                isResolved: t.isResolved,
                isOutdated: t.isOutdated,
                path: t.path,
                line: t.line === undefined ? 1 : t.line,
                originalLine: 1,
                startLine: null,
                diffSide: "RIGHT",
                resolvedBy: t.isResolved ? { login: "maintainer" } : null,
                comments: commentConnection(t, null),
              })),
            },
          },
        },
      },
    });
    return;
  }
  if (query.includes("node(id")) {
    const thread = [...threads.values()].flat().find((t) => t.id === vars.id);
    send(res, 200, { data: { node: thread ? { comments: commentConnection(thread, vars.after) } : null } });
    return;
  }
  send(res, 200, { errors: [{ message: "unsupported query" }] });
}
