// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntakeError, manifestRepository, readTaskIntake, repositoryModeChange } from "./index.js";

/** Counts reads of a bundle manifest and, when told, serves a different manifest to every read after the first (a bundle swapped between reads). */
const spy = vi.hoisted(() => ({ reads: 0, laterManifest: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (file: unknown, ...rest: unknown[]) => {
    if (typeof file === "string" && file.endsWith("graphloom.manifest.json")) {
      spy.reads += 1;
      if (spy.reads > 1 && spy.laterManifest !== undefined) return spy.laterManifest;
    }
    return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile };
});

const execFileAsync = promisify(execFile);
const temps: string[] = [];
afterEach(async () => {
  spy.reads = 0;
  spy.laterManifest = undefined;
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const manifestOf = (extra: Record<string, unknown>) => JSON.stringify({ graphId: "tidy", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./index.js" }, ...extra });

/** A task directory with a bundle whose manifest is `manifestText`; `repo` is a git repository beside it when asked for. */
async function world(manifestText: string, taskText: string, withRepo = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-intake-manifest-"));
  temps.push(dir);
  const bundle = path.join(dir, "plugins", "tidy");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "graphloom.manifest.json"), manifestText);
  await writeFile(path.join(bundle, "index.js"), "export function createGraph() { return {}; }\n");
  if (withRepo) {
    await mkdir(path.join(dir, "repo"));
    for (const args of [["init", "-q"], ["-c", "user.name=T", "-c", "user.email=t@e.x", "commit", "-q", "--allow-empty", "-m", "i"]]) await execFileAsync("git", args, { cwd: path.join(dir, "repo") });
  }
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, taskText);
  return { dir, taskPath };
}

describe("the repository mode comes from the pinned manifest bytes", () => {
  it("reads the manifest once, so the mode and the pinned bytes cannot disagree", async () => {
    const w = await world(manifestOf({ repository: "none" }), "graph: tidy\nrequest: go\n");
    const read = await readTaskIntake(w.taskPath);
    expect(spy.reads).toBe(1);
    expect(read.repository.mode).toBe("none");
  });

  it("takes both the mode and the pin from the one read when the bundle is swapped afterwards", async () => {
    const w = await world(manifestOf({ repository: "none" }), "graph: tidy\nrequest: go\n");
    spy.laterManifest = manifestOf({});
    const read = await readTaskIntake(w.taskPath);
    expect(read.repository.mode).toBe("none");
    expect(manifestRepository(read.bundle.manifestRaw)).toBe("none");
  });
});

describe("a manifest that is not an object", () => {
  it.each(["null", "[]", "3", '"x"'])("is an IntakeError from manifestRepository and repositoryModeChange (%s)", (text) => {
    expect(() => manifestRepository(text)).toThrow(IntakeError);
    expect(() => repositoryModeChange(manifestOf({}), text)).toThrow(IntakeError);
    expect(() => repositoryModeChange(text, manifestOf({}))).toThrow(IntakeError);
  });

  it.each(["null", "[]"])("is refused by intake as not valid JSON, not as a TypeError (%s)", async (text) => {
    const w = await world(text, "graph: tidy\nrepo: ./repo\nrequest: go\n", true);
    await expect(readTaskIntake(w.taskPath)).rejects.toThrow(IntakeError);
    await expect(readTaskIntake(w.taskPath)).rejects.toThrow("manifest is not valid JSON");
  });

  it("keeps the order of refusals of a graph that needs a repository: a missing repository is reported first", async () => {
    const w = await world("null", "graph: tidy\nrepo: ./nowhere\nrequest: go\n");
    await expect(readTaskIntake(w.taskPath)).rejects.toThrow(/nowhere/);
    await expect(readTaskIntake(w.taskPath)).rejects.not.toThrow("manifest is not valid JSON");
  });
});
