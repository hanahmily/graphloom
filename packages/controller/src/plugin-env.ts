// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Minimal env for plugin children — no inherited credentials or preload hooks. */
export function sanitizedPluginEnv(bundlePath: string): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    // The wire bound (packages/sdk validate.ts): the plugin worker parses the controller's requests with it, so an
    // operator's raised bound must reach the worker too, not only the controller's side.
    "GRAPHLOOM_MAX_WIRE_BYTES",
  ] as const;
  const env: NodeJS.ProcessEnv = {
    GRAPHLOOM_PLUGIN_CWD: bundlePath,
  };
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
