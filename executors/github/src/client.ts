// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

/** Non-secret operator configuration read by the executor process. */
export const GITHUB_API_URL_ENV = "GRAPHLOOM_GITHUB_API_URL";

export interface RateLimitSnapshot {
  limit?: number;
  remaining?: number;
  /** ISO time the primary limit resets. */
  resetAt?: string;
  /** Server-requested wait before retrying, when given. */
  retryAfterMs?: number;
}

export interface GitHubClientOptions {
  baseUrl: string;
  token?: string;
  signal?: AbortSignal;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  rateLimit: RateLimitSnapshot;
  /** Page number of the `rel="next"` link; undefined when this is the last page. */
  nextPage?: number;
}

/** Rate limited: surfaced to the caller with retry timing, never retried here. */
export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly rateLimit: RateLimitSnapshot,
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/** Definite HTTP rejection, or a 5xx whose effect is unknown. */
export class GitHubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }

  /** A 5xx may have been applied remotely before the error was returned. */
  get ambiguous(): boolean {
    return this.status >= 500;
  }
}

/** No response arrived; a write may or may not have reached GitHub. */
export class GitHubNetworkError extends Error {
  readonly ambiguous = true;
  constructor(message: string) {
    super(message);
    this.name = "GitHubNetworkError";
  }
}

export function isAmbiguous(err: unknown): boolean {
  return (
    err instanceof GitHubNetworkError ||
    (err instanceof GitHubHttpError && err.ambiguous)
  );
}

export async function githubRequest<T>(
  options: GitHubClientOptions,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  pathAndQuery: string,
  body?: unknown,
): Promise<GitHubResponse<T>> {
  const url = new URL(pathAndQuery.replace(/^\//, ""), withTrailingSlash(options.baseUrl));
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "graphloom-executor-github",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new GitHubNetworkError(
      `GitHub ${method} ${url.pathname} failed without a response: ${errorMessage(err)}`,
    );
  }

  const rateLimit = readRateLimit(res.headers);
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new GitHubNetworkError(
      `GitHub ${method} ${url.pathname} response interrupted: ${errorMessage(err)}`,
    );
  }

  if (isRateLimited(res.status, res.headers)) {
    throw new GitHubRateLimitError(
      `GitHub rate limited ${method} ${url.pathname}${describeRetry(rateLimit)}`,
      rateLimit,
    );
  }
  if (!res.ok) {
    throw new GitHubHttpError(
      `GitHub ${method} ${url.pathname} returned ${res.status}: ${apiMessage(text)}`,
      res.status,
    );
  }

  const nextPage = parseNextPage(res.headers.get("link"));
  return {
    status: res.status,
    data: (text === "" ? undefined : JSON.parse(text)) as T,
    rateLimit,
    ...(nextPage !== undefined ? { nextPage } : {}),
  };
}

/**
 * One GraphQL query. GraphQL reports most failures as HTTP 200 with `errors`,
 * so they are mapped to the same errors the REST path throws: a rate limit
 * keeps its retry timing and a missing object is a 404.
 */
export async function githubGraphql<T>(
  options: GitHubClientOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T; rateLimit: RateLimitSnapshot }> {
  // `../graphql` resolves beside the REST root on github.com (`/graphql`) and on
  // Enterprise (`/api/v3` -> `/api/graphql`).
  const res = await githubRequest<{ data?: T | null; errors?: { type?: string; message?: string }[] }>(
    options,
    "POST",
    "../graphql",
    { query, variables },
  );
  const errors = res.data?.errors ?? [];
  if (errors.length > 0) {
    const text = errors.map((e) => e.message ?? e.type ?? "error").join("; ").slice(0, 300);
    if (errors.some((e) => e.type === "RATE_LIMITED")) {
      throw new GitHubRateLimitError(`GitHub GraphQL rate limited: ${text}`, res.rateLimit);
    }
    throw new GitHubHttpError(
      `GitHub GraphQL returned ${errors.some((e) => e.type === "NOT_FOUND") ? 404 : 400}: ${text}`,
      errors.some((e) => e.type === "NOT_FOUND") ? 404 : 400,
    );
  }
  if (res.data?.data === undefined || res.data.data === null) {
    throw new GitHubHttpError("GitHub GraphQL returned no data", 502);
  }
  return { data: res.data.data, rateLimit: res.rateLimit };
}

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after");
}

function readRateLimit(headers: Headers): RateLimitSnapshot {
  const snapshot: RateLimitSnapshot = {};
  const limit = intHeader(headers, "x-ratelimit-limit");
  const remaining = intHeader(headers, "x-ratelimit-remaining");
  const reset = intHeader(headers, "x-ratelimit-reset");
  const retryAfter = intHeader(headers, "retry-after");
  if (limit !== undefined) snapshot.limit = limit;
  if (remaining !== undefined) snapshot.remaining = remaining;
  if (reset !== undefined) snapshot.resetAt = new Date(reset * 1000).toISOString();
  if (retryAfter !== undefined) snapshot.retryAfterMs = retryAfter * 1000;
  else if (reset !== undefined && remaining === 0) {
    snapshot.retryAfterMs = Math.max(0, reset * 1000 - Date.now());
  }
  return snapshot;
}

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function describeRetry(rateLimit: RateLimitSnapshot): string {
  const parts: string[] = [];
  if (rateLimit.retryAfterMs !== undefined) {
    parts.push(`retry after ${Math.ceil(rateLimit.retryAfterMs / 1000)}s`);
  }
  if (rateLimit.resetAt !== undefined) parts.push(`limit resets at ${rateLimit.resetAt}`);
  return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}

/** Page number from the `rel="next"` entry of a GitHub Link header. */
export function parseNextPage(link: string | null): number | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (!match?.[1]) continue;
    const page = Number.parseInt(new URL(match[1]).searchParams.get("page") ?? "", 10);
    return Number.isFinite(page) ? page : undefined;
  }
  return undefined;
}

function apiMessage(text: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; errors?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
    // 422 responses carry the actual reason (e.g. "Can not approve your own pull request") in `errors`.
    const details = Array.isArray(parsed.errors) ? parsed.errors.map(errorDetail).filter(Boolean) : [];
    if (details.length > 0) message = `${message} (${details.join("; ")})`;
  } catch {
    /* not JSON */
  }
  return message.slice(0, 300) || "(empty body)";
}

function errorDetail(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e !== "object" || e === null) return "";
  const { message, field, code } = e as { message?: unknown; field?: unknown; code?: unknown };
  if (typeof message === "string") return message;
  return [field, code].filter((s) => typeof s === "string").join(" ");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
