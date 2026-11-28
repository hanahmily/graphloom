// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { confinementUnsupported } from "@graphloom/runner";
import { createChildPluginHost, type PluginHost } from "@graphloom/plugin-host";
import { LOOP_EXIT, loopEvaluate } from "../src/loop-cli.js";
import { confinedHookLauncher } from "../src/loop-confine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/main.js");
const TOKEN = "ghp_confine_test_token_9f3a";
const unsupported = await confinementUnsupported();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

/**
 * Reports what a hook can reach: every process environment it can read (looking for the token), its parent's environment,
 * the user's home, a planted token file, a local TCP server, and writes to its bundle, the system and /tmp.
 */
const SPY = `
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const code = (fn) => { try { const v = fn(); return v === undefined ? "ok" : v; } catch (e) { return String(e.code || e.message); } };
function connect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(1000, () => done("timeout"));
    socket.on("connect", () => done("connected"));
    socket.on("error", (e) => done("error:" + e.code));
  });
}
export function createGraph() {
  return {
    describe() { return { graphId: "spy", version: "1", stages: [], requirements: [], defaultValidators: [] }; },
    advance() { throw new Error("unused"); },
    async loopCandidates(input) {
      const p = input.profile;
      const tokenIn = [];
      for (const pid of fs.readdirSync("/proc").filter((n) => /^\\d+$/.test(n))) {
        try { if (fs.readFileSync("/proc/" + pid + "/environ", "latin1").includes(p.token)) tokenIn.push(pid); } catch {}
      }
      let ppidEnv;
      try { ppidEnv = fs.readFileSync("/proc/" + process.ppid + "/environ", "latin1").split("\\0").filter(Boolean).map((e) => e.split("=")[0]); } catch (e) { ppidEnv = String(e.code); }
      const report = {
        tokenInProcEnviron: tokenIn.length,
        ppidEnv,
        procCount: fs.readdirSync("/proc").filter((n) => /^\\d+$/.test(n)).length,
        home: code(() => fs.readdirSync(p.home).length),
        planted: code(() => fs.readFileSync(p.planted, "utf8")),
        net: await connect(p.port),
        writeBundle: code(() => fs.writeFileSync(path.join(bundleDir, "planted.txt"), "x")),
        writeUsr: code(() => fs.writeFileSync("/usr/planted.txt", "x")),
        writeEtc: code(() => fs.writeFileSync("/etc/planted.txt", "x")),
        writeTmp: code(() => fs.writeFileSync("/tmp/planted.txt", "x")),
        cwd: process.cwd(),
        env: Object.keys(process.env).sort(),
      };
      return { refused: JSON.stringify(report) };
    },
  };
}
`;

interface Spy {
  tokenInProcEnviron: number;
  ppidEnv: string[] | string;
  procCount: number;
  home: string | number;
  planted: string;
  net: string;
  writeBundle: string;
  writeUsr: string;
  writeEtc: string;
  writeTmp: string;
  cwd: string;
  env: string[];
}

interface Arena {
  out: string;
  bundleDir: string;
  profile: Record<string, unknown>;
  profilePath: string;
  server: net.Server;
}

async function arena(): Promise<Arena> {
  const out = await mkdtemp(path.join(os.tmpdir(), "graphloom-loop-confine-"));
  cleanups.push(() => rm(out, { recursive: true, force: true }));
  const bundleDir = path.join(out, "plugins", "spy");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, "index.mjs"), SPY);
  await writeFile(path.join(bundleDir, "graphloom.manifest.json"), JSON.stringify({ graphId: "spy", version: "1", sdkProtocol: 1, entryPoints: { createGraph: "./index.mjs" }, loop: { protocol: 1, reads: [] } }));
  // A "home" holding a token file the hook must not see: in the temp dir, and the operator's real home is probed too.
  const home = path.join(out, "home");
  await mkdir(home);
  await writeFile(path.join(home, ".token"), `token=${TOKEN}`);
  const server = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const profile = { token: TOKEN, home: os.homedir(), planted: path.join(home, ".token"), port: (server.address() as net.AddressInfo).port };
  const profilePath = path.join(out, "profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  return { out, bundleDir, profile, profilePath, server };
}

/** The evaluator's own process: a shell holding the token in its environment, the hook's ancestor, as the evaluator's is. */
const ancestor = (launcher: (w: readonly [string, string, string]) => { command: string; args: readonly string[] }) => (w: readonly [string, string, string]) => {
  const l = launcher(w);
  return { command: "sh", args: ["-c", 'env -i PATH="$PATH" "$@"; exit $?', "sh", l.command, ...l.args] };
};
const plain = (w: readonly [string, string, string]) => ({ command: w[0], args: w.slice(1) });

async function viaHost(a: Arena, confined: boolean): Promise<Spy> {
  const env = { PATH: process.env.PATH, GRAPHLOOM_TEST_TOKEN: TOKEN };
  const host: PluginHost = await createChildPluginHost({
    entryModule: path.join(a.bundleDir, "index.mjs"),
    activeVersion: "spy@1",
    generation: 1,
    cwd: a.bundleDir,
    callbackTimeoutMs: 10_000,
    env,
    launcher: ancestor(confined ? confinedHookLauncher({ bundle: a.bundleDir, env: { PATH: process.env.PATH } }) : plain),
  });
  cleanups.push(() => host.close());
  const result = await host.loopCandidates!({ runId: "r", operationId: "op-1", expectedStateRevision: 0 }, { protocol: 1, profile: a.profile, now: "2026-03-04T05:06:07.000Z", round: 0, results: [] });
  if (!result.ok) throw new Error(result.observation.message);
  return JSON.parse((result.value as { refused: string }).refused) as Spy;
}

describe.skipIf(unsupported !== undefined)(`the hook child's confinement${unsupported !== undefined ? ` (skipped: ${unsupported})` : ""}`, () => {
  it("control: an unconfined hook sees the evaluator's token, the home, the network and can write", async () => {
    const a = await arena();
    const seen = await viaHost(a, false);
    expect(seen.tokenInProcEnviron).toBeGreaterThan(0);
    expect(seen.planted).toContain(TOKEN);
    expect(seen.home).toBeGreaterThanOrEqual(1);
    expect(seen.net).toBe("connected");
    expect(seen.writeBundle).toBe("ok");
  });

  it("a confined hook sees no environment, no home, no token file, and has no network", async () => {
    const a = await arena();
    const seen = await viaHost(a, true);
    expect(seen.tokenInProcEnviron).toBe(0);
    expect(seen.ppidEnv === "ENOENT" || seen.ppidEnv === "EACCES" || (Array.isArray(seen.ppidEnv) && seen.ppidEnv.every((name) => name === "PATH" || name === "PWD"))).toBe(true);
    expect(seen.env.filter((n) => n !== "PWD")).toEqual(["PATH"]);
    // Only the directories leading to the node binary exist (a home under which node is installed shows that one entry), never the home's content.
    expect(typeof seen.home === "string" ? seen.home : seen.home <= 1).toSatisfy((v: unknown) => v === true || v === "ENOENT" || v === "EACCES");
    expect(seen.planted).toMatch(/^(ENOENT|EACCES)$/);
    expect(seen.planted).not.toContain(TOKEN);
    expect(seen.net).toMatch(/^error:/);
    // Its own pid namespace: the hook sees the sandbox's few processes, not the host's.
    expect(seen.procCount).toBeLessThan(10);
  });

  it("a confined hook cannot write its bundle or the system, and works in an empty /tmp", async () => {
    const a = await arena();
    const seen = await viaHost(a, true);
    expect(seen.writeBundle).toBe("EROFS");
    expect(seen.writeUsr).toBe("EROFS");
    expect(seen.writeEtc).toMatch(/^(ENOENT|EROFS|EACCES)$/);
    expect(seen.writeTmp).toBe("ok");
    expect(seen.cwd).toBe("/tmp");
  });

  it("the evaluator's CLI runs the hook confined, with the token in its own environment", async () => {
    const a = await arena();
    const run = spawnSync(process.execPath, [cli, "loop", "evaluate", "spy", "--out", a.out, "--profile", a.profilePath, "--json"], {
      env: { PATH: process.env.PATH, HOME: os.homedir(), GRAPHLOOM_TEST_TOKEN: TOKEN },
      encoding: "utf8",
    });
    expect(run.status).toBe(LOOP_EXIT.refused);
    const doc = JSON.parse(run.stdout) as { outcome: { reason: string } };
    const seen = JSON.parse(doc.outcome.reason) as Spy;
    expect(seen.tokenInProcEnviron).toBe(0);
    expect(seen.env.filter((n) => n !== "PWD")).toEqual(["PATH"]);
    // Only the directories leading to the node binary exist (a home under which node is installed shows that one entry), never the home's content.
    expect(typeof seen.home === "string" ? seen.home : seen.home <= 1).toSatisfy((v: unknown) => v === true || v === "ENOENT" || v === "EACCES");
    expect(seen.planted).toMatch(/^(ENOENT|EACCES)$/);
    expect(seen.net).toMatch(/^error:/);
    expect(seen.writeBundle).toBe("EROFS");
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it("--replay runs the hook confined too", async () => {
    const a = await arena();
    const out: string[] = [];
    const live = await loopEvaluate({ graph: "spy", out: a.out, profile: a.profilePath, env: { PATH: process.env.PATH, GRAPHLOOM_TEST_TOKEN: TOKEN }, json: true, now: "2026-03-04T05:06:07.000Z" }, (l) => void out.push(l));
    expect(live).toBe(LOOP_EXIT.refused);
    const file = path.join(a.out, "t.json");
    await writeFile(file, out.join("\n"));
    const replayed: string[] = [];
    const code = await loopEvaluate({ graph: "spy", out: a.out, profile: a.profilePath, replay: file, env: { PATH: process.env.PATH }, json: true }, (l) => void replayed.push(l));
    // The recorded reply names this run's pids and ports; whatever the verdict, it is JSON and the hook ran in the sandbox.
    expect([LOOP_EXIT.ok, LOOP_EXIT.failed]).toContain(code);
    expect(JSON.parse(replayed.join("\n"))).toHaveProperty("replay");
  });

  it("kills a spinning hook at the timeout and leaves no sandbox process", async () => {
    const a = await arena();
    await writeFile(path.join(a.bundleDir, "index.mjs"), SPY.replace("const p = input.profile;", "const p = input.profile; if (p.spin) { for (;;) {} }"));
    await writeFile(a.profilePath, JSON.stringify({ ...a.profile, spin: true }));
    const started = Date.now();
    const lines: string[] = [];
    const code = await loopEvaluate({ graph: "spy", out: a.out, profile: a.profilePath, env: { PATH: process.env.PATH }, hookTimeoutMs: 400 }, (l) => void lines.push(l));
    expect(code).toBe(LOOP_EXIT.blocked);
    expect(lines.join("\n")).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(6_000);
    await expect.poll(() => lingering(a.bundleDir), { timeout: 3_000, interval: 100 }).toBe("");
  });

  it("closes the hook and exits on SIGTERM, leaving no sandbox process", async () => {
    const a = await arena();
    await writeFile(path.join(a.bundleDir, "index.mjs"), SPY.replace("const p = input.profile;", "const p = input.profile; if (p.spin) { await new Promise(() => {}); }"));
    await writeFile(a.profilePath, JSON.stringify({ ...a.profile, spin: true }));
    const child = spawn(process.execPath, [cli, "loop", "evaluate", "spy", "--out", a.out, "--profile", a.profilePath], { env: { PATH: process.env.PATH }, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    cleanups.push(async () => void child.kill("SIGKILL"));
    await expect.poll(() => lingering(a.bundleDir), { timeout: 8_000, interval: 50 }).not.toBe("");
    child.kill("SIGTERM");
    const result = await exited;
    expect(result.code).toBe(143);
    await expect.poll(() => lingering(a.bundleDir), { timeout: 3_000, interval: 100 }).toBe("");
  });
});

describe("the hook child's confinement fails closed", () => {
  it("refuses with exit 1 naming the cause when confinement is unsupported, and never starts the hook", async () => {
    const a = await arena();
    const errors: string[] = [];
    const code = await loopEvaluate(
      { graph: "spy", out: a.out, profile: a.profilePath, env: { PATH: process.env.PATH }, confinementProbe: async () => "bubblewrap (bwrap) cannot create a mount namespace here (test)" },
      () => undefined,
      (l) => {
        errors.push(l);
      },
    );
    expect(code).toBe(LOOP_EXIT.failed);
    expect(errors.join("\n")).toContain("must run confined");
    expect(errors.join("\n")).toContain("cannot create a mount namespace here (test)");
    expect(lingeringNow(a.bundleDir)).toBe("");
  });
});

function lingeringNow(marker: string): string {
  return spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim();
}
async function lingering(marker: string): Promise<string> {
  return lingeringNow(marker);
}
