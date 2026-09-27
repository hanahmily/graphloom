/**
 * Credential binding for an Anthropic API key. Without it, Claude Code uses its
 * own login (for example the user's Claude subscription).
 */
export const CLAUDE_API_KEY_CREDENTIAL = "anthropic-api-key";
/** Operator config for the Claude Code harness module (`@graphloom/executor-coding-agent/claude`). */
export const CLAUDE_BIN_ENV = "GRAPHLOOM_CLAUDE_BIN";
export const CLAUDE_MODEL_ENV = "GRAPHLOOM_CLAUDE_MODEL";
/** Comma-separated names of extra environment variables Claude Code may see. */
export const CLAUDE_PASS_ENV_ENV = "GRAPHLOOM_CLAUDE_PASS_ENV";
export const CLAUDE_STARTUP_TIMEOUT_ENV = "GRAPHLOOM_CLAUDE_STARTUP_TIMEOUT_MS";
export const CLAUDE_RESPONSE_TIMEOUT_ENV = "GRAPHLOOM_CLAUDE_RESPONSE_TIMEOUT_MS";
/** Claude Code's stall watchdogs; each must be shorter than the coding job's timeout. */
export const CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
export const CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS = 600_000;
