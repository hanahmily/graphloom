import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createScriptedRunner } from "@graphloom/runner";
import { createController } from "./index.js";
import { readOwnerClaim } from "./owner.js";
import type { DurableRunState } from "./state.js";

const failSave = vi.hoisted(() => ({ on: false }));
vi.mock("./state.js", async (original) => {
  const actual = await original<typeof import("./state.js")>();
  return {
    ...actual,
    saveRunState: async (state: DurableRunState) => {
      // The save that exposes `running` on resume.
      if (failSave.on && state.status === "running" && state.lastResume !== undefined) throw new Error("disk full");
      return actual.saveRunState(state);
    },
  };
});

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("resume owner claim (#175)", () => {
  it("is released when resume cannot save its running state, so a later resume is not rejected as owned", async () => {
    if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
      await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-claim-"));
    const repo = path.join(dir, "test-repo");
    await mkdir(repo, { recursive: true });
    for (const args of [["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
      await execFileAsync("git", args, { cwd: repo });
    }
    await writeFile(path.join(repo, "README.md"), "repo\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
    await mkdir(path.join(dir, "plugins"));
    await symlink(path.join(repoRoot, "examples/plugins/hello"), path.join(dir, "plugins/hello"));
    const taskPath = path.join(dir, "task.yaml");
    await writeFile(taskPath, "graph: hello\nrepo: ./test-repo\nrequest: Create GREETING.txt.\n");

    const controller = createController();
    const stopped = await controller.run({
      taskPath,
      runner: createScriptedRunner({ jobs: [async () => ({ status: "failed" as const, summary: "agent broke" })] }),
      stateRoot: path.join(dir, "state"),
      runId: "claim1",
    });
    expect(stopped.status).toBe("stopped");

    failSave.on = true;
    try {
      await expect(controller.resume({ runRef: stopped.stateDir, runner: createScriptedRunner({ jobs: [] }) })).rejects.toThrow("disk full");
    } finally {
      failSave.on = false;
    }
    expect(await readOwnerClaim(stopped.stateDir)).toBeUndefined();

    const later = await controller.resume({ runRef: stopped.stateDir, runner: createScriptedRunner({ jobs: [async () => ({ status: "failed" as const, summary: "again" })] }) });
    expect(later.status).toBe("stopped");
    expect(later.stopReason).toMatch(/^job failed/);
  }, 60_000);
});
