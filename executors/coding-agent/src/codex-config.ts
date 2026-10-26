// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Operator config for the Codex harness module (`@graphloom/executor-coding-agent/codex`). Codex uses its own login. */
export const CODEX_BIN_ENV = "GRAPHLOOM_CODEX_BIN";
export const CODEX_MODEL_ENV = "GRAPHLOOM_CODEX_MODEL";
/** Codex home (its login and config), which selects the account. */
export const CODEX_HOME_ENV = "GRAPHLOOM_CODEX_HOME";
/** Comma-separated names of extra environment variables Codex may see. */
export const CODEX_PASS_ENV_ENV = "GRAPHLOOM_CODEX_PASS_ENV";
export const CODEX_REASONING_EFFORT_ENV = "GRAPHLOOM_CODEX_REASONING_EFFORT";
export const CODEX_RESPONSE_TIMEOUT_ENV = "GRAPHLOOM_CODEX_RESPONSE_TIMEOUT_MS";
/** Codex's stall watchdog; it must be shorter than the coding job's timeout. */
export const CODEX_DEFAULT_RESPONSE_TIMEOUT_MS = 600_000;
