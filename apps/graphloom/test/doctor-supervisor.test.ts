// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom doctor`'s supervisor checks on hosts with one agent each
 * (docs/design-supervisor-harnesses.md §10, phase S6): Pi only, Claude Code
 * only, and Codex only, with stub CLIs on a stubbed PATH and a temporary
 * HOME. The supervisor config enables all three harnesses; each enabled
 * harness gets its own row from its own `probe()`, which each host shows by
 * a failure only that probe reports (the doctor's CLI and login checks pass).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "../src/doctor.js";
import { STUB_SECRETS, makeDoctorEnv, removeDoctorBase, type DoctorEnv, type DoctorEnvOptions } from "./doctor-env.js";

afterAll(removeDoctorBase);

const row = (report: DoctorReport, name: string): DoctorCheck => {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no ${name} check in ${JSON.stringify(report.checks.map((c) => c.name))}`);
  return found;
};

async function doctor(env: DoctorEnv): Promise<{ report: DoctorReport; text: string }> {
  const json = await env.run(["doctor", "--json"]);
  const text = await env.run(["doctor"]);
  for (const secret of Object.values(STUB_SECRETS)) expect(json.stdout + text.stdout + json.stderr).not.toContain(secret);
  expect(json.stdout, json.stderr).not.toBe("");
  return { report: JSON.parse(json.stdout) as DoctorReport, text: text.stdout };
}

/** A host with the stubs `options` asks for and a supervisor config enabling every harness. */
async function host(options: DoctorEnvOptions, pi: Record<string, unknown> = { provider: "minimax-cn", modelId: "MiniMax-M3" }): Promise<DoctorEnv> {
  const env = await makeDoctorEnv(options);
  await mkdir(path.dirname(env.supervisorFile), { recursive: true });
  await writeFile(env.supervisorFile, JSON.stringify({ harnesses: ["pi", "claude-code", "codex"], pi, claude: {}, codex: {} }));
  return env;
}

describe("graphloom doctor: each enabled supervisor harness's own probe (S6)", () => {
  it("Pi only: Pi's probe passes and is the selection; the CLIs' probes say why not", async () => {
    const env = await host({ claude: "missing", codex: "missing", piEnv: true });
    const { report, text } = await doctor(env);
    expect(row(report, "supervisor pi")).toMatchObject({ status: "pass", detail: "enabled; its probe passed on minimax-cn/MiniMax-M3 (no provider call)" });
    expect(row(report, "supervisor claude-code")).toMatchObject({ status: "warn", detail: expect.stringContaining("cannot run claude --help; is Claude Code installed?") });
    expect(row(report, "supervisor codex")).toMatchObject({ status: "warn", detail: expect.stringContaining("cannot run codex exec --help; is Codex installed?") });
    expect(row(report, "supervisor config").status).toBe("warn");
    expect(row(report, "supervisor")).toMatchObject({ status: "pass", detail: expect.stringContaining("pi (recommended: pi") });
    expect(text).toMatch(/^ {2}pass {2}supervisor pi +enabled; its probe passed/m);

    // The row is Pi's own probe: a model Pi's registry lacks fails with the Pi harness's message.
    const unknown = await host({ claude: "missing", codex: "missing", piEnv: true }, { provider: "minimax-cn", modelId: "no-such-model" });
    expect(row((await doctor(unknown)).report, "supervisor pi")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("Pi model not found: minimax-cn/no-such-model"),
      fix: expect.stringContaining("graphloom setup"),
    });
    // And a provider with no credential fails with its credential message, the fix naming the provider's variable.
    const noKey = await host({ claude: "missing", codex: "missing" });
    expect(row((await doctor(noKey)).report, "supervisor pi")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("credential unavailable for provider minimax-cn"),
      fix: expect.stringContaining("export MINIMAX_CN_API_KEY=<key>"),
    });
  });

  it("Claude Code only: Claude Code's probe passes; Pi's and Codex's say why not", async () => {
    const env = await host({ claude: "ok", codex: "missing" });
    const { report } = await doctor(env);
    expect(row(report, "supervisor claude-code")).toMatchObject({ status: "pass", detail: "enabled; its probe passed on its default model (no provider call)" });
    expect(row(report, "supervisor pi")).toMatchObject({ status: "warn", detail: expect.stringContaining("credential unavailable for provider minimax-cn") });
    expect(row(report, "supervisor codex").status).toBe("warn");
    expect(row(report, "supervisor")).toMatchObject({ status: "pass", detail: expect.stringContaining("claude-code (recommended: claude-code") });

    // Claude Code's own probe looks for the login in its config dir, which `claude auth status` does not:
    // with the CLI check passing, only the probe can fail on it.
    await rm(path.join(env.home, ".claude", ".credentials.json"));
    const { report: noLogin } = await doctor(env);
    expect(row(noLogin, "claude-code").status).toBe("pass");
    expect(row(noLogin, "supervisor claude-code")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining(`Claude Code has no login in ${path.join(env.home, ".claude")}`),
      fix: "claude",
    });
  });

  it("Codex only: Codex's probe passes; Pi's and Claude Code's say why not", async () => {
    const env = await host({ claude: "missing", codex: "ok" });
    const { report } = await doctor(env);
    expect(row(report, "supervisor codex")).toMatchObject({ status: "pass", detail: "enabled; its probe passed on its default model (no provider call)" });
    expect(row(report, "supervisor pi").status).toBe("warn");
    expect(row(report, "supervisor claude-code")).toMatchObject({ status: "warn", detail: expect.stringContaining("is Claude Code installed?") });
    expect(row(report, "supervisor")).toMatchObject({ status: "pass", detail: expect.stringContaining("codex (recommended: codex") });

    // A Codex whose exec lacks the supervisor's flags passes the executor's capability probe, not the supervisor's.
    const older = await host({ claude: "missing", codex: "nosupervisor" });
    const { report: old } = await doctor(older);
    expect(row(old, "codex").status).toBe("pass");
    expect(row(old, "supervisor codex")).toMatchObject({ status: "warn", detail: expect.stringMatching(/codex exec --help does not mention .*; update Codex/) });
  });
});
