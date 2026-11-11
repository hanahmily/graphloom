// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSetup = fileURLToPath(new URL("../../vitest.global-setup.mjs", import.meta.url));

export default defineConfig({
  test: {
    // Bounded parallelism: one test run must not exhaust the machine's memory
    // (every worker loads the full module graph). GRAPHLOOM_TEST_WORKERS overrides.
    maxWorkers: Number(process.env.GRAPHLOOM_TEST_WORKERS) || 6,
    execArgv: ["--max-old-space-size=2048"],
    // Bundles are copied alone for repair qualification; only use the repo-root setup when present.
    globalSetup: existsSync(sharedSetup) ? [sharedSetup] : [],
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
