// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { machineChecks } from "../src/doctor.js";
import { probeConfiguredLaunchers, probeRefusal, sessionSetup } from "../src/session-launcher.js";
import { parseRunnerConfig } from "../src/runner-config.js";
import { fakeDiscovery } from "./discovery-fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-launcher-"));
  dirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("doctor: session launchers", () => {
  it("passes a launcher that lists the Claude fork flags, warns with the open's own refusal for one that rejects --help or resume, and says nothing for plain commands", async () => {
    const good = await script("hapi-claude", 'echo "--resume --fork-session --session-id --append-system-prompt"');
    const bad = await script("hapi-codex", 'echo "Unsupported shared Codex launch flag: --help" >&2; exit 1');
    const base = { harness: "claude-code", allowUnrestricted: true };
    const config = parseRunnerConfig({ ...base, claude: { sessionLauncher: [good] }, codex: { sessionLauncher: [bad, "codex"] } });
    const launchers = await probeConfiguredLaunchers(config, process.env);
    expect(launchers.map((l) => [l.harness, l.probe.ok])).toEqual([["claude-code", true], ["codex", false]]);
    const checks = machineChecks({ ...fakeDiscovery(), sessionLaunchers: launchers });
    const rows = checks.filter((c) => c.name.startsWith("session launcher"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "session launcher claude-code", status: "pass" });
    expect(rows[1]).toMatchObject({ name: "session launcher codex", status: "warn", detail: probeRefusal(launchers[1]!.setup, launchers[1]!.probe), fix: expect.stringContaining("remove codex.sessionLauncher") });
    expect(rows[1]!.detail).toContain("Unsupported shared Codex launch flag: --help");
    // No launcher set: no probe, no row.
    expect(await probeConfiguredLaunchers(parseRunnerConfig(base), {})).toEqual([]);
    expect(machineChecks(fakeDiscovery()).some((c) => c.name.startsWith("session launcher"))).toBe(false);
  });

  it("a Claude launcher whose --help lacks a flag fails the probe and names it; the environment override is probed as the open would", async () => {
    const partial = await script("partial", 'echo "--resume --session-id"');
    const [probe] = await probeConfiguredLaunchers(undefined, { GRAPHLOOM_CLAUDE_SESSION_LAUNCHER: `"${partial}"`, PATH: process.env.PATH });
    expect(probe!.setup.source).toBe("environment");
    expect(probe!.probe.ok).toBe(false);
    expect(probe!.probe.output).toBe("its --help does not list --fork-session, --append-system-prompt");
    expect(sessionSetup("claude-code", undefined, { GRAPHLOOM_CLAUDE_SESSION_LAUNCHER: "  " }).source).toBe("command");
    expect(() => sessionSetup("claude-code", undefined, { GRAPHLOOM_CLAUDE_SESSION_LAUNCHER: '"unterminated' })).toThrow(/GRAPHLOOM_CLAUDE_SESSION_LAUNCHER: unterminated quote/);
  });
});
