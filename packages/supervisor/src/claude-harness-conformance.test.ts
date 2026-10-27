// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_CODE_HARNESS, CLAUDE_HARNESS_CAPABILITIES } from "./claude-harness.js";
import { harnessConformance } from "./testing/harness-conformance.js";
import { fakeClaude, fakeClaudeHarness, fakeStepFor, loggingSessions } from "./testing/fake-claude.js";
import type { ScriptLog } from "./testing/scripted-harness.js";

// The patch case runs a real (fake) Claude Code process in the candidate root.
const candidateRoot = path.join(mkdtempSync(path.join(os.tmpdir(), "gl-claude-conf-")), "repairs", "a1", "candidate");
mkdirSync(candidateRoot, { recursive: true });

// The real Claude Code harness (its sessions, prompts, resume, failure
// mapping, and step recording), with the fake CLI in place of `claude`.
harnessConformance({
  name: CLAUDE_CODE_HARNESS,
  capabilities: CLAUDE_HARNESS_CAPABILITIES,
  mode: "reply",
  candidateRoot,
  timeoutMs: 60_000,
  build({ script, models, transientRetryBaseMs, quotaRetryMs }) {
    const fake = fakeClaude(script.map(fakeStepFor));
    const log: ScriptLog = { prompts: [], opened: [], setModel: [], granted: [], revoked: [], closed: [], compactions: 0, toolCalls: [] };
    const harness = fakeClaudeHarness(fake, {
      configuredModels: models,
      observeSession: loggingSessions(log),
      ...(transientRetryBaseMs !== undefined ? { transientRetryBaseMs } : {}),
      ...(quotaRetryMs !== undefined ? { quotaRetryMs } : {}),
    });
    return { harness, log, start: () => harness.start(), remaining: () => fake.remaining() };
  },
});
