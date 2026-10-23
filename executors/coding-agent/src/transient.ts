import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Bounds on retrying a transient harness failure (capacity, 429/5xx, connection reset). */
export interface TransientRetryPolicy {
  /** Total tries including the first; 1 disables retrying. */
  maxAttempts: number;
  /** Delay before the second try; doubles for each later one. */
  baseDelayMs: number;
  /** Ceiling for one backoff delay. */
  maxDelayMs: number;
}

export const DEFAULT_TRANSIENT_RETRY: TransientRetryPolicy = { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 };

/** Runner-config overrides, read when a job executes. */
export const RETRY_MAX_ATTEMPTS_ENV = "GRAPHLOOM_CODING_RETRY_MAX_ATTEMPTS";
export const RETRY_BASE_DELAY_ENV = "GRAPHLOOM_CODING_RETRY_BASE_DELAY_MS";
export const RETRY_MAX_DELAY_ENV = "GRAPHLOOM_CODING_RETRY_MAX_DELAY_MS";

function envNumber(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
  return n;
}

/** Explicit executor options win over the environment, which wins over the defaults. */
export function resolveRetryPolicy(options: Partial<TransientRetryPolicy> = {}): TransientRetryPolicy {
  const maxAttempts = options.maxAttempts ?? envNumber(RETRY_MAX_ATTEMPTS_ENV, 1) ?? DEFAULT_TRANSIENT_RETRY.maxAttempts;
  return {
    maxAttempts: Math.floor(maxAttempts),
    baseDelayMs: options.baseDelayMs ?? envNumber(RETRY_BASE_DELAY_ENV, 0) ?? DEFAULT_TRANSIENT_RETRY.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? envNumber(RETRY_MAX_DELAY_ENV, 0) ?? DEFAULT_TRANSIENT_RETRY.maxDelayMs,
  };
}

export interface TransientFailure {
  /** Short name of the cause, e.g. "model at capacity". */
  reason: string;
  /** Provider-reported wait, when the failure text carries one. */
  retryAfterMs?: number;
}

/** Failures a retry cannot fix, checked first so a transient-looking word in them never wins. */
const PERMANENT =
  /\b(?:401|403|400|unauthori[sz]ed|forbidden|authentication|invalid[ _-]?(?:api[ _-]?key|x-api-key|request|request_error)|permission[ _-]denied|not[ _-]logged[ _-]in|invalid_request_error|bad request|context[ _-]length|insufficient[ _-](?:quota|credit)|billing|credit balance|write[ -]scope|outside (?:the )?(?:write )?scope|aborted|budget exhausted|could not start|stalled)\b/i;

const TRANSIENT: Array<[RegExp, string]> = [
  [/\bat capacity\b/i, "model at capacity"],
  [/\boverloaded(?:_error)?\b/i, "model overloaded"],
  [/\b429\b|too many requests|rate[ _-]?limit(?:ed)?/i, "rate limited (429)"],
  [/\b(?:500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway time-?out/i, "provider server error (5xx)"],
  [
    /\bECONNRESET\b|connection reset|socket hang up|\bEPIPE\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|connection (?:closed|error|lost)|network error|fetch failed/i,
    "connection failure",
  ],
  [/temporarily unavailable|try again later/i, "provider temporarily unavailable"],
];

/** Where each harness puts a provider failure in its summary; start-up, stall and protocol failures fall outside these shapes and are never transient. */
const FAILURE_SHAPE: Record<string, RegExp> = {
  codex: /^Codex run failed:/,
  claude: /^Claude Code (?:run failed|exited with code)/,
  // Pi reports a provider error as `agent request failed:`, and a request that throws as the bare message.
  pi: /^(?:agent request failed:|(?!agent |could not|Pi ))/,
};

/** Parses "retry-after: 20", "retry after 20 seconds", "try again in 1m30s", "in 500ms". */
export function retryAfterMs(text: string): number | undefined {
  const m =
    /(?:retry[ _-]?after|try again in|retry in)[:= ]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s|minutes?|mins?|m)?(?:\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s))?/i.exec(text);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  let ms = unit.startsWith("ms") || unit.startsWith("milli") ? n : unit.startsWith("m") ? n * 60_000 : n * 1_000;
  if (m[3] !== undefined) ms += Number(m[3]) * 1_000;
  return Math.round(ms);
}

/** Classifies a failed run's summary; undefined means the failure is not worth retrying. */
export function classifyTransient(harness: string, summary: string): TransientFailure | undefined {
  const shape = FAILURE_SHAPE[harness];
  if (shape !== undefined && !shape.test(summary)) return undefined;
  if (PERMANENT.test(summary)) return undefined;
  for (const [pattern, reason] of TRANSIENT) {
    if (pattern.test(summary)) {
      const wait = retryAfterMs(summary);
      return wait !== undefined ? { reason, retryAfterMs: wait } : { reason };
    }
  }
  return undefined;
}

/** Backoff before try `attempt + 1` (attempt is 1-based): base * 2^(attempt-1), at least the provider's retry-after, at most the ceiling. */
export function backoffMs(policy: TransientRetryPolicy, attempt: number, reported?: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(policy.maxDelayMs, Math.max(exponential, reported ?? 0));
}

/** Resolves false when the signal aborts first, true once the delay has passed. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fingerprints the worktree (tracked changes plus untracked file sizes and
 * mtimes). A retry re-runs the whole assignment, so it is safe only when the
 * failed attempt left the worktree as it found it. undefined when the
 * directory is not a git worktree or any git read fails: a change cannot be ruled out.
 */
export async function worktreeDigest(cwd: string): Promise<string | undefined> {
  const git = (args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
  try {
    const hash = createHash("sha256");
    const ref = (await git(["symbolic-ref", "-q", "HEAD"]).catch(() => ({ stdout: Buffer.from("(detached)") }))).stdout;
    // An unborn branch has no commit; any other failure to read HEAD fails closed.
    const head = await git(["rev-parse", "--verify", "-q", "HEAD"]).then(
      (r) => ({ id: r.stdout.toString().trim(), unborn: false }),
      () => (ref.toString().startsWith("refs/") ? { id: "", unborn: true } : undefined),
    );
    if (head === undefined) return undefined;
    hash.update(`${ref.toString().trim()}\0${head.id}\0`);
    hash.update((await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    hash.update((await git(head.unborn ? ["diff", "--binary"] : ["diff", "HEAD", "--binary"])).stdout);
    const untracked = (await git(["ls-files", "-o", "--exclude-standard", "-z"])).stdout.toString("utf8").split("\0").filter(Boolean);
    for (const file of untracked) {
      const s = await stat(path.join(cwd, file));
      hash.update(`${file}\0${s.size}\0${s.mtimeMs}\0`);
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
