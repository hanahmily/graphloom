import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

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
    const child = spawn("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { stdio: "ignore" });
    child.once("error", () => resolve("write confinement needs bubblewrap (bwrap) on PATH, and it was not found"));
    child.once("exit", (code) =>
      resolve(code === 0 ? undefined : "bubblewrap (bwrap) cannot create a mount namespace here (unprivileged user namespaces may be disabled)"),
    );
  });
}

export interface ConfinedWorker {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
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
  /** Paths the job reads that must stay visible (the worker and executor modules, the runtime). */
  readPaths?: readonly string[];
  keepUserState: boolean;
}): ConfinedWorker {
  const scratch = path.resolve(options.scratchDir);
  const dirs = [scratch];
  const env: NodeJS.ProcessEnv = { ...options.env };
  const redirect = (name: string, dir: string) => {
    env[name] = dir;
    dirs.push(dir);
  };
  for (const [name, rel] of Object.entries(SCOPED_ENV_DIRS)) redirect(name, path.join(scratch, rel));
  if (!options.keepUserState) {
    for (const [name, rel] of Object.entries(XDG_DIRS)) redirect(name, path.join(scratch, "xdg", rel));
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  // The operator's Go settings (GOPROXY and the like) carry over once; a later `go env -w` stays in the run.
  const goEnv = path.join(scratch, "go", "env");
  const operatorGoEnv =
    options.env.GOENV ?? path.join(options.env.XDG_CONFIG_HOME ?? path.join(options.env.HOME ?? "", ".config"), "go", "env");
  if (!existsSync(goEnv) && operatorGoEnv !== "off" && existsSync(operatorGoEnv)) {
    try {
      copyFileSync(operatorGoEnv, goEnv);
    } catch {
      /* unreadable settings: the run starts with Go's defaults */
    }
  }
  env.GOENV = goEnv;

  const binds = [...new Set([...options.writable, ...dirs].map((p) => path.resolve(p)))];
  // A writable path that is missing would silently stay read-only, so the job fails later and obscurely.
  const missing = binds.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new Error(`confined job needs writable paths that do not exist: ${missing.join(", ")}`);
  // A private /tmp hides everything under it but the writable paths rebound below, so it is
  // used only when nothing the job reads lives there; otherwise /tmp stays read-only.
  const needed = [...(options.readPaths ?? []), options.cwd];
  const privateTmp = !needed.some(underTmp);
  return {
    command: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      ...(privateTmp ? ["--tmpfs", "/tmp"] : []),
      "--die-with-parent",
      ...binds.flatMap((p) => ["--bind", p, p]),
      "--chdir", options.cwd,
      "--",
      options.command,
      ...options.args,
    ],
    env,
  };
}

function underTmp(p: string): boolean {
  const abs = path.resolve(p);
  return abs === "/tmp" || abs.startsWith("/tmp/");
}
