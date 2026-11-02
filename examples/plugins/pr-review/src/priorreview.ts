// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What one aspect's sweep is given of the earlier heads' findings (design §9.3): the open ones that can be judged on this head,
 * re-anchored to its patch; the ones settled without a model (the file is no longer in the change, or it lies outside this review's
 * scope); and the places where a new comment is suppressed, because an earlier finding, open or closed, already covers them.
 */
import type { Aspect } from "./aspects.js";
import { reanchor, type PriorItem, type PriorRegistry } from "./prior.js";
import type { PriorFinding, PriorOutcome } from "./review.js";
import type { PullFile } from "./snapshot.js";

export interface AspectPrior {
  /** The findings the first pass judges. */
  given: PriorFinding[];
  /** The findings settled without the sweep: `fixed` (their file left the change) or `open` (carried, not re-checked). */
  settled: PriorOutcome[];
  /** Where a new comment is left out: closed findings and the judged ones, at their place on this head. */
  suppress: Array<{ path: string; side: "RIGHT" | "LEFT"; start: number; end: number }>;
}

const at = (i: PriorItem): { path: string; side: "RIGHT" | "LEFT"; line: number; endLine: number } => ({ path: i.path ?? "", side: i.side ?? "RIGHT", line: i.line ?? 1, endLine: i.endLine ?? i.line ?? 1 });

export function aspectPrior(registry: PriorRegistry, aspect: Aspect, files: readonly PullFile[], scope: ReadonlySet<string>): AspectPrior {
  const out: AspectPrior = { given: [], settled: [], suppress: [] };
  for (const item of registry.items) {
    if (item.origin !== "round2" || item.path === undefined) continue;
    const where = reanchor(item, files);
    if (item.status !== "open") {
      // A closed finding is never raised again: a new comment over its place is dropped.
      if (where.state === "found") out.suppress.push({ path: item.path, side: item.side ?? "RIGHT", start: where.line, end: where.endLine });
      continue;
    }
    if (item.aspect !== aspect) {
      if (where.state === "found") out.suppress.push({ path: item.path, side: item.side ?? "RIGHT", start: where.line, end: where.endLine });
      continue;
    }
    const base = at(item);
    if (where.state === "gone") {
      out.settled.push({ id: item.id, status: "fixed", how: "gone", reason: "its file is no longer changed by the pull request", ...base, outdated: false });
      continue;
    }
    if (!scope.has(item.path)) {
      out.settled.push({ id: item.id, status: "open", how: "carried", reason: "its file is outside this review's scope, so it was not re-checked", ...base, outdated: false });
      continue;
    }
    const line = where.state === "found" ? where.line : base.line;
    const endLine = where.state === "found" ? where.endLine : base.endLine;
    if (where.state === "found") out.suppress.push({ path: item.path, side: base.side, start: line, end: endLine });
    out.given.push({ id: item.id, path: item.path, side: base.side, startLine: line, endLine, outdated: where.state === "outdated", severity: (item.severity as PriorFinding["severity"] | undefined) ?? "P2", kind: (item.kind as PriorFinding["kind"] | undefined) ?? "behavioral", text: item.text ?? "" });
  }
  return out;
}
