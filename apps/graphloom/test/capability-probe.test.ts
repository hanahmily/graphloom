import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE_ADAPTER_FLAGS, CODEX_ADAPTER_FLAGS } from "@graphloom/executor-coding-agent";
import { probeHarnessCapabilities } from "../src/capability-probe.js";
import type { RunnerConfig } from "../src/runner-config.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fake CLI whose `--help` (or `exec --help`) prints every real adapter flag, so it reports "passed" unless told to drop one. */
async function fakeBinary(dir: string, name: string, helpArgs: string[], flags: readonly string[], omit: string[] = []): Promise<string> {
  const bin = path.join(dir, name);
  const help = flags.filter((f) => !omit.includes(f)).join(" ");
  await mkdir(dir, { recursive: true });
  await writeFile(
    bin,
    `#!/bin/sh\n[ "$*" = "${helpArgs.join(" ")}" ] && { echo "${help}"; exit 0; }\nexit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe("harness capability probe (B2)", () => {
  it("reports unverified without a runner configured", async () => {
    expect(await probeHarnessCapabilities(undefined)).toMatchObject({ status: "unverified" });
  });

  it("passes when every configured spawned-CLI harness's --help names every flag its adapter uses", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-capability-"));
    dirs.push(dir);
    const claude = await fakeBinary(dir, "claude", ["--help"], CLAUDE_CODE_ADAPTER_FLAGS);
    const codex = await fakeBinary(dir, "codex", ["exec", "--help"], CODEX_ADAPTER_FLAGS);
    const config: RunnerConfig = {
      harness: "claude-code",
      harnesses: ["claude-code", "codex", "pi"],
      allowUnrestricted: true,
      claude: { command: claude },
      codex: { command: codex },
    };
    const result = await probeHarnessCapabilities(config);
    expect(result.status).toBe("passed");
    expect(result.notes).toEqual([]);
    expect(result.helpText["claude-code"]).toContain(CLAUDE_CODE_ADAPTER_FLAGS[0]);
    expect(result.helpText["codex"]).toContain(CODEX_ADAPTER_FLAGS[0]);
  });

  it("never checks pi, which has no CLI or --help to ask", async () => {
    const config: RunnerConfig = { harness: "pi", allowUnrestricted: true };
    expect(await probeHarnessCapabilities(config)).toEqual({ status: "passed", notes: [], helpText: {} });
  });

  it("fails when a configured binary's own --help is missing a flag its adapter depends on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-capability-"));
    dirs.push(dir);
    const claude = await fakeBinary(dir, "claude", ["--help"], CLAUDE_CODE_ADAPTER_FLAGS, ["--resume", "--json-schema"]);
    const config: RunnerConfig = { harness: "claude-code", allowUnrestricted: true, claude: { command: claude } };
    const result = await probeHarnessCapabilities(config);
    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("--resume");
    expect(result.notes[0]).toContain("--json-schema");
  });

  it("does not let one flag's name satisfy another it merely prefixes", async () => {
    // Regression: a substring check let "--model-provider" (present) satisfy
    // the required "--model" (absent), producing a false B2 pass for a binary
    // that does not actually have the flag the adapter depends on.
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-capability-"));
    dirs.push(dir);
    const flagsWithoutModel = CODEX_ADAPTER_FLAGS.filter((f) => f !== "--model");
    const help = [...flagsWithoutModel, "--model-provider"].join(" ");
    const codex = path.join(dir, "codex");
    await mkdir(dir, { recursive: true });
    await writeFile(codex, `#!/bin/sh\n[ "$*" = "exec --help" ] && { echo "${help}"; exit 0; }\nexit 1\n`, { mode: 0o755 });
    const config: RunnerConfig = { harness: "codex", allowUnrestricted: true, codex: { command: codex } };
    const result = await probeHarnessCapabilities(config);
    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("--model");
  });

  it("reports unverified, never a pass, when a configured binary's --help cannot be read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-capability-"));
    dirs.push(dir);
    const config: RunnerConfig = { harness: "codex", allowUnrestricted: true, codex: { command: path.join(dir, "does-not-exist") } };
    const result = await probeHarnessCapabilities(config);
    expect(result.status).toBe("unverified");
    expect(result.notes[0]).toContain("could not be read");
  });

  it("fails overall even when one harness is unverified, if another configured one is missing a flag", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-capability-"));
    dirs.push(dir);
    const claude = await fakeBinary(dir, "claude", ["--help"], CLAUDE_CODE_ADAPTER_FLAGS, ["--mcp-config"]);
    const config: RunnerConfig = {
      harness: "claude-code",
      harnesses: ["claude-code", "codex"],
      allowUnrestricted: true,
      claude: { command: claude },
      codex: { command: path.join(dir, "does-not-exist") },
    };
    const result = await probeHarnessCapabilities(config);
    expect(result.status).toBe("failed");
    expect(result.notes.some((n) => n.includes("--mcp-config"))).toBe(true);
    expect(result.notes.some((n) => n.includes("could not be read"))).toBe(true);
  });
});
