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
