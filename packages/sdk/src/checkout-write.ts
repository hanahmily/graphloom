// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";

/** The most files one checkout may add (`CheckoutSpec.write`). */
export const MAX_CHECKOUT_WRITE_FILES = 16;
/** The largest file, in UTF-8 bytes, a checkout may add. */
export const MAX_CHECKOUT_WRITE_BYTES = 64 * 1024;

/**
 * The digest a checkout records for a file it added: `sha256:<hex>` of the
 * content's UTF-8 bytes. A validator recomputes it from the `write` it asked
 * for to see that the checkout ran exactly those bytes.
 */
export function checkoutWriteDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Why a single added file's path is unsafe, or undefined. The path is
 * repository-relative with `/` separators: not absolute, no empty, `.` or `..`
 * segment, no `.git` segment (any case), no backslash or control character.
 */
export function checkoutWritePathProblem(rel: string): string | undefined {
  if (rel.length === 0) return "the path is empty";
  if (rel.startsWith("/")) return "the path must be relative to the repository";
  if (/[\u0000-\u001f\u007f\\]/.test(rel)) return "the path must not contain a backslash or a control character";
  const parts = rel.split("/");
  if (parts.some((part) => part === "")) return "the path must not have an empty segment (a leading, trailing or doubled /)";
  if (parts.some((part) => part === "." || part === "..")) return "the path must not have a . or .. segment";
  if (parts.some((part) => part.toLowerCase() === ".git")) return "the path must stay outside .git";
  return undefined;
}

/**
 * Why a checkout's `write` list is malformed, or undefined when every entry
 * passes the rules that need no checkout: an array of at most
 * `MAX_CHECKOUT_WRITE_FILES` `{ path, content }` entries with safe, distinct
 * paths, none a parent directory of another, each content a string of at most
 * `MAX_CHECKOUT_WRITE_BYTES` UTF-8 bytes. The controller adds the rules that
 * need the checkout: no path the workspace change touches, nothing already at
 * the path, no symbolic link on the way.
 */
export function checkoutWriteProblem(write: unknown): string | undefined {
  if (!Array.isArray(write)) return "checkout.write must be an array of { path, content }";
  if (write.length > MAX_CHECKOUT_WRITE_FILES) {
    return `checkout.write adds ${write.length} files, more than ${MAX_CHECKOUT_WRITE_FILES}`;
  }
  const seen = new Set<string>();
  for (const [i, raw] of write.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return `checkout.write[${i}] must be an object`;
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).filter((key) => key !== "path" && key !== "content");
    if (extra.length > 0) return `checkout.write[${i}] has unknown fields: ${extra.join(", ")}`;
    if (typeof entry["path"] !== "string") return `checkout.write[${i}].path must be a string`;
    if (typeof entry["content"] !== "string") return `checkout.write[${i}].content must be a string`;
    const rel = entry["path"];
    const label = `checkout.write[${i}] ${JSON.stringify(rel)}`;
    const problem = checkoutWritePathProblem(rel);
    if (problem !== undefined) return `${label}: ${problem}`;
    if (seen.has(rel)) return `${label}: the path is listed twice`;
    seen.add(rel);
    const size = Buffer.byteLength(entry["content"], "utf8");
    if (size > MAX_CHECKOUT_WRITE_BYTES) return `${label}: ${size} bytes, more than ${MAX_CHECKOUT_WRITE_BYTES}`;
  }
  for (const rel of seen) {
    for (const other of seen) {
      if (other.startsWith(`${rel}/`)) return `checkout.write ${JSON.stringify(rel)}: the path is a directory of ${JSON.stringify(other)}, which is also written`;
    }
  }
  return undefined;
}
