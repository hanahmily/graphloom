// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The shared metrics library. Everything except tsmetrics.ts is
// dependency-free, so it can be vendored into the issue-fix review kit.

export * from "./record.js";
export * from "./crap.js";
export * from "./generated.js";
export * from "./hunks.js";
export * from "./scope.js";
export * from "./validate.js";
export { analyzeTypeScript, runTsMetrics, type MeasuredFunction } from "./tsmetrics.js";
export * from "./coverage.js";
