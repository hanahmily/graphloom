// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeInto } from "./conversations.js";

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(os.tmpdir(), "gl-merge-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("merging a staged conversation into the run's sessions", () => {
  it("merges into directories that already exist, nested ones too, and keeps what was there", async () => {
    const from = await tmp();
    const to = await tmp();
    await mkdir(path.join(from, "projects", "p"), { recursive: true });
    await writeFile(path.join(from, "projects", "p", "new.jsonl"), "new");
    await symlink("new.jsonl", path.join(from, "projects", "p", "link"));
    await mkdir(path.join(to, "projects", "p"), { recursive: true });
    await writeFile(path.join(to, "projects", "p", "old.jsonl"), "old");
    await mergeInto(from, to);
    expect(await readFile(path.join(to, "projects", "p", "new.jsonl"), "utf8")).toBe("new");
    expect(await readFile(path.join(to, "projects", "p", "old.jsonl"), "utf8")).toBe("old");
    expect(await readlink(path.join(to, "projects", "p", "link"))).toBe("new.jsonl");
  });

  it("creates the target when it is absent", async () => {
    const from = await tmp();
    await writeFile(path.join(from, "a"), "a");
    const to = path.join(await tmp(), "sessions");
    await mergeInto(from, to);
    expect(await readFile(path.join(to, "a"), "utf8")).toBe("a");
  });

  it("refuses to overwrite a file that already exists, and leaves it as it was", async () => {
    const from = await tmp();
    const to = await tmp();
    await writeFile(path.join(from, "s.jsonl"), "staged");
    await writeFile(path.join(to, "s.jsonl"), "saved");
    await expect(mergeInto(from, to)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(to, "s.jsonl"), "utf8")).toBe("saved");
  });
});
