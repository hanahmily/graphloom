// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Supervisor selection (design-supervisor-harnesses.md §7.3, §7.4, phase S5):
 * the full precedence table `run`, `resume`, `check`, and `doctor --task`
 * share, the plugin's model hints, the resume plan for pinned, transitioned,
 * S3-pinned, and never-pinned runs, `check`'s report per branch, and
 * `switch-model` on the pinned harness.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DurableRunState } from "@graphloom/controller";
import type { GraphDefinition, SupervisorPreference } from "@graphloom/sdk";
import type { HarnessProbe, SupervisorHarnessName } from "@graphloom/supervisor";
import { checkSupervisorSelection } from "../src/rehearsal.js";
import {
  ignoredModelHints,
  parseSupervisorConfig,
  resolveSupervisorSelection,
  resumeSupervisorPlan,
  selectSupervisorHarness,
  supervisorChooser,
  withModelHints,
  type SupervisorConfig,
} from "../src/supervisor-config.js";
import { switchModelTarget } from "../src/switch-model.js";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

type Avail = Partial<Record<SupervisorHarnessName, boolean>>;
const sync = (ok: Avail) => (h: SupervisorHarnessName): HarnessProbe => (ok[h] ? { ok: true } : { ok: false, reason: `${h} is missing` });
const async_ = (ok: Avail) => async (h: SupervisorHarnessName): Promise<HarnessProbe> => sync(ok)(h);

const ALL = parseSupervisorConfig({
  harnesses: ["pi", "claude-code", "codex"],
  pi: { provider: "minimax-cn", modelId: "MiniMax-M3", models: ["deepseek/deepseek-v4-pro"] },
  claude: { models: ["opus", "sonnet"] },
  codex: { models: ["gpt-5-codex", { modelId: "o4", thinkingLevel: "high" }] },
});
const FLAT = parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3" });
const withHarnesses = (harnesses: SupervisorHarnessName[], extra: Record<string, unknown> = {}): SupervisorConfig =>
  parseSupervisorConfig({ harnesses, pi: { provider: "minimax-cn", modelId: "MiniMax-M3" }, claude: { models: ["opus", "sonnet"] }, codex: {}, ...extra });
const resolve = (config: SupervisorConfig, ok: Avail, options: { flag?: string; preference?: SupervisorPreference } = {}) => resolveSupervisorSelection(config, sync(ok), options);
const pick = (config: SupervisorConfig, ok: Avail, options: { flag?: string; preference?: SupervisorPreference } = {}) => resolve(config, ok, options).selection;

describe("the selection table (§7.3)", () => {
  const everything: Avail = { pi: true, "claude-code": true, codex: true };
  const plugin: SupervisorPreference = { harnesses: ["codex", "claude-code"] };

  it("1. --supervisor wins over select and the plugin, and must be enabled and available", () => {
    const selected = withHarnesses(["pi", "claude-code", "codex"], { select: "pi" });
    expect(pick(selected, everything, { flag: "claude-code", preference: plugin })).toEqual({ harness: "claude-code", source: "flag", reason: "--supervisor claude-code" });
    expect(() => resolve(selected, { pi: true }, { flag: "claude-code" })).toThrow("supervisor: --supervisor claude-code is not available: claude-code is missing");
    expect(() => resolve(withHarnesses(["pi"]), everything, { flag: "codex" })).toThrow("supervisor: --supervisor codex is not enabled in the operator's supervisor config (enabled: pi)");
    expect(() => resolve(ALL, everything, { flag: "gemini" })).toThrow(/--supervisor gemini is not enabled/);
    // Named by the flag, even the flat form's Pi must pass its probe.
    expect(() => resolve(FLAT, {}, { flag: "pi" })).toThrow("supervisor: --supervisor pi is not available: pi is missing");
    expect(pick(FLAT, { pi: true }, { flag: "pi" })).toMatchObject({ harness: "pi", source: "flag" });
  });

  it("2. the operator's select overrides the plugin for every run, under the same conditions", () => {
    const selected = withHarnesses(["pi", "claude-code", "codex"], { select: "pi" });
    expect(pick(selected, everything, { preference: { ...plugin, required: true } })).toEqual({ harness: "pi", source: "operator", reason: "select pi" });
    expect(() => resolve(selected, { codex: true }, { preference: plugin })).toThrow("supervisor: select pi is not available: pi is missing");
  });

  it("3. the plugin's order among the harnesses the operator enabled that are available", () => {
    expect(pick(ALL, everything, { preference: plugin })).toEqual({ harness: "codex", source: "plugin", reason: "the plugin's preference (codex, claude-code): codex" });
    // Past one that is not available, and one the operator forbids by not listing it.
    expect(pick(ALL, { pi: true, "claude-code": true }, { preference: plugin })).toEqual({ harness: "claude-code", source: "plugin", reason: "the plugin's preference (codex, claude-code): claude-code (codex: codex is missing)" });
    expect(pick(withHarnesses(["pi", "claude-code"]), everything, { preference: plugin })).toEqual({
      harness: "claude-code",
      source: "plugin",
      reason: "the plugin's preference (codex, claude-code): claude-code (codex: not enabled by the operator)",
    });
    // The plugin order wins over the operator's order among enabled harnesses.
    expect(pick(withHarnesses(["codex", "claude-code", "pi"]), everything, { preference: { harnesses: ["pi", "codex"] } })?.harness).toBe("pi");
  });

  it("4. none of the plugin's: refused when required, else the operator's order with the reason recorded", () => {
    const piOnly = withHarnesses(["pi", "claude-code"]);
    expect(() => resolve(piOnly, { pi: true, "claude-code": true }, { preference: { harnesses: ["codex"], required: true } })).toThrow(
      "supervisor: plugin requires one of codex; enabled and available: pi, claude-code (codex: not enabled by the operator)",
    );
    expect(() => resolve(ALL, { pi: true }, { preference: { harnesses: ["codex", "claude-code"], required: true } })).toThrow(
      "supervisor: plugin requires one of codex, claude-code; enabled and available: pi (codex: codex is missing; claude-code: claude-code is missing)",
    );
    expect(() => resolve(ALL, {}, { preference: { harnesses: ["codex"], required: true } })).toThrow(/enabled and available: none/);
    expect(pick(ALL, { "claude-code": true }, { preference: { harnesses: ["codex"] } })).toEqual({
      harness: "claude-code",
      source: "fallback",
      reason: "none of the plugin's harnesses (codex) is enabled and available (codex: codex is missing), so the operator's order applies: claude-code, the first enabled harness available (pi: pi is missing)",
    });
  });

  it("5. no harness available: no supervisor, with why; selectSupervisorHarness says so and returns none", async () => {
    expect(resolve(ALL, {})).toEqual({ none: "no enabled harness is available (pi: pi is missing; claude-code: claude-code is missing; codex: codex is missing)", warnings: [] });
    expect(resolve(ALL, {}, { preference: { harnesses: ["codex"] } }).selection).toBeUndefined();
    const said: string[] = [];
    expect(await selectSupervisorHarness(ALL, { probe: async_({}), onNone: (why) => said.push(why) })).toBeUndefined();
    expect(said).toEqual([expect.stringContaining("no enabled harness is available")]);
  });

  it("with no preference, the operator's order, Pi first by default", () => {
    expect(pick(parseSupervisorConfig({ pi: {}, claude: {}, codex: {} }), everything)).toEqual({ harness: "pi", source: "fallback", reason: "the first enabled harness, pi" });
    expect(pick(ALL, { codex: true })?.harness).toBe("codex");
  });

  it("the flat Pi form enables Pi alone, unprobed, and a plugin's preference chooses within it", () => {
    let probed = false;
    const spy = (h: SupervisorHarnessName): HarnessProbe => ((probed = true), sync({})(h));
    expect(resolveSupervisorSelection(FLAT, spy).selection).toEqual({ harness: "pi", source: "operator", reason: "the operator's Pi supervisor config" });
    expect(resolveSupervisorSelection(FLAT, spy, { preference: { harnesses: ["pi", "codex"] } }).selection).toEqual({ harness: "pi", source: "plugin", reason: "the plugin's preference (pi, codex): pi" });
    expect(resolveSupervisorSelection(FLAT, spy, { preference: { harnesses: ["claude-code"] } }).selection).toEqual({
      harness: "pi",
      source: "fallback",
      reason: "none of the plugin's harnesses (claude-code) is enabled and available (claude-code: not enabled by the operator), so the operator's order applies: the operator's Pi supervisor config",
    });
    expect(() => resolveSupervisorSelection(FLAT, spy, { preference: { harnesses: ["claude-code"], required: true } })).toThrow(/plugin requires one of claude-code; enabled and available: pi/);
    expect(probed).toBe(false);
  });

  it("selectSupervisorHarness probes every enabled harness once and resolves on those probes", async () => {
    const asked: string[] = [];
    const probe = async (h: SupervisorHarnessName): Promise<HarnessProbe> => (asked.push(h), sync({ codex: true })(h));
    expect(await selectSupervisorHarness(ALL, { probe, preference: { harnesses: ["claude-code", "codex"] } })).toMatchObject({ harness: "codex", source: "plugin" });
    expect(asked.sort()).toEqual(["claude-code", "codex", "pi"]);
    // A flag or select decides alone: only it is probed.
    asked.length = 0;
    expect(await selectSupervisorHarness(ALL, { probe, flag: "codex" })).toMatchObject({ harness: "codex", source: "flag" });
    expect(asked).toEqual(["codex"]);
    // A probe that throws counts as not available.
    const broken = async (h: SupervisorHarnessName): Promise<HarnessProbe> => {
      if (h === "pi") throw new Error("registry unreadable");
      return { ok: true };
    };
    expect(await selectSupervisorHarness(ALL, { probe: broken })).toMatchObject({ harness: "claude-code", reason: expect.stringContaining("pi: registry unreadable") });
  });
});

describe("the plugin's model hints (§7.2)", () => {
  it("reorder the operator's models for the selected harness; the first is the initial one", () => {
    const pi = withModelHints(ALL, "pi", { harnesses: ["pi"], models: { pi: ["deepseek/deepseek-v4-pro"] } });
    expect([pi.provider, pi.modelId]).toEqual(["deepseek", "deepseek-v4-pro"]);
    expect(pi.models.map((m) => `${m.provider}/${m.modelId}`)).toEqual(["deepseek/deepseek-v4-pro", "minimax-cn/MiniMax-M3"]);
    const claude = withModelHints(ALL, "claude-code", { harnesses: ["claude-code"], models: { "claude-code": ["claude-code/sonnet"] } });
    expect(claude.claude?.models.map((m) => m.modelId)).toEqual(["sonnet", "opus"]);
    const codex = withModelHints(ALL, "codex", { harnesses: ["codex"], models: { codex: ["o4", "gpt-5-codex"] } });
    expect(codex.codex?.models).toEqual([{ provider: "codex", modelId: "o4", thinkingLevel: "high" }, { provider: "codex", modelId: "gpt-5-codex" }]);
    // An unconfigured hint is ignored, with no substitution, and named for check.
    expect(withModelHints(ALL, "claude-code", { harnesses: ["claude-code"], models: { "claude-code": ["haiku"] } })).toBe(ALL);
    expect(ignoredModelHints(ALL, { harnesses: ["claude-code"], models: { "claude-code": ["haiku", "opus"], pi: ["openai/gpt-5"] } })).toEqual([
      "the plugin's claude-code model hint haiku is not among the operator's claude-code models (opus, sonnet), so it is ignored",
      "the plugin's pi model hint openai/gpt-5 is not among the operator's pi models (minimax-cn/MiniMax-M3, deepseek/deepseek-v4-pro), so it is ignored",
    ]);
    // Hints for a harness the operator does not enable are not the operator's concern.
    expect(ignoredModelHints(withHarnesses(["pi"]), { harnesses: ["codex"], models: { codex: ["x"] } })).toEqual([]);
    expect(resolve(ALL, { pi: true }, { preference: { harnesses: ["pi"], models: { "claude-code": ["haiku"] } } }).warnings).toHaveLength(1);
  });

  it("the run's chooser starts the selected harness on the hinted model and pairs the reviewer with it", async () => {
    const chooser = supervisorChooser(withHarnesses(["pi", "claude-code"]), { probe: async_({ "claude-code": true }), bundlePath: async () => "/bundle" });
    const choice = await chooser({ harnesses: ["claude-code"], models: { "claude-code": ["sonnet"] } });
    expect(choice?.selection).toEqual({ harness: "claude-code", source: "plugin", reason: "the plugin's preference (claude-code): claude-code" });
    expect(choice?.repair?.reviewer).toBeDefined();
    await expect(chooser({ harnesses: ["codex"], required: true })).rejects.toThrow(/plugin requires one of codex; enabled and available: claude-code/);
    expect(await supervisorChooser(withHarnesses(["pi"]), { probe: async_({}), bundlePath: async () => "/bundle" })(undefined)).toBeUndefined();
  });
});

/** A run as resume sees it: its pin, its binding, and the preference intake described. */
function runState(parts: { selection?: string; binding?: string | "legacy"; preference?: SupervisorPreference }): Pick<DurableRunState, "supervisorSelection" | "supervisorBinding" | "definition" | "runId"> {
  const definition = { graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [], ...(parts.preference !== undefined ? { supervisor: parts.preference } : {}) } as GraphDefinition;
  return {
    runId: "run-1",
    definition,
    ...(parts.selection !== undefined ? { supervisorSelection: { harness: parts.selection, source: "plugin", reason: "r", generation: 1, at: "t", ...(parts.preference !== undefined ? { preference: parts.preference } : {}) } } : {}),
    ...(parts.binding !== undefined
      ? {
          supervisorBinding: {
            sessionId: "sess",
            sessionFile: "/state/supervisor/x.jsonl",
            provider: parts.binding === "claude-code" ? "claude-code" : "minimax-cn",
            modelId: parts.binding === "claude-code" ? "opus" : "MiniMax-M3",
            switchJournal: [],
            ...(parts.binding !== "legacy" ? { harness: parts.binding } : {}),
          },
        }
      : {}),
  };
}

describe("resume's supervisor (§7.4)", () => {
  const everything = async_({ pi: true, "claude-code": true, codex: true });

  it("keeps the pin: the selection's harness, or refuses when it is no longer enabled or available, naming --supervisor", async () => {
    expect(await resumeSupervisorPlan(ALL, runState({ selection: "claude-code", binding: "claude-code" }), { probe: everything })).toMatchObject({ harness: "claude-code" });
    expect((await resumeSupervisorPlan(ALL, runState({ selection: "claude-code", binding: "claude-code" }), { probe: everything })).pin).toBeUndefined();
    // Pinned at intake, never bound: the factory starts it.
    expect(await resumeSupervisorPlan(ALL, runState({ selection: "codex" }), { probe: everything })).toMatchObject({ harness: "codex" });
    await expect(resumeSupervisorPlan(withHarnesses(["pi"]), runState({ selection: "codex" }), { probe: everything })).rejects.toThrow(
      "supervisor harness pin mismatch: this run's supervisor is pinned to codex, which the operator's supervisor config does not enable (enabled: pi); enable it again, or resume with --supervisor <harness>",
    );
    await expect(resumeSupervisorPlan(ALL, runState({ selection: "codex" }), { probe: async_({ pi: true }) })).rejects.toThrow(
      "supervisor harness pin mismatch: this run's supervisor is pinned to codex, which is not available here: codex is missing; resume with --supervisor <harness>",
    );
    // The flat Pi form keeps Pi unprobed.
    expect(await resumeSupervisorPlan(FLAT, runState({ selection: "pi" }), { probe: async_({}) })).toMatchObject({ harness: "pi" });
    // Without a config, only a binding on the pinned harness restores; a pin with nothing to restore is refused, not dropped.
    expect(await resumeSupervisorPlan(undefined, runState({ selection: "claude-code", binding: "claude-code" }))).toEqual({ harness: "claude-code" });
    await expect(resumeSupervisorPlan(undefined, runState({ selection: "codex" }))).rejects.toThrow(
      /pinned to codex, but there is no operator supervisor config to start it .*restore a config that enables codex/,
    );
    // A pin moved to codex whose new binding was never saved: the old binding is not the pin.
    await expect(resumeSupervisorPlan(undefined, runState({ selection: "codex", binding: "pi" }))).rejects.toThrow(/pinned to codex, but there is no operator supervisor config/);
    // Nothing falls back: the plugin's other harnesses are not considered.
    await expect(resumeSupervisorPlan(ALL, runState({ selection: "codex", preference: { harnesses: ["codex", "pi"] } }), { probe: async_({ pi: true }) })).rejects.toThrow(/pin mismatch/);
  });

  it("probes a bound Pi session on the model it restores on, not the operator's first", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-resume-pi-probe-"));
    temps.push(dir);
    const config = parseSupervisorConfig({ harnesses: ["pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3", models: ["deepseek/deepseek-v4-pro"], agentDir: dir } });
    const saved = { minimax: process.env.MINIMAX_CN_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
    delete process.env.MINIMAX_CN_API_KEY;
    process.env.DEEPSEEK_API_KEY = "stand-in-not-a-key";
    try {
      const switched = runState({ selection: "pi", binding: "pi" });
      switched.supervisorBinding = { ...switched.supervisorBinding!, provider: "deepseek", modelId: "deepseek-v4-pro" };
      expect(await resumeSupervisorPlan(config, switched)).toMatchObject({ harness: "pi" });
      // --supervisor naming the pinned harness is the same resume.
      const same = await resumeSupervisorPlan(config, switched, { flag: "pi" });
      expect(same).toMatchObject({ harness: "pi" });
      expect(same.pin).toBeUndefined();
      // Bound to the model without a credential, the same resume is refused.
      await expect(resumeSupervisorPlan(config, runState({ selection: "pi", binding: "pi" }))).rejects.toThrow(/pin mismatch: .*pinned to pi, which is not available here/);
      // The bound model removed from the operator's models still restores on it, so it is the one probed:
      // with the operator's first (minimax-cn, no credential) the bound deepseek session resumes...
      const removed = parseSupervisorConfig({ harnesses: ["pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3", agentDir: dir } });
      expect(await resumeSupervisorPlan(removed, switched)).toMatchObject({ harness: "pi" });
      // ...and with a credential only for the operator's first, the bound model's missing one refuses it.
      process.env.MINIMAX_CN_API_KEY = "stand-in-not-a-key";
      delete process.env.DEEPSEEK_API_KEY;
      await expect(resumeSupervisorPlan(removed, switched)).rejects.toThrow(/pin mismatch: .*pinned to pi, which is not available here: .*deepseek/);
      // Unless a crash interrupted a switch: the controller settles it from the transcript, so the restore decides.
      const interrupted = runState({ selection: "pi", binding: "pi" });
      interrupted.supervisorBinding = {
        ...interrupted.supervisorBinding!,
        switchJournal: [{ at: "t", from: { provider: "minimax-cn", modelId: "MiniMax-M3" }, to: { provider: "deepseek", modelId: "deepseek-v4-pro" }, reason: "r", status: "intent" }],
      };
      expect(await resumeSupervisorPlan(config, interrupted)).toMatchObject({ harness: "pi" });
    } finally {
      for (const [k, v] of [["MINIMAX_CN_API_KEY", saved.minimax], ["DEEPSEEK_API_KEY", saved.deepseek]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("applies the run's model hints to the pinned harness", async () => {
    const plan = await resumeSupervisorPlan(ALL, runState({ selection: "claude-code", preference: { harnesses: ["claude-code"], models: { "claude-code": ["sonnet"] } } }), { probe: everything });
    expect(plan.config?.claude?.models.map((m) => m.modelId)).toEqual(["sonnet", "opus"]);
  });

  it("--supervisor moves the pin as a transition; to the same harness it changes nothing", async () => {
    expect(await resumeSupervisorPlan(ALL, runState({ selection: "pi", binding: "pi" }), { flag: "codex", reason: "Pi is out of credit", probe: everything })).toMatchObject({
      harness: "codex",
      pin: { transition: { from: "pi", to: "codex", reason: "Pi is out of credit" } },
    });
    expect(await resumeSupervisorPlan(ALL, runState({ selection: "pi" }), { flag: "codex", probe: everything })).toMatchObject({
      pin: { transition: { from: "pi", to: "codex", reason: "the operator's resume --supervisor" } },
    });
    const same = await resumeSupervisorPlan(ALL, runState({ selection: "pi", binding: "pi" }), { flag: "pi", probe: everything });
    expect(same).toMatchObject({ harness: "pi" });
    expect(same.pin).toBeUndefined();
    // The target must be enabled and available, as for run.
    await expect(resumeSupervisorPlan(withHarnesses(["pi", "claude-code"]), runState({ selection: "pi" }), { flag: "codex", probe: everything })).rejects.toThrow(/--supervisor codex is not enabled/);
    await expect(resumeSupervisorPlan(ALL, runState({ selection: "pi" }), { flag: "codex", probe: async_({ pi: true }) })).rejects.toThrow(/--supervisor codex is not available: codex is missing/);
    await expect(resumeSupervisorPlan(undefined, runState({ selection: "pi" }), { flag: "codex" })).rejects.toThrow(/--supervisor codex needs an operator supervisor config/);
  });

  it("a run pinned the S3 way (binding only) keeps its binding's harness and records it as a selection", async () => {
    expect(await resumeSupervisorPlan(ALL, runState({ binding: "claude-code" }), { probe: everything })).toEqual({
      harness: "claude-code",
      config: ALL,
      pin: { selection: { harness: "claude-code", source: "binding", reason: "pinned at the run's first recovery episode, claude-code (a run started before supervisor selection)" } },
    });
    // A binding recorded before harnesses reads as pi.
    expect(await resumeSupervisorPlan(ALL, runState({ binding: "legacy" }), { probe: everything })).toMatchObject({ harness: "pi", pin: { selection: { harness: "pi", source: "binding" } } });
    // Moving it is a transition from the binding's harness.
    expect(await resumeSupervisorPlan(ALL, runState({ binding: "legacy" }), { flag: "codex", probe: everything })).toMatchObject({ pin: { transition: { from: "pi", to: "codex" } } });
    // Without any config, the binding still restores (on the harness's defaults), and is recorded.
    expect(await resumeSupervisorPlan(undefined, runState({ binding: "legacy" }))).toMatchObject({ harness: "pi", pin: { selection: { harness: "pi", source: "binding" } } });
  });

  it("a run nothing pinned is pinned now, by run's selection on the preference it was described with", async () => {
    expect(await resumeSupervisorPlan(ALL, runState({ preference: { harnesses: ["codex", "pi"] } }), { probe: async_({ pi: true }) })).toMatchObject({
      harness: "pi",
      pin: { selection: { harness: "pi", source: "plugin", reason: "pinned at resume: the plugin's preference (codex, pi): pi (codex: codex is missing)" } },
    });
    expect(await resumeSupervisorPlan(ALL, runState({}), { flag: "codex", probe: everything })).toMatchObject({
      harness: "codex",
      pin: { selection: { harness: "codex", source: "flag" } },
    });
    expect(await resumeSupervisorPlan(ALL, runState({}), { probe: async_({}) })).toEqual({});
    expect(await resumeSupervisorPlan(undefined, runState({}))).toEqual({});
    await expect(resumeSupervisorPlan(ALL, runState({ preference: { harnesses: ["codex"], required: true } }), { probe: async_({ pi: true }) })).rejects.toThrow(/plugin requires one of codex/);
  });
});

describe("check's supervisor report, per branch", () => {
  const writeConfig = (value: unknown): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-check-supervisor-"));
    temps.push(dir);
    const file = path.join(dir, "supervisor.json");
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return { HOME: dir, GRAPHLOOM_SUPERVISOR_CONFIG: file };
  };
  const definition = (supervisor?: SupervisorPreference) => ({ graphId: "g", version: "1", stages: [], requirements: [], defaultValidators: [], ...(supervisor !== undefined ? { supervisor } : {}) }) as GraphDefinition;
  const flat = { provider: "minimax-cn", modelId: "MiniMax-M3" };

  it("selected: by the plugin, by the operator, or by fallback with the reason", async () => {
    expect(await checkSupervisorSelection(definition({ harnesses: ["pi"] }), writeConfig(flat))).toEqual({
      status: "selected",
      harness: "pi",
      source: "plugin",
      reason: "the plugin's preference (pi): pi",
      warnings: [],
    });
    expect(await checkSupervisorSelection(definition(), writeConfig(flat))).toMatchObject({ status: "selected", harness: "pi", source: "operator" });
    expect(await checkSupervisorSelection(definition({ harnesses: ["codex"], models: { pi: ["openai/gpt-5"] } }), writeConfig(flat))).toEqual({
      status: "selected",
      harness: "pi",
      source: "fallback",
      reason: expect.stringContaining("none of the plugin's harnesses (codex) is enabled and available (codex: not enabled by the operator)"),
      warnings: [expect.stringContaining("pi model hint openai/gpt-5 is not among the operator's pi models")],
    });
  });

  it("refused: a required preference the operator cannot meet, a select that is not enabled, or a config run would refuse", async () => {
    expect(await checkSupervisorSelection(definition({ harnesses: ["codex"], required: true }), writeConfig(flat))).toEqual({
      status: "refused",
      reason: "supervisor: plugin requires one of codex; enabled and available: pi (codex: not enabled by the operator)",
      warnings: [],
    });
    expect(await checkSupervisorSelection(definition(), writeConfig("{not json"))).toMatchObject({ status: "refused" });
    expect(await checkSupervisorSelection(definition(), writeConfig({ ...flat, apiKey: "x" }))).toMatchObject({ status: "refused", reason: expect.stringContaining("apiKey is not accepted") });
  });

  it("none: no supervisor config, or no harness available", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-check-supervisor-"));
    temps.push(dir);
    expect(await checkSupervisorSelection(definition({ harnesses: ["pi"] }), { HOME: dir })).toEqual({
      status: "none",
      reason: "no operator supervisor config, so the run has no automatic recovery (the plugin prefers pi)",
      warnings: [],
    });
    // A Claude Code supervisor whose command does not exist is not available.
    const missing = writeConfig({ claude: { command: path.join(dir, "no-such-claude") } });
    expect(await checkSupervisorSelection(definition({ harnesses: ["claude-code"] }), missing)).toMatchObject({ status: "none", reason: expect.stringMatching(/^no enabled harness is available \(claude-code: .*\), so the run has no automatic recovery$/) });
  });
});

describe("switch-model takes a model of the pinned harness (§4.4)", () => {
  const claudeRun = runState({ selection: "claude-code", binding: "claude-code" });
  const codexRun = runState({ selection: "codex" });
  const piRun = runState({ selection: "pi", binding: "pi" });

  it("accepts the pinned CLI harness's configured models by name or qualified, and Pi's provider/model", () => {
    expect(switchModelTarget("sonnet", ALL, claudeRun)).toEqual({ provider: "claude-code", modelId: "sonnet" });
    expect(switchModelTarget("claude-code/opus", ALL, claudeRun)).toEqual({ provider: "claude-code", modelId: "opus" });
    expect(switchModelTarget("o4", ALL, codexRun)).toEqual({ provider: "codex", modelId: "o4" });
    expect(switchModelTarget("deepseek/deepseek-v4-pro", ALL, piRun)).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
    // A run pinned the S3 way, and a binding from before harnesses (pi).
    expect(switchModelTarget("sonnet", ALL, runState({ binding: "claude-code" }))).toEqual({ provider: "claude-code", modelId: "sonnet" });
    expect(switchModelTarget("minimax-cn/MiniMax-M3", ALL, runState({ binding: "legacy" }))).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
  });

  it("refuses another harness's model, pointing to resume --supervisor, and a model the operator did not configure", () => {
    expect(() => switchModelTarget("deepseek/deepseek-v4-pro", ALL, claudeRun)).toThrow(
      "deepseek/deepseek-v4-pro is a pi model, but run run-1's supervisor is pinned to claude-code; switch-model takes a model of the pinned harness. To move the run to pi, stop it and run graphloom resume run-1 --supervisor pi",
    );
    expect(() => switchModelTarget("codex/o4", ALL, claudeRun)).toThrow(/is a codex model, but .* pinned to claude-code; .*resume run-1 --supervisor codex/);
    expect(() => switchModelTarget("claude-code/opus", ALL, piRun)).toThrow(/is a claude-code model, but .* pinned to pi/);
    expect(() => switchModelTarget("haiku", ALL, claudeRun)).toThrow("haiku is not among the operator's claude-code supervisor models (claude-code/opus, claude-code/sonnet)");
    expect(() => switchModelTarget("openai/gpt-5", ALL, piRun)).toThrow(/openai\/gpt-5 is not among the operator's pi supervisor models/);
    expect(() => switchModelTarget("claude-code/", ALL, claudeRun)).toThrow(/expected a model name/);
  });

  it("without a supervisor config or a pin, only the form is checked", () => {
    expect(switchModelTarget("opus", undefined, claudeRun)).toEqual({ provider: "claude-code", modelId: "opus" });
    expect(switchModelTarget("codex/o4", undefined, runState({}))).toEqual({ provider: "codex", modelId: "o4" });
    expect(() => switchModelTarget("opus", undefined, runState({}))).toThrow(/expected provider\/model/);
  });
});
