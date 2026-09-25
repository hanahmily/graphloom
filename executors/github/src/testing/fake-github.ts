import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
}

export interface FakeReview {
  id: number;
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
  labels: string[];
  milestones: FakeMilestone[];
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
  } = {},
): Promise<FakeGitHub> {
  const issues = [...(seed.issues ?? [])];
  const pulls = [...(seed.pulls ?? [])];
  const labels = [...(seed.labels ?? [])];
  const milestones = [...(seed.milestones ?? [])];
  const comments = new Map<number, FakeComment[]>();
  const reviews = new Map<number, FakeReview[]>();
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
    labels,
    milestones,
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

function paginate(res: ServerResponse, url: URL, items: unknown[]): void {
  const perPage = Number(url.searchParams.get("per_page") ?? "30");
  const page = Number(url.searchParams.get("page") ?? "1");
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (page * perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    res.setHeader("link", `<${next.toString()}>; rel="next"`);
  }
  send(res, 200, slice);
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
    draft: false,
    merged_at: null,
    head: { ref: pull.head.split(":").pop(), label: pull.head, sha: "abc123" },
    base: { ref: pull.base },
  };
}

function rawReview(owner: string, repo: string, pull: number, review: FakeReview) {
  return {
    id: review.id,
    body: review.body,
    state: review.state,
    commit_id: review.commitId,
    html_url: `https://github.com/${owner}/${repo}/pull/${pull}#pullrequestreview-${review.id}`,
    user: { login: FAKE_VIEWER },
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
