// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom doctor` from an installed version (docs/design-release.md §4.4):
 * install integrity against `release.json` (read-only directory, bundled
 * Node, executor and plugin digests) and the automatic-update check, on a
 * release tree that carries the real CLI, installed with the real install.sh
 * in a temporary HOME with no Node on PATH and a stub gh.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestExecutorSource } from "@graphloom/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "../src/doctor.js";
import { makeSandbox, realCli, removeTree, tempBase, type Sandbox } from "./install-env.js";

let base: string;
beforeAll(async () => {
  base = await tempBase("gl-doctor-installed-");
});
afterAll(async () => {
  await removeTree(base);
});

/** The real CLI, with release.json naming the tree's executor and plugin digests, as assemble.mjs writes them. */
async function populate(tree: string): Promise<void> {
  await realCli(tree);
  const release = JSON.parse(readFileSync(path.join(tree, "release.json"), "utf8")) as Record<string, unknown>;
  const executors = [];
  for (const dir of await readdir(path.join(tree, "executors"))) {
    const pkg = JSON.parse(readFileSync(path.join(tree, "executors", dir, "package.json"), "utf8")) as { name: string; version: string };
    executors.push({ package: pkg.name, version: pkg.version, digest: await digestExecutorSource(path.join(tree, "executors", dir)) });
  }
  const manifest = readFileSync(path.join(tree, "examples", "plugins", "hello", "graphloom.manifest.json"));
  const plugins = [{ graphId: "hello", version: "0.1.0", manifestSha256: createHash("sha256").update(manifest).digest("hex") }];
  await writeFile(path.join(tree, "release.json"), `${JSON.stringify({ ...release, stateFormat: 1, executors, plugins }, null, 2)}\n`);
}

function doctor(sb: Sandbox, extra: NodeJS.ProcessEnv = {}): { report: DoctorReport; status: number | null } {
  // The version's own launcher, not the shim, so no update check starts.
  const r = spawnSync(path.join(sb.ghome, "current", "bin", "graphloom"), ["doctor", "--json"], { env: { ...sb.env, ...extra }, cwd: sb.root, encoding: "utf8", timeout: 120_000 });
  expect(r.stdout, r.stderr).not.toBe("");
  return { report: JSON.parse(r.stdout) as DoctorReport, status: r.status };
}

const row = (report: DoctorReport, name: string): DoctorCheck => report.checks.find((c) => c.name === name)!;

describe("graphloom doctor in an installed version", () => {
  it("checks install integrity against release.json and reports automatic updates", async () => {
    const sb = await makeSandbox(base);
    const built = await sb.build("0.1.0", { populate });
    expect(sb.installer(["--from", built.tarball]).status).toBe(0);

    const { report } = doctor(sb);
    expect(row(report, "install integrity")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^read-only; bundled Node .*; 3 executors and 1 plugin match release\.json$/) });
    expect(row(report, "platform")).toMatchObject({ status: "pass", detail: "linux-x64" });
    // gh is logged in and can read the repository, and the version carries a release key.
    expect(row(report, "gh").status).toBe("pass");
    expect(row(report, "updates")).toMatchObject({ status: "pass", detail: "auto (from the default); no check yet" });

    expect(row(doctor(sb, { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).report, "updates")).toMatchObject({ status: "warn", detail: expect.stringContaining("automatic updates are off") });
    expect(row(doctor(sb, { FAKE_GH_AUTH_STATUS: "1" }).report, "updates")).toMatchObject({ status: "warn", detail: expect.stringContaining("because gh is not logged in"), fix: "gh auth login" });
    expect(row(doctor(sb, { FAKE_GH_NO_ACCESS: "1" }).report, "updates")).toMatchObject({ status: "warn", detail: expect.stringContaining("gh cannot read hanahmily/graphloom") });
    await mkdir(path.join(sb.ghome, "update"), { recursive: true });
    await writeFile(path.join(sb.ghome, "update", "last-failure"), JSON.stringify({ version: "0.1.1", reason: "the signature on SHA256SUMS does not verify", time: "2026-10-27T00:00:00Z" }));
    await writeFile(path.join(sb.ghome, "update", "skip"), "0.1.2\n");
    expect(row(doctor(sb).report, "updates")).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/skipping 0\.1\.2; the last attempt failed for 0\.1\.1 .*does not verify/),
    });

    // A changed executor byte fails integrity, and the doctor exits 1.
    const executor = path.join(sb.ghome, "versions", "0.1.0", "executors", "command", "package.json");
    spawnSync("chmod", ["-R", "u+w", path.join(sb.ghome, "versions", "0.1.0")]);
    await writeFile(executor, readFileSync(executor, "utf8").replace(/\n$/, " \n"));
    const tampered = doctor(sb);
    expect(row(tampered.report, "install integrity")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("@graphloom/executor-command does not match its release.json digest"),
    });
    expect(row(tampered.report, "install integrity").detail).toContain("is writable");
    expect(tampered.status).toBe(1);
    await chmod(path.join(sb.ghome, "versions", "0.1.0"), 0o555);
  });
});
