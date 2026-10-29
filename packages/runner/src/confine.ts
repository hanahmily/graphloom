// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REHEARSAL_SCENARIO_ENV } from "@graphloom/sdk";

/**
 * The directory a rehearsal's stand-ins write beside their scenario file (what
 * they were asked, which reply they gave), when `env` names a scenario: that
 * directory is the rehearsal's own, so a confined job's stand-in may write it
 * (docs/design-graph-rehearsal.md §4.1). A real run names no scenario.
 */
export function rehearsalWritable(env: NodeJS.ProcessEnv): string | undefined {
  const file = env[REHEARSAL_SCENARIO_ENV];
  if (file === undefined || file === "") return undefined;
  const dir = path.dirname(path.resolve(file));
  try {
    return lstatSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Run-scoped locations a confined job's user-level state is redirected to, under its scratch directory. */
const SCOPED_ENV_DIRS = {
  TMPDIR: "tmp",
  GOCACHE: "go/cache",
  GOTMPDIR: "go/tmp",
  npm_config_cache: "npm",
  YARN_CACHE_FOLDER: "yarn",
  PIP_CACHE_DIR: "pip",
} as const;

const XDG_DIRS = { XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state" } as const;

let bubblewrap: Promise<string | undefined> | undefined;

/**
 * Why this machine cannot confine a job's writes to a set of paths, or
 * undefined when it can. Confinement is a bubblewrap mount namespace: Node's
 * permission model cannot stand in, since it also denies the child processes
 * a command job exists to run.
 */
export function confinementUnsupported(): Promise<string | undefined> {
  bubblewrap ??= probeBubblewrap();
  return bubblewrap;
}

async function probeBubblewrap(): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return `write confinement needs Linux bubblewrap and is not available on ${process.platform}`;
  }
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "true"], { stdio: "ignore" });
    child.once("error", () => resolve("write confinement needs bubblewrap (bwrap) on PATH, and it was not found"));
    child.once("exit", (code) =>
      resolve(code === 0 ? undefined : "bubblewrap (bwrap) cannot create a mount namespace here (unprivileged user namespaces may be disabled)"),
    );
  });
}

/** The operator's effective Go module settings, read once host-side with `go env` (which writes nothing). */
export interface OperatorGo {
  modCache: string;
  proxy: string;
  flags: string;
  /** False when the operator has private-module settings: the job keeps their cache read-only and unredirected. */
  redirect: boolean;
}

/** The operator's module cache, proxy, and flags as `go env` reports them for `env`; undefined when Go is not available. */
export function operatorGoSettings(env: NodeJS.ProcessEnv): OperatorGo | undefined {
  try {
    // The probe must write nothing: no toolchain switch (which downloads into the operator's cache), no
    // module or workspace lookup, and a neutral directory instead of whatever checkout the runner sits in.
    const probeEnv: NodeJS.ProcessEnv = { ...env, GOTOOLCHAIN: "local", GOWORK: "off", GO111MODULE: "off" };
    delete probeEnv.GOFLAGS;
    const res = spawnSync("go", ["env", "-json", "GOMODCACHE", "GOPROXY", "GOFLAGS", "GOPRIVATE", "GONOPROXY"], {
      env: probeEnv,
      cwd: os.tmpdir(),
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0) return undefined;
    const parsed = JSON.parse(res.stdout) as Record<string, string>;
    if (!parsed.GOMODCACHE || !path.isAbsolute(parsed.GOMODCACHE)) return undefined;
    // GOPRIVATE/GONOPROXY make Go bypass every proxy for matching modules, the file:// one over the operator's
    // cache included, and a private module path must never be routed through a proxy. Such an operator keeps
    // the pre-run-scoped behavior: their cache read-only and unredirected, so cached modules still resolve
    // and an uncached download is not available inside confinement.
    const redirect = (parsed.GOPRIVATE ?? "") === "" && (parsed.GONOPROXY ?? "") === "";
    return { modCache: parsed.GOMODCACHE, proxy: parsed.GOPROXY ?? "", flags: env.GOFLAGS ?? parsed.GOFLAGS ?? "", redirect };
  } catch {
    return undefined;
  }
}

/**
 * Whether the launch gets a private writable /tmp: only when nothing the job reads lives under it
 * (`needed`), since a private /tmp hides everything below it but the writable paths. Admission
 * asks the same question, so a write it accepts under /tmp is one the sandbox allows.
 */
export function hasPrivateTmp(needed: readonly string[]): boolean {
  return !needed.some(underTmp);
}

/** The bubblewrap part of a job's own confinement (`JobSpec.confinement`, kind bwrap). */
export interface BwrapSandbox {
  network: boolean;
  mask: readonly string[];
  binds: ReadonlyArray<{ path: string; readOnly: boolean }>;
}

/** `~` and `~/x` mean the operator's home; anything else is already absolute. */
export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : path.resolve(p);
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The mount arguments of a job's own sandbox. The home directory becomes an empty tmpfs, and is
 * given back only what the job cannot start without (`needed`: the runtime and executor modules,
 * read-only) and the writable paths and executor state (`binds`, which the caller binds
 * read-write after this). Then the declared binds, and last the masks: a directory is replaced by an
 * empty tmpfs and a file by an empty one, so what a mask names reads as missing or empty.
 */
function sandboxMounts(
  sandbox: BwrapSandbox,
  ctx: { needed: readonly string[]; binds: readonly string[]; home: string },
): { hideHome: string[]; after: string[] } {
  const home = path.resolve(ctx.home);
  const holes = new Set<string>(ctx.binds);
  const hideHome: string[] = [];
  const reads = new Set<string>();
  if (existsSync(home) && home !== "/") {
    hideHome.push("--tmpfs", home);
    for (const p of ctx.needed) {
      for (const candidate of [path.resolve(p), realOrSame(path.resolve(p))]) {
        if (under(candidate, home) && existsSync(candidate) && !ctx.binds.some((b) => under(candidate, b))) reads.add(candidate);
      }
    }
    for (const r of reads) {
      // A symbolic link is given back as a link to its final target (which is exposed too), not as
      // a bind: binding a link mounts the target's content at the link's path, so a launcher that
      // resolves files beside its real location (an npm package's bin script) would look in the
      // wrong directory.
      if (lstatOrUndefined(r)?.isSymbolicLink()) {
        const target = realOrSame(r);
        if (target !== r && existsSync(target)) {
          hideHome.push("--symlink", target, r);
          continue;
        }
      }
      hideHome.push("--ro-bind", r, r);
    }
  }
  // A path is still there when it is, or sits in, an exposed path; and when it holds one (a mask of a
  // parent hides what is exposed beneath it: masks win).
  const visible = (p: string): boolean => !under(p, home) || [...reads, ...holes].some((h) => under(p, h) || under(h, p));
  const after: string[] = [];
  for (const bind of sandbox.binds) {
    const p = expandHome(bind.path, home);
    if (!existsSync(p)) throw new Error(`sandbox bind ${bind.path} does not exist`);
    after.push(bind.readOnly ? "--ro-bind" : "--bind", p, p);
    holes.add(p);
  }
  for (const mask of sandbox.mask) {
    const p = expandHome(mask, home);
    const stat = lstatOrUndefined(p);
    // A path that is not there, or sits in the hidden home, is already unreadable.
    if (stat === undefined || !visible(p)) continue;
    if (stat.isDirectory()) after.push("--tmpfs", p);
    else after.push("--ro-bind", "/dev/null", p);
  }
  return { hideHome, after };
}

export interface ConfinedWorker {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * bubblewrap reports (--json-status-fd) the sandbox's init process on this extra file descriptor as one JSON line
   * (`{ "child-pid": n }`, its pid outside the sandbox), so the host can signal the worker itself:
   * bubblewrap does not forward signals, and the worker is pid 1 of a pid namespace.
   */
  infoFd: number;
}

/**
 * The command and environment that run `command args` with the whole
 * filesystem read-only except `writable` and a private /tmp, and with
 * user-level state redirected into `scratchDir`. `keepUserState` leaves XDG_*
 * alone for an executor that keeps its own (its dirs are listed in `writable`).
 */
export function confineWorker(options: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  scratchDir: string;
  writable: readonly string[];
  /** Writable directories that are the executor's own state (an agent's login), which may legitimately be links. */
  trustedWritable?: readonly string[];
  /** Paths the job reads that must stay visible (the worker and executor modules, the runtime). */
  readPaths?: readonly string[];
  keepUserState: boolean;
  /**
   * The job's own sandbox (`JobSpec.confinement`, kind bwrap): the home directory is hidden but for the
   * executor's own state and what it needs to start, `mask` paths are hidden, `binds` are added, and
   * `network: false` removes the network.
   */
  sandbox?: BwrapSandbox;
  /** The operator's Go settings, when known; the job then gets a run-scoped module cache reading through the operator's. */
  operatorGo?: OperatorGo;
}): ConfinedWorker {
  const scratch = path.resolve(options.scratchDir);
  const env: NodeJS.ProcessEnv = { ...options.env };
  const subdirs: string[] = [];
  const redirect = (name: string, rel: string) => {
    env[name] = path.join(scratch, rel);
    subdirs.push(rel);
  };
  for (const [name, rel] of Object.entries(SCOPED_ENV_DIRS)) redirect(name, rel);
  if (!options.keepUserState) {
    for (const [name, rel] of Object.entries(XDG_DIRS)) redirect(name, path.join("xdg", rel));
  }
  // Everything below `scratch` was writable by earlier jobs, so none of it is trusted: each component is
  // checked without following links, and a link or file in the way is removed, never written through.
  ensureRealDir(scratch);
  for (const rel of [...subdirs, "go", ...(options.operatorGo?.redirect === true ? ["go/mod"] : [])]) ensureRealDirBelow(scratch, rel);
  // The operator's Go settings (GOPROXY and the like) carry over once; a later `go env -w` stays in the run.
  const goEnv = path.join(scratch, "go", "env");
  const operatorGoEnv =
    options.env.GOENV ?? path.join(options.env.XDG_CONFIG_HOME ?? path.join(options.env.HOME ?? "", ".config"), "go", "env");
  if (!lstatOrUndefined(goEnv) && operatorGoEnv !== "off" && existsSync(operatorGoEnv)) {
    try {
      // `wx` never opens an existing path, and never follows a link at it.
      writeFileSync(goEnv, readFileSync(operatorGoEnv), { flag: "wx" });
    } catch {
      /* unreadable settings: the run starts with Go's defaults */
    }
  }
  env.GOENV = goEnv;
  const go = options.operatorGo;
  if (go?.redirect === true) {
    // Cached modules are copied from the operator's cache through a file:// proxy, uncached ones download
    // into the run's cache; -modcacherw keeps the copies deletable. Nothing is written to the operator's cache.
    env.GOMODCACHE = path.join(scratch, "go", "mod");
    const operatorProxy = go.proxy === "" ? "https://proxy.golang.org,direct" : go.proxy;
    env.GOPROXY = `${pathToFileURL(path.join(go.modCache, "cache", "download")).href.replaceAll(",", "%2C")},${operatorProxy}`;
    env.GOFLAGS = `${go.flags} -modcacherw`.trim();
    // Checksum verification needs the operator's checksum-database evidence, which lives in their cache.
    seedSumdb(path.join(go.modCache, "cache", "download", "sumdb"), scratch, path.join("go", "mod", "cache", "download", "sumdb"));
  }

  for (const dir of options.writable) {
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symbolic link; a confined job's writable path must be a real directory`);
  }
  const binds = [...new Set([...options.writable, ...(options.trustedWritable ?? []), scratch].map((p) => path.resolve(p)))];
  // A writable path that is missing would silently stay read-only, so the job fails later and obscurely.
  const missing = binds.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new Error(`confined job needs writable paths that do not exist: ${missing.join(", ")}`);
  // A private /tmp hides everything under it but the writable paths rebound below, so it is
  // used only when nothing the job reads lives there; otherwise /tmp stays read-only.
  const needed = [...(options.readPaths ?? []), options.cwd, ...(go !== undefined ? [go.modCache] : [])];
  const privateTmp = hasPrivateTmp(needed);
  const own = options.sandbox !== undefined ? sandboxMounts(options.sandbox, { needed, binds, home: os.homedir() }) : undefined;
  return {
    command: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      ...(privateTmp ? ["--tmpfs", "/tmp"] : []),
      ...(own?.hideHome ?? []),
      ...(options.sandbox?.network === false ? ["--unshare-net"] : []),
      // The worker is pid 1 of its own pid namespace: when it exits, or bubblewrap is killed
      // (--die-with-parent), the kernel kills every process left in it, detached ones included.
      "--unshare-pid",
      "--proc", "/proc",
      "--die-with-parent",
      "--json-status-fd", "3",
      ...binds.flatMap((p) => ["--bind", p, p]),
      ...(own?.after ?? []),
      "--chdir", options.cwd,
      "--",
      options.command,
      ...options.args,
    ],
    env,
    infoFd: 3,
  };
}

/**
 * Copy the operator's checksum-database cache (small) into the run's module cache, so an offline job can
 * verify modules whose go.sum entries are missing. Copies, never links; links in the source are skipped;
 * each destination component is checked without following links, and what a job left in the way is
 * replaced. A file already there is kept.
 */
function seedSumdb(source: string, scratch: string, rel: string): void {
  const walk = (from: string, to: string): void => {
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return; // no checksum evidence cached
    }
    ensureRealDirBelow(scratch, to);
    for (const entry of entries) {
      const src = path.join(from, entry.name);
      const dstRel = path.join(to, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(src, dstRel);
      } else if (entry.isFile()) {
        const dst = path.join(scratch, dstRel);
        const stat = lstatOrUndefined(dst);
        if (stat?.isFile()) continue;
        try {
          if (stat !== undefined) {
            if (stat.isDirectory()) rmSync(dst, { recursive: true, force: true });
            else unlinkSync(dst);
          }
          // `wx` never opens an existing path, and never follows a link at it.
          writeFileSync(dst, readFileSync(src), { flag: "wx" });
        } catch {
          /* unreadable evidence: the job verifies against the network instead */
        }
      }
    }
  };
  walk(source, rel);
}

function underTmp(p: string): boolean {
  const abs = path.resolve(p);
  return abs === "/tmp" || abs.startsWith("/tmp/");
}

function lstatOrUndefined(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

/** `dir` exists as a real directory (not a link), created if absent; its parents are the runner's own. */
export function ensureRealDir(dir: string): void {
  const stat = lstatOrUndefined(dir);
  if (stat === undefined) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} must be a real directory the runner owns`);
}

/** Make `rel` below `root` real directories one component at a time, replacing any link or file a job left in the way. */
export function ensureRealDirBelow(root: string, rel: string): void {
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = lstatOrUndefined(current);
    if (stat !== undefined && !stat.isDirectory()) unlinkSync(current);
    else if (stat !== undefined) continue;
    mkdirSync(current);
  }
}

/**
 * The host pid of the worker bubblewrap started: a child of the sandbox's init process whose command
 * line names `workerModule` (processes the worker orphaned are children of the init too). bubblewrap
 * does not forward signals, and its init ignores SIGTERM, so a stop signal must reach the worker itself.
 */
export function findSandboxWorker(init: number, workerModule: string): number | undefined {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (parent === init && readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(workerModule)) return Number(entry);
      } catch {
        /* the process went away while it was being read */
      }
    }
  } catch {
    /* no /proc: the stop falls back to the grace kill */
  }
  return undefined;
}
