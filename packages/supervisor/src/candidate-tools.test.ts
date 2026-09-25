import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAdmittedCandidateRoot,
  CANDIDATE_CODING_TOOL_NAMES,
  createCandidateCodingTools,
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
  it("withholds shell and search tools that cannot be confined", () => {
    expect([...CANDIDATE_CODING_TOOL_NAMES]).toEqual(["read", "edit", "write", "ls"]);
    const names = createCandidateCodingTools("/tmp").map((t) => t.name);
    expect(names).not.toContain("bash");
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

  it("writes inside the candidate but rejects traversal, absolute escapes, and symlinks", async () => {
    const { root, base } = await issuedCandidate();
    await run(root, "write", { path: "validator.js", content: "export const ok = true;\n" });
    expect(await readFile(path.join(root, "validator.js"), "utf8")).toBe(
      "export const ok = true;\n",
    );

    await expect(
      run(root, "write", { path: "../../../escape.txt", content: "x" }),
    ).rejects.toThrow(/outside repair candidate/);
    await expect(
      run(root, "write", { path: path.join(base, "live.txt"), content: "x" }),
    ).rejects.toThrow(/outside repair candidate/);
    await expect(run(root, "read", { path: path.join(base, "state") })).rejects.toThrow(
      /outside repair candidate/,
    );

    await symlink(base, path.join(root, "link"));
    await expect(
      run(root, "write", { path: "link/escape.txt", content: "x" }),
    ).rejects.toThrow(/symlink/);
  });
});
