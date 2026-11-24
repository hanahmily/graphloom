// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import path from "node:path";
import { parseTaskYaml } from "@graphloom/controller";
import { submissionBlocker } from "@graphloom/hub";
import type { HubArchiveEntry, HubRequestSummary, HubSchedulingState, HubStatus, HubSubmission } from "@graphloom/sdk";
import { boundedText } from "./hub-input.js";

/** History search over live submissions and the archive index (docs/design-run-hub.md §3.1). */
export interface HubListFilter {
  states?: HubSchedulingState[];
  graph?: string;
  /** An absolute path matches the repository exactly; anything else is a substring of its path. */
  repo?: string;
  key?: string;
  /** Inclusive ISO bounds on acceptance time. */
  since?: string;
  until?: string;
  /** Case-insensitive text in the request or the blocker. */
  grep?: string;
  limit?: number;
  archived?: boolean;
}

export const HUB_STATES: readonly HubSchedulingState[] = ["queued", "starting", "running", "stopping", "waiting", "paused", "blocked", "succeeded", "failed", "canceled"];
export const HUB_LIST_LIMIT_MAX = 10_000;
const SEARCH_PARAMS = ["state", "graph", "repo", "key", "since", "until", "grep", "limit", "archived"];

/** The search a `GET /v1/submissions` query names, or undefined for the plain queue listing. */
export function parseListQuery(query: URLSearchParams): HubListFilter | undefined {
  for (const name of query.keys()) if (!SEARCH_PARAMS.includes(name)) throw new Error(`unknown list parameter: ${name}`);
  if ([...query.keys()].length === 0) return undefined;
  const one = (name: string): string | undefined => {
    const values = query.getAll(name);
    if (values.length > 1) throw new Error(`list parameter ${name} is given twice`);
    if (values[0] !== undefined && (values[0].length === 0 || values[0].length > 4096 || values[0].includes("\0"))) throw new Error(`invalid list parameter ${name}`);
    return values[0];
  };
  const states = query.getAll("state");
  for (const state of states) if (!HUB_STATES.includes(state as HubSchedulingState)) throw new Error(`state must be one of ${HUB_STATES.join(", ")}`);
  const time = (name: string): string | undefined => {
    const value = one(name);
    if (value === undefined) return undefined;
    if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO time`);
    return new Date(Date.parse(value)).toISOString();
  };
  const limitText = one("limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIST_LIMIT_MAX)) throw new Error(`limit must be an integer from 1 to ${HUB_LIST_LIMIT_MAX}`);
  const archived = one("archived");
  if (archived !== undefined && !["true", "false"].includes(archived)) throw new Error("archived must be true or false");
  const filter: HubListFilter = {
    ...(states.length ? { states: states as HubSchedulingState[] } : {}),
    ...(one("graph") !== undefined ? { graph: one("graph")! } : {}),
    ...(one("repo") !== undefined ? { repo: one("repo")! } : {}),
    ...(one("key") !== undefined ? { key: one("key")! } : {}),
    ...(time("since") !== undefined ? { since: time("since")! } : {}),
    ...(time("until") !== undefined ? { until: time("until")! } : {}),
    ...(one("grep") !== undefined ? { grep: one("grep")! } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(archived === "true" ? { archived: true } : {}),
  };
  return filter;
}

/** The query string for `filter`, the inverse of `parseListQuery`. */
export function listQuery(filter: HubListFilter): URLSearchParams {
  const query = new URLSearchParams();
  for (const state of filter.states ?? []) query.append("state", state);
  for (const name of ["graph", "repo", "key", "since", "until", "grep"] as const) if (filter[name] !== undefined) query.set(name, filter[name]!);
  if (filter.limit !== undefined) query.set("limit", String(filter.limit));
  if (filter.archived) query.set("archived", "true");
  return query;
}

/** A row both a live submission and an archive entry project to. */
interface Row { id: string; state: string; acceptedAt: string; key?: string; graph?: string; repoPath: string; request: string; blocker?: string; }

function matches(filter: HubListFilter, row: Row): boolean {
  if (filter.states && !filter.states.includes(row.state as HubSchedulingState)) return false;
  if (filter.graph !== undefined && row.graph !== filter.graph) return false;
  if (filter.repo !== undefined && (path.isAbsolute(filter.repo) ? path.resolve(row.repoPath) !== path.resolve(filter.repo) : !row.repoPath.includes(filter.repo))) return false;
  if (filter.key !== undefined && !(row.key ?? "").includes(filter.key)) return false;
  const accepted = Date.parse(row.acceptedAt);
  if (filter.since !== undefined && accepted < Date.parse(filter.since)) return false;
  if (filter.until !== undefined && accepted > Date.parse(filter.until)) return false;
  if (filter.grep !== undefined) {
    const needle = filter.grep.toLowerCase();
    if (!row.request.toLowerCase().includes(needle) && !(row.blocker ?? "").toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** What a live submission asked for: the request's full text (for --grep) and its summary. */
export interface LiveRequest { summary: HubRequestSummary; text: string; }

/**
 * Filters live submissions and (with `archived`) the archive index, newest acceptance
 * first, then applies `limit` across both. Index entries for a submission still live
 * (an archive interrupted before its snapshot committed) are skipped.
 */
export function searchHub(status: HubStatus, archive: readonly HubArchiveEntry[], requests: ReadonlyMap<string, LiveRequest>, filter: HubListFilter): HubStatus {
  const live = status.submissions.filter((item) => {
    const request = requests.get(item.id);
    return matches(filter, { id: item.id, state: item.state, acceptedAt: item.acceptedAt, ...(item.key !== undefined ? { key: item.key } : {}), ...(request?.summary.graph !== undefined ? { graph: request.summary.graph } : {}), repoPath: item.input.repoPath, request: request?.text ?? "", ...(blockerOf(item) !== undefined ? { blocker: blockerOf(item)! } : {}) });
  });
  const liveIds = new Set(status.submissions.map((item) => item.id));
  const archived = filter.archived ? archive.filter((entry) => !liveIds.has(entry.id) && matches(filter, {
    id: entry.id, state: entry.state, acceptedAt: entry.acceptedAt, ...(entry.key !== undefined ? { key: entry.key } : {}), ...(entry.graph !== undefined ? { graph: entry.graph } : {}),
    repoPath: entry.repoPath, request: entry.request?.firstLine ?? "", ...(entry.blocker !== undefined ? { blocker: entry.blocker } : {}),
  })) : [];
  const rows = [...live.map((item) => ({ at: item.acceptedAt, id: item.id, live: item as HubSubmission | undefined, entry: undefined as HubArchiveEntry | undefined })),
    ...archived.map((entry) => ({ at: entry.acceptedAt, id: entry.id, live: undefined, entry }))];
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  const kept = filter.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  const submissions = kept.flatMap((row) => row.live ? [row.live] : []);
  const summaries = Object.fromEntries(submissions.flatMap((item) => requests.has(item.id) ? [[item.id, requests.get(item.id)!.summary]] : []));
  return {
    ...status, submissions, summaries, matched: rows.length,
    ...(filter.archived ? { archived: kept.flatMap((row) => row.entry ? [row.entry] : []) } : {}),
  };
}

/** A live submission's blocker, none for a succeeded one. */
export function blockerOf(item: HubSubmission): string | undefined { return submissionBlocker(item); }

/** The request summary and text of a captured task; never throws (unreadable means no graph, empty request). */
export async function readLiveRequest(taskFile: string): Promise<LiveRequest> {
  try {
    const task = parseTaskYaml(await boundedText(taskFile, 256 * 1024));
    return { summary: summarizeRequest(task.graph, task.request), text: task.request };
  } catch {
    return { summary: summarizeRequest(undefined, ""), text: "" };
  }
}

export function summarizeRequest(graph: string | undefined, request: string): HubRequestSummary {
  const line = request.split("\n").map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  return {
    ...(graph !== undefined ? { graph } : {}),
    digest: createHash("sha256").update(request).digest("hex"),
    firstLine: line.length > 200 ? `${line.slice(0, 199)}…` : line,
  };
}
