// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bounded parallelism: one test run must not exhaust the machine's memory
    // (every worker loads the full module graph). GRAPHLOOM_TEST_WORKERS overrides.
    maxWorkers: Number(process.env.GRAPHLOOM_TEST_WORKERS) || 6,
    minWorkers: 1,
    poolOptions: { forks: { execArgv: ["--max-old-space-size=2048"] } },
    globalSetup: ["../../vitest.global-setup.mjs"],
    include: ["src/**/*.test.ts"],
  },
});
