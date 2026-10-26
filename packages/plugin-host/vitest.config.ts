// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../vitest.global-setup.mjs"],
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
