// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Stage-agnostic pieces shared by the code-review ledger (findings.ts) and the
 * plan-review ledger (plan-findings.ts): quote verification against observed
 * file bytes, and the finding-verification-v1 result both verifiers return.
 */

/** A line of a candidate file, as a verifier quotes it. */
export interface Quote {
  path: string;
  line: number;
  text: string;
}

export type Verdict = "confirmed" | "refuted" | "uncertain";
const VERDICTS: readonly Verdict[] = ["confirmed", "refuted", "uncertain"];

export const PRIOR_STATUSES = ["resolved", "still_present", "withdrawn"] as const;
export type PriorStatus = (typeof PRIOR_STATUSES)[number];

/** Quotes a refutation may pin; the verifier is told the same bound. */
export const MAX_REFUTATION_QUOTES = 3;
/** Shorter quotes match too easily to disprove anything. */
const MIN_QUOTE_CHARS = 8;
/** How far a quote may sit from the line it cites. */
const QUOTE_WINDOW = 3;

export type FileIndex = Map<string, string>;
const fileKey = (digest: string, path: string) => `${digest}\n${path}`;

/** Observed file bytes by candidate and path; a file's bytes on one candidate never change. */
export function fileIndex(evidence: readonly { kind: string; candidateDigest?: string; payload?: unknown }[]): FileIndex {
  const files: FileIndex = new Map();
  for (const e of evidence) {
    const payload = e.payload as { path?: unknown; bytes?: unknown } | undefined;
    if (e.kind === "file" && e.candidateDigest !== undefined && typeof payload?.path === "string") {
      files.set(fileKey(e.candidateDigest, payload.path), String(payload.bytes ?? ""));
    }
  }
  return files;
}

/**
 * A repository file path the controller can observe: relative, no `.` or `..`
 * segment, outside `.git`, and naming a file by its extension, since observing
 * a directory or an escaping path stops the run.
 */
export function observablePath(p: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s === ".git")) return false;
  return parts.at(-1)!.indexOf(".", 1) > 0;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The quote's text, whitespace collapsed, is on a line within three of the one it cites. */
export function quoteMatches(q: Quote, bytes: string): boolean {
  const text = collapse(q.text);
  if (text.length < MIN_QUOTE_CHARS || q.line < 1) return false;
  const lines = bytes.split("\n");
  for (let i = Math.max(1, q.line - QUOTE_WINDOW); i <= Math.min(lines.length, q.line + QUOTE_WINDOW); i += 1) {
    if (collapse(lines[i - 1]!).includes(text)) return true;
  }
  return false;
}

/** "match", "mismatch", or the paths still to observe on `digest`; always "mismatch" when there is no candidate yet to check against. */
export function checkQuotes(quotes: Quote[], digest: string | undefined, files: FileIndex): "match" | "mismatch" | string[] {
  if (digest === undefined) return "mismatch";
  const missing: string[] = [];
  for (const q of quotes) {
    if (!observablePath(q.path)) return "mismatch";
    const bytes = files.get(fileKey(digest, q.path));
    if (bytes === undefined) {
      if (!missing.includes(q.path)) missing.push(q.path);
    } else if (!quoteMatches(q, bytes)) {
      return "mismatch";
    }
  }
  return missing.length > 0 ? missing : "match";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const QUOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line", "text"],
  properties: { path: { type: "string" }, line: { type: "integer" }, text: { type: "string" } },
};

/** The verifier's result (finding-verification-v1): every property required, none extra. */
export const VERIFICATION_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "verdict", "reason", "quotes"],
        properties: {
          finding: { type: "string" },
          verdict: { type: "string", enum: VERDICTS },
          reason: { type: "string" },
          quotes: { type: "array", items: QUOTE_SCHEMA },
        },
      },
    },
  },
});

/** The verifier's verdicts by finding; conflicting verdicts for one finding count as uncertain. */
export function parseVerification(output: unknown): { verdicts: Map<string, { verdict: Verdict; reason: string; quotes: Quote[] }> } | { problem: string } {
  const list = object(output)?.verdicts;
  if (!Array.isArray(list)) return { problem: "the verifier returned no verdicts" };
  const verdicts = new Map<string, { verdict: Verdict; reason: string; quotes: Quote[] }>();
  for (const raw of list) {
    const v = object(raw);
    const verdict = VERDICTS.find((x) => x === v?.verdict);
    if (v === undefined || typeof v.finding !== "string" || verdict === undefined) continue;
    const quotes = (Array.isArray(v.quotes) ? v.quotes : []).flatMap((q) => {
      const o = object(q);
      return o !== undefined && typeof o.path === "string" && typeof o.text === "string" && Number.isInteger(o.line) ? [{ path: o.path, line: o.line as number, text: o.text }] : [];
    });
    const id = v.finding.trim();
    const earlier = verdicts.get(id);
    const reason = String(v.reason ?? "");
    verdicts.set(id, earlier === undefined || earlier.verdict === verdict ? { verdict, reason: earlier?.reason ?? reason, quotes: earlier?.quotes ?? quotes } : { verdict: "uncertain", reason: "the verifier gave conflicting verdicts", quotes: [] });
  }
  return { verdicts };
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
