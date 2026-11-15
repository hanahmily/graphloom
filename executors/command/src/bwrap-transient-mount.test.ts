// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confinementUnsupported, createBuiltinExecutorRunner, type JobContext, type Runner } from "@graphloom/runner";
import type { BwrapConfinement, JobSpec } from "@graphloom/sdk";

// Probed with the real bubblewrap, before any stand-in is put on PATH.
const unsupported = await confinementUnsupported();
const realBwrap = unsupported === undefined ? execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim() : "";

/** What bubblewrap 0.9.0 printed on a host whose Docker healthchecks mount under /tmp, verbatim. */
const SETUP_FAILURE =
  'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/tmp/containerd-mount1715733460": Invalid argument';

let dir: string;
let work: string;
let bin: string;
const savedPath = process.env.PATH;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-bwrap-transient-"));
  work = path.join(dir, "work");
  bin = path.join(dir, "bin");
  await mkdir(work);
  await mkdir(bin);
  // A stand-in bwrap that fails its first GL_FAKE_BWRAP_FAILS starts the way bubblewrap does when a host mount
  // vanishes during setup (its init's pid on the status fd, its message, exit 1, the command never executed),
  // then hands over to the real one. Each start is counted.
  await writeFile(
    path.join(bin, "bwrap"),
    [
      "#!/bin/sh",
      `n=$(cat "${dir}/starts" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/starts"`,
      'if [ "$n" -le "${GL_FAKE_BWRAP_FAILS:-0}" ]; then',
      `  echo '{ "child-pid": 999999, "mnt-namespace": 1, "pid-namespace": 2 }' >&3`,
      `  echo '${SETUP_FAILURE.replaceAll("'", "'\\''")}' >&2`,
      "  exit 1",
      "fi",
      `exec ${JSON.stringify(realBwrap)} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(path.join(bin, "bwrap"), 0o755);
});

/** A runner, made while the stand-in is on PATH: a built-in runner takes the environment it is made in. */
async function makeRunner(): Promise<Runner> {
  const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
  return createBuiltinExecutorRunner({
    packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
    fallback: { runJob: async () => { throw new Error("not served"); } },
  });
}

afterAll(async () => {
  process.env.PATH = savedPath;
  delete process.env.GL_FAKE_BWRAP_FAILS;
  await rm(dir, { recursive: true, force: true });
});

const sandbox: BwrapConfinement = { kind: "bwrap", network: true, mask: [], binds: [] };

function job(script: string): JobSpec {
  return { stageId: "s", kind: "command", purpose: "check", instruction: "x", writeScope: ["."], input: { commands: [{ id: "c", argv: ["sh", "-c", script] }] }, confinement: sandbox };
}

let op = 0;
function ctx(): JobContext {
  op += 1;
  return {
    runId: "r1",
    operationId: `op-${op}`,
    generation: 1,
    worktreePath: work,
    artifactDir: path.join(dir, "artifacts"),
    confinement: { scratchDir: path.join(dir, "scratch"), writablePaths: [work] },
  };
}

/** Run one job through the stand-in that fails its first `fails` starts; how many starts it saw, and how often the command ran. */
async function withFailingStarts(fails: number, script: string) {
  await writeFile(path.join(dir, "starts"), "0");
  await rm(path.join(work, "ran.txt"), { force: true });
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  process.env.GL_FAKE_BWRAP_FAILS = String(fails);
  try {
    const result = await (await makeRunner()).runJob(job(script), ctx());
    const starts = Number((await readFile(path.join(dir, "starts"), "utf8")).trim());
    const ran = (await readFile(path.join(work, "ran.txt"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    return { result, starts, ran };
  } finally {
    process.env.PATH = savedPath;
    delete process.env.GL_FAKE_BWRAP_FAILS;
  }
}

describe.skipIf(unsupported !== undefined)("a confined job whose sandbox setup hits a host mount that changed under it", () => {
  it("starts the sandbox again and runs the command once", async () => {
    const { result, starts, ran } = await withFailingStarts(2, "echo ran >> ran.txt");
    expect(result.status, result.summary).toBe("ok");
    expect(starts).toBe(3);
    expect(ran).toBe(1);
  });

  it("gives up after a bounded number of starts, and says so", async () => {
    const { result, starts, ran } = await withFailingStarts(100, "echo ran >> ran.txt");
    expect(result.status).toBe("failed");
    expect(starts).toBe(4);
    expect(ran).toBe(0);
    expect(result.summary).toContain("the sandbox was started 4 times");
    expect(result.summary).toContain("Unable to apply mount flags");
  });

  it("never starts again a sandbox whose executor ran and then died", async () => {
    // The command kills the executor: the sandbox exits non-zero, but bubblewrap reports an exit code, so it ran.
    // (A forged setup message on bubblewrap's standard error is covered with the real bubblewrap in the runner's
    // confine-retry tests; an executor's commands cannot reach that stream here.)
    const { result, starts, ran } = await withFailingStarts(0, "echo ran >> ran.txt; kill -9 $PPID");
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("executor child exited (code=137)");
    expect(starts).toBe(1);
    expect(ran).toBe(1);
    expect(result.summary).not.toContain("the sandbox was started");
  });
});

/**
 * The real thing, in a user and mount namespace the test owns (`unshare -rm`): two loops mount and unmount
 * tmpfs under a shared directory in the test's temporary directory while confined jobs run, as containerd's
 * healthcheck mounts under /tmp do on a Docker host. Real bubblewrap then fails some starts with the message above; every job must still succeed,
 * running its command exactly once. Skipped where unprivileged user and mount namespaces are not available.
 */
const userns =
  unsupported === undefined &&
  spawnSync("unshare", ["-rm", "--propagation", "unchanged", "sh", "-c", `${JSON.stringify(realBwrap)} --ro-bind / / --dev /dev true`], { stdio: "ignore" }).status === 0;

describe.skipIf(!userns)("a confined job on a host whose mounts under /tmp come and go", () => {
  it("succeeds every time, its command running once", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const runnerUrl = pathToFileURL(path.resolve(here, "../../../packages/runner/dist/index.js")).href;
    const packageUrl = pathToFileURL(path.resolve(here, "../dist/package.js")).href;
    const flapWork = path.join(dir, "flap-work");
    await mkdir(flapWork);
    const driver = path.join(dir, "driver.mjs");
    await writeFile(
      driver,
      `import { readFileSync } from "node:fs";
import path from "node:path";
import { confinementUnsupported, createBuiltinExecutorRunner } from ${JSON.stringify(runnerUrl)};
import { commandBinding, commandExecutorPackage } from ${JSON.stringify(packageUrl)};
const [dir, work] = process.argv.slice(2);
const unsupported = await confinementUnsupported();
if (unsupported !== undefined) { console.log(JSON.stringify({ unsupported })); process.exit(0); }
const runner = createBuiltinExecutorRunner({ packages: [{ manifest: commandExecutorPackage, ...commandBinding() }], fallback: { runJob: async () => { throw new Error("not served"); } } });
const starts = () => readFileSync(path.join(dir, "starts"), "utf8").split("\\n").filter((l) => l === "job").length;
const failures = [];
let jobs = 0;
// Until some start has been seen to fail (a retry), and at least 10 jobs; at most 80.
while (jobs < 80 && (jobs < 10 || starts() === jobs)) {
  jobs += 1;
  const result = await runner.runJob(
    { stageId: "s", kind: "command", purpose: "check", instruction: "x", writeScope: ["."], input: { commands: [{ id: "c", argv: ["sh", "-c", "echo ran >> ran.txt"] }] }, confinement: { kind: "bwrap", network: true, mask: [], binds: [] } },
    { runId: "r", operationId: "op-" + jobs, generation: 1, worktreePath: work, artifactDir: path.join(dir, "flap-artifacts"), confinement: { scratchDir: path.join(dir, "flap-scratch"), writablePaths: [work] } },
  );
  if (result.status !== "ok") failures.push(result.summary);
}
console.log(JSON.stringify({ jobs, starts: starts(), failures }));
`,
    );
    // The counting stand-in: every start of a job's sandbox (not the probe, whose command is \`true\`) is recorded.
    const countBin = path.join(dir, "count-bin");
    await mkdir(countBin);
    await writeFile(
      path.join(countBin, "bwrap"),
      `#!/bin/sh\neval "last=\\\${$#}"\n[ "$last" = true ] || echo job >> "${dir}/starts"\nexec ${JSON.stringify(realBwrap)} "$@"\n`,
    );
    await chmod(path.join(countBin, "bwrap"), 0o755);
    await writeFile(path.join(dir, "starts"), "");
    const script = `set -e
flap=${JSON.stringify(path.join(dir, "flap"))}
mkdir "$flap" "$flap/a" "$flap/b"
mount --bind "$flap" "$flap"
mount --make-shared "$flap"
for m in a b; do ( while [ ! -e "$flap/stop" ]; do mount -t tmpfs flap "$flap/$m" 2>/dev/null || true; umount "$flap/$m" 2>/dev/null || true; done ) & done
set +e
PATH="${countBin}:$PATH" ${JSON.stringify(process.execPath)} ${JSON.stringify(driver)} ${JSON.stringify(dir)} ${JSON.stringify(flapWork)}
status=$?
touch "$flap/stop"
wait
umount "$flap" 2>/dev/null || true
rm -rf "$flap"
exit $status
`;
    const res = spawnSync("unshare", ["-rm", "--propagation", "unchanged", "sh", "-c", script], { encoding: "utf8", timeout: 240_000 });
    expect(res.status, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout.trim().split("\n").pop()!) as { unsupported?: string; jobs: number; starts: number; failures: string[] };
    if (report.unsupported !== undefined) return; // bwrap cannot nest here; nothing to show
    expect(report.failures).toEqual([]);
    // Some start really failed on a vanishing mount and was started again ...
    expect(report.starts).toBeGreaterThan(report.jobs);
    // ... and each job's command still ran exactly once.
    const ran = (await readFile(path.join(flapWork, "ran.txt"), "utf8")).split("\n").filter(Boolean).length;
    expect(ran).toBe(report.jobs);
  }, 300_000);
});
