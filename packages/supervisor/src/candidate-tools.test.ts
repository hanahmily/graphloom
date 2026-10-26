// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAdmittedCandidateRoot,
  CANDIDATE_CODING_TOOL_NAMES,
  CANDIDATE_REVIEW_TOOL_NAMES,
  createCandidateCodingTools,
  createCandidateReviewTools,
} from "./candidate-tools.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function issuedCandidate(): Promise<{ root: string; repairsDir: string; base: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "gl-cand-"));
  temps.push(base);
  const repairsDir = path.join(base, "state", "repairs");
  const root = path.join(repairsDir, "repair-1", "candidate");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(repairsDir, "repair-1", "snapshot.json"), "{}", "utf8");
  await writeFile(path.join(root, "validator.js"), "export const ok = false;\n", "utf8");
  return { root, repairsDir, base };
}

function tool(root: string, name: string) {
  const found = createCandidateCodingTools(root).find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function run(root: string, name: string, params: Record<string, unknown>) {
  return tool(root, name).execute("call-1", params as never, undefined, undefined, {} as never);
}

describe("candidate coding tools", () => {
  it("grants Pi's full coding toolset, shell included", () => {
    expect([...CANDIDATE_CODING_TOOL_NAMES]).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(createCandidateCodingTools("/tmp").map((t) => t.name)).toEqual([...CANDIDATE_CODING_TOOL_NAMES]);
  });

  it("admits only controller-issued, non-symlinked candidate roots", async () => {
    const { root, repairsDir, base } = await issuedCandidate();
    await expect(assertAdmittedCandidateRoot(repairsDir, root)).resolves.toBe(root);
    await expect(assertAdmittedCandidateRoot(undefined, root)).rejects.toThrow(/repairs directory/);
    await expect(assertAdmittedCandidateRoot(repairsDir, base)).rejects.toThrow(/controller-issued/);

    const linked = path.join(repairsDir, "repair-2", "candidate");
    await mkdir(path.dirname(linked), { recursive: true });
    await writeFile(path.join(repairsDir, "repair-2", "snapshot.json"), "{}", "utf8");
    await symlink(base, linked);
    await expect(assertAdmittedCandidateRoot(repairsDir, linked)).rejects.toThrow(/symlink/);

    const unrecorded = path.join(repairsDir, "repair-3", "candidate");
    await mkdir(unrecorded, { recursive: true });
    await expect(assertAdmittedCandidateRoot(repairsDir, unrecorded)).rejects.toThrow(
      /snapshot record/,
    );
  });

  it("writes and lists with the candidate root as the working directory", async () => {
    const { root } = await issuedCandidate();
    await run(root, "write", { path: "test/regression.test.js", content: "// newline case\n" });
    expect(await readFile(path.join(root, "test/regression.test.js"), "utf8")).toBe("// newline case\n");
    const listed = await run(root, "ls", { path: "." });
    expect(JSON.stringify(listed.content)).toContain("validator.js");
  });
});

describe("candidate review tools", () => {
  it("grants only read-only tools: no bash, edit or write", () => {
    expect([...CANDIDATE_REVIEW_TOOL_NAMES]).toEqual(["read", "grep", "find", "ls"]);
    expect(createCandidateReviewTools("/tmp").map((t) => t.name)).toEqual([...CANDIDATE_REVIEW_TOOL_NAMES]);
  });

  it("reads and lists with the candidate root as the working directory", async () => {
    const { root } = await issuedCandidate();
    const tool = (name: string) => {
      const found = createCandidateReviewTools(root).find((t) => t.name === name);
      if (!found) throw new Error(`missing tool ${name}`);
      return found;
    };
    const read = await tool("read").execute("call-1", { path: "validator.js" } as never, undefined, undefined, {} as never);
    expect(JSON.stringify(read.content)).toContain("export const ok = false");
    const listed = await tool("ls").execute("call-2", { path: "." } as never, undefined, undefined, {} as never);
    expect(JSON.stringify(listed.content)).toContain("validator.js");
  });
});
