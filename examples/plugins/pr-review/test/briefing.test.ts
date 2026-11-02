// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { validateResultShape } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import {
  assembleBriefing,
  BRIEFING_PROMPT,
  briefingProblems,
  briefingTargets,
  checkLines,
  emptyBriefing,
  featureLines,
  MAX_CHECK_PER_LIST,
  MAX_FEATURES,
  MAX_FLOWS,
  MAX_STAGES,
  MAX_WHATS_NEW,
  whatsNewLines,
  type Briefing,
  type Feature,
} from "../src/briefing.js";
import type { Cite } from "../src/cites.js";
import { CHANGE_REPORT_SCHEMA } from "../src/report.js";
import { pullFile, type PullFile } from "../src/snapshot.js";

const file = (path: string, patch: string | null): PullFile => pullFile({ path, status: "modified", patch, previousPath: null, additions: 2, deletions: 1, patchOmitted: patch === null })!;
const PATCH = "@@ -10,3 +10,5 @@ func f() {\n a\n-old\n+new\n+newer\n+newest\n b";
const files = [file("pkg/a.go", PATCH), file("pkg/b.go", PATCH), file("img/logo.png", null)];
const at = (path: string, start: number, end = start, side: "head" | "base" = "head"): Cite => ({ path, side, start, end, symbol: "" });

const feature = (over: Partial<Feature> = {}): Feature => ({
  name: "Retention sweep",
  summary: "A flag sets retention and a sweep removes what expired.",
  stages: [
    { id: "flag", label: "retention flag", kind: "source", cite: at("pkg/a.go", 11) },
    { id: "sweep", label: "nightly sweep", kind: "process", cite: at("pkg/a.go", 12) },
    { id: "disk", label: "group data", kind: "store", cite: at("pkg/b.go", 13) },
  ],
  flows: [
    { from: "flag", to: "sweep", label: "schedules", cite: at("pkg/a.go", 11) },
    { from: "sweep", to: "disk", label: "deletes expired parts", cite: at("pkg/b.go", 12) },
  ],
  ...over,
});
const valid = (over: Partial<Briefing> = {}): Briefing => ({
  ...emptyBriefing(),
  whatsNew: [{ text: "Adds a retention policy.", cites: [at("pkg/a.go", 11, 12)] }],
  features: [feature()],
  ...over,
});
const problems = (b: Briefing, ctx: { large?: boolean; areaIds?: string[] } = {}, final = false): string[] => briefingProblems(b, { files, ...ctx }, final);

describe("the briefing fields of the reporter's contract", () => {
  const output = (over: Record<string, unknown> = {}) => ({
    purpose: { text: "t", source: "inferred", quote: "" },
    overview: "One.",
    whatsNew: [{ text: "Adds a thing.", cites: [{ path: "pkg/a.go", side: "head", start: 11, end: 11, symbol: "" }] }],
    features: [],
    check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] },
    areas: [],
    sections: [],
    notes: [],
    ...over,
  });
  const shape = (o: unknown): string[] => validateResultShape(o, CHANGE_REPORT_SCHEMA as unknown as Record<string, unknown>);

  it("requires whatsNew, features, check and areas, and has no architecture property", () => {
    expect(shape(output())).toEqual([]);
    expect(shape({ ...output(), architecture: { nodes: [], edges: [] } }).join(" ")).toMatch(/architecture/);
    const { whatsNew: _w, ...without } = output();
    expect(shape(without).join(" ")).toMatch(/whatsNew/);
    expect(Object.keys((CHANGE_REPORT_SCHEMA as { properties: Record<string, unknown> }).properties)).not.toContain("architecture");
  });

  it("refuses a stage kind that is none of the six, and an unknown property on a stage", () => {
    const f = feature();
    expect(shape(output({ features: [f] }))).toEqual([]);
    expect(shape(output({ features: [{ ...f, stages: [{ ...f.stages[0]!, kind: "database" }] }] })).join(" ")).toMatch(/kind/);
    expect(shape(output({ features: [{ ...f, stages: [{ ...f.stages[0]!, paths: [] }] }] })).join(" ")).toMatch(/paths/);
  });

  it("tells the reporter what each field is for, and its bounds", () => {
    for (const word of ["whatsNew", "features", "check", "surfaces", "behavior", "compatibility", "risks", "tests", "two minutes"]) expect(BRIEFING_PROMPT).toContain(word);
    for (const kind of ["source", "process", "transport", "store", "external", "sink"]) expect(BRIEFING_PROMPT).toContain(`"${kind}"`);
    expect(BRIEFING_PROMPT).toContain(`at most ${MAX_FEATURES}`);
  });
});

describe("deterministic validation of the briefing", () => {
  it("passes a briefing whose cites lie in the diff", () => {
    expect(problems(valid())).toEqual([]);
  });

  it("wants a what's-new bullet, at most five, each cited and bounded", () => {
    expect(problems(valid({ whatsNew: [] })).join(" ")).toMatch(/whatsNew is empty/);
    expect(problems(valid({ whatsNew: [] }), {}, true)).toEqual([]);
    const six = Array.from({ length: MAX_WHATS_NEW + 1 }, (_, i) => ({ text: `Adds ${i}.`, cites: [at("pkg/a.go", 11)] }));
    expect(problems(valid({ whatsNew: six })).join(" ")).toMatch(/6 bullets, more than 5/);
    expect(problems(valid({ whatsNew: [{ text: "x".repeat(241), cites: [at("pkg/a.go", 11)] }, { text: "No cite.", cites: [] }] })).join(" ")).toMatch(/241 characters[\s\S]*cites nothing/);
  });

  it("keeps a bullet's cites in the diff, on the side they name, as an item's cites must be", () => {
    expect(problems(valid({ whatsNew: [{ text: "Out.", cites: [at("pkg/a.go", 90)] }] })).join(" ")).toMatch(/line\(s\) 90 on the head side are outside the file's hunks/);
    expect(problems(valid({ whatsNew: [{ text: "Not a file.", cites: [at("pkg/zzz.go", 11)] }] })).join(" ")).toMatch(/pkg\/zzz.go, which is not a file of the pull request/);
    expect(problems(valid({ whatsNew: [{ text: "Whole file.", cites: [at("pkg/a.go", 0)] }] })).join(" ")).toMatch(/cite the lines/);
  });

  it("allows a file the pull request does not change, and lines outside its hunks, in a large report, where the claim check verifies the quote in the tree", () => {
    const b = valid({ whatsNew: [{ text: "Reads a hop.", cites: [at("pkg/other.go", 40, 41), at("pkg/a.go", 90)] }] });
    expect(problems(b).length).toBeGreaterThan(0);
    expect(problems(b, { large: true })).toEqual([]);
    expect(problems(valid({ whatsNew: [{ text: "Bad range.", cites: [at("pkg/other.go", 0)] }] }), { large: true }).join(" ")).toMatch(/not a file of the pull request/);
    expect(problems(valid({ whatsNew: [{ text: "Escapes.", cites: [at("../etc/passwd", 1)] }] }), { large: true }).join(" ")).toMatch(/not a file of the pull request/);
  });

  it("bounds a feature: at most three, two to eight stages, one to twelve flows", () => {
    expect(problems(valid({ features: [feature(), feature(), feature(), feature()] })).join(" ")).toMatch(/4 entries, more than 3/);
    expect(problems(valid({ features: [feature({ stages: feature().stages.slice(0, 1), flows: [] })] })).join(" ")).toMatch(/1 stage\(s\)[\s\S]*no flow/);
    const stages = Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ id: `s${i}`, label: `Stage ${i}`, kind: "process" as const, cite: at("pkg/a.go", 11) }));
    const flows = Array.from({ length: MAX_FLOWS + 1 }, () => ({ from: "s0", to: "s1", label: "moves", cite: at("pkg/a.go", 11) }));
    expect(problems(valid({ features: [feature({ stages, flows })] })).join(" ")).toMatch(/9 stages, more than 8[\s\S]*13 flows, more than 12/);
  });

  it("wants unique stage ids of a plain form, and flows between two stages of the feature", () => {
    const f = feature();
    const dup = feature({ stages: [f.stages[0]!, { ...f.stages[1]!, id: "flag" }, f.stages[2]!] });
    expect(problems(valid({ features: [dup] })).join(" ")).toMatch(/the id appears twice in this feature/);
    expect(problems(valid({ features: [feature({ stages: [{ ...f.stages[0]!, id: "1bad id" }, f.stages[1]!, f.stages[2]!] })] })).join(" ")).toMatch(/letters, digits/);
    const loose = feature({ flows: [{ from: "flag", to: "nowhere", label: "moves", cite: at("pkg/a.go", 11) }, { from: "sweep", to: "sweep", label: "loops", cite: at("pkg/a.go", 11) }] });
    expect(problems(valid({ features: [loose] })).join(" ")).toMatch(/to "nowhere" is not a stage id of this feature[\s\S]*joins a stage to itself/);
  });

  it("checks the cites of every stage and flow against the diff, and the label bounds", () => {
    const f = feature();
    const out = feature({ stages: [{ ...f.stages[0]!, cite: at("pkg/a.go", 90), label: "" }, f.stages[1]!, f.stages[2]!], flows: [{ ...f.flows[0]!, cite: at("pkg/b.go", 91), label: "x".repeat(81) }, f.flows[1]!] });
    const text = problems(valid({ features: [out] })).join(" | ");
    expect(text).toMatch(/stage 1 \("flag"\): the label is empty/);
    expect(text).toMatch(/stage 1 \("flag"\): pkg\/a.go: line\(s\) 90/);
    expect(text).toMatch(/flow 1 \(F1.f1\): the label is 81 characters, more than 80/);
    expect(text).toMatch(/flow 1 \(F1.f1\): pkg\/b.go: line\(s\) 91/);
  });

  it("bounds each check list at eight one-line entries with cites", () => {
    const entry = { text: "Adds a flag.", cites: [at("pkg/a.go", 11)] };
    const nine = Array.from({ length: MAX_CHECK_PER_LIST + 1 }, () => entry);
    const b = valid({ check: { surfaces: nine, behavior: [], compatibility: [], risks: [{ text: "x".repeat(300), cites: [] }], tests: [] } });
    expect(problems(b).join(" | ")).toMatch(/check.surfaces has 9 entries, more than 8[\s\S]*check.risks 1: the text is 300 characters[\s\S]*check.risks 1: it cites nothing/);
  });

  it("allows area labels only for the area ids a large report has, each once", () => {
    expect(problems(valid({ areas: [{ id: "A1", label: "stream path" }] })).join(" ")).toMatch(/this report has none, so leave it empty/);
    expect(problems(valid({ areas: [{ id: "A1", label: "stream path" }] }), { areaIds: ["A1", "A2"] })).toEqual([]);
    expect(problems(valid({ areas: [{ id: "A1", label: "a" }, { id: "A1", label: "b" }, { id: "A9", label: "c" }] }), { areaIds: ["A1", "A2"] }).join(" ")).toMatch(/appears twice[\s\S]*no area has this id/);
    // A large pull request may have more than 40 areas: a label for each of them is valid.
    const ids = Array.from({ length: 55 }, (_, i) => `A${i + 1}`);
    expect(problems(valid({ areas: ids.map((id) => ({ id, label: `area ${id}` })) }), { areaIds: ids })).toEqual([]);
  });
});

describe("the claims of the briefing", () => {
  it("has one claim for each bullet (W1), feature (F1), stage (F1.s2), flow (F1.f3) and check entry (C.risks.1), in that order, each needing quotes and carrying its cites", () => {
    const b = valid({ check: { ...emptyBriefing().check, risks: [{ text: "Retries without a bound.", cites: [at("pkg/b.go", 12)] }], tests: [{ text: "Covers the sweep.", cites: [at("pkg/a.go", 12)] }] } });
    const targets = briefingTargets(b);
    expect(targets.map((t) => t.id)).toEqual(["W1", "F1", "F1.s1", "F1.s2", "F1.s3", "F1.f1", "F1.f2", "C.risks.1", "C.tests.1"]);
    expect(targets.every((t) => t.quotes === "required" && t.cites !== undefined && t.cites.length > 0)).toBe(true);
    expect(targets.find((t) => t.id === "F1.s2")!.cites).toEqual([at("pkg/a.go", 12)]);
    expect(targets.find((t) => t.id === "F1.f2")!.text).toContain('from "nightly sweep" to "group data"');
    expect(targets.find((t) => t.id === "F1")!.cites).toHaveLength(3);
  });
});

describe("the briefing once the claim check has spoken", () => {
  const unsupported = (...ids: string[]): Map<string, string> => new Map(ids.map((id) => [id, "unsupported: the code does not show it"]));
  const full = valid({
    whatsNew: [
      { text: "Adds a retention policy.", cites: [at("pkg/a.go", 11)] },
      { text: "Adds a metric.", cites: [at("pkg/b.go", 12)] },
    ],
    check: { ...emptyBriefing().check, risks: [{ text: "Retries without a bound.", cites: [at("pkg/b.go", 12)] }, { text: "Drops errors.", cites: [at("pkg/b.go", 13)] }] },
  });

  it("keeps everything when everything is supported, naming a feature by its place (F1)", () => {
    const r = assembleBriefing(full, new Map());
    expect(r.parts).toEqual([]);
    expect(r.briefing.features.map((f) => f.id)).toEqual(["F1"]);
    expect(r.briefing.whatsNew).toHaveLength(2);
  });

  it("drops an unsupported bullet and an unsupported check entry, and records each", () => {
    const r = assembleBriefing(full, unsupported("W2", "C.risks.1"));
    expect(r.briefing.whatsNew.map((w) => w.text)).toEqual(["Adds a retention policy."]);
    expect(r.briefing.check.risks.map((e) => e.text)).toEqual(["Drops errors."]);
    expect(r.parts.map((p) => [p.id, p.kind])).toEqual([["W2", "whatsNew"], ["C.risks.1", "check"]]);
  });

  it("drops an unsupported stage with the flows that touch it, and an unsupported flow alone", () => {
    const r = assembleBriefing(full, unsupported("F1.s2"));
    // Both flows touch the dropped stage, so the feature is left with no flow and goes whole.
    expect(r.briefing.features).toEqual([]);
    expect(r.parts.map((p) => [p.id, p.kind])).toEqual([["F1.s2", "stage"], ["F1.f1", "flow"], ["F1.f2", "flow"], ["F1", "feature"]]);
    const flowOnly = assembleBriefing(full, unsupported("F1.f2"));
    expect(flowOnly.briefing.features[0]!.flows.map((x) => x.label)).toEqual(["schedules"]);
    expect(flowOnly.parts.map((p) => p.id)).toEqual(["F1.f2"]);
  });

  it("drops a feature whose own claim is unsupported, or that is left with fewer than two stages, and keeps the places of the others", () => {
    const two = valid({ features: [feature(), feature({ name: "Second" })] });
    const r = assembleBriefing(two, unsupported("F1"));
    expect(r.briefing.features.map((f) => [f.id, f.name])).toEqual([["F2", "Second"]]);
    const few = assembleBriefing(valid(), unsupported("F1.s1", "F1.s2"));
    expect(few.briefing.features).toEqual([]);
    expect(few.parts.at(-1)).toMatchObject({ id: "F1", kind: "feature" });
    expect(few.parts.at(-1)!.reason).toMatch(/1 stage\(s\), 0 flow\(s\)/);
  });

  it("is a briefing the rules judge again without a minimum owed", () => {
    const r = assembleBriefing(full, unsupported("W1", "W2", "F1"));
    expect(r.briefing.whatsNew).toEqual([]);
    expect(problems({ whatsNew: r.briefing.whatsNew, features: r.briefing.features, check: r.briefing.check, areas: r.briefing.areas }, {}, true)).toEqual([]);
  });
});

describe("the briefing as text", () => {
  const r = assembleBriefing(valid({ check: { ...emptyBriefing().check, surfaces: [{ text: "Adds the retention_days flag.", cites: [at("pkg/a.go", 11, 12)] }] } }), new Map()).briefing;

  it("lists what is new, one bullet each with its cites", () => {
    expect(whatsNewLines(r)).toEqual(["## What's new", "- **W1** Adds a retention policy. — pkg/a.go:11-12", ""]);
  });

  it("lists each feature's stages and flows with their cites", () => {
    const text = featureLines(r).join("\n");
    expect(text).toContain("### F1. Retention sweep");
    expect(text).toContain("- retention flag (source) — pkg/a.go:11");
    expect(text).toContain("- retention flag → nightly sweep: schedules — pkg/a.go:11");
    expect(featureLines({ ...r, features: [] }).join("\n")).toContain("None: the report names no new feature");
  });

  it("lists the five check lists, an empty one saying None", () => {
    const text = checkLines(r).join("\n");
    expect(text).toMatch(/### New surfaces[^\n]*\n- Adds the retention_days flag\. — pkg\/a\.go:11-12/);
    expect(text).toMatch(/### Tests added, and what they cover\n- None\./);
    expect((text.match(/^### /gm) ?? []).length).toBe(5);
  });
});
