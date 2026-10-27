// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The doctor's report over constructed discoveries (docs/design-release.md
 * §4.4): viable setups per harness mix, the supervisor order, each reason
 * automatic updates are a no-op, the supervisor selection, and the agent role
 * checks with their alternatives.
 */
import type { AgentRoleDeclaration } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { exec, type Discovery } from "../src/discovery.js";
import { machineChecks, roleChecks, supervisorSelection, updatesCheck, viableSetups, type DoctorCheck } from "../src/doctor.js";
import { fakeDiscovery } from "./discovery-fixture.js";

const row = (checks: DoctorCheck[], name: string) => {
  const found = checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe("discovery's bounded commands", () => {
  it("time out even when a descendant keeps the output pipes open", async () => {
    const start = Date.now();
    const r = await exec("/bin/sh", ["-c", "sleep 5 & wait"], process.env, 200);
    expect(r.error).toMatch(/timed out after 200 ms/);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect((await exec("/bin/sh", ["-c", "echo hi"], process.env)).stdout).toBe("hi\n");
  });
});

describe("viable setups (§4.4)", () => {
  it("Claude Code only", () => {
    const d = fakeDiscovery({ available: ["claude-code"] });
    expect(viableSetups(d)).toEqual({ defaultHarness: ["claude-code"], enable: [], supervisorLater: ["claude-code"] });
    const checks = machineChecks(d);
    expect(row(checks, "default harness")).toMatchObject({ status: "pass", detail: "claude-code (recommended)" });
    expect(row(checks, "supervisor")).toMatchObject({ status: "warn", detail: expect.stringContaining("Claude Code supervises from the releases that ship them") });
    expect(row(checks, "supervisor").fix).toMatch(/MINIMAX_CN_API_KEY/);
  });

  it("Codex only: no harness can write, and the fix lists each login still missing", () => {
    const d = fakeDiscovery({ available: ["codex"] });
    expect(viableSetups(d)).toEqual({ defaultHarness: [], enable: ["codex"], supervisorLater: ["codex"] });
    const checks = machineChecks(d);
    expect(row(checks, "default harness")).toMatchObject({ status: "warn", fix: "Claude Code: claude; Pi: export MINIMAX_CN_API_KEY=<key>" });
    expect(row(checks, "also enable").detail).toContain("codex (read-only jobs)");
  });

  it("Pi only", () => {
    const d = fakeDiscovery({ available: ["pi"] });
    expect(viableSetups(d)).toEqual({ defaultHarness: ["pi"], enable: [], supervisor: "pi", supervisorLater: [] });
    expect(row(machineChecks(d), "supervisor")).toMatchObject({ status: "pass", detail: expect.stringContaining("the repair reviewer uses the same agent") });
  });

  it("all three, with the supervisor order Pi, Claude Code, Codex", () => {
    const d = fakeDiscovery();
    expect(viableSetups(d)).toEqual({ defaultHarness: ["claude-code", "pi"], enable: ["codex", "pi"], supervisor: "pi", supervisorLater: ["claude-code", "codex"] });
    const checks = machineChecks(d);
    expect(row(checks, "default harness").detail).toBe("claude-code (recommended), pi");
    expect(row(checks, "supervisor").detail).toMatch(/^pi \(order pi, claude-code, codex\)/);
    expect(row(checks, "supervisor").detail).toContain("Claude Code and Codex supervise from the releases that ship them (phases S3, S4)");
  });

  it("without Pi, the next supervisor in the order only counts once its release ships it", () => {
    const d = fakeDiscovery({ available: ["claude-code", "codex"] });
    expect(viableSetups(d).supervisor).toBeUndefined();
    expect(viableSetups(d).supervisorLater).toEqual(["claude-code", "codex"]);
  });
});

describe("automatic updates (§4.4, §5.4)", () => {
  const installed = (updates: Partial<Discovery["updates"]>, gh: Partial<Discovery["gh"]> = {}): Discovery => {
    const d = fakeDiscovery();
    return { ...d, gh: { ...d.gh, ...gh }, updates: { mode: "auto", source: "the default", home: "/home/.local/share/graphloom", canVerify: true, sshKeygen: true, ...updates } };
  };
  it.each([
    ["off in the environment", installed({ mode: "off", source: "GRAPHLOOM_DISABLE_AUTOUPDATE=1" }), /automatic updates are off/, /unset GRAPHLOOM_DISABLE_AUTOUPDATE/],
    ["off in the runner config", installed({ mode: "off", source: "/home/.config/graphloom/runner.json" }), /automatic updates are off/, /"autoUpdate": "auto"/],
    ["a clone", fakeDiscovery(), /not an installed release/, /install\.sh/],
    ["no gh", installed({}, { available: false, reason: "gh is not on PATH", fix: "sudo apt-get install gh" }), /a no-op, because gh is not on PATH/, /apt-get install gh/],
    ["gh logged out", installed({}, { available: false, loggedIn: false, reason: "gh is not logged in", fix: "gh auth login" }), /because gh is not logged in/, /^gh auth login$/],
    ["gh without access", installed({}, { available: false, access: false, reason: "gh cannot read hanahmily/graphloom", fix: "ask a maintainer" }), /cannot read/, /maintainer/],
    ["a recorded failure", installed({ lastFailure: { version: "0.2.0", reason: "checksum mismatch", time: "2026-10-27T00:00:00Z" } }), /last attempt failed for 0\.2\.0 .*checksum mismatch/, /^graphloom upgrade$/],
    ["no ssh-keygen", installed({ sshKeygen: false }), /only announced.*ssh-keygen is not installed/, /openssh-client/],
    ["no release key", installed({ canVerify: false }), /only announced.*no release\/allowed_signers/, /graphloom upgrade/],
  ] as const)("%s is a warn naming why", (_name, d, detail, fix) => {
    const c = updatesCheck(d);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(detail);
    expect(c.fix).toMatch(fix);
  });

  it("passes with the mode, its source, the last check, and the skipped version", () => {
    const c = updatesCheck(installed({ mode: "notify", source: "/r.json", lastCheck: { time: "2026-10-26T00:00:00Z", action: "none" }, skip: "0.3.0" }));
    expect(c).toEqual({ section: "configuration", name: "updates", status: "pass", detail: "notify (from /r.json); last check 2026-10-26T00:00:00Z: none; skipping 0.3.0" });
    // notify never installs, so a missing release key does not matter.
    expect(updatesCheck(installed({ mode: "notify", canVerify: false })).status).toBe("pass");
  });
});

describe("doctor --task: supervisor selection", () => {
  it("none without a supervisor config, Pi from it, and a warning when its Pi model is not available", () => {
    const d = fakeDiscovery();
    expect(supervisorSelection(d)).toMatchObject({ status: "warn", detail: expect.stringContaining("no automatic recovery; pi is available"), fix: "graphloom setup" });
    const configured: Discovery = {
      ...d,
      supervisor: { ...d.supervisor, exists: true, config: { provider: "minimax-cn", modelId: "MiniMax-M3", models: [{ provider: "minimax-cn", modelId: "MiniMax-M3" }] } },
      pi: { ...d.pi, configured: [{ where: "supervisor config", provider: "minimax-cn", modelId: "MiniMax-M3", resolves: true, credential: true }] },
    };
    expect(supervisorSelection(configured)).toMatchObject({ status: "pass", detail: expect.stringMatching(/^pi \(minimax-cn\/MiniMax-M3, from .*supervisor\.json: operator\)/) });
    const noKey: Discovery = { ...configured, pi: { ...configured.pi, configured: [{ ...configured.pi.configured[0]!, credential: false }] } };
    expect(supervisorSelection(noKey)).toMatchObject({ status: "warn", fix: expect.stringContaining("MINIMAX_CN_API_KEY") });
    const broken: Discovery = { ...d, supervisor: { ...d.supervisor, exists: true, error: "supervisor.json: provider must be a non-empty string" } };
    expect(supervisorSelection(broken)).toMatchObject({ status: "fail", detail: expect.stringContaining("run refuses") });
  });
});

describe("doctor --task: agent roles (§4.4)", () => {
  const issueFixRoles = (implementer = "claude-code", reviewer = "codex", verifier = "claude-code"): AgentRoleDeclaration[] => [
    { role: "implementer", harness: implementer, access: "write", setting: "harnesses.implementer" },
    { role: "reviewer", harness: reviewer, access: "read", setting: "harnesses.reviewer" },
    { role: "verifier", harness: verifier, access: "read", distinctFrom: ["reviewer"], setting: "harnesses.verifier" },
  ];
  const withRunner = (d: Discovery, harnesses: string[]): Discovery => ({
    ...d,
    runner: { ...d.runner, exists: true, config: { harness: harnesses[0] as "claude-code", harnesses: harnesses as Array<"claude-code">, allowUnrestricted: true } },
  });

  it("on a host with only Claude Code, the reviewer needs Codex (codex login) or a profile change", () => {
    const d = withRunner(fakeDiscovery({ available: ["claude-code"] }), ["claude-code"]);
    const checks = roleChecks(d, issueFixRoles(), "/work/profiles/repo.json");
    expect(row(checks, "role implementer")).toMatchObject({ status: "pass", detail: "implementer: claude-code (write); enabled and available; alternatives: none" });
    // Claude Code cannot take the reviewer: the verifier, distinct from the reviewer, already uses it.
    expect(row(checks, "role reviewer")).toMatchObject({ status: "fail", detail: expect.stringContaining("codex is not available: not logged in; alternatives: none"), fix: "codex login" });
    expect(row(checks, "role verifier").status).toBe("pass");
  });

  it("an unavailable role harness lists the harnesses that could take the role", () => {
    const d = withRunner(fakeDiscovery({ available: ["claude-code", "pi"] }), ["claude-code", "pi"]);
    const c = row(roleChecks(d, issueFixRoles(), "/work/p.json"), "role reviewer");
    expect(c).toMatchObject({ status: "fail", detail: expect.stringContaining("alternatives: pi") });
    expect(c.fix).toBe('set harnesses.reviewer to "pi" in /work/p.json, or codex login');
  });

  it("a read-only harness on a write role", () => {
    const d = withRunner(fakeDiscovery(), ["claude-code", "codex", "pi"]);
    const c = row(roleChecks(d, issueFixRoles("codex"), "/work/p.json"), "role implementer");
    expect(c).toMatchObject({ status: "fail", detail: expect.stringContaining("codex serves read-only jobs only; alternatives: claude-code, pi") });
    expect(c.fix).toBe('set harnesses.implementer to "claude-code" or "pi" in /work/p.json');
  });

  it("a distinctFrom conflict", () => {
    const d = withRunner(fakeDiscovery(), ["claude-code", "codex", "pi"]);
    const checks = roleChecks(d, issueFixRoles("claude-code", "claude-code", "claude-code"), undefined);
    const c = row(checks, "role verifier");
    expect(c).toMatchObject({ status: "fail", detail: expect.stringContaining("must not share its harness with reviewer; alternatives: codex, pi") });
    expect(c.fix).toBe(`set harnesses.verifier to "codex" or "pi" in the task's config`);
  });

  it("an available harness the runner config does not enable, and no runner config at all", () => {
    const d = withRunner(fakeDiscovery(), ["claude-code"]);
    const c = row(roleChecks(d, issueFixRoles(), undefined), "role reviewer");
    expect(c).toMatchObject({ status: "fail", detail: expect.stringContaining("the runner config does not enable codex"), fix: expect.stringContaining('add "codex" to "harnesses"') });
    const none = row(roleChecks(fakeDiscovery(), issueFixRoles(), undefined), "role implementer");
    expect(none).toMatchObject({ status: "fail", fix: "graphloom setup" });
  });

  it("treats an unknown harness and opaque role text as data", () => {
    const d = withRunner(fakeDiscovery(), ["claude-code", "codex", "pi"]);
    const [c] = roleChecks(d, [{ role: "Grader of ✓", harness: "gemini", access: "read" }], undefined);
    expect(c).toMatchObject({ name: "role Grader of ✓", status: "fail", detail: expect.stringContaining("gemini is not a harness GraphLoom runs") });
  });
});
