// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_HARNESS, CODEX_HARNESS_CAPABILITIES } from "./codex-harness.js";
import { harnessConformance } from "./testing/harness-conformance.js";
import { codexObservedAs, fakeCodex, fakeCodexHarness, fakeCodexStepFor } from "./testing/fake-codex.js";
import { loggingSessions } from "./testing/fake-claude.js";
import type { ScriptLog } from "./testing/scripted-harness.js";

// The patch case runs a real (fake) Codex process in the candidate root.
const candidateRoot = path.join(mkdtempSync(path.join(os.tmpdir(), "gl-codex-conf-")), "repairs", "a1", "candidate");
mkdirSync(candidateRoot, { recursive: true });

// The real Codex harness (its threads, prompts, resume, failure mapping, and
// step recording), with the fake CLI in place of `codex`.
harnessConformance({
  name: CODEX_HARNESS,
  capabilities: CODEX_HARNESS_CAPABILITIES,
  mode: "reply",
  candidateRoot,
  timeoutMs: 60_000,
  observedAs: codexObservedAs,
  build({ script, models, transientRetryBaseMs, quotaRetryMs }) {
    const fake = fakeCodex(script.map(fakeCodexStepFor));
    const log: ScriptLog = { prompts: [], opened: [], setModel: [], granted: [], revoked: [], closed: [], compactions: 0, toolCalls: [] };
    const harness = fakeCodexHarness(fake, {
      configuredModels: models,
      observeSession: loggingSessions(log, "codex-session"),
      ...(transientRetryBaseMs !== undefined ? { transientRetryBaseMs } : {}),
      ...(quotaRetryMs !== undefined ? { quotaRetryMs } : {}),
    });
    return { harness, log, start: () => harness.start(), remaining: () => fake.remaining() };
  },
});
