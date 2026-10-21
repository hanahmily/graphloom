import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../vitest.global-setup.mjs"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
