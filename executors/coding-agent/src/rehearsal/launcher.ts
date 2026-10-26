// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes an executable `sh` launcher `<dir>/<name>` for a rehearsal stand-in
 * script, `exec <this Node> <stand-in> "$@"`, and returns its path. Bind it
 * as `claude.command`/`codex.command`: the harness spawns it as the whole
 * command, and a graph's environment checks run it from a shell
 * (`"$GRAPHLOOM_CLAUDE_BIN" --version`). So the stand-in needs no executable
 * bit, no `node` on `PATH`, and no shebang naming the Node of the machine
 * that built it (docs/design-release.md §2.7). The Node path is written on
 * the running machine, into a scratch directory, and never shipped.
 */
export async function writeStandInLauncher(dir: string, name: string, standIn: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const launcher = path.join(dir, name);
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(standIn)} "$@"\n`, { mode: 0o755 });
  return launcher;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
