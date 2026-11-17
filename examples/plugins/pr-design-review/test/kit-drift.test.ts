// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The review kit is vendored as source into src/kit/ (docs/design-pr-review-split.md §2): the copy must be the kit's
// bytes. A bundle copied alone (a repair qualification's candidate tree, a release install) has no kit beside it, and
// its copy is then the plugin's own source, so the check runs only in the repository.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const copy = path.join(root, "src", "kit");
const kit = path.join(root, "..", "review-kit", "src");
const SYNC = "change examples/plugins/review-kit/src, then run `npm run vendor -w @graphloom/plugin-pr-design-review` and regenerate the manifest";

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => (statSync(path.join(dir, name)).isDirectory() ? files(path.join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

/** Every difference between the kit and the copy, one line per file, naming the file. */
function kitDrift(kitDir: string, copyDir: string): string[] {
  const inKit = new Set(files(kitDir));
  const inCopy = existsSync(copyDir) ? new Set(files(copyDir)) : new Set<string>();
  const problems: string[] = [];
  for (const f of [...new Set([...inKit, ...inCopy])].sort()) {
    if (!inCopy.has(f)) problems.push(`src/kit/${f} is missing: the kit has review-kit/src/${f}`);
    else if (!inKit.has(f)) problems.push(`src/kit/${f} is not in the kit (review-kit/src/${f})`);
    else if (!readFileSync(path.join(kitDir, f)).equals(readFileSync(path.join(copyDir, f)))) problems.push(`src/kit/${f} differs from review-kit/src/${f}`);
  }
  return problems;
}

describe.skipIf(!existsSync(kit))("the vendored review kit", () => {
  it("src/kit/ is byte-identical to examples/plugins/review-kit/src", () => {
    const drift = kitDrift(kit, copy);
    expect(drift, drift.length === 0 ? "" : `${drift.join("\n")}\nThe kit is the source: ${SYNC}.`).toEqual([]);
  });
});

describe("the drift check", () => {
  it("names each file that differs, is missing from the copy, or is not in the kit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kit-drift-"));
    try {
      const write = (rel: string, text: string): void => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), text);
      };
      write("kit/same.ts", "a\n");
      write("kit/metrics/changed.ts", "b\n");
      write("kit/gone.ts", "c\n");
      write("copy/same.ts", "a\n");
      write("copy/metrics/changed.ts", "b \n");
      write("copy/extra.ts", "d\n");
      expect(kitDrift(path.join(dir, "kit"), path.join(dir, "copy"))).toEqual([
        "src/kit/extra.ts is not in the kit (review-kit/src/extra.ts)",
        "src/kit/gone.ts is missing: the kit has review-kit/src/gone.ts",
        "src/kit/metrics/changed.ts differs from review-kit/src/metrics/changed.ts",
      ]);
      expect(kitDrift(path.join(dir, "kit"), path.join(dir, "absent"))).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
