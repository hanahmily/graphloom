// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Environment an agent and its commands need to run, find logins, and reach the network. */
const BASE_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Where the runner points toolchain state when it confines the job to the run (see runner confine.ts).
  "GOENV",
  "GOCACHE",
  "GOTMPDIR",
  "GOMODCACHE",
  "GOPROXY",
  "GOFLAGS",
  "npm_config_cache",
  "YARN_CACHE_FOLDER",
  "PIP_CACHE_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** The basics and locale (`LC_*`) from `env`, plus the names in `passEnv`; never the rest. */
export function minimalEnv(env: NodeJS.ProcessEnv, passEnv: readonly string[]): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (BASE_ENV.has(name) || name.startsWith("LC_") || passEnv.includes(name))) kept[name] = value;
  }
  return kept;
}

/** Names from a comma-separated list, such as a `*_PASS_ENV` setting. */
export function envList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}
