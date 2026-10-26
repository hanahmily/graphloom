// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Automatic updates (docs/design-release.md §5.4): the shim's daily trigger
 * and notice, and `graphloom __auto-update` (the real built CLI) against a
 * fake release source served by a stub gh, in a temporary HOME with no Node
 * on PATH. Plus the policy table and the runner config key as units.
 */
import { spawnSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideUpdate, isBreaking, newestRelease } from "../src/auto-update.js";
import { parseRunnerConfig } from "../src/runner-config.js";
import { makeSandbox, removeTree, startDetached, tempBase, type Sandbox } from "./install-env.js";

let base: string;
beforeAll(async () => {
  base = await tempBase("gl-autoupdate-");
});
afterAll(async () => {
  await removeTree(base);
});

/** A sandbox with `versions` installed from tarballs (the last one current), and no check run yet. */
async function sandboxWith(...versions: string[]): Promise<Sandbox> {
  const sb = await makeSandbox(base);
  for (const v of versions) {
    const r = sb.installer(["--from", (await sb.build(v)).tarball]);
    expect(r.status, r.stderr).toBe(0);
  }
  return sb;
}

async function runnerConfig(sb: Sandbox, autoUpdate: string): Promise<void> {
  const dir = path.join(sb.home, ".config", "graphloom");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "runner.json"), JSON.stringify({ harness: "claude-code", allowUnrestricted: true, autoUpdate }));
}

/** Makes `update/last-check` older than a day, so the next invocation checks again. */
function ageLastCheck(sb: Sandbox): void {
  const old = (Date.now() - 25 * 3600_000) / 1000;
  utimesSync(path.join(sb.ghome, "update", "last-check"), old, old);
}

const listCalls = (sb: Sandbox) => sb.ghCalls().filter((c) => c.startsWith("release list")).length;

describe("the update policy (§5.4)", () => {
  it("installs non-breaking releases, announces breaking ones, and respects the skip", () => {
    expect(isBreaking("0.1.0", "0.1.1")).toBe(false);
    expect(isBreaking("0.1.0", "0.2.0")).toBe(true);
    expect(isBreaking("1.0.0", "1.4.2")).toBe(false);
    expect(isBreaking("1.9.0", "2.0.0")).toBe(true);
    expect(isBreaking("0.9.3", "1.0.0")).toBe(true);
    expect(decideUpdate({ mode: "auto", current: "0.1.0", newest: "0.1.1" })).toEqual({ action: "install", version: "0.1.1" });
    expect(decideUpdate({ mode: "notify", current: "0.1.0", newest: "0.1.1" })).toEqual({ action: "notify", version: "0.1.1", breaking: false });
    expect(decideUpdate({ mode: "auto", current: "0.1.0", newest: "0.2.0" })).toEqual({ action: "notify", version: "0.2.0", breaking: true });
    expect(decideUpdate({ mode: "auto", current: "0.1.1", newest: "0.1.1" }).action).toBe("none");
    expect(decideUpdate({ mode: "auto", current: "0.1.2", newest: "0.1.1" }).action).toBe("none");
    expect(decideUpdate({ mode: "auto", current: "0.1.0", newest: "0.1.1", skipped: "0.1.1" }).action).toBe("none");
    expect(decideUpdate({ mode: "auto", current: "0.1.0", newest: "0.1.2", skipped: "0.1.1" })).toEqual({ action: "install", version: "0.1.2" });
    expect(decideUpdate({ mode: "auto", current: "0.1.0" }).action).toBe("none");
    expect(newestRelease([
      { tagName: "v0.1.9", isDraft: false, isPrerelease: false },
      { tagName: "v0.1.10", isDraft: false, isPrerelease: false },
      { tagName: "v0.2.0", isDraft: true, isPrerelease: false },
      { tagName: "v0.3.0", isDraft: false, isPrerelease: true },
      { tagName: "nightly", isDraft: false, isPrerelease: false },
    ])).toBe("0.1.10");
  });

  it("accepts autoUpdate in the runner config", () => {
    const base = { harness: "claude-code", allowUnrestricted: true };
    expect(parseRunnerConfig(base).autoUpdate).toBeUndefined();
    for (const mode of ["auto", "notify", "off"] as const) expect(parseRunnerConfig({ ...base, autoUpdate: mode }).autoUpdate).toBe(mode);
    expect(() => parseRunnerConfig({ ...base, autoUpdate: "always" })).toThrow("autoUpdate must be auto, notify, or off");
  });
});

describe("graphloom __auto-update through the shim", () => {
  it("checks at most once per 24 hours", async () => {
    const sb = await sandboxWith("0.1.0");
    expect(sb.graphloom(["version"]).stdout.trim()).toBe("graphloom 0.1.0");
    await sb.checksDone(1);
    expect(sb.graphloom(["version"]).status).toBe(0);
    expect(sb.graphloom(["status"]).status).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(listCalls(sb)).toBe(1);
    expect(sb.read("update/log")).toContain("nothing to do: no published release");
    ageLastCheck(sb);
    sb.graphloom(["version"]);
    await sb.checksDone(2);
    expect(listCalls(sb)).toBe(2);
  });

  it("installs and switches to a patch release, then announces it once to a terminal", async () => {
    const sb = await sandboxWith("0.1.0");
    await sb.publish("0.1.1");
    sb.graphloom(["version"]);
    const log = await sb.checksDone(1);
    expect(log).toContain("installed and switched to 0.1.1");
    expect(sb.current()).toBe("0.1.1");
    expect(sb.read("previous")?.trim()).toBe("0.1.0");
    expect(sb.read("update/notice")).toContain("GraphLoom updated to 0.1.1 (from 0.1.0).");
    const tty = sb.graphloomTty(["version"]);
    expect(tty.stdout).toContain("graphloom: GraphLoom updated to 0.1.1 (from 0.1.0).");
    expect(tty.stdout).toContain("graphloom 0.1.1");
    expect(sb.read("update/notice")).toBeUndefined();
    expect(sb.graphloomTty(["version"]).stdout).not.toContain("GraphLoom updated");
  });

  it("from 1.0, installs a minor release; a new major is only announced", async () => {
    const sb = await sandboxWith("1.0.0");
    await sb.publish("1.1.0");
    sb.graphloom(["version"]);
    await sb.checksDone(1);
    expect(sb.current()).toBe("1.1.0");
    await sb.publish("2.0.0");
    ageLastCheck(sb);
    sb.graphloom(["version"]);
    await sb.checksDone(2);
    expect(sb.current()).toBe("1.1.0");
    expect(sb.installed()).toEqual(["1.0.0", "1.1.0"]);
    expect(sb.read("update/notice")).toContain("GraphLoom 2.0.0 is available (current 1.1.0). It is a breaking release");
  });

  it("before 1.0, only announces a new minor release", async () => {
    const sb = await sandboxWith("0.1.0");
    await sb.publish("0.2.0");
    sb.graphloom(["version"]);
    expect(await sb.checksDone(1)).toContain("announced 0.2.0 (breaking)");
    expect(sb.installed()).toEqual(["0.1.0"]);
    expect(sb.ghCalls().some((c) => c.startsWith("release download"))).toBe(false);
  });

  it("notify never installs", async () => {
    const sb = await sandboxWith("0.1.0");
    await runnerConfig(sb, "notify");
    await sb.publish("0.1.1");
    sb.graphloom(["version"]);
    await sb.checksDone(1);
    expect(sb.installed()).toEqual(["0.1.0"]);
    expect(sb.read("update/notice")).toBe("graphloom: GraphLoom 0.1.1 is available (current 0.1.0); run graphloom upgrade.\n");
    expect(sb.ghCalls().some((c) => c.startsWith("release download"))).toBe(false);
  });

  it("records a bad checksum or signature, and neither extracts nor switches", async () => {
    for (const [opts, reason] of [
      [{ badChecksum: true }, "checksum mismatch for graphloom-0.1.1-linux-x64.tar.gz"],
      [{ sign: "other" as const }, "the signature on SHA256SUMS does not verify"],
      [{ sign: false }, "a verified signature is required, but the release has no SHA256SUMS.sig"],
    ] as const) {
      const sb = await sandboxWith("0.1.0");
      await sb.publish("0.1.1", opts);
      sb.graphloom(["version"]);
      await sb.checksDone(1);
      const failure = JSON.parse(sb.read("update/last-failure") ?? "{}") as { version?: string; reason?: string; time?: string };
      expect(failure.version).toBe("0.1.1");
      expect(failure.reason).toContain(reason);
      expect(failure.time).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(sb.current()).toBe("0.1.0");
      expect(sb.installed()).toEqual(["0.1.0"]);
      expect(sb.read("update/notice")).toBeUndefined();
    }
  });

  it("announces instead of installing when the signature cannot be verified", async () => {
    const sb = await makeSandbox(base);
    expect(sb.installer(["--from", (await sb.build("0.1.0", { noSigners: true })).tarball]).status).toBe(0);
    await sb.publish("0.1.1");
    sb.graphloom(["version"]);
    await sb.checksDone(1);
    expect(sb.installed()).toEqual(["0.1.0"]);
    expect(sb.read("update/notice")).toContain("not installed automatically because its signature cannot be verified (GraphLoom 0.1.0 carries no release/allowed_signers)");
    expect(JSON.parse(sb.read("update/last-check") ?? "{}")).toMatchObject({ mode: "auto", current: "0.1.0", newest: "0.1.1", action: "notify" });
  });

  it("installs once when two checks run at the same time", async () => {
    const sb = await sandboxWith("0.1.0");
    await sb.publish("0.1.1");
    const env = { ...sb.env, GRAPHLOOM_HOME: sb.ghome, FAKE_GH_DELAY: "1" };
    const worker = path.join(sb.ghome, "current", "bin", "graphloom");
    const [a, b] = await Promise.all([startDetached(worker, ["__auto-update"], env).done, startDetached(worker, ["__auto-update"], env).done]);
    const out = a.stdout + b.stdout;
    expect(out.match(/installed GraphLoom 0\.1\.1/g)).toHaveLength(1);
    expect(out).toMatch(/another install holds install\.lock|GraphLoom 0\.1\.1 is already installed/);
    expect(sb.current()).toBe("0.1.1");
    expect(sb.installed()).toEqual(["0.1.0", "0.1.1"]);
    expect(sb.read("update/last-failure")).toBeUndefined();
  });

  it("makes no network call with GRAPHLOOM_DISABLE_AUTOUPDATE=1 or autoUpdate off", async () => {
    const sb = await sandboxWith("0.1.0");
    await sb.publish("0.1.1");
    expect(sb.graphloom(["version"], { GRAPHLOOM_DISABLE_AUTOUPDATE: "1" }).status).toBe(0);
    await new Promise((r) => setTimeout(r, 1000));
    expect(sb.read("update/last-check")).toBeUndefined();
    expect(sb.read("update/log")).toBeUndefined();
    expect(sb.ghCalls()).toEqual([]);

    await runnerConfig(sb, "off");
    sb.graphloom(["version"]);
    expect(await sb.checksDone(1)).toContain("autoUpdate is off");
    expect(sb.ghCalls()).toEqual([]);
    expect(sb.installed()).toEqual(["0.1.0"]);
  });

  it("honors a relative GRAPHLOOM_RUNNER_CONFIG from the caller's directory", async () => {
    const sb = await sandboxWith("0.1.0");
    await sb.publish("0.1.1");
    // The sandbox commands run in sb.root.
    await writeFile(path.join(sb.root, "runner.json"), JSON.stringify({ harness: "claude-code", allowUnrestricted: true, autoUpdate: "off" }));
    sb.graphloom(["version"], { GRAPHLOOM_RUNNER_CONFIG: "./runner.json" });
    expect(await sb.checksDone(1)).toContain("autoUpdate is off");
    expect(sb.ghCalls()).toEqual([]);
  });

  it("decides again under the lock: never moves current back or across a breaking release", async () => {
    const sb = await sandboxWith("0.1.0", "0.1.2");
    await sb.publish("0.1.1");
    await sb.publish("0.2.1");
    const installer = path.join(sb.ghome, "current", "install.sh");
    const stale = spawnSync("sh", [installer, "--version", "0.1.1", "--auto"], { env: sb.env, encoding: "utf8" });
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.stdout).toContain("current is 0.1.2, not older than 0.1.1; not installing");
    const major = spawnSync("sh", [installer, "--version", "0.2.1", "--auto"], { env: sb.env, encoding: "utf8" });
    expect(major.status, major.stderr).toBe(0);
    expect(major.stdout).toContain("0.2.1 is a breaking release for current 0.1.2; not installing it automatically");
    expect(sb.current()).toBe("0.1.2");
    expect(sb.installed()).toEqual(["0.1.0", "0.1.2"]);
  });

  it("shows the notice only to a terminal, never with --json or in a hook, and keeps the exit code", async () => {
    const sb = await sandboxWith("0.1.0");
    await mkdir(path.join(sb.ghome, "update"), { recursive: true });
    await writeFile(path.join(sb.ghome, "update", "notice"), "graphloom: NOTICE-LINE\n");
    // Not a terminal: piped stdout and stderr. The check starts (no last-check yet); the exit code is the command's.
    const piped = sb.graphloom(["exit", "7"]);
    expect(piped.status).toBe(7);
    expect(piped.stdout + piped.stderr).not.toContain("NOTICE-LINE");
    await sb.checksDone(1);
    expect(sb.read("update/notice")).toBe("graphloom: NOTICE-LINE\n");
    const json = sb.graphloomTty(["exit", "3", "--json"]);
    expect(json.status).toBe(3);
    expect(json.stdout).not.toContain("NOTICE-LINE");
    const hook = sb.graphloomTty(["exit", "4"], { GRAPHLOOM_RUN_ID: "run-1" });
    expect(hook.status).toBe(4);
    expect(hook.stdout).not.toContain("NOTICE-LINE");
    expect(sb.read("update/notice")).toBeDefined();
    ageLastCheck(sb);
    const shown = sb.graphloomTty(["exit", "5"]);
    expect(shown.status).toBe(5);
    expect(shown.stdout).toContain("NOTICE-LINE");
    expect(shown.stdout).toContain("exiting 5");
    expect(sb.read("update/notice")).toBeUndefined();
    await sb.checksDone(2);
  });

  it("after self rollback, skips the version left until a newer release or graphloom upgrade", async () => {
    const sb = await sandboxWith("0.1.0");
    await sb.publish("0.1.1");
    sb.graphloom(["version"]);
    await sb.checksDone(1);
    expect(sb.current()).toBe("0.1.1");
    expect(sb.graphloom(["self", "rollback"]).status).toBe(0);
    expect(sb.current()).toBe("0.1.0");
    expect(sb.read("update/skip")?.trim()).toBe("0.1.1");

    ageLastCheck(sb);
    sb.graphloom(["version"]);
    expect(await sb.checksDone(2)).toContain("nothing to do: 0.1.1 is not newer than the skipped 0.1.1");
    expect(sb.current()).toBe("0.1.0");

    await sb.publish("0.1.2");
    ageLastCheck(sb);
    sb.graphloom(["version"]);
    await sb.checksDone(3);
    expect(sb.current()).toBe("0.1.2");
    expect(sb.read("update/skip")).toBeUndefined();

    // graphloom upgrade clears a skip too.
    expect(sb.graphloom(["self", "use", "0.1.0"]).status).toBe(0);
    expect(sb.read("update/skip")?.trim()).toBe("0.1.2");
    expect(sb.graphloom(["upgrade", "0.1.2"]).status).toBe(0);
    expect(sb.read("update/skip")).toBeUndefined();
    expect(sb.current()).toBe("0.1.2");
  });

  it("auto-prunes to the three newest versions plus current, previous, run owners, and plugin links", async () => {
    const sb = await sandboxWith("0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4");
    const owner = path.join(sb.root, "repo", "graphloom-state", "run-owner");
    await mkdir(owner, { recursive: true });
    await sb.ownRun("run-owner", { version: "0.1.0", stateDir: owner });
    const linked = path.join(sb.root, "repo", "graphloom-state", "run-linked");
    await mkdir(linked, { recursive: true });
    await sb.ownRun("run-linked", { version: "0.1.4", stateDir: linked, plugin: path.join(sb.ghome, "versions", "0.1.1", "examples", "plugins", "hello") });
    await sb.publish("0.1.5");
    sb.graphloom(["version"]);
    const log = await sb.checksDone(1);
    expect(log).toContain("removed 0.1.2");
    expect(sb.current()).toBe("0.1.5");
    expect(sb.installed()).toEqual(["0.1.0", "0.1.1", "0.1.3", "0.1.4", "0.1.5"]);
    expect(sb.read("update/notice")).toContain("2 runs stay on older versions");
  });
});
