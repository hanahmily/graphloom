#!/usr/bin/env node
/**
 * Replaces the compiled rehearsal stand-ins' `#!/usr/bin/env node` shebang
 * with the absolute path of the Node that built them. `createCodexHarness`/
 * `createClaudeCodeHarness` spawn these as the whole command (no `node
 * <script>` wrapper, since the CLI args are fixed), so they rely on their own
 * shebang to find an interpreter. `env node` resolves via `PATH`, which a
 * rehearsed graph's own environment declaration may rebind — a plugin
 * checking for a specific `node` on PATH (as banyandb-fix's does) can shadow
 * the real one with a fake that exits before ever running the stand-in's own
 * code, failing as a silent, hard-to-diagnose "exited 0, no result". An
 * absolute path removes the dependency on PATH entirely.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/rehearsal");
const files = ["codex-standin.js", "claude-standin.js"].map((f) => path.join(dist, f));

for (const file of files) {
  const contents = readFileSync(file, "utf8");
  const patched = contents.replace(/^#!.*\n/, `#!${process.execPath}\n`);
  writeFileSync(file, patched, "utf8");
  chmodSync(file, 0o755);
}
