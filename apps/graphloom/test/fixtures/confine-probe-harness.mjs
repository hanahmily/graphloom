// A coding harness for the confinement test: it saves a transcript in its session directory and runs a
// command the way a real harness does, with the environment its launch path hands it.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { minimalEnv } from "@graphloom/executor-coding-agent";

export const harness = {
  name: "confine-probe",
  resumable: true,
  async createSession(options) {
    return {
      async run() {
        const saved = [];
        try {
          writeFileSync(path.join(options.sessionDir, "transcript.json"), "{}");
          saved.push("session-saved");
        } catch (err) {
          saved.push(`session-failed:${err.code}`);
        }
        const ran = spawnSync("sh", ["-c", 'echo "$GOCACHE|$GOENV|$GOTMPDIR|$npm_config_cache"'], { cwd: options.cwd, env: minimalEnv(process.env, []), encoding: "utf8" });
        return { status: "completed", summary: `${saved.join(",")};${ran.stdout.trim()}`, sessionRef: "probe-ref" };
      },
    };
  },
};
