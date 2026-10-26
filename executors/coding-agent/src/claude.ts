// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createClaudeCodeHarness } from "./claude-harness.js";

export { createClaudeCodeHarness, type ClaudeCodeHarnessOptions } from "./claude-harness.js";
export {
  CLAUDE_API_KEY_CREDENTIAL,
  CLAUDE_BIN_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_MODEL_ENV,
  CLAUDE_PASS_ENV_ENV,
  CLAUDE_RESPONSE_TIMEOUT_ENV,
  CLAUDE_STARTUP_TIMEOUT_ENV,
} from "./claude-config.js";

/** Default export for `GRAPHLOOM_CODING_HARNESS` pointing at this module; configured from the environment. */
export const harness = createClaudeCodeHarness();
