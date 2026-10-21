import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSetup = fileURLToPath(new URL("../../../vitest.global-setup.mjs", import.meta.url));

export default defineConfig({
  test: {
    // Bundles are copied alone for repair qualification; only use the repo-root setup when present.
    globalSetup: existsSync(sharedSetup) ? [sharedSetup] : [],
  },
});
