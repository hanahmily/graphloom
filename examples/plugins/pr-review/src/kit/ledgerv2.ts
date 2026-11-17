// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The ledger's v2 layout (design-pr-review-split §5): one ledger per pull request with a section per graph. The ref's commit
 * holds a top-level `ledger.json` (`graphloom-pr-ledger-v2`, written once, by whichever write creates or migrates the ledger),
 * the `design/` section (round 1: its heads, `N1` and `Q<n>`, the latest report, Q&A and necessity record) and the `review/`
 * section (round 2: its heads and `F<n>`). A ledger of 0.21 to 0.26 (`graphloom-pr-ledger-v1`) is migrated by the first write;
 * the migration is one pure function here, so every write and every validator builds the same v2 tree from the same v1 commit.
 */
import { createHash } from "node:crypto";
import { isObject } from "./evidence.js";

export const LEDGER_V1 = "graphloom-pr-ledger-v1";
export const LEDGER_V2 = "graphloom-pr-ledger-v2";
export const DESIGN_SCHEMA = "pr-design-review-ledger-v1";
export const REVIEW_SCHEMA = "pr-review-ledger-v1";
export const SECTIONS = ["design", "review"] as const;
export type Section = (typeof SECTIONS)[number];

/** The reasons a migration closes an open v1 round-1 item whose question round 1 no longer asks (§5.4). */
export const MOVED_REASON = "a detail question since the split; the PR review judges it as a lead";
export const SUPERSEDED_REASON = "round 1 now asks per high-level change";
/** What a `rounds: review-only` head of a v1 ledger says in the design section (§5.4). */
export const SKIPPED_NOTE = "round 1 skipped (rounds: review-only)";
/** The question types round 1 no longer asks after the split. */
const MOVED_TYPES = new Set(["missing-test", "split-function", "complexity-coverage", "weak-test"]);
const REUSE = "existing-reuse-common";
export const FEATURE_TYPE = "existing-feature";

type Doc = Record<string, unknown>;
export interface Pull {
  owner: string;
  repo: string;
  number: number;
}

/** The two sections as a write or a validator sees them: absent is a graph that has not run on this pull request. */
export interface Sections {
  schema: typeof LEDGER_V2;
  design?: Doc;
  review?: Doc;
}

/** The top-level `ledger.json` of a v2 ledger. */
export const topLedgerJson = (pull: Pull): string => JSON.stringify({ schema: LEDGER_V2, pull: { owner: pull.owner, repo: pull.repo, number: pull.number }, sections: [...SECTIONS] });

/** The review section's `ledger.md`: the same text whichever write creates the section. */
export const reviewMarkdown = (pull: Pull): string =>
  [`# ${pull.owner}/${pull.repo}#${pull.number}: the PR review`, "", "This section's ledger.json holds the heads round 2 reviewed and its findings (`F<n>`); `git log -p` on this ref is the pull request's history.", ""].join("\n");

/** The design section's `ledger.md` as a migration leaves it (the next design write replaces it with its own). */
export const migratedDesignMarkdown = (pull: Pull): string =>
  [`# ${pull.owner}/${pull.repo}#${pull.number}: the design review`, "", `Migrated from a ${LEDGER_V1} ledger. The files beside this one are the latest report.json, qa.json and necessity.json.`, ""].join("\n");

/** A high-level `existing-reuse-common` key (`existing-reuse-common|item|<path>`) as v2 keys it (`existing-feature|item|<path>`); any other key is unchanged. */
export const featureKey = (key: string): string => (key.startsWith(`${REUSE}|item|`) ? `${FEATURE_TYPE}${key.slice(REUSE.length)}` : key);

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const isDesignId = (id: string): boolean => id === "N1" || /^Q\d+$/.test(id);
const isReviewId = (id: string): boolean => /^F\d+$/.test(id);

/** Why a v1 round-1 item that is open is closed by the migration, or undefined when round 1 still asks its question. */
function closedBy(item: Doc, qaItem: string | undefined): { state: "moved" | "superseded"; reason: string } | undefined {
  const key = str(item.key) ?? "";
  const [type = "", subject = ""] = key.split("|");
  if (MOVED_TYPES.has(type) || (type === REUSE && subject !== "item")) return { state: "moved", reason: MOVED_REASON };
  if (type !== "purpose" && type !== "other") return undefined;
  // About a symbol or a measured function, or about a change item that is not a high-level change (`W<n>`).
  if (subject === "sym" || subject === "fn" || (subject === "item" && qaItem !== undefined && !/^W\d+$/.test(qaItem))) return { state: "superseded", reason: SUPERSEDED_REASON };
  return undefined;
}

/** How many of the v1 round-1 items were open on head `sha`, by each one's status history. */
const openAt = (items: readonly Doc[], sha: string): number => items.filter((f) => arr(f.history).some((h) => isObject(h) && h.head === sha && h.status === "open")).length;

/**
 * A v1 `ledger.json` (whole, or the registry Fetch extracts from it) as the two v2 sections (§5.4), field by field:
 *
 * - every head goes to `design.heads` (`round1` `issues` becomes `items`, `skipped` becomes `clean` with a note); a reviewed head
 *   also goes to `review.heads`, with its review id, verdict and open count, and its context (`design-review` at the head, or
 *   `prelude` when round 1 was skipped); a round-1 post keeps its review id in `design`;
 * - `qa` and `purposes` go to `design`, a high-level `existing-reuse-common` key rewritten to `existing-feature`;
 * - posted items with an `N1` or `Q<n>` id go to `design.items` (an open one whose question round 1 no longer asks is closed as
 *   `moved` or `superseded`, with a reason), `F<n>` to `review.findings` unchanged.
 *
 * The review section is absent when no head was reviewed and no `F<n>` was recorded.
 */
export function migrateV1(v1: unknown): { design: Doc; review: Doc | undefined } {
  const v = isObject(v1) ? v1 : {};
  const qa = arr(v.qa).filter(isObject).map((q) => (typeof q.key === "string" ? { ...q, key: featureKey(q.key) } : q));
  const qaItem = new Map<string, string>();
  for (const q of arr(v.qa).filter(isObject)) if (typeof q.id === "string" && typeof q.item === "string") qaItem.set(q.id, q.item);
  const findings = arr(v.findings).filter(isObject);
  const round1 = findings.filter((f) => typeof f.id === "string" && isDesignId(f.id));
  const items = round1.map((f) => {
    const keyed: Doc = typeof f.key === "string" ? { ...f, key: featureKey(f.key) } : { ...f };
    const closed = f.state === "open" || f.state === undefined ? closedBy(f, qaItem.get(String(f.id))) : undefined;
    return closed === undefined ? keyed : { ...keyed, state: closed.state, reason: closed.reason };
  });
  const designHeads: Doc[] = [];
  const reviewHeads: Doc[] = [];
  for (const h of arr(v.heads).filter(isObject)) {
    const sha = str(h.sha);
    if (sha === undefined) continue;
    const skipped = h.round1 === "skipped";
    const gated = h.round1 === "issues" || h.round1 === "clean" || skipped;
    const open = openAt(round1, sha);
    designHeads.push({
      sha,
      ...(h.base !== undefined ? { base: h.base } : {}),
      ...(h.files !== undefined ? { files: h.files } : {}),
      ...(h.commits !== undefined ? { commits: h.commits } : {}),
      ...(h.facts !== undefined ? { facts: h.facts } : {}),
      ...(gated ? { round1: h.round1 === "issues" ? "items" : "clean", open } : {}),
      ...(h.round1 === "issues" && h.reviewId !== undefined ? { reviewId: h.reviewId } : {}),
      ...(h.round1 === "issues" && h.reviewUrl !== undefined ? { reviewUrl: h.reviewUrl } : {}),
      ...(skipped ? { note: SKIPPED_NOTE } : {}),
    });
    if (h.reviewed === true) {
      reviewHeads.push({
        sha,
        ...(h.base !== undefined ? { base: h.base } : {}),
        context: skipped ? { source: "prelude" } : { source: "design-review", head: sha },
        round1: skipped ? null : { head: sha, open },
        ...(h.reviewId !== undefined ? { reviewId: h.reviewId } : {}),
        ...(h.reviewUrl !== undefined ? { reviewUrl: h.reviewUrl } : {}),
        ...(h.verdict !== undefined ? { verdict: h.verdict } : {}),
        ...(h.open !== undefined ? { open: h.open } : {}),
        leads: { given: 0, raised: 0 },
      });
    }
  }
  const reviewFindings = findings.filter((f) => typeof f.id === "string" && isReviewId(f.id));
  const design: Doc = { schema: DESIGN_SCHEMA, heads: designHeads, purposes: arr(v.purposes), qa, items };
  const review = reviewHeads.length > 0 || reviewFindings.length > 0 ? { schema: REVIEW_SCHEMA, heads: reviewHeads, findings: reviewFindings } : undefined;
  return { design, review };
}

// ---- Git object ids, so a baseline and a migrated subtree can be named before anything is written ----

const sha1 = (b: Buffer): string => createHash("sha1").update(b).digest("hex");

/** The id `git hash-object` gives `text` (UTF-8). */
export function blobId(text: string): string {
  const body = Buffer.from(text, "utf8");
  return sha1(Buffer.concat([Buffer.from(`blob ${body.length}\0`, "utf8"), body]));
}

/** The id `git mktree` gives a tree of these entries (blobs `100644` and trees `40000`), in Git's order. */
export function treeId(entries: ReadonlyArray<{ name: string; id: string; tree?: boolean }>): string {
  const key = (e: { name: string; tree?: boolean }): string => (e.tree === true ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(key(a), "utf8"), Buffer.from(key(b), "utf8")));
  const body = Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.tree === true ? "40000" : "100644"} ${e.name}\0`, "utf8"), Buffer.from(e.id, "hex")])));
  return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`, "utf8"), body]));
}

/**
 * The subtrees a migration of v1 commit `listing` builds: `design/` holds the migrated `ledger.json` and its `ledger.md` beside
 * the v1 commit's own `report.json`, `qa.json` and `necessity.json` (whichever it has), `review/` the migrated `ledger.json` and
 * the section's `ledger.md`. `listing` maps a v1 commit's paths to their blob ids.
 */
export function migratedTrees(v1: unknown, pull: Pull, listing: ReadonlyMap<string, string>): { design: string; review: string | "absent"; json: { design: string; review: string | undefined } } {
  const m = migrateV1(v1);
  const json = { design: JSON.stringify(m.design), review: m.review === undefined ? undefined : JSON.stringify(m.review) };
  const kept = ["necessity.json", "qa.json", "report.json"].flatMap((name) => (listing.has(name) ? [{ name, id: listing.get(name)! }] : []));
  const design = treeId([{ name: "ledger.json", id: blobId(json.design) }, { name: "ledger.md", id: blobId(migratedDesignMarkdown(pull)) }, ...kept]);
  const review = json.review === undefined ? "absent" : treeId([{ name: "ledger.json", id: blobId(json.review) }, { name: "ledger.md", id: blobId(reviewMarkdown(pull)) }]);
  return { design, review, json };
}
