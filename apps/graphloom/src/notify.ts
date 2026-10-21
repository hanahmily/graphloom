/**
 * Stop notification and waiting (`--on-stop`, `notify.onStop`, `graphloom wait`).
 *
 * The hook is operator-supplied shell: a best-effort signal that never changes
 * the run's durable state or the CLI's exit code. `wait` reads the run's durable
 * state and owner claim, never the process table.
 */
import { spawn } from "node:child_process";
import { isClaimStale, loadRunState, readOwnerClaim, resolveStateDir } from "@graphloom/controller";

export const DEFAULT_ON_STOP_TIMEOUT_MS = 60_000;

/** What the hook is told. `crashed` is a hook-only status: the CLI died before the run could report. */
export interface StopNotice {
  runId: string;
  status: string;
  stopReason?: string;
  stopRetryable?: boolean;
  stateDir?: string;
  /** The report JSON given on stdin. */
  report: unknown;
}

/** Environment the hook runs with, on top of the CLI's own. */
export function stopEnv(notice: StopNotice): Record<string, string> {
  return {
    GRAPHLOOM_RUN_ID: notice.runId,
    GRAPHLOOM_STATUS: notice.status,
    GRAPHLOOM_STOP_REASON: notice.stopReason ?? "",
    GRAPHLOOM_STOP_RETRYABLE: notice.stopRetryable === undefined ? "" : String(notice.stopRetryable),
    GRAPHLOOM_STATE_DIR: notice.stateDir ?? "",
  };
}

/** Runs `command` through the shell once, bounded by `timeoutMs`. Never throws. */
export async function runStopHook(
  command: string,
  notice: StopNotice,
  timeoutMs = DEFAULT_ON_STOP_TIMEOUT_MS,
): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      // The hook's stdout goes to stderr so the report on stdout stays parseable.
      const child = spawn("/bin/sh", ["-c", command], {
        env: { ...process.env, ...stopEnv(notice) },
        stdio: ["pipe", 2, 2],
        detached: true,
      });
      let settled = false;
      const done = (message?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (message !== undefined) console.error(`graphloom: on-stop hook ${message}`);
        resolve();
      };
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        done(`timed out after ${timeoutMs}ms and was killed`);
      }, timeoutMs);
      child.once("error", (err) => done(`failed to start: ${err.message}`));
      child.once("close", (code, signal) => done(code === 0 ? undefined : `exited ${code ?? signal}`));
      child.stdin!.on("error", () => undefined); // a hook that ignores stdin
      child.stdin!.end(`${JSON.stringify(notice.report, null, 2)}\n`);
    });
  } catch (err) {
    console.error(`graphloom: on-stop hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fires the hook at most once per process, whichever of the stop and crash
 * paths gets there first. An explicit command wins; `useConfig` supplies the
 * runner config's command and timeout once the config has loaded and validated.
 */
export function onceStopHook(command: string | undefined): {
  useConfig(notify: { onStop?: string; timeoutMs?: number } | undefined): void;
  fire(notice: StopNotice): Promise<void>;
} {
  let fired: Promise<void> | undefined;
  let timeoutMs: number | undefined;
  return {
    useConfig(notify) {
      command ??= notify?.onStop;
      timeoutMs = notify?.timeoutMs;
    },
    fire(notice) {
      if (command === undefined) return Promise.resolve();
      fired ??= runStopHook(command, notice, timeoutMs);
      return fired;
    },
  };
}

/** `90s`, `10m`, `2h`, `500ms`, or bare seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`invalid duration ${JSON.stringify(text)}: use e.g. 90s, 10m, 2h`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"]!;
  return Math.round(Number(m[1]) * unit);
}

export type WaitResult =
  | { outcome: "finished"; status: string; stateDir: string }
  | { outcome: "timeout"; stateDir: string }
  /** The state says running, but no live controller owns the run. */
  | { outcome: "orphaned"; stateDir: string; detail: string };

export interface WaitOptions {
  stateRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Blocks until the run's durable state is no longer `running`. A controller
 * claims the run before state says `running` and clears the claim only after
 * the final state is saved, so a running run with no live claim, confirmed by
 * a second read of the state, has lost its controller.
 */
export async function waitForRun(runRef: string, options: WaitOptions = {}): Promise<WaitResult> {
  const stateDir = await resolveStateDir(runRef, options.stateRoot);
  const pollMs = options.pollMs ?? 1_000;
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  for (;;) {
    const state = await loadRunState(stateDir);
    if (state.status !== "running") return { outcome: "finished", status: state.status, stateDir };
    // A missing claim is `undefined`; any other failure is not evidence the controller is gone.
    const owner = await readOwnerClaim(stateDir).catch((err: unknown) => {
      throw new Error(`cannot read owner claim in ${stateDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (owner === undefined || isClaimStale(owner)) {
      const again = await loadRunState(stateDir);
      if (again.status !== "running") return { outcome: "finished", status: again.status, stateDir };
      const detail = owner === undefined
        ? "no controller owns it"
        : `its controller (pid ${owner.controllerPid}) is no longer running`;
      return { outcome: "orphaned", stateDir, detail };
    }
    if (Date.now() >= deadline) return { outcome: "timeout", stateDir };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
