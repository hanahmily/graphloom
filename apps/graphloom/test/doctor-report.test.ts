// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The doctor's report over constructed discoveries (docs/design-release.md
 * §4.4): viable setups per harness mix, the supervisor order, each reason
 * automatic updates are a no-op, the supervisor selection, and the agent role
 * checks with their alternatives.
 */
import type { AgentRoleDeclaration, SupervisorPreference } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { exec, NO_PI_CREDENTIAL_FIX, piCredentialFix, type Discovery } from "../src/discovery.js";
import { machineChecks, roleChecks, supervisorRoutes, supervisorSelection, updatesCheck, viableSetups, type DoctorCheck } from "../src/doctor.js";
import { recommend, recommendedPi } from "../src/setup.js";
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
  it("Claude Code only: Claude Code supervises (S3)", () => {
    const d = fakeDiscovery({ available: ["claude-code"] });
    expect(viableSetups(d)).toEqual({ defaultHarness: ["claude-code"], enable: [], supervisor: "claude-code", supervisors: ["claude-code"] });
    const checks = machineChecks(d);
    expect(row(checks, "default harness")).toMatchObject({ status: "pass", detail: "claude-code (recommended)" });
    expect(row(checks, "supervisor")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^claude-code \(recommended: claude-code; order pi, claude-code, codex\)/) });
  });

  it("Claude Code whose supervisor probe fails does not count as a supervisor", () => {
    const d = fakeDiscovery({ available: ["claude-code"] });
    d.supervisorCandidates["claude-code"] = { harness: "claude-code", ok: false, reason: "Claude Code has no login in /home/.claude; run `claude /login`", fix: "claude" };
    expect(viableSetups(d).supervisor).toBeUndefined();
    expect(row(machineChecks(d), "supervisor")).toMatchObject({ status: "warn", detail: expect.stringContaining("claude-code: Claude Code has no login"), fix: expect.stringContaining("Claude Code: claude") });
  });

  it("Codex only: no harness can write, Codex supervises (S4), and the fixes list each login still missing", () => {
    const d = fakeDiscovery({ available: ["codex"] });
    expect(viableSetups(d)).toEqual({ defaultHarness: [], enable: ["codex"], supervisor: "codex", supervisors: ["codex"] });
    const checks = machineChecks(d);
    expect(row(checks, "default harness")).toMatchObject({ status: "warn", fix: `Claude Code: claude; Pi: ${NO_PI_CREDENTIAL_FIX}` });
    expect(row(checks, "also enable").detail).toContain("codex (read-only jobs)");
    expect(row(checks, "supervisor").detail).toMatch(/^codex \(recommended: codex; order pi, claude-code, codex\)/);
  });

  it("Codex whose supervisor probe fails does not count as a supervisor", () => {
    const d = fakeDiscovery({ available: ["codex"] });
    d.supervisorCandidates.codex = { harness: "codex", ok: false, reason: "Codex has no login in /home/.codex; run `codex login`", fix: "codex login" };
    expect(viableSetups(d).supervisor).toBeUndefined();
    expect(row(machineChecks(d), "supervisor")).toMatchObject({ status: "warn", detail: expect.stringContaining("codex: Codex has no login"), fix: expect.stringContaining("Codex: codex login") });
  });

  it("Pi only", () => {
    const d = fakeDiscovery({ available: ["pi"] });
    expect(viableSetups(d)).toEqual({ defaultHarness: ["pi"], enable: [], supervisor: "pi", supervisors: ["pi"] });
    expect(row(machineChecks(d), "supervisor")).toMatchObject({ status: "pass", detail: expect.stringContaining("the repair reviewer uses the same agent") });
  });

  it("all three, with the supervisor order Pi, Claude Code, Codex", () => {
    const d = fakeDiscovery();
    expect(viableSetups(d)).toEqual({ defaultHarness: ["claude-code", "pi"], enable: ["codex", "pi"], supervisor: "pi", supervisors: ["pi", "claude-code", "codex"] });
    const checks = machineChecks(d);
    expect(row(checks, "default harness").detail).toBe("claude-code (recommended), pi");
    expect(row(checks, "supervisor").detail).toMatch(/^pi, claude-code, codex \(recommended: pi; order pi, claude-code, codex\)/);
    expect(row(checks, "supervisor").detail).not.toContain("phase S4");
  });

  it("without Pi, Claude Code is next in the order, then Codex (counted since S4)", () => {
    const d = fakeDiscovery({ available: ["claude-code", "codex"] });
    expect(viableSetups(d)).toMatchObject({ supervisor: "claude-code", supervisors: ["claude-code", "codex"] });
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
  const sel = (d: Discovery, preference?: SupervisorPreference) => supervisorSelection(d, preference)[0]!;
  const pi = { provider: "minimax-cn", modelId: "MiniMax-M3", models: [{ provider: "minimax-cn", modelId: "MiniMax-M3" }] };
  const claude = { models: [{ provider: "claude-code", modelId: "opus" }, { provider: "claude-code", modelId: "sonnet" }] };
  const perHarness = (d: Discovery, ok: Partial<Record<"pi" | "claude-code" | "codex", boolean>>, extra: Record<string, unknown> = {}): Discovery => ({
    ...d,
    supervisor: { ...d.supervisor, exists: true, config: { ...pi, harnesses: ["pi", "claude-code", "codex"], claude, codex: { models: [{ provider: "codex", modelId: "default" }] }, ...extra } },
    supervisorEnabled: (["pi", "claude-code", "codex"] as const).map((h) => (ok[h] ? { harness: h, ok: true } : { harness: h, ok: false, reason: `${h} is missing`, fix: `fix-${h}` })),
  });

  it("none without a supervisor config; the harness run would select from it; a warning when it is not available", () => {
    const d = fakeDiscovery();
    expect(sel(d)).toMatchObject({ status: "warn", detail: expect.stringContaining("no automatic recovery; pi is available"), fix: "graphloom setup" });
    expect(sel(d, { harnesses: ["codex"], required: true })).toMatchObject({ status: "warn", detail: expect.stringContaining("the plugin prefers codex (required)") });
    const flat: Discovery = { ...d, supervisor: { ...d.supervisor, exists: true, config: pi }, supervisorEnabled: [{ harness: "pi", ok: true }] };
    expect(sel(flat)).toMatchObject({ status: "pass", detail: expect.stringMatching(/^pi \(minimax-cn\/MiniMax-M3\) \(operator: the operator's Pi supervisor config, from .*supervisor\.json\)/) });
    const noKey: Discovery = { ...flat, supervisorEnabled: [{ harness: "pi", ok: false, reason: "no credential for minimax-cn", fix: "export MINIMAX_CN_API_KEY=<key>" }] };
    expect(sel(noKey)).toMatchObject({ status: "warn", detail: expect.stringContaining("which is not available"), fix: expect.stringContaining("MINIMAX_CN_API_KEY") });
    // A per-harness config falls back past an unavailable Pi to Claude Code, as run does.
    const fallback = perHarness(d, { "claude-code": true });
    expect(sel(fallback)).toMatchObject({ status: "pass", detail: expect.stringMatching(/^claude-code \(opus\) \(fallback: claude-code, the first enabled harness available \(pi: pi is missing\)/) });
    const none = perHarness(d, {});
    expect(sel(none)).toMatchObject({ status: "warn", detail: expect.stringContaining("none: no enabled harness is available"), fix: "fix-pi; fix-claude-code; fix-codex" });
    const refused = perHarness(d, { pi: true }, { select: "codex" });
    expect(sel(refused)).toMatchObject({ status: "fail", detail: expect.stringContaining("run refuses: supervisor: select codex is not available: codex is missing") });
    const broken: Discovery = { ...d, supervisor: { ...d.supervisor, exists: true, error: "supervisor.json: provider must be a non-empty string" } };
    expect(sel(broken)).toMatchObject({ status: "fail", detail: expect.stringContaining("run refuses") });
  });

  it("joins the plugin's preference through the selection run makes (S5), one row per branch", () => {
    const d = fakeDiscovery();
    const all = perHarness(d, { pi: true, "claude-code": true, codex: true });
    // The plugin's order among enabled, available harnesses.
    expect(sel(all, { harnesses: ["codex", "pi"] })).toMatchObject({ status: "pass", detail: expect.stringMatching(/^codex \(plugin: the plugin's preference \(codex, pi\): codex, from /) });
    // Past one that is not available, with the reason.
    expect(sel(perHarness(d, { pi: true, "claude-code": true }), { harnesses: ["codex", "claude-code"] })).toMatchObject({ detail: expect.stringMatching(/^claude-code \(opus\) \(plugin: .*\(codex: codex is missing\)/) });
    // The operator's select overrides the plugin.
    expect(sel(perHarness(d, { pi: true, codex: true }, { select: "pi" }), { harnesses: ["codex"] })).toMatchObject({ status: "pass", detail: expect.stringMatching(/^pi \(minimax-cn\/MiniMax-M3\) \(operator: select pi/) });
    // A harness the operator does not enable is forbidden, even when the plugin prefers it.
    const piOnly: Discovery = { ...all, supervisor: { ...all.supervisor, config: { ...pi, harnesses: ["pi", "claude-code"], claude } }, supervisorEnabled: all.supervisorEnabled.filter((c) => c.harness !== "codex") };
    expect(sel(piOnly, { harnesses: ["codex", "claude-code"] })).toMatchObject({ detail: expect.stringMatching(/^claude-code \(opus\) \(plugin: .*\(codex: not enabled by the operator\)/) });
    // None of the plugin's: the operator's order, with the reason; or a refusal when it is required.
    expect(sel(piOnly, { harnesses: ["codex"] })).toMatchObject({ status: "pass", detail: expect.stringMatching(/^pi .*\(fallback: none of the plugin's harnesses \(codex\) is enabled and available \(codex: not enabled by the operator\), so the operator's order applies: the first enabled harness, pi/) });
    expect(sel(piOnly, { harnesses: ["codex"], required: true })).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("run refuses: supervisor: plugin requires one of codex; enabled and available: pi, claude-code"),
      fix: expect.stringContaining("or enable one of codex in"),
    });
    // Model hints: a configured one is honored silently (the selection shows the hinted model run starts on), an unconfigured one warns.
    const hinted = supervisorSelection(all, { harnesses: ["claude-code"], models: { "claude-code": ["sonnet", "haiku"], codex: ["gpt-5-codex"] } });
    expect(hinted[0]).toMatchObject({ status: "pass", detail: expect.stringMatching(/^claude-code \(sonnet\) \(plugin/) });
    expect(hinted.slice(1).map((c) => [c.name, c.status, c.detail])).toEqual([
      ["supervisor model hints", "warn", expect.stringContaining("claude-code model hint haiku is not among the operator's claude-code models (opus, sonnet)")],
      ["supervisor model hints", "warn", expect.stringContaining("codex model hint gpt-5-codex is not among the operator's codex models (default)")],
    ]);
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

describe("any Pi provider (no MiniMax binding)", () => {
  it("names each provider's own key variable from Pi's table, or its models.json reference", () => {
    expect(piCredentialFix("deepseek")).toBe("export DEEPSEEK_API_KEY=<key>   (or store it with pi: /login)");
    expect(piCredentialFix("anthropic")).toBe("export ANTHROPIC_API_KEY=<key>   (or store it with pi: /login)");
    expect(piCredentialFix("google")).toBe("export GEMINI_API_KEY=<key>   (or store it with pi: /login)");
    expect(piCredentialFix("minimax-cn")).toBe("export MINIMAX_CN_API_KEY=<key>   (or store it with pi: /login)");
    expect(piCredentialFix("my-endpoint")).toMatch(/variable my-endpoint's apiKey references in Pi's models.json/);
    expect(NO_PI_CREDENTIAL_FIX).not.toMatch(/^export MINIMAX/);
  });

  it("recommends the first provider with a credential, on Pi's own default model, without MiniMax", () => {
    const d = fakeDiscovery({ piProviders: ["deepseek", "openai"] });
    d.pi = { ...d.pi, models: { deepseek: ["deepseek-flash", "deepseek-v4-pro"], openai: ["gpt-4", "gpt-5.5"] }, defaults: { deepseek: "deepseek-v4-pro", openai: "gpt-5.5" } };
    expect(recommendedPi(d)).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
    expect(recommendedPi(d, "openai")).toEqual({ provider: "openai", modelId: "gpt-5.5" });
    expect(recommend(d)).toMatchObject({ pi: { provider: "deepseek" }, supervisor: { provider: "deepseek", modelId: "deepseek-v4-pro" } });
  });

  it("prefers the configured supervisor model when its provider has a credential, and MiniMax-M3 only as minimax-cn's fallback", () => {
    const d = fakeDiscovery({ piProviders: ["deepseek", "minimax-cn"] });
    d.pi = { ...d.pi, defaults: { deepseek: "deepseek-v4-pro", "minimax-cn": "MiniMax-M2.7" } };
    expect(recommendedPi(d, "minimax-cn")).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    d.pi.configured = [{ where: "supervisor config", provider: "minimax-cn", modelId: "MiniMax-M2.7", resolves: true, credential: true }];
    expect(recommendedPi(d, undefined, "supervisor")).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M2.7" });
    // A configured provider without a credential is not recommended.
    d.pi.configured = [{ where: "supervisor config", provider: "openai", modelId: "gpt-5.5", resolves: true, credential: false }];
    expect(recommendedPi(d, undefined, "supervisor")).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
  });

  it("presents each vendor's routes: Claude via Claude Code or Pi, OpenAI via Codex (S4) or Pi, the rest via Pi", () => {
    const d = fakeDiscovery({ piProviders: ["anthropic", "deepseek", "google"] });
    d.pi = { ...d.pi, credentials: [{ provider: "anthropic", source: "ANTHROPIC_API_KEY" }, { provider: "deepseek", source: "DEEPSEEK_API_KEY" }, { provider: "google", source: "auth store" }] };
    expect(supervisorRoutes(d)).toEqual([
      "Claude: via Claude Code (logged in) or via Pi (anthropic: ANTHROPIC_API_KEY present)",
      "OpenAI: via Codex (logged in) or via Pi (openai: no OPENAI_API_KEY)",
      "Gemini, DeepSeek, MiniMax, Kimi, and every other provider: via Pi (credentials present for deepseek (DEEPSEEK_API_KEY), google (auth store))",
    ]);
    expect(row(machineChecks(d), "supervisor routes").detail).toContain("Claude: via Claude Code (logged in) or via Pi");    // Codex counts as a route only when its supervisor probe passes, as Claude Code does.
    d.supervisorCandidates.codex = { harness: "codex", ok: false, reason: "not logged in (codex login status)", fix: "codex login" };
    expect(supervisorRoutes(d)[1]).toBe("OpenAI: via Codex (not available: not logged in (codex login status)) or via Pi (openai: no OPENAI_API_KEY)");
  });
});
