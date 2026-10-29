// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Changed-function scope (design-code-quality-metrics.md §1), shared by the
// tools and the validator so both apply one rule.

import type { FunctionIndexEntry } from "./record.js";

/**
 * A line is the function's own when it is in the function's range and not
 * strictly inside a nested function. A nested function's first and last
 * lines are shared with the function that holds it.
 */
export function isOwnLine(fn: FunctionIndexEntry, all: readonly FunctionIndexEntry[], line: number): boolean {
  if (line < fn[1] || line > fn[2]) return false;
  for (const other of all) {
    if (other === fn) continue;
    if (other[1] >= fn[1] && other[2] <= fn[2] && line > other[1] && line < other[2]) return false;
  }
  return true;
}

/**
 * "added" when every line of the function is changed, "modified" when one of
 * its own lines is changed, undefined when the function is untouched.
 */
export function classifyFunction(
  fn: FunctionIndexEntry,
  all: readonly FunctionIndexEntry[],
  changed: ReadonlySet<number>,
): "added" | "modified" | undefined {
  let allChanged = true;
  let touched = false;
  for (let l = fn[1]; l <= fn[2]; l++) {
    if (!changed.has(l)) allChanged = false;
    else if (isOwnLine(fn, all, l)) touched = true;
  }
  if (allChanged) return "added";
  return touched ? "modified" : undefined;
}
