// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * install.sh, the shim, `graphloom upgrade`, and `graphloom self ...`
 * (docs/design-release.md §4.2, §4.3, §5.3), as shell tests in a temporary
 * HOME with no Node on PATH, against fake release trees and a stub gh.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ttyRun } from "./doctor-env.js";
import { makeSandbox, removeTree, startDetached, tempBase, waitUntil, type Sandbox } from "./install-env.js";

let base: string;
beforeAll(async () => {
  base = await tempBase("gl-install-");
});
afterAll(async () => {
  await removeTree(base);
});

// The updater has its own tests; keep it out of these.
const quiet = { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" };

async function installed(sb: Sandbox, ...versions: string[]): Promise<void> {
  for (const v of versions) {
    const built = await sb.build(v);
    const r = sb.installer(["--from", built.tarball]);
    expect(r.stderr + r.stdout, `install ${v}`).toContain(`installed GraphLoom ${v}`);
    expect(r.status).toBe(0);
  }
}

describe("install.sh --from, with no node on PATH", () => {
  it("verifies, installs a read-only version, switches current, writes the shim, and runs it", async () => {
    const sb = await makeSandbox(base);
    expect(spawnSync("sh", ["-c", "command -v node"], { env: sb.env }).status).not.toBe(0);
    const built = await sb.build("0.1.0");
    const r = sb.installer(["--from", built.tarball, "--allowed-signers", sb.signers]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("checksum: graphloom-0.1.0-linux-x64.tar.gz ok");
    expect(r.stdout).toContain("signature: verified");
    expect(r.stdout).toContain("current -> 0.1.0");
    expect(r.stdout).toContain(`shim: ${sb.shim}`);
    expect(r.stdout).toContain("is not on PATH");
    expect(sb.current()).toBe("0.1.0");
    expect(sb.installed()).toEqual(["0.1.0"]);
    expect(readdirSync(path.join(sb.ghome, ".staging"))).toEqual([]);

    const dir = path.join(sb.ghome, "versions", "0.1.0");
    expect(statSync(dir).mode & 0o222).toBe(0);
    expect(statSync(path.join(dir, "bin", "graphloom")).mode & 0o222).toBe(0);
    await expect(writeFile(path.join(dir, "new-file"), "x")).rejects.toThrow();

    const version = sb.graphloom(["version"], quiet);
    expect(version.stdout.trim()).toBe("graphloom 0.1.0");
    const list = sb.graphloom(["self", "list"], quiet);
    expect(list.stdout.trim()).toBe("0.1.0 (current)");
  });

  it("refuses a checksum mismatch or a bad signature before extracting, and warns on a missing signature", async () => {
    const sb = await makeSandbox(base);
    const bad = sb.installer(["--from", (await sb.build("0.1.0", { badChecksum: true })).tarball]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("checksum mismatch for graphloom-0.1.0-linux-x64.tar.gz; nothing was extracted");
    const forged = sb.installer(["--from", (await sb.build("0.1.0", { sign: "other" })).tarball, "--allowed-signers", sb.signers]);
    expect(forged.status).toBe(1);
    expect(forged.stderr).toContain("the signature on SHA256SUMS does not verify");
    expect(sb.installed()).toEqual([]);

    const unsigned = await sb.build("0.1.0", { sign: false });
    const required = sb.installer(["--from", unsigned.tarball, "--require-signature"]);
    expect(required.status).toBe(1);
    expect(required.stderr).toContain("a verified signature is required, but the release has no SHA256SUMS.sig");
    const relaxed = sb.installer(["--from", unsigned.tarball]);
    expect(relaxed.status, relaxed.stderr).toBe(0);
    expect(relaxed.stderr).toContain("cannot verify the signature: the release has no SHA256SUMS.sig; relying on the SHA-256 checksum");
    expect(sb.installed()).toEqual(["0.1.0"]);
  });

  it("never overwrites an installed version; reinstalling the same tarball is a no-op", async () => {
    const sb = await makeSandbox(base);
    const first = await sb.build("0.1.0");
    expect(sb.installer(["--from", first.tarball]).status).toBe(0);
    const recorded = await readFile(path.join(sb.ghome, "versions", "0.1.0", ".graphloom-tarball.sha256"), "utf8");

    const again = sb.installer(["--from", first.tarball]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("GraphLoom 0.1.0 is already installed");
    expect(again.stdout).toContain("current is already 0.1.0");

    const other = await sb.build("0.1.0", { salt: "different bytes" });
    const refused = sb.installer(["--from", other.tarball]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("versions/0.1.0 already exists with other contents; an installed version is never overwritten");
    expect(await readFile(path.join(sb.ghome, "versions", "0.1.0", ".graphloom-tarball.sha256"), "utf8")).toBe(recorded);
    expect(await readFile(path.join(sb.ghome, "versions", "0.1.0", "examples", "plugins", "hello", "graphloom.manifest.json"), "utf8")).toContain('"salt":""');
  });

  it("never lists an interrupted install, and the next install clears its staging", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0");

    // A tarball that verifies but cannot be extracted.
    const broken = await sb.build("0.1.1");
    const bytes = await readFile(broken.tarball);
    await writeFile(broken.tarball, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const { createHash } = await import("node:crypto");
    await writeFile(path.join(broken.dir, "SHA256SUMS"), `${createHash("sha256").update(await readFile(broken.tarball)).digest("hex")}  graphloom-0.1.1-linux-x64.tar.gz\n`);
    await rm(path.join(broken.dir, "SHA256SUMS.sig"));
    const failed = sb.installer(["--from", broken.tarball]);
    expect(failed.status).toBe(1);
    expect(sb.installed()).toEqual(["0.1.0"]);
    expect(sb.current()).toBe("0.1.0");
    expect(readdirSync(path.join(sb.ghome, ".staging"))).not.toEqual([]);

    // Killed after extraction, before the rename: a tar that extracts and then hangs.
    const wrap = path.join(sb.root, "slow-bin");
    await mkdir(wrap);
    const realTar = spawnSync("sh", ["-c", "command -v tar"], { env: sb.env, encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(wrap, "tar"), `#!/bin/sh\n"${realTar}" "$@" || exit $?\ncase " $* " in *" -xzf "*) touch "${sb.root}/extracted"; sleep 30 ;; esac\n`, { mode: 0o755 });
    const killed = await sb.build("0.1.2");
    const install = startDetached("sh", [sb.installerPath, "--from", killed.tarball], { ...sb.env, PATH: `${wrap}:${sb.env.PATH}` });
    await waitUntil(() => existsSync(path.join(sb.root, "extracted")), 20_000, "the extraction");
    expect(sb.graphloom(["self", "list"], quiet).stdout).not.toContain("0.1.2");
    process.kill(-install.child.pid!, "SIGKILL");
    await install.done;
    expect(sb.installed()).toEqual(["0.1.0"]);
    expect(sb.graphloom(["self", "list"], quiet).stdout.trim()).toBe("0.1.0 (current)");
    const staged = readdirSync(path.join(sb.ghome, ".staging"));
    expect(staged.some((n) => n.startsWith("0.1.2-"))).toBe(true);
    // A selectable version cannot be named for it either.
    const use = sb.graphloom(["self", "use", "0.1.2"], quiet);
    expect(use.status).toBe(1);
    expect(use.stderr).toContain("GraphLoom 0.1.2 is not installed");

    await installed(sb, "0.1.3");
    expect(readdirSync(path.join(sb.ghome, ".staging"))).toEqual([]);
    expect(sb.installed()).toEqual(["0.1.0", "0.1.3"]);
  });
});

describe("switching current", () => {
  it("replaces the current link atomically: a reader never sees it missing or half-written", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0", "0.1.1");
    expect(sb.read("previous")?.trim()).toBe("0.1.0");
    const seen = path.join(sb.root, "seen");
    const stop = path.join(sb.root, "stop");
    const reader = startDetached("sh", ["-c", `while [ ! -f "${stop}" ]; do readlink "${sb.ghome}/current" || echo MISSING; done >"${seen}"`], sb.env);
    for (let i = 0; i < 15; i++) {
      expect(sb.graphloom(["self", "use", i % 2 === 0 ? "0.1.0" : "0.1.1"], quiet).status).toBe(0);
    }
    await writeFile(stop, "");
    await reader.done;
    const values = new Set((await readFile(seen, "utf8")).split("\n").filter(Boolean));
    expect([...values].sort()).toEqual(["versions/0.1.0", "versions/0.1.1"]);
    expect(readdirSync(sb.ghome).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("use and rollback round-trip, record the version left as skipped, and refuse self upgrade", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0", "0.1.1");
    const back = sb.graphloom(["self", "rollback"], quiet);
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toContain("current -> 0.1.0 (was 0.1.1)");
    expect(back.stdout).toContain("automatic updates skip 0.1.1");
    expect(sb.current()).toBe("0.1.0");
    expect(sb.read("previous")?.trim()).toBe("0.1.1");
    expect(sb.read("update/skip")?.trim()).toBe("0.1.1");
    expect(sb.graphloom(["self", "list"], quiet).stdout.trim().split("\n")).toEqual([
      "0.1.1 (previous, skipped by automatic updates)",
      "0.1.0 (current)",
    ]);
    // Rolling forward to the skipped version clears the skip.
    expect(sb.graphloom(["self", "rollback"], quiet).status).toBe(0);
    expect(sb.current()).toBe("0.1.1");
    expect(sb.read("update/skip")).toBeUndefined();
    expect(sb.graphloom(["version"], quiet).stdout.trim()).toBe("graphloom 0.1.1");

    const missing = sb.graphloom(["self", "use", "9.9.9"], quiet);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("GraphLoom 9.9.9 is not installed");
    const upgrade = sb.graphloom(["self", "upgrade"], quiet);
    expect(upgrade.status).toBe(2);
    expect(upgrade.stderr).toContain("there is no 'self upgrade'; use graphloom upgrade");
  });

  it("keeps a process started from the old version loading from it across a switch", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0", "0.1.1");
    expect(sb.graphloom(["self", "use", "0.1.0"], quiet).status).toBe(0);
    const signal = path.join(sb.root, "go");
    const held = startDetached(sb.shim, ["hold", signal], { ...sb.env, ...quiet });
    await waitUntil(() => held.output().stdout.includes("holding 0.1.0"), 20_000, "the held process");
    expect(sb.graphloom(["self", "use", "0.1.1"], quiet).status).toBe(0);
    expect(sb.graphloom(["version"], quiet).stdout.trim()).toBe("graphloom 0.1.1");
    await writeFile(signal, "");
    const result = await held.done;
    expect(result.status, result.stderr).toBe(0);
    const last = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { started: string; root: string; late: string };
    expect(last).toEqual({ started: "0.1.0", root: path.join(sb.ghome, "versions", "0.1.0"), late: "0.1.0" });
  });
});

describe("self prune", () => {
  it("keeps current, previous, owners of runs whose state exists, and versions a run's plugin links into", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4");
    const live = path.join(sb.root, "repo", "graphloom-state", "run-live");
    await mkdir(live, { recursive: true });
    await sb.ownRun("run-live", { version: "0.1.0", stateDir: live });
    await sb.ownRun("run-gone", { version: "0.1.1", stateDir: path.join(sb.root, "repo", "graphloom-state", "deleted") });
    // A run owned by the newest version whose task links a bundle inside 0.1.2.
    const task = path.join(sb.root, "task", "plugins");
    await mkdir(task, { recursive: true });
    await symlink(path.join(sb.ghome, "versions", "0.1.2", "examples", "plugins", "hello"), path.join(task, "hello"));
    const linked = path.join(sb.root, "repo", "graphloom-state", "run-linked");
    await mkdir(linked, { recursive: true });
    await sb.ownRun("run-linked", { version: "0.1.4", stateDir: linked, plugin: path.join(task, "hello") });

    expect(sb.graphloom(["self", "list"], quiet).stdout.trim().split("\n")).toEqual([
      "0.1.4 (current, owns 1 run)",
      "0.1.3 (previous)",
      "0.1.2 (plugin links)",
      "0.1.1",
      "0.1.0 (owns 1 run)",
    ]);
    const dry = sb.graphloom(["self", "prune", "--dry-run"], quiet);
    expect(dry.stdout.trim()).toBe("would remove 0.1.1");
    expect(sb.installed()).toHaveLength(5);

    const pruned = sb.graphloom(["self", "prune"], quiet);
    expect(pruned.status, pruned.stderr).toBe(0);
    expect(pruned.stdout.trim()).toBe("removed 0.1.1");
    expect(sb.installed()).toEqual(["0.1.0", "0.1.2", "0.1.3", "0.1.4"]);
    expect(sb.graphloom(["self", "prune"], quiet).stdout.trim()).toBe("nothing to prune");

    // --force overrides ownership and links, never current or previous.
    const forced = sb.graphloom(["self", "prune", "--force"], quiet);
    expect(forced.stdout.trim().split("\n").sort()).toEqual(["removed 0.1.0", "removed 0.1.2"]);
    expect(sb.installed()).toEqual(["0.1.3", "0.1.4"]);
    expect(readdirSync(path.join(sb.ghome, ".staging"))).toEqual([]);
  });
});

describe("graphloom upgrade", () => {
  it("installs the latest release, switches, clears the skip, and lists runs on older versions", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0");
    await sb.publish("0.1.1");
    await sb.publish("0.2.0");
    await sb.publish("0.3.0", { draft: true });
    await sb.publish("0.2.1", { prerelease: true });
    const state = path.join(sb.root, "repo", "graphloom-state", "run-old");
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, "state.json"), JSON.stringify({ runId: "run-old", status: "stopped", current: { status: "running" } }));
    await sb.ownRun("run-old", { version: "0.1.0", stateDir: state });
    await mkdir(path.join(sb.ghome, "update"), { recursive: true });
    await writeFile(path.join(sb.ghome, "update", "skip"), "0.2.0\n");

    const up = sb.graphloom(["upgrade"], quiet);
    expect(up.status, up.stderr).toBe(0);
    expect(up.stdout).toContain("installed GraphLoom 0.2.0");
    expect(up.stdout).toContain("current -> 0.2.0 (was 0.1.0)");
    expect(up.stdout).toContain("runs still on older versions (move one with graphloom resume <run> --upgrade):");
    expect(up.stdout).toContain("  run-old  0.1.0  stopped  graphloom resume run-old --upgrade");
    expect(sb.current()).toBe("0.2.0");
    expect(sb.read("update/skip")).toBeUndefined();
    expect(sb.graphloom(["version"], quiet).stdout.trim()).toBe("graphloom 0.2.0");
    expect(sb.ghCalls().some((c) => c.startsWith("release download v0.2.0 -R hanahmily/graphloom -D "))).toBe(true);
  });

  it("--no-switch keeps current, and naming an older version implies it", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.2.0");
    await sb.publish("0.3.0");
    await sb.publish("0.1.0");
    const noSwitch = sb.graphloom(["upgrade", "0.3.0", "--no-switch"], quiet);
    expect(noSwitch.status, noSwitch.stderr).toBe(0);
    expect(sb.installed()).toEqual(["0.2.0", "0.3.0"]);
    expect(sb.current()).toBe("0.2.0");
    const older = sb.graphloom(["upgrade", "0.1.0"], quiet);
    expect(older.status, older.stderr).toBe(0);
    expect(older.stdout).toContain("0.1.0 is older than current 0.2.0; installing without switching");
    expect(sb.current()).toBe("0.2.0");
    expect(sb.installed()).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
  });

  it("names why gh cannot download: missing, logged out, or without access", async () => {
    const none = await makeSandbox(base, { gh: false });
    await installed(none, "0.1.0");
    const missing = none.graphloom(["upgrade", "0.1.1"], quiet);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("gh (GitHub CLI) is not installed");

    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0");
    await sb.publish("0.1.1");
    expect(sb.graphloom(["upgrade"], { ...quiet, FAKE_GH_AUTH_STATUS: "1" }).stderr).toContain("gh is not logged in; run gh auth login");
    expect(sb.graphloom(["upgrade", "0.1.1"], { ...quiet, FAKE_GH_NO_ACCESS: "1" }).stderr).toContain("gh cannot read hanahmily/graphloom; ask a maintainer for read access");
    expect(sb.graphloom(["upgrade", "0.9.9"], quiet).stderr).toContain("gh cannot download release v0.9.9");
    expect(sb.installed()).toEqual(["0.1.0"]);
  });

  it("still works through previous's install.sh when current is missing", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0", "0.1.1");
    await sb.publish("0.1.2");
    // A broken current: its directory is gone.
    spawnSync("chmod", ["-R", "u+w", path.join(sb.ghome, "versions", "0.1.1")]);
    await rm(path.join(sb.ghome, "versions", "0.1.1"), { recursive: true });
    expect(sb.graphloom(["version"], quiet).stderr).toContain("no current version");
    const up = sb.graphloom(["upgrade"], quiet);
    expect(up.status, up.stderr).toBe(0);
    expect(sb.current()).toBe("0.1.2");
  });
});

describe("self uninstall", () => {
  it("removes the shim and the install home, keeps run state, and purges config only when asked", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0");
    const config = path.join(sb.home, ".config", "graphloom");
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "runner.json"), "{}");
    const state = path.join(sb.root, "repo", "graphloom-state", "run-a");
    await mkdir(state, { recursive: true });
    await sb.ownRun("run-a", { version: "0.1.0", stateDir: state });

    const out = sb.graphloom(["self", "uninstall"], quiet);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(`run-a (0.1.0) ${state}`);
    expect(existsSync(sb.shim)).toBe(false);
    expect(existsSync(sb.ghome)).toBe(false);
    expect(existsSync(path.join(config, "runner.json"))).toBe(true);
    expect(existsSync(state)).toBe(true);

    await installed(sb, "0.1.0");
    const xdg = path.join(sb.root, "xdg-config", "graphloom");
    await mkdir(xdg, { recursive: true });
    expect(sb.graphloom(["self", "uninstall", "--purge-config"], { ...quiet, XDG_CONFIG_HOME: path.join(sb.root, "xdg-config") }).status).toBe(0);
    expect(existsSync(xdg)).toBe(true);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(state)).toBe(true);
  });
});

describe("install.sh step 6: the doctor, then the setup offer (§4.2)", () => {
  const stubRuns = (output: string) =>
    output
      .split("\n")
      .filter((l) => l.startsWith('{"stub"'))
      .map((l) => JSON.parse(l) as { stub: string; version: string; tty: boolean });

  it("runs the doctor and, without a terminal, prints graphloom setup --yes instead of asking", async () => {
    const sb = await makeSandbox(base);
    const built = await sb.build("0.1.0");
    const r = sb.installer(["--from", built.tarball]);
    expect(r.status, r.stderr).toBe(0);
    expect(stubRuns(r.stdout)).toEqual([{ stub: "doctor", version: "0.1.0", tty: false }]);
    expect(r.stdout).toContain("No runner config yet: run graphloom setup (graphloom setup --yes in scripts).");
    expect(r.stdout).not.toContain("Run graphloom setup now?");
    // A doctor failure is reported but does not undo the install.
    const next = await sb.build("0.1.1");
    const failed = sb.installer(["--from", next.tarball], { FAKE_STUB_EXIT: "1" });
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain("graphloom doctor reported a failure; the install is kept");
    expect(sb.current()).toBe("0.1.1");
  });

  it.runIf(spawnSync("script", ["--version"]).status === 0)("on a terminal, offers setup (default yes) only when no runner config exists", async () => {
    const sb = await makeSandbox(base);
    const built = await sb.build("0.1.0");
    const yes = await ttyRun(["sh", sb.installerPath, "--from", built.tarball], [""], sb.env, sb.root);
    expect(yes.code, yes.output).toBe(0);
    expect(yes.output).toContain("No runner config yet. Run graphloom setup now? [Y/n]");
    expect(stubRuns(yes.output)).toEqual([
      { stub: "doctor", version: "0.1.0", tty: true },
      { stub: "setup", version: "0.1.0", tty: true },
    ]);

    const no = await ttyRun(["sh", sb.installerPath, "--from", built.tarball], ["n"], sb.env, sb.root);
    expect(stubRuns(no.output)).toEqual([{ stub: "doctor", version: "0.1.0", tty: true }]);
    expect(no.output).toContain("Run graphloom setup when ready.");

    await mkdir(path.join(sb.home, ".config", "graphloom"), { recursive: true });
    await writeFile(path.join(sb.home, ".config", "graphloom", "runner.json"), JSON.stringify({ harness: "claude-code", allowUnrestricted: true }));
    const present = await ttyRun(["sh", sb.installerPath, "--from", built.tarball], [], sb.env, sb.root);
    expect(present.output).not.toContain("Run graphloom setup now?");
    expect(present.output).toContain("review it with graphloom setup");
    expect(stubRuns(present.output)).toEqual([{ stub: "doctor", version: "0.1.0", tty: true }]);
  });

  it("graphloom upgrade skips it", async () => {
    const sb = await makeSandbox(base);
    await installed(sb, "0.1.0");
    await sb.publish("0.1.1");
    const up = sb.graphloom(["upgrade"], quiet);
    expect(up.status, up.stderr).toBe(0);
    expect(stubRuns(up.stdout)).toEqual([]);
  });
});
