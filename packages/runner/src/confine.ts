import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
}

/** The operator's module cache, proxy, and flags as `go env` reports them for `env`; undefined when Go is not available. */
export function operatorGoSettings(env: NodeJS.ProcessEnv): OperatorGo | undefined {
  try {
    const res = spawnSync("go", ["env", "-json", "GOMODCACHE", "GOPROXY", "GOFLAGS"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    if (res.status !== 0) return undefined;
    const parsed = JSON.parse(res.stdout) as Record<string, string>;
    if (!parsed.GOMODCACHE || !path.isAbsolute(parsed.GOMODCACHE)) return undefined;
    return { modCache: parsed.GOMODCACHE, proxy: parsed.GOPROXY ?? "", flags: parsed.GOFLAGS ?? "" };
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
  for (const rel of [...subdirs, "go", ...(options.operatorGo !== undefined ? ["go/mod"] : [])]) ensureRealDirBelow(scratch, rel);
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
  if (go !== undefined) {
    // Cached modules are copied from the operator's cache through a file:// proxy, uncached ones download
    // into the run's cache; -modcacherw keeps the copies deletable. Nothing is written to the operator's cache.
    env.GOMODCACHE = path.join(scratch, "go", "mod");
    const operatorProxy = go.proxy === "" ? "https://proxy.golang.org,direct" : go.proxy;
    env.GOPROXY = `${pathToFileURL(path.join(go.modCache, "cache", "download")).href.replaceAll(",", "%2C")},${operatorProxy}`;
    env.GOFLAGS = `${go.flags} -modcacherw`.trim();
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
  return {
    command: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      ...(privateTmp ? ["--tmpfs", "/tmp"] : []),
      // The worker is pid 1 of its own pid namespace: when it exits, or bubblewrap is killed
      // (--die-with-parent), the kernel kills every process left in it, detached ones included.
      "--unshare-pid",
      "--proc", "/proc",
      "--die-with-parent",
      "--json-status-fd", "3",
      ...binds.flatMap((p) => ["--bind", p, p]),
      "--chdir", options.cwd,
      "--",
      options.command,
      ...options.args,
    ],
    env,
    infoFd: 3,
  };
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
function ensureRealDir(dir: string): void {
  const stat = lstatOrUndefined(dir);
  if (stat === undefined) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} must be a real directory the runner owns`);
}

/** Make `rel` below `root` real directories one component at a time, replacing any link or file a job left in the way. */
function ensureRealDirBelow(root: string, rel: string): void {
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
