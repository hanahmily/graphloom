// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The coding-agent executor vendors @graphloom/agent-harness into its own
// package tree, so the digest a run pins it by covers the harness code
// (docs/design-supervisor-harnesses.md §3.2).

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codingAgentExecutorPackage } from "@graphloom/executor-coding-agent";
import { digestExecutorSource, packageRootOf } from "@graphloom/runner";

// The root a run pins the executor by: the package holding its entry module (runner builtin.ts).
const executorRoot = packageRootOf(codingAgentExecutorPackage.entryModule);
const libraryRoot = path.resolve(executorRoot, "..", "..", "packages", "agent-harness");
const vendored = path.join(executorRoot, "dist", "vendor", "agent-harness");

async function files(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await files(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** A copy of the executor package as a run-local repair takes it: everything but `node_modules`. */
async function copyPackage(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
}

function vendor(packageRoot: string): string {
  return execFileSync(process.execPath, [path.join(packageRoot, "scripts", "vendor-agent-harness.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("coding-agent executor vendors the agent harness", () => {
  it("carries exactly the built library's modules and declarations", async () => {
    const built = (await files(path.join(libraryRoot, "dist"))).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"));
    expect(built).toContain("claude/driver.js");
    expect(await files(vendored)).toEqual(built);
    for (const rel of built) {
      const want = (await readFile(path.join(libraryRoot, "dist", rel), "utf8")).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
      expect(await readFile(path.join(vendored, rel), "utf8"), rel).toBe(want);
    }
  });

  it("loads the harness from the vendored copy, never from an installed package", async () => {
    const pkg = JSON.parse(await readFile(path.join(executorRoot, "package.json"), "utf8")) as { imports?: Record<string, string>; dependencies?: Record<string, string> };
    expect(pkg.imports).toEqual({ "#agent-harness/*": "./dist/vendor/agent-harness/*/index.js" });
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@graphloom/agent-harness");
    for (const rel of (await files(path.join(executorRoot, "dist"))).filter((f) => f.endsWith(".js") && !f.startsWith("vendor/"))) {
      expect(await readFile(path.join(executorRoot, "dist", rel), "utf8"), rel).not.toContain("@graphloom/agent-harness");
    }
    const resolved = execFileSync(process.execPath, ["--input-type=module", "-e", 'console.log(import.meta.resolve("#agent-harness/claude"))'], {
      cwd: executorRoot,
      encoding: "utf8",
    }).trim();
    expect(new URL(resolved).pathname).toBe(path.join(vendored, "claude", "index.js"));
  });

  it("changes the executor digest when one vendored byte changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-vendor-digest-"));
    const copy = path.join(dir, "coding-agent");
    await copyPackage(executorRoot, copy);
    const pinned = await digestExecutorSource(executorRoot);
    expect(await digestExecutorSource(copy)).toBe(pinned);
    const file = path.join(copy, "dist", "vendor", "agent-harness", "claude", "driver.js");
    const bytes = await readFile(file);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 2) ^ 1, bytes.length - 2);
    await writeFile(file, bytes);
    expect(await digestExecutorSource(copy)).not.toBe(pinned);
  });

  it("rebuilds the vendored copy from a changed library, which moves the digest; a standalone copy keeps its own", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-vendor-build-"));
    // A checkout layout: the library beside the executor, as in this repository.
    const library = path.join(dir, "packages", "agent-harness");
    const executor = path.join(dir, "executors", "coding-agent");
    await mkdir(library, { recursive: true });
    await cp(path.join(libraryRoot, "package.json"), path.join(library, "package.json"));
    await cp(path.join(libraryRoot, "dist"), path.join(library, "dist"), { recursive: true });
    await copyPackage(executorRoot, executor);
    const pinned = await digestExecutorSource(executorRoot);

    vendor(executor);
    expect(await digestExecutorSource(executor)).toBe(pinned);

    const changed = path.join(library, "dist", "codex", "driver.js");
    await writeFile(changed, `${await readFile(changed, "utf8")}\n// a harness fix\n`);
    vendor(executor);
    expect(await readFile(path.join(executor, "dist", "vendor", "agent-harness", "codex", "driver.js"), "utf8")).toContain("// a harness fix");
    const fixed = await digestExecutorSource(executor);
    expect(fixed).not.toBe(pinned);

    // A repair candidate is the package alone: its build keeps the vendored code it was reviewed with.
    const standalone = path.join(dir, "repairs", "r1", "candidate");
    await copyPackage(executor, standalone);
    const patched = path.join(standalone, "dist", "vendor", "agent-harness", "claude", "driver.js");
    await writeFile(patched, `${await readFile(patched, "utf8")}\n// a run-local repair\n`);
    const before = await digestExecutorSource(standalone);
    vendor(standalone);
    expect(await digestExecutorSource(standalone)).toBe(before);
    expect(await readFile(patched, "utf8")).toContain("// a run-local repair");
  });
});
