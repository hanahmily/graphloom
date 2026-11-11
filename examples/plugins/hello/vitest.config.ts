// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSetup = fileURLToPath(new URL("../../../vitest.global-setup.mjs", import.meta.url));

export default defineConfig({
  test: {
    // Bounded parallelism: one test run must not exhaust the machine's memory
    // (every worker loads the full module graph). GRAPHLOOM_TEST_WORKERS overrides.
    maxWorkers: Number(process.env.GRAPHLOOM_TEST_WORKERS) || 6,
    execArgv: ["--max-old-space-size=2048"],
    // Vitest 3 could fail a passing run with the unhandled error `[vitest-worker]: Timeout calling "onTaskUpdate"` when a
    // starved CI runner delayed its birpc reporting channel (60s default timeout). Vitest 4 turns that timeout off; this
    // keeps any leftover from failing the run. Every other unhandled error still fails it.
    onUnhandledError: (error) => (/^\[vitest-worker\]: Timeout calling "onTaskUpdate"/.test(String(error.message)) ? false : undefined),
    // Bundles are copied alone for repair qualification; only use the repo-root setup when present.
    globalSetup: existsSync(sharedSetup) ? [sharedSetup] : [],
    include: ["test/**/*.test.ts"],
  },
});
