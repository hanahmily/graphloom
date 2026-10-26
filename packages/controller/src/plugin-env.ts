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
