// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Stable, private install-home registry entry; its existence protects queued inputs. */
export function hubRetentionFile(home: string, hubDirectory: string): string {
  return path.join(home, "hub-retention", `${createHash("sha256").update(path.resolve(hubDirectory)).digest("hex")}.json`);
}

/**
 * Before acknowledging a submission, retain every installed runtime/bundle it
 * references. Records survive daemon exits and missing/corrupt hub stores. The
 * shell installer conservatively retains all versions while any record exists.
 */
export async function retainHubInstallations(hubDirectory: string, referencedPaths: readonly string[]): Promise<string[]> {
  const homes = new Map<string, string[]>();
  for (const reference of referencedPaths) {
    const resolved = await realpath(reference);
    let cursor = resolved;
    for (;;) {
      const parent = path.dirname(cursor);
      if (path.basename(parent) === "versions" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(path.basename(cursor))) {
        const home = path.dirname(parent);
        const references = homes.get(home) ?? [];
        references.push(resolved);
        homes.set(home, references);
        break;
      }
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (const home of [...homes.keys()].sort()) await registerHubRetention(home, hubDirectory, homes.get(home)!);
  return [...homes.keys()].sort();
}

/** Acquires exactly the installer's install.lock, only for this small registry transaction. */
export async function registerHubRetention(home: string, hubDirectory: string, references: readonly string[] = []): Promise<void> {
  const canonicalHome = await realpath(home);
  await withInstallLock(canonicalHome, async () => {
    // Prune may have won the lock after input capture. Refuse acceptance then.
    for (const reference of references) await access(reference);
    const destination = hubRetentionFile(canonicalHome, hubDirectory);
    const directory = path.dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ protocolVersion: 1, hubDirectory: path.resolve(hubDirectory) }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, destination);
      await syncDirectory(directory);
      await syncDirectory(canonicalHome);
    } finally { await unlink(temporary).catch(() => undefined); }
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function withInstallLock<T>(home: string, work: () => Promise<T>): Promise<T> {
  const child = spawn("flock", ["--exclusive", "--timeout", "30", "--no-fork", path.join(home, "install.lock"), "sh", "-c", "printf 'locked\\n'; read -r release || :"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`cannot retain hub installation: flock exited ${code}: ${stderr}`)));
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("locked\n")) resolve(); });
    });
    return await work();
  } finally { child.stdin.end(); await closed; }
}
