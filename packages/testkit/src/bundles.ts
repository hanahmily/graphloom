// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { cp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./git.js";
import type { TestScope } from "./scope.js";

const MANIFEST = "graphloom.manifest.json";

/**
 * A private copy of a built graph bundle (manifest, package.json, dist/,
 * profiles/, and scripts/, which environment checks may run), so a test can
 * change it without touching the checkout. Its imports (`@graphloom/sdk`) resolve through a `node_modules` link to this
 * checkout's.
 */
export async function copyBundle(scope: TestScope, source: string): Promise<string> {
  if (!existsSync(path.join(source, "dist"))) throw new Error(`${source} is not built (no dist/); run npm run build first`);
  const dest = path.join(await scope.tempDir("gl-bundle-"), path.basename(source));
  for (const entry of [MANIFEST, "package.json", "dist", "profiles", "scripts"]) {
    if (existsSync(path.join(source, entry))) await cp(path.join(source, entry), path.join(dest, entry), { recursive: true, dereference: true });
  }
  await symlink(path.join(repoRoot, "node_modules"), path.join(dest, "node_modules"));
  return dest;
}

interface Manifest {
  graphId: string;
  version: string;
  entryPoints?: { createGraph?: string; rehearsal?: string };
  [key: string]: unknown;
}

async function readManifest(bundle: string): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(bundle, MANIFEST), "utf8")) as Manifest;
}

async function writeManifest(bundle: string, manifest: Manifest): Promise<void> {
  await writeFile(path.join(bundle, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function jsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => path.join(e.parentPath, e.name));
}

/**
 * Release a new version of the same graph in place, as a plugin fix would
 * (#133: issue-fix 0.1.0 -> 0.2.0 was refused on `resume --update-plugin`):
 * the manifest, package.json and every `"<old version>"` string literal in
 * the built code (the version the graph describes) move to `to`. Stages,
 * requirements and everything else stay as they were.
 */
export async function bumpBundleVersion(bundle: string, to: string): Promise<{ from: string; to: string }> {
  const manifest = await readManifest(bundle);
  const from = manifest.version;
  if (from === to) throw new Error(`bundle is already at version ${to}`);
  await writeManifest(bundle, { ...manifest, version: to });
  const pkgPath = path.join(bundle, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
    await writeFile(pkgPath, `${JSON.stringify({ ...pkg, version: to }, null, 2)}\n`);
  }
  let replaced = 0;
  for (const file of await jsFiles(path.join(bundle, "dist"))) {
    const text = await readFile(file, "utf8");
    const next = text.split(JSON.stringify(from)).join(JSON.stringify(to));
    if (next !== text) {
      replaced += 1;
      await writeFile(file, next);
    }
  }
  if (replaced === 0) throw new Error(`no "${from}" literal in ${bundle}/dist to move to ${to}`);
  return { from, to };
}

export interface SlowBundleOptions {
  /** How long loading the plugin entry takes, before it exports (or fails). Default 300. */
  loadDelayMs?: number;
  /**
   * How late each line the worker writes to stdout reaches the host. Lines
   * still held when the worker exits are handed to a relay process that
   * outlives it and writes them after the delay, so the host sees the exit
   * first and the line afterwards (#137). Keep it under the host's 250ms
   * trailing-output grace. Default 100.
   */
  stdoutDelayMs?: number;
  /** Fail to load with this message after the delay, as a plugin with a broken import would. */
  failLoad?: string;
}

const SLOW_ENTRY = "testkit-slow-entry.js";

/**
 * A copy of `source` whose plugin child is slow: it takes `loadDelayMs` to
 * load, and its stdout reaches the host `stdoutDelayMs` late, even past its
 * own exit. The manifest's `createGraph` entry points at a wrapper that
 * re-exports the real one.
 */
export async function slowBundle(scope: TestScope, source: string, options: SlowBundleOptions = {}): Promise<string> {
  const bundle = await copyBundle(scope, source);
  const manifest = await readManifest(bundle);
  const real = manifest.entryPoints?.createGraph ?? "./dist/index.js";
  const realDir = path.dirname(path.join(bundle, real));
  const wrapper = path.join(realDir, SLOW_ENTRY);
  const relative = `./${path.relative(realDir, path.join(bundle, real)).split(path.sep).join("/")}`;
  await writeFile(wrapper, slowEntrySource(relative, options));
  await writeManifest(bundle, {
    ...manifest,
    entryPoints: { ...manifest.entryPoints, createGraph: `./${path.relative(bundle, wrapper).split(path.sep).join("/")}` },
  });
  return bundle;
}

function slowEntrySource(realEntry: string, options: SlowBundleOptions): string {
  const loadDelayMs = options.loadDelayMs ?? 300;
  const stdoutDelayMs = options.stdoutDelayMs ?? 100;
  return `// Generated by @graphloom/testkit slowBundle: a slow plugin child.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STDOUT_DELAY_MS = ${JSON.stringify(stdoutDelayMs)};
const out = process.stdout;
const write = out._write.bind(out);
const queue = [];
let flushing = false;
// Accept each chunk at once and write it STDOUT_DELAY_MS later, in order.
function pump() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  setTimeout(() => {
    const [chunk, encoding] = queue.shift();
    write(chunk, encoding, () => {
      flushing = false;
      pump();
    });
  }, STDOUT_DELAY_MS);
}
out._write = (chunk, encoding, callback) => {
  queue.push([chunk, encoding]);
  callback();
  pump();
};
out._writev = (chunks, callback) => {
  for (const { chunk, encoding } of chunks) queue.push([chunk, encoding]);
  callback();
  pump();
};
// Lines still held at exit outlive the worker: a relay that inherits its
// stdout writes them after the delay, so the host sees the exit first.
process.on("exit", () => {
  if (queue.length === 0) return;
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gl-slow-relay-")), "lines");
  writeFileSync(file, Buffer.concat(queue.map(([chunk, encoding]) => (typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk))));
  const relay = \`const fs = require("node:fs"); setTimeout(() => { fs.writeSync(1, fs.readFileSync(process.argv[1])); fs.rmSync(require("node:path").dirname(process.argv[1]), { recursive: true, force: true }); }, Number(process.argv[2]));\`;
  spawn(process.execPath, ["-e", relay, file, String(STDOUT_DELAY_MS)], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
});

await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(loadDelayMs)}));
${options.failLoad !== undefined ? `throw new Error(${JSON.stringify(options.failLoad)});` : ""}
export * from ${JSON.stringify(realEntry)};
`;
}
