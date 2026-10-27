// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** A constructed `Discovery` for unit tests of the doctor's report and of setup (docs/design-release.md §4.4, §4.5). */
import os from "node:os";
import path from "node:path";
import type { Discovery } from "../src/discovery.js";
import type { HarnessName } from "../src/runner-config.js";

export interface FakeDiscoveryOptions {
  /** The harnesses that are available. Default all three. */
  available?: HarnessName[];
  /** Pi providers with a credential. Default `minimax-cn` when Pi is available. */
  piProviders?: string[];
  runnerFile?: string;
  supervisorFile?: string;
}

const PI_MODELS: Record<string, string[]> = {
  "minimax-cn": ["MiniMax-M2.7", "MiniMax-M3"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
};

export function fakeDiscovery(options: FakeDiscoveryOptions = {}): Discovery {
  const available = new Set(options.available ?? ["claude-code", "codex", "pi"]);
  const providers = options.piProviders ?? (available.has("pi") ? ["minimax-cn"] : []);
  const cli = (harness: "claude-code" | "codex") =>
    available.has(harness)
      ? { harness, command: harness === "claude-code" ? "claude" : "codex", commandSource: "PATH", path: `/stub/${harness}`, version: "1.0", probe: { status: "passed" as const, notes: [] }, login: "logged-in" as const, available: true }
      : { harness, command: harness === "claude-code" ? "claude" : "codex", commandSource: "PATH", path: `/stub/${harness}`, version: "1.0", probe: { status: "passed" as const, notes: [] }, login: "logged-out" as const, available: false, reason: "not logged in", fix: harness === "claude-code" ? "claude" : "codex login" };
  return {
    self: { record: { version: "0.0.0-dev", root: "/clone" } },
    root: "/clone",
    host: {
      platform: { ok: true, actual: "linux-x64", expected: "linux-x64" },
      git: { path: "/usr/bin/git", version: "git version 2" },
      flock: { path: "/usr/bin/flock", version: "flock 2" },
      confinement: { ok: true },
      integrity: { status: "pass", detail: "a clone", problems: [] },
    },
    claude: cli("claude-code"),
    codex: cli("codex"),
    pi: {
      agentDir: path.join(os.homedir(), ".pi", "agent"),
      credentials: providers.map((provider) => ({ provider, source: provider === "minimax-cn" ? "MINIMAX_CN_API_KEY" : "auth store" })),
      configured: [],
      models: Object.fromEntries(providers.map((p) => [p, PI_MODELS[p] ?? [`${p}-model`]])),
      available: available.has("pi") && providers.length > 0,
      ...(available.has("pi") && providers.length > 0 ? {} : { reason: "no Pi provider has a credential", fix: "export MINIMAX_CN_API_KEY=<key>" }),
    },
    gh: { repo: "hanahmily/graphloom", path: "/stub/gh", version: "gh 2", loggedIn: true, access: true, available: true },
    runner: { file: options.runnerFile ?? "/home/.config/graphloom/runner.json", explicit: false, exists: false },
    supervisor: { file: options.supervisorFile ?? "/home/.config/graphloom/supervisor.json", explicit: false, exists: false },
    updates: { mode: "auto", source: "the default", canVerify: false, sshKeygen: true },
    env: {},
  };
}
