// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createSupervisorHost } from "./host.js";
import { PI_HARNESS_CAPABILITIES, type HarnessCapabilities } from "./harness.js";
import { createPiHarness } from "./pi-harness.js";
import { harnessConformance } from "./testing/harness-conformance.js";
import { scriptedHarness, scriptedSessions } from "./testing/scripted-harness.js";

// The real Pi harness (createPiHarness: its start, restore and session
// opening), with scripted sessions in place of Pi agent sessions.
harnessConformance({
  name: "pi",
  capabilities: PI_HARNESS_CAPABILITIES,
  mode: "tools",
  build({ script, models, transientRetryBaseMs, quotaRetryMs }) {
    const sessions = scriptedSessions({ name: "pi", capabilities: PI_HARNESS_CAPABILITIES, mode: "tools", script });
    const harness = createPiHarness({
      runId: "run-conf",
      sessionDir: "/nonexistent/supervisor",
      configuredModels: models,
      ...(transientRetryBaseMs !== undefined ? { transientRetryBaseMs } : {}),
      ...(quotaRetryMs !== undefined ? { quotaRetryMs } : {}),
      sessionOpener: (model, role) => sessions.open(model, role),
    });
    return { harness, log: sessions.log, start: () => harness.start(), remaining: sessions.remaining };
  },
});

// A CLI-shaped harness: no GraphLoom tools (the JSON reply protocol), no
// compaction, resend, or in-session model switch, and investigation steps.
const CLI_CAPABILITIES: HarnessCapabilities = {
  toolCalling: false,
  inSessionModelSwitch: false,
  compaction: false,
  exactResend: false,
  exactProviderCalls: false,
  rawStreamCapture: false,
};

harnessConformance({
  name: "fake-cli",
  capabilities: CLI_CAPABILITIES,
  mode: "reply",
  build({ script, models, transientRetryBaseMs, quotaRetryMs }) {
    const fake = scriptedHarness({
      name: "fake-cli",
      capabilities: CLI_CAPABILITIES,
      mode: "reply",
      script,
      configuredModels: models,
      ...(transientRetryBaseMs !== undefined ? { transientRetryBaseMs } : {}),
    });
    return {
      harness: fake.harness,
      log: fake.log,
      remaining: fake.remaining,
      start: async () =>
        createSupervisorHost({
          harness: fake.harness,
          session: await fake.open(models[0]!),
          configuredModels: models,
          ...(transientRetryBaseMs !== undefined ? { transientRetryBaseMs } : {}),
          ...(quotaRetryMs !== undefined ? { quotaRetryMs } : {}),
        }),
    };
  },
});
