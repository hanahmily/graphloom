// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const synced: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (file: string, flags?: string) => {
      const handle = await real.open(file, flags);
      if (flags === "r") {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          synced.push(path.resolve(file));
          return sync();
        };
      }
      return handle;
    },
  };
});

const { writeMigratedSideFiles } = await import("./index.js");

describe("a migration's side files", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    synced.length = 0;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("sync the directory of every renamed file and the parents of the directories they created, before state.json is committed", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "gl-side-"));
    dirs.push(stateDir);
    const name = "evidence/sha256/abc.json";
    await writeMigratedSideFiles(stateDir, { original: { "state.json": "{}" }, files: { "state.json": "{}", [name]: "\"x\"" }, steps: [] });
    expect(await readFile(path.join(stateDir, name), "utf8")).toBe("\"x\"");
    // The blob's own directory, and the parents of the two directories the write created (evidence, evidence/sha256).
    expect(synced).toEqual(expect.arrayContaining([path.join(stateDir, "evidence", "sha256"), path.join(stateDir, "evidence"), stateDir]));
  });
});
