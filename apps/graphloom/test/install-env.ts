// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Fixtures for the install, shim, and updater tests (docs/design-release.md
 * §4, §5.3, §5.4, phase R2). Each sandbox is a temporary `HOME` whose `PATH`
 * holds the host's tools except Node, its package managers, and the real `gh`;
 * a stub `gh` serves releases from a local directory and logs every call.
 * Release trees are small fakes built from the real `install.sh`, `shim.sh`,
 * and launcher, with `node/bin/node` linked to the Node running the tests (the
 * stand-in for the bundled runtime) and a stub CLI that hands `__auto-update`
 * to the real built CLI. Nothing here touches the network, the real
 * `~/.graphloom`, or the real install home.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = path.join(repoRoot, "scripts");
const realMain = path.join(repoRoot, "apps", "graphloom", "dist", "main.js");

const GH_STUB = `#!/bin/sh
# Stub gh: serves releases from $FAKE_GH_RELEASES/v<version>/ and logs each call to $FAKE_GH_LOG.
printf '%s\\n' "$*" >>"$FAKE_GH_LOG"
rel=$FAKE_GH_RELEASES
case "$1 $2" in
  "auth status") exit "\${FAKE_GH_AUTH_STATUS:-0}" ;;
  "repo view")
    if [ "\${FAKE_GH_NO_ACCESS:-}" = 1 ]; then echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; fi
    echo '{"name":"graphloom"}'; exit 0 ;;
  "release list")
    printf '['; sep=
    for d in "$rel"/v*; do
      [ -d "$d" ] || continue
      draft=false; pre=false
      [ -f "$d/.draft" ] && draft=true
      [ -f "$d/.prerelease" ] && pre=true
      printf '%s{"tagName":"%s","isDraft":%s,"isPrerelease":%s}' "$sep" "$(basename "$d")" "$draft" "$pre"; sep=,
    done
    printf ']\\n'; exit 0 ;;
  "release view")
    t=$(for d in "$rel"/v*; do [ -d "$d" ] && [ ! -f "$d/.draft" ] && [ ! -f "$d/.prerelease" ] && basename "$d"; done | sort -V | tail -n 1)
    [ -n "$t" ] || { echo "release not found" >&2; exit 1; }
    echo "$t"; exit 0 ;;
  "release download")
    tag=$3; shift 3; dest=.; pats=
    while [ $# -gt 0 ]; do
      case "$1" in -R) shift 2 ;; -D) dest=$2; shift 2 ;; -p) pats="$pats $2"; shift 2 ;; *) shift ;; esac
    done
    [ -d "$rel/$tag" ] || { echo "release not found" >&2; exit 1; }
    if [ -n "\${FAKE_GH_DELAY:-}" ]; then sleep "$FAKE_GH_DELAY"; fi
    n=0
    for f in "$rel/$tag"/*; do
      b=$(basename "$f")
      set -f
      for p in $pats; do
        case "$b" in $p) cp "$f" "$dest/"; n=$((n + 1)) ;; esac
      done
      set +f
    done
    [ "$n" -gt 0 ] || { echo "no assets match the file pattern" >&2; exit 1; }
    exit 0 ;;
esac
echo "stub gh: unsupported: $*" >&2
exit 1
`;

/** The stub CLI of a fake release: `version`, `exit <n>`, `hold <file>`, and the real `__auto-update`. */
function stubMain(version: string): string {
  return `import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const version = ${JSON.stringify(version)};
const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "__auto-update") {
  await import(${JSON.stringify(pathToFileURL(realMain).href)});
} else if (cmd === "version") {
  console.log("graphloom " + version);
} else if (cmd === "doctor" || cmd === "setup") {
  // install.sh step 6 (§4.2): which command ran, with a terminal or not.
  console.log(JSON.stringify({ stub: cmd, version, tty: process.stdin.isTTY === true && process.stdout.isTTY === true }));
  process.exit(Number(process.env.FAKE_STUB_EXIT ?? 0));
} else if (cmd === "exit") {
  console.log("exiting " + rest[0]);
  process.exit(Number(rest[0]));
} else if (cmd === "hold") {
  console.log("holding " + version);
  while (!existsSync(rest[0])) await new Promise((r) => setTimeout(r, 25));
  const late = await import("./late.js");
  console.log(JSON.stringify({ started: version, root, late: late.version }));
} else {
  console.log(JSON.stringify({ version, root, args: process.argv.slice(2) }));
}
`;
}

let systemPath: Promise<string> | undefined;
/** One no-Node, no-gh PATH directory for the whole test file. */
function noNodePath(base: string): Promise<string> {
  systemPath ??= (async () => {
    const dir = path.join(base, "system-bin");
    const made = spawnSync(process.execPath, [path.join(scripts, "release", "no-node-path.mjs"), "--dir", dir], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(made.stderr);
    await unlink(path.join(dir, "gh")).catch(() => undefined);
    return dir;
  })();
  return systemPath;
}

let signingKey: Promise<{ key: string; signers: string; otherKey: string }> | undefined;
/** An ed25519 release key, its allowed_signers line, and an unrelated key. */
function testKeys(base: string) {
  signingKey ??= (async () => {
    const dir = path.join(base, "keys");
    await mkdir(dir, { recursive: true });
    for (const name of ["release", "other"]) {
      const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path.join(dir, name)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const pub = (await readFile(path.join(dir, "release.pub"), "utf8")).trim();
    return { key: path.join(dir, "release"), signers: `graphloom-release namespaces="graphloom-release" ${pub}\n`, otherKey: path.join(dir, "other") };
  })();
  return signingKey;
}

export interface ReleaseOptions {
  /** `true` (default) signs with the release key; `"other"` signs with an unrelated key; `false` ships no signature. */
  sign?: boolean | "other";
  /** Write a wrong digest into SHA256SUMS. */
  badChecksum?: boolean;
  /** Extra bytes in the tree, to make two builds of one version differ. */
  salt?: string;
  /** Leave release/allowed_signers out of the tree. */
  noSigners?: boolean;
  /** Fill the tree further before it is packed, such as with the real CLI (ownership tests). */
  populate?: (tree: string) => Promise<void>;
  /** Extra release.json fields. */
  release?: Record<string, unknown>;
}

export interface BuiltRelease {
  version: string;
  dir: string;
  tarball: string;
}

export interface Sandbox {
  root: string;
  home: string;
  /** `$GRAPHLOOM_HOME`'s default under the sandbox HOME. */
  ghome: string;
  shim: string;
  releases: string;
  ghLog: string;
  /** The test release key's allowed_signers file. */
  signers: string;
  env: NodeJS.ProcessEnv;
  build(version: string, options?: ReleaseOptions): Promise<BuiltRelease>;
  /** Builds and publishes into the stub gh's release directory. */
  publish(version: string, options?: ReleaseOptions & { draft?: boolean; prerelease?: boolean }): Promise<BuiltRelease>;
  /**
   * A copy of this checkout's `scripts/install.sh` outside it, so it never takes the
   * checkout's committed `release/allowed_signers` (the real release key) as its anchor.
   */
  installerPath: string;
  installer(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  graphloom(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  /** `graphloom` under a pseudo-terminal (`script`), so stdout and stderr are terminals. */
  graphloomTty(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  ghCalls(): string[];
  current(): string | undefined;
  installed(): string[];
  read(rel: string): string | undefined;
  /** Waits until `update/log` records `count` finished checks. */
  checksDone(count: number, timeoutMs?: number): Promise<string>;
  ownRun(runId: string, record: { version: string; stateDir: string; plugin?: string }): Promise<void>;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function makeSandbox(base: string, options: { gh?: boolean } = {}): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(path.join(base, "sb-")));
  const home = path.join(root, "home");
  const stub = path.join(root, "stub-bin");
  const releases = path.join(root, "releases");
  const ghLog = path.join(root, "gh.log");
  for (const dir of [home, stub, releases, path.join(root, "tmp"), path.join(root, "builds")]) await mkdir(dir, { recursive: true });
  if (options.gh !== false) await writeFile(path.join(stub, "gh"), GH_STUB, { mode: 0o755 });
  await writeFile(ghLog, "");
  const sys = await noNodePath(base);
  const keys = await testKeys(base);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${stub}:${sys}`,
    LANG: "C.UTF-8",
    TMPDIR: path.join(root, "tmp"),
    FAKE_GH_RELEASES: releases,
    FAKE_GH_LOG: ghLog,
  };
  const signers = path.join(root, "allowed_signers");
  const installerPath = path.join(root, "installer", "install.sh");
  await mkdir(path.dirname(installerPath), { recursive: true });
  await copyFile(path.join(scripts, "install.sh"), installerPath);
  await writeFile(signers, keys.signers);
  const ghome = path.join(home, ".local", "share", "graphloom");
  const shim = path.join(home, ".local", "bin", "graphloom");
  let builds = 0;

  const build = async (version: string, opts: ReleaseOptions = {}): Promise<BuiltRelease> => {
    const work = path.join(root, "builds", `${version}-${++builds}`);
    const name = `graphloom-${version}-linux-x64`;
    const tree = path.join(work, "tree", name);
    const out = path.join(work, "out");
    await mkdir(path.join(tree, "bin"), { recursive: true });
    await mkdir(path.join(tree, "node", "bin"), { recursive: true });
    await mkdir(path.join(tree, "apps", "graphloom", "dist"), { recursive: true });
    await mkdir(path.join(tree, "examples", "plugins", "hello"), { recursive: true });
    await mkdir(out, { recursive: true });
    await writeFile(path.join(tree, "release.json"), `${JSON.stringify({ product: "graphloom", version, platform: "linux-x64", git: { commit: "0".repeat(40) }, node: { version: process.versions.node }, ...opts.release }, null, 2)}\n`);
    await copyFile(path.join(scripts, "release", "launcher.sh"), path.join(tree, "bin", "graphloom"));
    await chmod(path.join(tree, "bin", "graphloom"), 0o755);
    await symlink(process.execPath, path.join(tree, "node", "bin", "node"));
    await copyFile(path.join(scripts, "install.sh"), path.join(tree, "install.sh"));
    await copyFile(path.join(scripts, "shim.sh"), path.join(tree, "shim.sh"));
    if (!opts.noSigners) {
      await mkdir(path.join(tree, "release"), { recursive: true });
      await writeFile(path.join(tree, "release", "allowed_signers"), keys.signers);
    }
    await writeFile(path.join(tree, "apps", "graphloom", "package.json"), `{"type":"module"}\n`);
    await writeFile(path.join(tree, "apps", "graphloom", "dist", "main.js"), stubMain(version));
    await writeFile(path.join(tree, "apps", "graphloom", "dist", "late.js"), `export const version = ${JSON.stringify(version)};\n`);
    await writeFile(path.join(tree, "examples", "plugins", "hello", "graphloom.manifest.json"), `{"graphId":"hello","salt":${JSON.stringify(opts.salt ?? "")}}\n`);
    if (opts.populate !== undefined) await opts.populate(tree);
    const tarball = path.join(out, `${name}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", path.join(work, "tree"), name], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
    const digest = opts.badChecksum ? "f".repeat(64) : sha256(await readFile(tarball));
    await writeFile(path.join(out, "SHA256SUMS"), `${digest}  ${name}.tar.gz\n`);
    const sign = opts.sign ?? true;
    if (sign !== false) {
      const r = spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-f", sign === "other" ? keys.otherKey : keys.key, "-n", "graphloom-release", path.join(out, "SHA256SUMS")], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    return { version, dir: out, tarball };
  };

  const run = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(cmd, args, { encoding: "utf8", env: { ...env, ...extra }, cwd: root, timeout: 60_000 });

  const sandbox: Sandbox = {
    root,
    home,
    ghome,
    shim,
    releases,
    ghLog,
    signers,
    env,
    build,
    async publish(version, opts = {}) {
      const built = await build(version, opts);
      const dest = path.join(releases, `v${version}`);
      await cp(built.dir, dest, { recursive: true });
      if (opts.draft) await writeFile(path.join(dest, ".draft"), "");
      if (opts.prerelease) await writeFile(path.join(dest, ".prerelease"), "");
      return built;
    },
    installerPath,
    installer: (args, extra) => run("sh", [installerPath, ...args], extra),
    graphloom: (args, extra) => run(shim, args, extra),
    graphloomTty: (args, extra) => run("script", ["-qec", [shim, ...args].map(shellQuote).join(" "), "/dev/null"], extra),
    ghCalls: () => readFileSync(ghLog, "utf8").split("\n").filter(Boolean),
    current() {
      try {
        return path.basename(spawnSync("readlink", [path.join(ghome, "current")], { encoding: "utf8" }).stdout.trim()) || undefined;
      } catch {
        return undefined;
      }
    },
    installed() {
      const r = spawnSync("ls", [path.join(ghome, "versions")], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.split("\n").filter(Boolean).sort() : [];
    },
    read(rel) {
      const file = path.join(ghome, rel);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
    async checksDone(count, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const log = sandbox.read("update/log") ?? "";
        if ((log.match(/auto-update: done$/gm) ?? []).length >= count) return log;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} finished checks; update/log:\n${log}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async ownRun(runId, record) {
      await mkdir(path.join(ghome, "runs"), { recursive: true });
      await writeFile(path.join(ghome, "runs", `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    },
  };
  return sandbox;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Starts `cmd` in its own process group; resolves with its output when it exits. */
export function startDetached(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(cmd, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const done = new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr })),
  );
  return { child, done, output: () => ({ stdout, stderr }) };
}

export async function waitUntil(cond: () => boolean, timeoutMs = 20_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Removes a sandbox tree, read-only version directories included. */
export async function removeTree(dir: string): Promise<void> {
  spawnSync("chmod", ["-R", "u+w", dir]);
  await rm(dir, { recursive: true, force: true });
}

export async function tempBase(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

/**
 * Replaces a fake release tree's stub CLI with this checkout's built CLI, core
 * packages, and executors (real copies, so each version has its own executor
 * sources and digests). Third-party dependencies link to this checkout's.
 */
export async function realCli(tree: string): Promise<void> {
  const copy = async (rel: string, entries: string[]) => {
    for (const entry of entries) {
      const from = path.join(repoRoot, rel, entry);
      if (existsSync(from)) await cp(from, path.join(tree, rel, entry), { recursive: true, force: true });
    }
  };
  await copy("apps/graphloom", ["package.json", "dist"]);
  for (const pkg of await readdir(path.join(repoRoot, "packages"))) {
    if (pkg !== "testkit") await copy(`packages/${pkg}`, ["package.json", "dist"]);
  }
  for (const ex of await readdir(path.join(repoRoot, "executors"))) {
    await cp(path.join(repoRoot, "executors", ex), path.join(tree, "executors", ex), {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules"),
    });
  }
  const modules = path.join(tree, "node_modules");
  await mkdir(path.join(modules, "@graphloom"), { recursive: true });
  for (const entry of await readdir(path.join(repoRoot, "node_modules"))) {
    if (entry.startsWith(".")) continue;
    if (entry !== "@graphloom") {
      await symlink(path.join(repoRoot, "node_modules", entry), path.join(modules, entry));
      continue;
    }
    for (const name of await readdir(path.join(repoRoot, "node_modules", "@graphloom"))) {
      const target = await readlink(path.join(repoRoot, "node_modules", "@graphloom", name));
      if (existsSync(path.resolve(modules, "@graphloom", target))) await symlink(target, path.join(modules, "@graphloom", name));
    }
  }
}
