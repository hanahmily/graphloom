// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Externalized evidence (docs/design-typescript-core.md, "Evidence storage") in the controller: large payload
 * parts leave `state.json` for the run's content-addressed store at record time, plugins and validators still
 * read them as if they were inline, a missing blob is the host observation `evidence_unavailable`, a crash
 * between a blob write and the state save leaves only an orphan, `resume --upgrade` migrates a format 1 run
 * with large evidence, and the supervisor's evidence tool shows hydrated, bounded content.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Child processes and thousand-record fixtures: generous limits so a loaded machine does not fail them.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import {
  createScriptedGraph,
  dispatch,
  hydrateRecord,
  installLazyPayload,
  overlappingParts,
  stableHash,
  stop,
  validate,
  type EvidenceRecord,
  type GraphDefinition,
  type RunView,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createInProcessPluginHost } from "@graphloom/plugin-host";
import { createAdmissionTools } from "@graphloom/supervisor";
import { createController, loadRunState, replayRun, saveRunState, toRunView } from "./index.js";
import { deleteRun } from "./delete-run.js";
import { evidenceReaderFor, evidenceStoreDir, externalizeRecord, hydrateEvidence } from "./evidence.js";
import { createSupervisorInspection, type InspectionHooks } from "./inspection.js";
import { CURRENT_STATE_FORMAT, migrateStateFiles, migrationPath, STATE_FORMATS } from "./state-migrations/index.js";
import type { DurableRunState } from "./state.js";

const execFileAsync = promisify(execFile);
const BIG = "x".repeat(30_000);

const definition: GraphDefinition = {
  graphId: "fixture",
  version: "1.0.0",
  stages: [{ id: "work", name: "Work", requirementIds: ["report"] }],
  requirements: [{ id: "report", statement: "The report carries the full text.", evidenceSchema: "report-v1" }],
  defaultValidators: [{ requirementId: "report", validatorId: "full-text", version: "1" }],
};

/** Reads the report text in full: a validator in the controller's process, so it is handed hydrated records. */
const validators: Record<string, Validator> = {
  "full-text": {
    evaluate(input) {
      const record = input.evidence.find((e) => (e.payload as { report?: unknown } | undefined)?.report !== undefined);
      const text = (record?.payload as { report?: { text?: string } } | undefined)?.report?.text;
      return text === BIG ? { status: "passed", reason: "full text" } : { status: "failed", reason: `text was ${text === undefined ? "absent" : String(text).length}` };
    },
  },
};

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

async function makeEnv() {
  const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-evidence-")));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, "init", "-q");
  await git(repoPath, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-q", "-m", "init");
  const bundle = path.join(taskDir, "plugins", "fixture");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  await writeFile(
    path.join(bundle, "graphloom.manifest.json"),
    `${JSON.stringify({ graphId: "fixture", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./dist/index.js" }, privateStateSchema: "fixture-private-v1" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: fixture\nrepo: ./test-repo\nrequest: |\n  Report.\n", "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

const reportRunner = () =>
  createScriptedRunner({
    jobs: [
      async () => ({
        status: "ok" as const,
        summary: "reported",
        evidence: [{ kind: "other" as const, payload: { report: { id: "r-1", text: BIG } } }],
      }),
    ],
  });

describe("externalized evidence in a run", () => {
  it("records a large part outside state.json, and plugin and validator still read it in full", async () => {
    const env = await makeEnv();
    const seenByPlugin: string[] = [];
    const advances: ScriptedAdvance[] = [
      dispatch({ stageId: "work", kind: "agent", purpose: "work", instruction: "report", writeScope: ["REPORT.txt"] }, "report"),
      (view: RunView) => {
        const record = view.evidence.find((e) => (e.payload as { report?: unknown } | undefined)?.report !== undefined)!;
        seenByPlugin.push((record.payload as { report: { text: string } }).report.text);
        return validate({ stageId: "work", requirementIds: ["report"] }, "validate");
      },
      stop({ reason: "complete", blocker: "none" }, "done"),
    ];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances }),
      validators,
      runner: reportRunner(),
      stateRoot: env.stateRoot,
      runId: "ev1",
    });
    expect(report.status).toBe("succeeded");
    expect(seenByPlugin).toEqual([BIG]);

    const stateDir = path.join(env.stateRoot, "ev1");
    const raw = await readFile(path.join(stateDir, "state.json"), "utf8");
    expect(raw).not.toContain("x".repeat(100));
    const state = JSON.parse(raw) as DurableRunState;
    const record = state.evidence.find((e) => (e.payload as { report?: unknown } | undefined)?.report !== undefined)!;
    expect(record.payload).toMatchObject({ report: { id: "r-1", text: null } });
    expect(record.externalized).toEqual([{ path: ["report", "text"], sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: JSON.stringify(BIG).length }]);
    const blob = path.join(evidenceStoreDir(stateDir), "sha256", `${record.externalized![0]!.sha256}.json`);
    expect(await readFile(blob, "utf8")).toBe(JSON.stringify(BIG));
    expect(stateFormatOf(state)).toBe(CURRENT_STATE_FORMAT);

    // The run's blobs go with the run.
    await deleteRun(stateDir, { force: true });
    expect(existsSync(stateDir)).toBe(false);
  });

  it("stops with evidence_unavailable, not a crash, when a recorded blob has gone missing", async () => {
    const env = await makeEnv();
    const stateDirOf = () => path.join(env.stateRoot, "ev2");
    const runner = createScriptedRunner({
      jobs: [
        async () => ({ status: "ok" as const, summary: "reported", evidence: [{ kind: "other" as const, payload: { report: { id: "r-1", text: BIG } } }] }),
        // The second job runs after the first's evidence is recorded: it removes the store, as a damaged disk would.
        async () => {
          await rm(evidenceStoreDir(stateDirOf()), { recursive: true, force: true });
          return { status: "ok" as const, summary: "second" };
        },
      ],
    });
    const advances: ScriptedAdvance[] = [
      dispatch({ stageId: "work", kind: "agent", purpose: "work", instruction: "report", writeScope: ["REPORT.txt"] }, "report"),
      dispatch({ stageId: "work", kind: "agent", purpose: "work", instruction: "again", writeScope: ["REPORT.txt"] }, "again"),
      stop({ reason: "never reached", blocker: "none" }, "done"),
    ];
    // A caller-supplied host that does not hydrate itself is handed hydrated records by the controller.
    const plugin = createScriptedGraph({ definition, advances });
    const report = await createController().run({
      taskPath: env.taskPath,
      host: createInProcessPluginHost(plugin, { activeVersion: "fixture@1.0.0" }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "ev2",
    });
    expect(report.status).toBe("stopped");
    expect(`${report.stopReason} ${report.blocker ?? ""}`).toMatch(/evidence_unavailable|unavailable/);
  });
});

/** A format-2 state of a stopped run, to add records to. */
async function stoppedState(): Promise<{ state: DurableRunState; stateDir: string }> {
  const env = await makeEnv();
  const report = await createController().run({
    taskPath: env.taskPath,
    plugin: createScriptedGraph({
      definition,
      advances: [dispatch({ stageId: "work", kind: "agent", purpose: "work", instruction: "report", writeScope: ["REPORT.txt"] }, "report"), stop({ reason: "pause", blocker: "none" }, "pause")],
    }),
    validators,
    runner: reportRunner(),
    stateRoot: env.stateRoot,
    runId: "sz",
  });
  const stateDir = report.stateDir;
  return { state: await loadRunState(stateDir), stateDir };
}

const stateFormatOf = (state: { stateFormat?: number }): number | undefined => state.stateFormat;

/**
 * The mix a large pr-review run recorded (1,713 records, 16.1 MB): file reads 2.7 MB, searches 1.9 MB, artifacts
 * written in command argv 4.5 MB, agent outputs 1.5 MB, metrics 1.2 MB, and the rest small.
 */
function largeRunRecords(count: number): EvidenceRecord[] {
  const text = (n: number, tag: string): string => `${tag}:`.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
  const records: EvidenceRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = { ref: `ev-g1-${i + 1}-aaaaaaaa`, generation: 1 };
    const producer = { operationId: `op-${i}`, stageId: "review", purpose: "work", kind: "agent" };
    const slot = i % 20;
    if (slot < 3) {
      // ~280 file reads of ~9.6 KB
      records.push({ ...base, kind: "file", payload: { path: `src/file-${i}.ts`, bytes: text(9_000 + (i % 7) * 200, `f${i}`) }, fingerprint: stableHash(i) });
    } else if (slot < 6) {
      // ~280 searches of ~6.7 KB (each under the threshold)
      records.push({ ...base, kind: "command", payload: { command: { id: `search-${i}`, exitCode: 0, stdout: text(6_600 + (i % 5) * 50, `s${i}`), stderr: "" }, producer } });
    } else if (slot < 9) {
      // ~280 artifacts written through argv, ~16 KB each
      records.push({ ...base, kind: "command", payload: { command: { id: `write-${i}`, exitCode: 0, argv: ["node", "-e", text(15_500 + (i % 5) * 300, `a${i}`)], stdout: "ok" }, producer } });
    } else if (slot === 9) {
      // ~85 agent outputs of ~17 KB
      records.push({ ...base, kind: "other", payload: { codingAgent: { status: "completed", output: { findings: Array.from({ length: 9 }, (_, k) => ({ id: k, body: text(1_900, `o${i}-${k}`) })) } }, producer } });
    } else if (slot === 10) {
      // ~85 metrics records of ~14 KB
      records.push({ ...base, kind: "other", payload: { metrics: { series: Array.from({ length: 450 }, (_, k) => [k, k * 3.14159, `m${i}`]) }, producer } });
    } else {
      records.push({ ...base, kind: i % 2 === 0 ? "workspace" : "other", payload: { changedPaths: [`p/${i}/a.ts`, `p/${i}/b.ts`], note: text(300, `n${i}`) }, fingerprint: stableHash(`w${i}`) });
    }
  }
  return records;
}

describe("a large run's evidence", () => {
  it("keeps state.json and the plugin view small, and hydrates back to the same records", async () => {
    const { state, stateDir } = await stoppedState();
    const inline = largeRunRecords(1_700);
    const inlineBytes = JSON.stringify(inline).length;
    const before = { ...state, evidence: [...state.evidence, ...inline] };
    const beforeStateJson = JSON.stringify(before, null, 2).length;
    expect(inlineBytes).toBeGreaterThan(10_000_000);

    const externalized = inline.map((record) => externalizeRecord(stateDir, record));
    const after: DurableRunState = { ...state, evidence: [...state.evidence, ...externalized] };
    await saveRunState(after);
    const stateJsonBytes = statSync(path.join(stateDir, "state.json")).size;
    const viewBytes = JSON.stringify(toRunView(after)).length;
    console.log(`measured: records=${inline.length} inline evidence=${inlineBytes} state.json before=${beforeStateJson} after=${stateJsonBytes} view after=${viewBytes}`);
    expect(stateJsonBytes).toBeLessThan(4_000_000);
    expect(viewBytes).toBeLessThan(4_000_000);

    // Identifying fields stay inline; content hydrates back byte-identical.
    const sample = externalized[6]!;
    expect((sample.payload as { command: { id: string; exitCode: number } }).command).toMatchObject({ id: "write-6", exitCode: 0 });
    const hydrated = hydrateEvidence(stateDir, externalized);
    expect(hydrated.map((r) => stableHash(r))).toEqual(inline.map((r) => stableHash(r)));
    expect(JSON.stringify(externalized)).toBe(JSON.stringify(inline.map((r) => externalizeRecord(stateDir, r))));
    const reloaded = await loadRunState(stateDir);
    expect(reloaded.evidence).toHaveLength(after.evidence.length);
  });

  it("lowers the threshold for a view whose inline size is still over the limit, deterministically", async () => {
    const { state, stateDir } = await stoppedState();
    // 3,000 records each just under the threshold stay inline at the default: 3,000 x ~7.9 KB is over 8 MB.
    const records: EvidenceRecord[] = Array.from({ length: 3_000 }, (_, i) => ({
      ref: `ev-g1-${i + 1}-bbbbbbbb`,
      kind: "other" as const,
      generation: 1,
      payload: { note: { id: i, text: `n${i}`.repeat(1_900) } },
    }));
    const withRecords: DurableRunState = { ...state, evidence: [...state.evidence, ...records] };
    expect(JSON.stringify(records).length).toBeGreaterThan(8 * 1024 * 1024);
    const view = toRunView(withRecords);
    expect(JSON.stringify(view.evidence).length).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(JSON.stringify(toRunView(withRecords).evidence)).toBe(JSON.stringify(view.evidence));
    // The stored state is unchanged by building a view.
    expect(withRecords.evidence.slice(-1)[0]!.externalized).toBeUndefined();
    const hydrated = hydrateEvidence(stateDir, view.evidence);
    expect(hydrated.map((r) => stableHash(r))).toEqual([...state.evidence, ...records].map((r) => stableHash(hydrateEvidence(stateDir, [r])[0])));
  });

  it("leaves only an orphan blob, never a dangling reference, when the run dies between a blob write and the state save", async () => {
    const { state, stateDir } = await stoppedState();
    const before = await readFile(path.join(stateDir, "state.json"), "utf8");
    const record = externalizeRecord(stateDir, { ref: "ev-g1-99-cccccccc", kind: "other", generation: 1, payload: { report: { id: "late", text: "z".repeat(40_000) } } });
    const sha = record.externalized![0]!.sha256;
    const blob = path.join(evidenceStoreDir(stateDir), "sha256", `${sha}.json`);
    // The blob is durable before any save references it.
    expect(existsSync(blob)).toBe(true);
    // ...and the process died before saving: state.json is untouched and names nothing the store lacks.
    expect(await readFile(path.join(stateDir, "state.json"), "utf8")).toBe(before);
    const reloaded = await loadRunState(stateDir);
    expect(reloaded.evidence.some((e) => e.ref === record.ref)).toBe(false);
    for (const e of reloaded.evidence) for (const part of e.externalized ?? []) expect(existsSync(path.join(evidenceStoreDir(stateDir), "sha256", `${part.sha256}.json`))).toBe(true);
    expect(JSON.stringify(reloaded)).not.toContain(sha);
    // The run goes on: a later save of the record writes no second blob.
    await saveRunState({ ...state, evidence: [...state.evidence, record] });
    expect(readdirSync(path.join(evidenceStoreDir(stateDir), "sha256")).filter((f) => f.startsWith(sha))).toHaveLength(1);
  });
});

describe("format 1 to 2 migration", () => {
  it("moves large parts into the store and keeps every record's content", async () => {
    const { state, stateDir } = await stoppedState();
    const records = largeRunRecords(60);
    // A run saved by format 1: everything inline, no store.
    const original = JSON.stringify({ ...state, stateFormat: 1, evidence: [...hydrateEvidence(stateDir, state.evidence), ...records] }, null, 2);
    const steps = migrationPath(1, STATE_FORMATS);
    expect(steps).toHaveLength(1);
    // migrateStateFiles throws when the protected view (which hydrates format 2 from the migration's own files) differs.
    const migrated = migrateStateFiles({ "state.json": original }, steps, STATE_FORMATS);
    const out = JSON.parse(migrated.files["state.json"]!) as DurableRunState;
    expect(migrated.files["state.json"]!.length).toBeLessThan(original.length / 4);
    expect(Object.keys(migrated.files).filter((f) => f.startsWith("evidence/sha256/")).length).toBeGreaterThan(20);
    expect(out.evidence.filter((e) => e.externalized !== undefined).length).toBeGreaterThan(20);
    // The same check, said directly.
    const read = (part: { sha256: string }): unknown => JSON.parse(migrated.files[`evidence/sha256/${part.sha256}.json`]!);
    const hydrated = out.evidence.map((e) => hydrateRecord(e, read));
    expect(hydrated.map((e) => stableHash(e))).toEqual((JSON.parse(original) as DurableRunState).evidence.map((e) => stableHash(e)));
  });
});

describe("the supervisor's evidence tool", () => {
  it("shows hydrated content, bounded", async () => {
    const { state, stateDir } = await stoppedState();
    const record = externalizeRecord(stateDir, { ref: "ev-g1-77-dddddddd", kind: "other", generation: 1, payload: { report: { id: "big", text: "q".repeat(50_000), tail: "END" } } });
    expect(JSON.stringify(record)).not.toContain("qqqqqqqqqq");
    const withRecord: DurableRunState = { ...state, evidence: [...state.evidence, record] };
    const hooks: InspectionHooks = {
      state: () => withRecord,
      validators: {},
      hasRepairHooks: false,
      reserveProbe: async () => ({ id: "probe-1" }),
      recordProbe: async () => undefined,
      signal: () => undefined,
      recoverHost: async () => undefined,
    };
    const { inspection } = createSupervisorInspection(hooks);
    const got = inspection.getEvidence(record.ref)!;
    expect((got.payload as { report: { text: string } }).report.text).toHaveLength(50_000);
    expect(got.externalized).toBeUndefined();

    const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }], [], 1, undefined, {}, undefined, undefined, inspection);
    const tool = toolbox.tools.find((t) => t.name === "get_evidence")!;
    const result = (await (tool as unknown as { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }).execute("1", { ref: record.ref })).content[0]!.text;
    expect(result).toContain("qqqqqqqqqq");
    expect(result).toContain("big");
    expect(result.length).toBeLessThan(8_300);
    expect(result).toContain("truncated");
  });
});

describe("re-externalizing a record", () => {
  it("stores a parent whole, with the descendant read back in, when a lower threshold reaches it, so paths never overlap", async () => {
    const { stateDir } = await stoppedState();
    const body: Record<string, string> = { big: "B".repeat(10_000) };
    for (let i = 0; i < 60; i += 1) body[`f${i}`] = `${i}`.repeat(45).slice(0, 90);
    const original: EvidenceRecord = { ref: "ev-g1-55-ffffffff", kind: "other", generation: 1, payload: { id: "k", body } };
    const first = externalizeRecord(stateDir, original);
    expect(first.externalized!.map((p) => p.path)).toEqual([["body", "big"]]);
    const second = externalizeRecord(stateDir, first, 4_096);
    expect(overlappingParts(second.externalized!)).toBeUndefined();
    expect(second.externalized!.map((p) => p.path)).toEqual([["body"]]);
    expect((second.payload as { id: string }).id).toBe("k");
    expect(stableHash(hydrateEvidence(stateDir, [second])[0])).toBe(stableHash(original));
    // The same through the lazy getters the worker installs.
    const lazy = JSON.parse(JSON.stringify(second)) as EvidenceRecord;
    installLazyPayload(lazy, evidenceReaderFor(stateDir));
    expect(stableHash(lazy.payload)).toBe(stableHash(original.payload));
    // Overlapping references are refused rather than hydrated wrongly.
    const bad = { ...second, externalized: [...second.externalized!, first.externalized![0]!] };
    expect(() => hydrateEvidence(stateDir, [bad])).toThrow(/overlap/);
  });
});

describe("replay is read-only", () => {
  it("answers on hydrated evidence over 8 MB and writes nothing under the run's evidence store", async () => {
    const { state, stateDir } = await stoppedState();
    const records: EvidenceRecord[] = Array.from({ length: 3_000 }, (_, i) => ({
      ref: `ev-g1-${i + 1}-99999999`,
      kind: "other" as const,
      generation: 1,
      payload: { note: { id: i, text: `n${i}`.repeat(1_900) } },
    }));
    const recorded: DurableRunState = { ...state, evidence: [...state.evidence, ...records] };
    expect(JSON.stringify(records).length).toBeGreaterThan(8 * 1024 * 1024);
    const listing = (): string[] => readdirSync(path.join(evidenceStoreDir(stateDir), "sha256"), { recursive: true }).map(String).sort();
    const before = listing();
    const host = createInProcessPluginHost(
      createScriptedGraph({ definition, advances: [(view: RunView) => stop({ reason: `saw ${view.evidence.length}`, blocker: "none" }, "stop")] }),
      { activeVersion: "fixture@1.0.0" },
    );
    const report = await replayRun(recorded, host);
    expect(report.nextDecision).toMatchObject({ decision: { action: { stop: { reason: `saw ${recorded.evidence.length}` } } } });
    expect(listing()).toEqual(before);
  });
});
