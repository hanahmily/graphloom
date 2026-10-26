// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/check-headers.mjs is part of the gate (`npm test`); docs/design-release.md §2.8.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts", "check-headers.mjs");
const header = "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 Hongtao Gao and the GraphLoom contributors\n";
const shHeader = header.replaceAll("// ", "# ");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repo(files: Record<string, string>, untracked: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "graphloom-headers-"));
  dirs.push(root);
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) await write(rel, text);
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  // -f: tracked generated output (dist/) must still be exempt even when ignored files are added.
  expect(spawnSync("git", ["add", "-f", "--", "."], { cwd: root }).status).toBe(0);
  for (const [rel, text] of Object.entries(untracked)) await write(rel, text);
  return root;
}

function check(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const exempt = {
  "dist/index.js": "export {};\n",
  "src/types.d.ts": "export {};\n",
  "test/fixtures/graph.mjs": "export {};\n",
  "legacy/go/tool.sh": "echo legacy\n",
  "node_modules/dep/index.js": "module.exports = {};\n",
  "package.json": "{}\n",
  "README.md": "# readme\n",
};

describe("check-headers", () => {
  it("fails on a tracked source file without the header and names only that file", async () => {
    const root = await repo(
      { "src/ok.ts": `${header}\nexport const ok = 1;\n`, "src/missing.ts": "export const missing = 1;\n", ...exempt },
      { "src/untracked.ts": "export const untracked = 1;\n" },
    );
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("src/missing.ts");
    for (const rel of ["src/ok.ts", "src/untracked.ts", ...Object.keys(exempt)]) expect(result.output).not.toContain(rel);
  });

  it("passes when every covered file has the header, including after a shebang and in shell syntax", async () => {
    const root = await repo({
      "src/a.ts": `${header}\nexport const a = 1;\n`,
      "bin/cli.mjs": `#!/usr/bin/env node\n${header}\nconsole.log("hi");\n`,
      "scripts/run.sh": `#!/bin/sh\n${shHeader}\necho hi\n`,
      ...exempt,
    });
    expect(check(root).status).toBe(0);
  });

  it("rejects a header that is not at the top or has the wrong comment syntax", async () => {
    const root = await repo({
      "src/late.ts": `export const late = 1;\n${header}`,
      "scripts/run.sh": `${header}echo hi\n`,
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("src/late.ts");
    expect(result.output).toContain("scripts/run.sh");
  });

  it("--fix inserts the header after any shebang so the check then passes", async () => {
    const root = await repo({
      "bin/cli.mjs": "#!/usr/bin/env node\n/** Doc. */\nconsole.log(1);\n",
      "src/a.ts": "export const a = 1;\n",
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
    });
    expect(check(root, "--fix").status).toBe(0);
    expect(await readFile(path.join(root, "bin/cli.mjs"), "utf8")).toBe(`#!/usr/bin/env node\n${header}\n/** Doc. */\nconsole.log(1);\n`);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe(`${header}\nexport const a = 1;\n`);
    expect(await readFile(path.join(root, "scripts/run.sh"), "utf8")).toBe(`#!/bin/sh\n${shHeader}\necho hi\n`);
    expect(check(root).status).toBe(0);
  });

  it("walks a tree without Git metadata, as in the release staging tree, with the same exemptions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "graphloom-headers-archive-"));
    dirs.push(root);
    const files: Record<string, string> = { "src/ok.ts": `${header}\nexport {};\n`, "src/missing.mjs": "export {};\n", ...exempt };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("src/missing.mjs");
    for (const rel of ["src/ok.ts", ...Object.keys(exempt)]) expect(result.output).not.toContain(rel);
    await writeFile(path.join(root, "src/missing.mjs"), `${header}\nexport {};\n`);
    expect(check(root).status).toBe(0);
  });

  it("passes on this repository", () => {
    const result = check(repoRoot);
    expect(result.output).toContain("every covered source file has the SPDX header");
    expect(result.status).toBe(0);
  });
});
