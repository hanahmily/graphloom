import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

/**
 * Starts `sleep` in its own process group, as agent CLIs do, and writes its pid
 * to `input.pidFile`. `stop-on-abort` kills the group when its signal aborts;
 * `ignore-abort` leaves it running and never returns.
 */
function start(input) {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  return writeFile(input.pidFile, String(child.pid)).then(() => child);
}

export const executors = [
  {
    id: "acme.group/stop-on-abort",
    version: "1",
    effect: "read",
    async execute(input, ctx) {
      const child = await start(input);
      await new Promise((resolve) => {
        ctx.signal?.addEventListener("abort", resolve, { once: true });
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      process.kill(-child.pid, "SIGKILL");
      await exited;
      return { status: "failed", summary: "stopped" };
    },
  },
  {
    id: "acme.group/await-tool",
    version: "1",
    effect: "read",
    async execute(_input, ctx) {
      const busy = setInterval(() => undefined, 1_000);
      try {
        const result = await ctx.tools.call({ toolCallId: "t1", tool: "probe", input: {} });
        return { status: "failed", summary: result.summary };
      } finally {
        clearInterval(busy);
      }
    },
  },
  {
    // An agent that saves its session when stopped, as the coding-agent harnesses do.
    id: "acme.group/session-on-abort",
    version: "1",
    effect: "read",
    async execute(_input, ctx) {
      const busy = setInterval(() => undefined, 1_000);
      await new Promise((resolve) => {
        ctx.signal?.addEventListener("abort", resolve, { once: true });
      });
      clearInterval(busy);
      return { status: "failed", summary: "agent session aborted", sessionRef: "saved-1", evidence: [{ kind: "other", payload: { progress: "half" } }] };
    },
  },
  {
    // An agent that reports its session as it saves it, then never answers again, even when stopped:
    // a harness slower than the stop grace to save its session while stopping.
    id: "acme.group/session-early-hang",
    version: "1",
    effect: "read",
    async execute(_input, ctx) {
      setInterval(() => undefined, 1_000);
      ctx.keepSession?.("early-1");
      ctx.keepSession?.("early-2");
      return new Promise(() => undefined);
    },
  },
  {
    // An agent that reports its session early, then claims success once it is stopped.
    id: "acme.group/late-success",
    version: "1",
    effect: "read",
    async execute(_input, ctx) {
      ctx.keepSession?.("early-1");
      const busy = setInterval(() => undefined, 1_000);
      await new Promise((resolve) => {
        ctx.signal?.addEventListener("abort", resolve, { once: true });
      });
      clearInterval(busy);
      return { status: "ok", summary: "all done", evidence: [{ kind: "other", payload: { claimed: "success" } }] };
    },
  },
  {
    id: "acme.group/report-timeout",
    version: "1",
    effect: "read",
    async execute(_input, ctx) {
      return { status: "ok", summary: String(ctx.timeoutMs) };
    },
  },
  {
    id: "acme.group/ignore-abort",
    version: "1",
    effect: "read",
    async execute(input) {
      await start(input);
      return new Promise(() => undefined);
    },
  },
];
