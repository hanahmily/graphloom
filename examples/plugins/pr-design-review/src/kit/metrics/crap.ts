// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// CRAP and the operator's thresholds (design-code-quality-metrics.md §2.1, §2.2, §2.4).

import type { Coverage, MetricsRecord } from "./record.js";

export const LIMITS = {
  /** Rule: complexity < 10. */
  complexity: 10,
  /** Rule: nesting <= 3. */
  nesting: 3,
  /** CRAP at or above this triggers follow-up. */
  crap: 30,
} as const;

/** cov(m) in [0, 1]. A function with no executable statements has nothing uncovered. */
export function coverageFraction(coverage: Coverage | undefined): number {
  if (coverage === undefined || coverage.source === "unknown") return 0;
  if (coverage.total === 0) return 1;
  return coverage.covered / coverage.total;
}

/** CRAP(m) = comp^2 * (1 - cov)^3 + comp, unrounded. Unknown coverage is cov = 0, the upper bound. */
export function crapValue(complexity: number, coverage: Coverage | undefined): number {
  const cov = coverageFraction(coverage);
  return complexity ** 2 * (1 - cov) ** 3 + complexity;
}

/** The value as a record stores it: two decimals. */
export function crapRounded(complexity: number, coverage: Coverage | undefined): number {
  return Math.round(crapValue(complexity, coverage) * 100) / 100;
}

export interface ThresholdResult {
  complexity: { value: number; limit: number; exceeded: boolean };
  nesting: { value: number; limit: number; exceeded: boolean };
  crap: { value: number; limit: number; upperBound: boolean; triggers: boolean };
  /** Unknown coverage and complexity >= 10: ask for the missing coverage. */
  coverageQuestion: boolean;
}

/**
 * Applies the rules to a record. With unknown coverage the upper-bound CRAP
 * is shown but triggers follow-up only when complexity >= 10; with measured
 * coverage, CRAP >= 30 triggers.
 */
export function checkThresholds(record: Pick<MetricsRecord, "complexity" | "nesting" | "coverage">): ThresholdResult {
  const unknown = record.coverage === undefined || record.coverage.source === "unknown";
  const value = crapRounded(record.complexity, record.coverage);
  const complexityExceeded = record.complexity >= LIMITS.complexity;
  return {
    complexity: { value: record.complexity, limit: LIMITS.complexity, exceeded: complexityExceeded },
    nesting: { value: record.nesting, limit: LIMITS.nesting, exceeded: record.nesting > LIMITS.nesting },
    crap: {
      value,
      limit: LIMITS.crap,
      upperBound: unknown,
      triggers: value >= LIMITS.crap && (!unknown || complexityExceeded),
    },
    coverageQuestion: unknown && complexityExceeded,
  };
}

export type Metric = "complexity" | "nesting";

/** Whether a value breaks its limit: complexity of 10 or more, nesting over 3. */
export const exceeds = (metric: Metric, value: number): boolean => (metric === "complexity" ? value >= LIMITS.complexity : value > LIMITS.nesting);

/**
 * Where a function's value comes from (design §6.8): a new function's is the pull request's own. A modified function's is
 * `inherited` when the base already broke the limit and the change did not raise it, `worse` when the base already broke it
 * and the change raised it, `introduced` when the base was within the limit and the head is not, and `unknown` when the base
 * value could not be measured.
 */
export type Origin = "new" | "introduced" | "inherited" | "worse" | "within" | "unknown";

export function originOf(r: Pick<MetricsRecord, "complexity" | "nesting" | "change" | "base">, metric: Metric): { origin: Origin; head: number; base?: number } {
  const head = r[metric];
  if (r.change === "added") return { origin: "new", head };
  if (r.base === undefined || "unavailable" in r.base) return { origin: "unknown", head };
  const base = r.base[metric];
  if (!exceeds(metric, head)) return { origin: "within", head, base };
  if (!exceeds(metric, base)) return { origin: "introduced", head, base };
  return { origin: head > base ? "worse" : "inherited", head, base };
}

/** The sentence a question or an answer uses for where an over-limit value comes from. */
export function originText(r: Pick<MetricsRecord, "complexity" | "nesting" | "change" | "base">, metric: Metric): string {
  const { origin, base, head } = originOf(r, metric);
  const limit = metric === "complexity" ? `the limit of < ${LIMITS.complexity}` : `the limit of ≤ ${LIMITS.nesting}`;
  switch (origin) {
    case "new":
      return `a new function, so the ${metric} is the pull request's own`;
    case "introduced":
      return `the pull request introduced it: ${metric} was ${base} at the base, within ${limit}`;
    case "worse":
      return `inherited and made worse: ${metric} was already over ${limit} at the base (${base}), and the pull request raised it to ${head}`;
    case "inherited":
      return `inherited: ${metric} was already ${base} at the base, over ${limit}, and the pull request did not raise it`;
    case "unknown":
      return `the base value is not known${r.base !== undefined && "unavailable" in r.base ? ` (${r.base.unavailable})` : ""}`;
    default:
      return `${metric} is within ${limit}`;
  }
}
