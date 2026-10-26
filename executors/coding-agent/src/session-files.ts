// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ScannedFile {
  rel: string;
  info: BigIntStats;
}

/** Regular files under `root`, relative to it; `other` flags symlinks and special files. Undefined when `root` is absent. */
export async function filesUnder(root: string): Promise<{ files: ScannedFile[]; other: boolean } | undefined> {
  const info = await lstat(root).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isDirectory()) return { files: [], other: true };
  const files: ScannedFile[] = [];
  let other = false;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push({ rel: child, info: await lstat(path.join(root, child), { bigint: true }) });
      else other = true;
    }
  };
  await walk("");
  return { files, other };
}

/** Copy scanned files from `from` into a fresh `to`, refusing any that were replaced since the scan. */
export async function copyFiles(from: string, files: ScannedFile[], to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const { rel, info } of files) {
    const target = path.join(to, rel);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const contents = await readScanned(path.join(from, rel), info);
    await writeFile(target, contents, {
      mode: 0o600,
      flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    });
  }
}

/**
 * Read the file a scan saw at `file`, refusing whatever has replaced it since:
 * a symlink at any component of the path would open a different file, and a
 * FIFO must not block the open. Inode numbers are reused, so the birth time
 * tells a new file from the scanned one.
 */
export async function readScanned(file: string, scanned: BigIntStats): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const handle = await open(file, flags).catch(() => undefined);
  try {
    const info = await handle?.stat({ bigint: true });
    if (
      handle === undefined ||
      !info?.isFile() ||
      info.dev !== scanned.dev ||
      info.ino !== scanned.ino ||
      info.birthtimeNs !== scanned.birthtimeNs
    ) {
      throw new Error(`${file} was replaced while it was copied`);
    }
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}
