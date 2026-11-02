// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { afterEach, describe, expect, it } from "vitest";
import { sanitizedPluginEnv } from "./plugin-env.js";

describe("the plugin worker's environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("carries the operator's wire bound to the worker, which parses the controller's requests with it", () => {
    process.env.GRAPHLOOM_MAX_WIRE_BYTES = "128000000";
    expect(sanitizedPluginEnv("/bundle").GRAPHLOOM_MAX_WIRE_BYTES).toBe("128000000");
  });

  it("still drops credentials and preload hooks", () => {
    process.env.GITHUB_TOKEN = "secret";
    process.env.NODE_OPTIONS = "--require /evil.js";
    process.env.ANTHROPIC_API_KEY = "secret";
    const env = sanitizedPluginEnv("/bundle");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GRAPHLOOM_PLUGIN_CWD).toBe("/bundle");
  });
});
