// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { configDefaults, defineConfig } from "vitest/config";
import { excludedFiles, onlyFiles, selectionFromEnv } from "./test/tiers.js";

// The test tier (test/tiers.ts): unset, everything runs; CI's pull-request jobs set GRAPHLOOM_TEST_TIER=pr.
const selection = selectionFromEnv(process.env);

export default defineConfig({
  test: {
    // Bounded parallelism: one test run must not exhaust the machine's memory
    // (every worker loads the full module graph). GRAPHLOOM_TEST_WORKERS overrides.
    maxWorkers: Number(process.env.GRAPHLOOM_TEST_WORKERS) || 6,
    execArgv: ["--max-old-space-size=2048"],
    globalSetup: ["../../vitest.global-setup.mjs"],
    include: onlyFiles(selection) ?? ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...excludedFiles(selection)],
    testTimeout: 30_000,
  },
});
