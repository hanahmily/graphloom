import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLAUDE_CODE_ADAPTER_FLAGS, CODEX_ADAPTER_FLAGS } from "@graphloom/executor-coding-agent";

/**
 * Fake `claude`/`codex` binaries satisfying both a graph's own environment
 * check (`--version`, `auth status`/`login status`) and B2's capability
 * probe (`--help`/`exec --help` naming every flag the real adapter passes),
 * so a test's own verdict does not depend on whether a real, logged-in
 * Claude Code or Codex happens to be installed on whatever machine runs it.
 */
export async function writeFakeCodingAgents(dir: string): Promise<{ bin: string; claude: string; codex: string }> {
  const bin = path.join(dir, "fake-coding-agents");
  await mkdir(bin, { recursive: true });
  const claude = path.join(bin, "claude");
  const codex = path.join(bin, "codex");
  await writeFile(
    claude,
    [
      "#!/bin/sh",
      `[ "$1" = "--help" ] && { echo "${CLAUDE_CODE_ADAPTER_FLAGS.join(" ")}"; exit 0; }`,
      '[ "$1" = "--version" ] && exit 0',
      '[ "$1 $2" = "auth status" ] && exit 0',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    codex,
    [
      "#!/bin/sh",
      `[ "$1 $2" = "exec --help" ] && { echo "${CODEX_ADAPTER_FLAGS.join(" ")}"; exit 0; }`,
      '[ "$1" = "--version" ] && exit 0',
      '[ "$1 $2" = "login status" ] && exit 0',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { bin, claude, codex };
}

/** A runner.json naming the fake binaries above, so B2 probes exactly them. */
export function fakeRunnerConfig(agents: { claude: string; codex?: string }): Record<string, unknown> {
  return {
    harness: "claude-code",
    ...(agents.codex !== undefined ? { harnesses: ["claude-code", "codex", "pi"] } : {}),
    allowUnrestricted: true,
    claude: { command: agents.claude },
    ...(agents.codex !== undefined ? { codex: { command: agents.codex } } : {}),
  };
}
