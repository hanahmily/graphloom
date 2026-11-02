// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagramCheckCommand, featureDiagramId, stateIds, DIAGRAM_CHECK_SCRIPT, diagramFlow, diagramInputOf, diagramSpecs, drawingOf, MAX_DIAGRAMS, MAX_DIAGRAM_BYTES, readAttempt, type DiagramInput } from "../src/diagrams.js";
import { documentProblems, embeddedSvg, labelProblems, normalizeLabel, parseSvg, svgProblems, textNodes } from "../src/diagramsvg.js";
import { htmlProblems, parseReportDoc } from "../src/html.js";
import { largeNeeds } from "../src/large.js";
import { agentRuns } from "../src/evidence.js";
import { LARGE_LIMITS, REHEARSAL_HEAD, REHEARSAL_MERGE_BASE, rehearsal } from "../src/rehearsal.js";
import { featureDocument, fixtureDiagrams, stateDocument } from "../src/rehearsal-diagrams.js";
import { recordedAppendix, recordedHtml, recordedReport } from "../src/parts.js";
import type { FinalFeature } from "../src/briefing.js";
import type { StateEntry } from "../src/report.js";
import { BANYANDB, root, scenarioWith, simulate, type Simulation } from "./support.js";

const MOUNT = path.join(root, "vendor", "diagram-design");
const GITHUB = { owner: "apache", repo: "skywalking-banyandb", head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE };
const python = spawnSync("python3", ["-I", "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" }).status === 0;
const cite = { path: "a.go", side: "head" as const, start: 1, end: 2 };
const scite = { ...cite, symbol: "" };

const FEATURE: FinalFeature = {
  id: "F1",
  name: "Retention sweep",
  summary: "A flag sets how long a group keeps data, and a sweep removes what expired.",
  stages: [
    { id: "flags", label: "Server flags", kind: "source", cite: scite },
    { id: "ttl", label: "Retention parser", kind: "process", cite: scite },
    { id: "store", label: "Schema store", kind: "store", cite: scite },
    { id: "cron", label: "Cron scheduler library", kind: "external", cite: scite },
  ],
  flows: [
    { from: "flags", to: "ttl", label: "parses retention", cite: scite },
    { from: "ttl", to: "store", label: "validates against max", cite: scite },
    { from: "cron", to: "ttl", label: "schedules cleanup", cite: scite },
  ],
};
const ENTRY: StateEntry = {
  name: "stored count",
  scope: "per call",
  initial: "stored := 0, per call",
  transitions: [
    { when: "an event is written", effect: "stored increments by one", cite: scite },
    { when: "the write fails with an error", effect: "first error is kept", cite: scite },
    { when: "the batch ends with nothing stored", effect: "reply carries the first error", cite: scite },
  ],
  reads: [{ where: "the write callback", decision: "replies with the first error when stored is zero", cite: scite }],
};
const INPUT: DiagramInput = { features: [FEATURE], states: [{ id: "state:R3:stored count", item: "R3", entry: ENTRY }] };

const specsOf = (input: DiagramInput) => diagramSpecs(input).drawn;
const featureSpec = specsOf(INPUT)[0]!;
const stateSpec = specsOf(INPUT)[1]!;
const featureDoc = featureDocument(FEATURE, featureSpec);
const stateDoc = stateDocument(ENTRY, stateSpec);

const reportOf = (sim: Simulation): { json: string; doc: ReturnType<typeof parseReportDoc> } => {
  const w = recordedReport(sim.evidence);
  if (w.state !== "read") throw new Error("no report.json");
  return { json: w.value.json, doc: parseReportDoc(w.value.json) };
};
const htmlOf = (sim: Simulation): string => {
  const h = recordedHtml(sim.evidence, true);
  if (h.state !== "read") throw new Error("no review.html");
  return h.value;
};
const appendixOf = (sim: Simulation): string => {
  const h = recordedAppendix(sim.evidence, true);
  if (h.state !== "read") throw new Error("no review-appendix.html");
  return h.value;
};
const diagramJobs = (sim: Simulation) => sim.jobs.filter((j) => j.kind === "agent" && j.resultSchema === "diagrams-v1");
const checkJobs = (sim: Simulation) => sim.jobs.filter((j) => j.kind === "command" && j.instruction.startsWith("Check the diagram documents"));

describe("the vendored diagram-design skill", () => {
  it("is present with its license and its provenance, and its files are pinned by the manifest", () => {
    for (const rel of ["SKILL.md", "LICENSE", "VENDORED.md", "scripts/self_check.py", "scripts/verify-geometry.py", "assets/template.html", "references/type-data-flow.md", "references/type-state.md", "references/style-guide.md", "references/primitives-core.md", "references/output-spec.md", "references/layout-budget.md"]) {
      expect(existsSync(path.join(MOUNT, rel)), rel).toBe(true);
    }
    expect(readFileSync(path.join(MOUNT, "LICENSE"), "utf8")).toMatch(/^MIT License[\s\S]*Cathryn Lavery/);
    expect(readFileSync(path.join(MOUNT, "SKILL.md"), "utf8")).toMatch(/^---\nname: diagram-design\n/);
    const note = readFileSync(path.join(MOUNT, "VENDORED.md"), "utf8");
    expect(note).toContain("https://github.com/cathrynlavery/diagram-design");
    expect(note).toContain("0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1");
    expect(note).toMatch(/^- License: MIT\b/m);
    const manifest = JSON.parse(readFileSync(path.join(root, "graphloom.manifest.json"), "utf8")) as { digests: { files: Record<string, string> } };
    const pinned = Object.keys(manifest.digests.files).filter((p) => p.startsWith("vendor/diagram-design/"));
    expect(pinned).toEqual(expect.arrayContaining(["vendor/diagram-design/SKILL.md", "vendor/diagram-design/LICENSE", "vendor/diagram-design/scripts/self_check.py", "vendor/diagram-design/scripts/verify-geometry.py"]));
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).files).toContain("vendor");
  });
});

describe("the label rule", () => {
  const phrases = ["Retention parser", "parses retention", "stored := 0, per call", "an event is written"];

  it("allows a label whole, in capitals, with extra spaces, wrapped over lines, and the skill's fixed words", () => {
    expect(labelProblems(["Retention parser", "RETENTION   PARSER", "retention", "parser", "parses", "ADDED", "Before", "After", "Changes", "REMOVED", "STATE", "INITIAL", "an event is", "is written"], phrases)).toEqual([]);
  });

  it("allows the two sides of a pair around an arrow, and a change word before a label", () => {
    expect(labelProblems(["Retention parser → parses retention", "Retention parser", "→", "ADDED · Retention parser", "+ ADDED", "stored := 0, per call"], phrases)).toEqual([]);
  });

  it("rejects a text that is not a label, whatever its case: a claim the checker never saw", () => {
    const bad = labelProblems(["Retention parser", "This change makes the system faster", "RETENTION PARSER IS SLOW"], phrases);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/This change makes the system faster/);
    expect(labelProblems(["parses retention quickly"], phrases)).toHaveLength(1);
    expect(labelProblems(["v2.3"], phrases)).toHaveLength(1);
  });

  it("is not satisfied by a mere word of a label that is in no label: the words must be in one label, in order", () => {
    expect(labelProblems(["parser retention"], phrases)).toHaveLength(1);
    expect(labelProblems(["retention parses"], phrases)).toHaveLength(1);
  });

  it("normalizes whitespace, case and decorative punctuation on both sides", () => {
    expect(normalizeLabel("  Retention\n  PARSER, (v1)  ")).toBe("retention parser v1");
    expect(labelProblems(["Server  FLAGS."], ["server flags"])).toEqual([]);
  });

  it("judges every <text> and <tspan> of a drawing and nothing in <title> or <desc>", () => {
    const parsed = parseSvg(featureDoc);
    if ("problem" in parsed) throw new Error(parsed.problem);
    const texts = textNodes(parsed.root);
    expect(texts).toEqual(expect.arrayContaining(["SOURCE", "Server flags", "Retention parser", "parses retention"]));
    expect(texts.join(" ")).not.toContain("Data flow");
    expect(labelProblems(texts, featureSpec.phrases)).toEqual([]);
  });

  it("refuses a drawing with one added text, naming it", () => {
    const tampered = featureDoc.replace("</svg>", '<text x="8" y="20" font-size="9">this change makes the system faster</text></svg>');
    const r = drawingOf(tampered, featureSpec, "dd1");
    expect("problems" in r && r.problems.join(" ")).toMatch(/this change makes the system faster.*not a label of the data/);
  });
});

describe("the inertness of a drawing and of its document (design 6.11)", () => {
  it("accepts the skill-shaped documents, and embeds the <svg> the plugin re-serialized", () => {
    for (const [doc, spec] of [[featureDoc, featureSpec], [stateDoc, stateSpec]] as const) {
      expect(documentProblems(doc)).toEqual([]);
      const r = drawingOf(doc, spec, "dd1");
      if (!("svg" in r)) throw new Error(JSON.stringify(r));
      expect(r.svg.startsWith('<svg class="dd" role="img" aria-labelledby="dd1-title dd1-desc" style="width:100%;height:auto"')).toBe(true);
      expect(r.svg).not.toContain("min-width");
      expect(r.svg).toContain(`<title id="dd1-title">${spec.title}</title>`);
      expect(r.svg).toContain('id="dd1-arrow"');
      expect(r.svg).toContain("url(#dd1-arrow)");
      expect(r.svg).not.toContain("xmlns");
      expect(r.svg).not.toContain('id="arrow"');
      expect(htmlProblems(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"></head><body><main><div class="scroll">${r.svg}</div></main></body></html>`, GITHUB)).toEqual([]);
    }
  });

  it("covers the skill's own shipped examples: their <svg> embeds, and the Google Fonts link of their document is refused", () => {
    for (const name of ["example-data-flow.html", "example-state.html"]) {
      const html = readFileSync(path.join(MOUNT, "assets", name), "utf8");
      const parsed = parseSvg(html);
      if ("problem" in parsed) throw new Error(parsed.problem);
      expect(embeddedSvg(parsed.root, "dd1", "t", "d"), name).toMatchObject({ svg: expect.stringContaining("<svg") });
      expect(documentProblems(html).join(" "), name).toMatch(/network address/);
    }
  });

  describe("the document's stylesheet (design 6.11)", () => {
    const withStyle = (css: string, firstTextClass = "ink"): string => {
      const doc = featureDoc.replace("</style>", `${css}</style>`);
      // The first <text> inside the <svg> takes the class.
      const at = doc.indexOf("<text ", doc.indexOf("<svg"));
      return `${doc.slice(0, at)}<text class="${firstTextClass}" ${doc.slice(at + "<text ".length)}`;
    };
    const textTag = (svg: string): string => /<text class="ink"[^>]*>|<text [^>]*fill="#123456"[^>]*>/.exec(svg)?.[0] ?? svg.match(/<text [^>]*>/)![0];

    it("resolves a class rule into presentation attributes, and leaves no class behind", () => {
      const r = drawingOf(withStyle(".ink { fill: #123456; font-weight: 700 }"), featureSpec, "dd1");
      if (!("svg" in r)) throw new Error(JSON.stringify(r));
      const tag = textTag(r.svg);
      expect(tag).toContain('fill="#123456"');
      expect(tag).toContain('font-weight="700"');
      expect(r.svg).not.toContain('class="ink"');
      expect(r.svg.match(/class="/g)).toHaveLength(1);
    });

    it("refuses a var() in an SVG attribute, which would lose its definition with the stylesheet", () => {
      const doc = withStyle(":root { --paper: #f5f5f5 }").replace(/<rect ([^>]*?)fill="[^"]*"/, '<rect $1fill="var(--paper)"');
      expect(doc).toContain('fill="var(--paper)"');
      const r = drawingOf(doc, featureSpec, "dd1");
      expect("problems" in r ? r.problems.join(" ") : "embedded").toMatch(/var\(\), which the embedded drawing cannot resolve/);
    });

    it("resolves several classes on one element in stylesheet order, not class-attribute order", () => {
      const r = drawingOf(withStyle(".node { fill: #ffffff } .added { fill: #ee8800 }", "added node"), featureSpec, "dd1");
      if (!("svg" in r)) throw new Error(JSON.stringify(r));
      expect(r.svg).toMatch(/<text [^>]*fill="#ee8800"/);
      expect(r.svg).not.toMatch(/<text [^>]*fill="#ffffff"/);
    });

    it("resolves var(--x) from :root, with a fallback, and a rule that lists several classes", () => {
      const r = drawingOf(withStyle(":root { --accent: #abcdef } .a, .ink { stroke: var(--accent); fill: var(--none, #010203) }"), featureSpec, "dd1");
      if (!("svg" in r)) throw new Error(JSON.stringify(r));
      expect(textTag(r.svg)).toContain('stroke="#abcdef"');
      expect(textTag(r.svg)).toContain('fill="#010203"');
    });

    it.each([
      ["a declaration with no presentation attribute", ".ink { filter: blur(2px) }", /filter/],
      ["an unresolved var()", ".ink { fill: var(--missing) }", /--missing/],
      ["a url( that leaves the drawing", ".ink { fill: url(https://x.test/a.svg#p) }", /url\(|script or data|network/],
      ["a rule on the drawing's elements by tag", "svg text { fill: red }", /svg text/],
      ["a descendant or attribute selector", ".frame .ink, rect[x] { fill: red }", /rect\[x\]|\.frame \.ink/],
    ])("refuses %s, so the correction or the fallback handles it", (_name, css, expected) => {
      const r = drawingOf(withStyle(css), featureSpec, "dd1");
      expect("problems" in r, JSON.stringify(r)).toBe(true);
      expect("problems" in r && r.problems.join(" | ")).toMatch(expected);
    });

    it("ignores the page's own rules (body, svg sizing, media queries) and a class no rule names", () => {
      const r = drawingOf(withStyle("body { margin: 0 } svg { display: block } @media print { svg { min-width: 0 } } .frame { max-width: 9px }", "unstyled"), featureSpec, "dd1");
      expect("svg" in r, JSON.stringify(r)).toBe(true);
      expect("svg" in r && r.svg).not.toContain("unstyled");
    });
  });

  describe("a hostile nesting or size", () => {
    const wrap = (inner: string): string => `<!DOCTYPE html><html><body><svg viewBox="0 0 100 100"><title>t</title><desc>d</desc>${inner}</svg></body></html>`;

    it("refuses 15,000 nested <g> with a problem, quickly, and never throws", () => {
      const started = Date.now();
      const doc = wrap(`${"<g>".repeat(15_000)}${"</g>".repeat(15_000)}`);
      expect(Buffer.byteLength(doc)).toBeLessThan(MAX_DIAGRAM_BYTES);
      const r = drawingOf(doc, featureSpec, "dd1");
      expect("problems" in r && r.problems.join(" | ")).toMatch(/nested more than 64/);
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("refuses more elements than the report embeds, during the parse", () => {
      const r = drawingOf(wrap("<g/>".repeat(7_000)), featureSpec, "dd1");
      expect("problems" in r && r.problems.join(" | ")).toMatch(/more than the 6000 elements/);
    });

    it("parses a drawing nested to the limit", () => {
      const parsed = parseSvg(`<svg viewBox="0 0 1 1">${"<g>".repeat(60)}${"</g>".repeat(60)}</svg>`);
      expect("root" in parsed).toBe(true);
    });
  });

  it("scales the embedded <svg> to its container instead of forcing a minimum width, and asks the job for a viewBox that fits a report page", () => {
    const r = drawingOf(featureDoc, featureSpec, "dd1");
    expect("svg" in r && r.svg).toContain('style="width:100%;height:auto"');
    const sim = simulate({ scenarioName: "feature-data-flow" });
    const text = (diagramJobs(sim)[0]!.input as { assignment: string }).assignment;
    expect(text).toMatch(/viewBox at most 1200 wide/);
    expect(text).toMatch(/doc-inline/);
  });

  it("writes its own title and description, never the model's", () => {
    const tampered = featureDoc.replace(/(<desc[^>]*>)[^<]*/, "$1The system is now ten times faster");
    const r = drawingOf(tampered, featureSpec, "dd1");
    if (!("svg" in r)) throw new Error(JSON.stringify(r));
    expect(r.svg).not.toContain("ten times faster");
    expect(r.svg).toContain(featureSpec.description);
  });

  it.each([
    ["a script", (d: string) => d.replace("</svg>", "<script>alert(1)</script></svg>"), /<script/],
    ["a handler", (d: string) => d.replace("<rect ", '<rect onload="x()" '), /onload/],
    ["a link", (d: string) => d.replace("</svg>", '<a href="https://example.com/"><text x="1" y="1">Before</text></a></svg>'), /not one a drawing may hold|network address/],
    ["an image", (d: string) => d.replace("</svg>", '<image href="https://example.com/x.png"/></svg>'), /not one a drawing may hold|loads or animates/],
    ["a foreign object", (d: string) => d.replace("</svg>", "<foreignObject><div>hi</div></foreignObject></svg>"), /not one a drawing may hold|loads or animates/],
    ["an external stylesheet", (d: string) => d.replace("<style>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist"><style>'), /loads or animates|network address/],
    ["an @import", (d: string) => d.replace("<style>", "<style>@import url(https://x.test/a.css);"), /imports|url\(/],
    ["a font link in the style", (d: string) => d.replace("</style>", "@font-face { font-family: X; src: url(https://x.test/f.woff2); }</style>"), /imports or declares a font|url\(|network address/],
    ["a url( to elsewhere", (d: string) => d.replace('fill="#f5f5f5"/>', 'fill="url(https://x.test/p.svg#a)"/>'), /url\(/],
    ["a style attribute", (d: string) => d.replace("<rect ", '<rect style="background:url(https://x.test/a.png)" '), /style|url\(/],
    ["a dangling reference", (d: string) => d.replace('marker-end="url(#arrow)"', 'marker-end="url(#nowhere)"'), /nowhere/],
  ])("refuses %s", (_name, tamper, expected) => {
    const doc = tamper(featureDoc);
    if (doc === featureDoc) return;
    const r = drawingOf(doc, featureSpec, "dd1");
    expect("problems" in r, JSON.stringify(r)).toBe(true);
    expect("problems" in r && r.problems.join(" | ")).toMatch(expected);
  });

  it("refuses a title or description anywhere but directly under the <svg>, and an id defined twice", () => {
    const parsed = parseSvg('<svg viewBox="0 0 100 100"><title id="t">a</title><desc id="d">b</desc><g><title>tooltip claim</title></g><rect id="x" width="1" height="1"/><rect id="x" width="1" height="1"/></svg>');
    if ("problem" in parsed) throw new Error(parsed.problem);
    expect(svgProblems(parsed.root).join(" | ")).toMatch(/title or description is the <svg>'s own/);
    expect(svgProblems(parsed.root).join(" | ")).toMatch(/id x is defined twice/);
  });

  it("refuses an <svg> with no title and description, or no usable viewBox", () => {
    for (const markup of ['<svg viewBox="0 0 100 100"><rect width="1" height="1"/></svg>', '<svg><title>a</title><desc>b</desc></svg>']) {
      const parsed = parseSvg(markup);
      if ("problem" in parsed) throw new Error(parsed.problem);
      expect("problems" in embeddedSvg(parsed.root, "dd1", "t", "d")).toBe(true);
    }
  });

  it("bounds a document's size", () => {
    const r = drawingOf(`${featureDoc}<!-- ${"x".repeat(MAX_DIAGRAM_BYTES)} -->`, featureSpec, "dd1");
    expect("problems" in r && r.problems[0]).toMatch(/more than the 160000 allowed/);
  });

  it("makes the written review.html fail its own inertness check if a raw drawing slipped in", () => {
    const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"></head><body><main>${featureDoc.slice(featureDoc.indexOf("<svg"), featureDoc.lastIndexOf("</svg>") + 6).replace("</svg>", "<script>x()</script></svg>")}</main></body></html>`;
    expect(htmlProblems(html, GITHUB).join(" ")).toMatch(/<script|script/);
  });
});

describe.skipIf(!python)("the skill's own checks on the fixture documents (python3 is needed; skipped without it)", () => {
  const run = (script: string, file: string, ...args: string[]) => spawnSync("python3", ["-I", path.join(MOUNT, "scripts", script), ...args, file], { encoding: "utf8" });
  const scratch = mkdtempSync(path.join(tmpdir(), "dd-fixture-"));
  const write = (name: string, html: string): string => {
    const file = path.join(scratch, name);
    writeFileSync(file, html);
    return file;
  };

  it("passes self_check.py --offline and verify-geometry.py on the data flow and the state machine", () => {
    for (const [name, html] of [["flow.html", featureDoc], ["state.html", stateDoc]] as const) {
      const file = write(name, html);
      const a = run("self_check.py", file, "--offline");
      expect(`${a.stdout}${a.stderr}`, name).toMatch(/^OK /);
      expect(a.status).toBe(0);
      const g = run("verify-geometry.py", file);
      expect(g.stdout, name).toMatch(/0 finding\(s\)/);
      expect(g.status).toBe(0);
    }
  });

  it("passes on every document the rehearsal's stand-in model returns, in every scenario, and they pass the label rule", () => {
    const seen = new Set<string>();
    for (const name of ["report", "complex-function", "state-lifecycle", "feature-data-flow", "diagram-corrected", "diagram-skill-check-fails"]) {
      const scenario = rehearsal(BANYANDB).scenarios[name]!;
      const sim = simulate({ scenarioName: name });
      // The last reply of a scenario that ends in a drawing that stands; the fallback scenario's drawings are bad on purpose.
      for (const run0 of name === "diagram-fallback" ? [] : agentRuns(sim.evidence, "diagrams-v1").slice(-1)) {
        const out = run0.output as { diagrams: Array<{ id: string; html: string }> };
        for (const d of out.diagrams) {
          if (seen.has(d.html)) continue;
          seen.add(d.html);
          const file = write(`${name}-${seen.size}.html`, d.html);
          expect(`${run("self_check.py", file, "--offline").stdout}`, `${name} ${d.id}`).toMatch(/^OK /);
          expect(run("verify-geometry.py", file).stdout, `${name} ${d.id}`).toMatch(/0 finding\(s\)/);
        }
      }
      expect(scenario.results).toBeDefined();
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it("passes on the documents of a large report too", () => {
    const sim = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, { limits: LARGE_LIMITS }), config: { limits: LARGE_LIMITS }, maxSteps: 250 });
    const docs = (agentRuns(sim.evidence, "diagrams-v1").at(-1)!.output as { diagrams: Array<{ id: string; html: string }> }).diagrams;
    expect(docs.map((d) => d.id)).toEqual(["feature:F1"]);
    for (const d of docs) {
      const file = write("large.html", d.html);
      expect(run("self_check.py", file, "--offline").stdout).toMatch(/^OK /);
      expect(run("verify-geometry.py", file).stdout).toMatch(/0 finding\(s\)/);
    }
  });

  it("fails self_check.py --offline on a document with a Google Fonts link, so the check is the real one", () => {
    const file = write("font.html", featureDoc.replace("</head>", '<link href="https://fonts.googleapis.com/css2?family=Geist" rel="stylesheet"></head>'));
    expect(run("self_check.py", file, "--offline").status).not.toBe(0);
  });

  it("runs as the graph's command: bytes into a scratch file, both checks, exit 0 for a drawing that stands and non-zero for one that does not", () => {
    const exec = (html: string) => {
      const command = diagramCheckCommand(1, 0, html, MOUNT)!;
      return spawnSync(command.argv[0]!, command.argv.slice(1), { encoding: "utf8", cwd: scratch, env: { ...process.env, TMPDIR: scratch } });
    };
    expect(exec(featureDoc).status).toBe(0);
    const bad = exec(featureDoc.replace("</head>", '<link href="https://fonts.googleapis.com/css2?family=Geist" rel="stylesheet"></head>'));
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/Google Fonts|offline|font/i);
    expect(DIAGRAM_CHECK_SCRIPT).toContain("python3 -I");
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe("the diagram job in the graph", () => {
  describe("a standard report, with a drawing that fails the label rule first (diagram-corrected)", () => {
    const sim = simulate({ scenarioName: "diagram-corrected" });

    it("draws, checks, sends the problems back to the same session once, and checks the correction", () => {
      expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
      const jobs = diagramJobs(sim);
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({ jobId: "diagrammer", stageId: "report", purpose: "diagnostic", readOnly: true });
      expect(jobs[0]!.continueFrom).toBeUndefined();
      expect(jobs[1]!.continueFrom).toBeDefined();
      const second = (jobs[1]!.input as { assignment: string }).assignment;
      expect(second).toMatch(/Your previous result failed the checks below/);
      expect(second).toMatch(/feature:F1: .*this change makes the system faster.*not a label of the data/);
      // The checks run only on a drawing that passed the plugin's own: the first attempt has none, the correction has one.
      const ids = checkJobs(sim).flatMap((j) => (j.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id));
      expect(ids).toEqual(["diagram-check-2-0"]);
    });

    it("records the skill's drawing in report.json and embeds it in review.html in a scrolling wrapper, with no fallback note", () => {
      const { doc } = reportOf(sim);
      expect(doc!.diagrams!.features.F1).toMatchObject({ via: "diagram-design" });
      const html = htmlOf(sim);
      const flow = html.slice(html.indexOf("<h2>Data flow</h2>"), html.indexOf("<h2>Risk map</h2>"));
      expect(flow).toMatch(/<div class="scroll"><svg class="dd" role="img" aria-labelledby="dd1-title dd1-desc"/);
      expect(flow).not.toContain("drawn by the plugin");
      expect(flow).toContain("Nightly retention sweep");
      expect(htmlProblems(html, GITHUB)).toEqual([]);
    });
  });

  describe("drawings that never pass (diagram-fallback)", () => {
    const sim = simulate({ scenarioName: "diagram-fallback" });

    it("goes on: the plugin draws the diagram, and review.html says the skill's drawing failed its checks and why", () => {
      expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
      expect(diagramJobs(sim)).toHaveLength(2);
      const { doc } = reportOf(sim);
      const drawn = doc!.diagrams!.features.F1!;
      expect(drawn).toMatchObject({ via: "plugin" });
      expect((drawn as { note: string }).note).toMatch(/^drawn by the plugin: the diagram-design drawing failed its checks \(.*<script/);
      const html = htmlOf(sim);
      const section = html.slice(html.indexOf("<h2>Data flow</h2>"), html.indexOf("<h2>Risk map</h2>"));
      // The note is a tooltip of the caption, and a paragraph in the appendix.
      expect(section).toMatch(/<div class="cap" title="[^"]*\(drawn by the plugin: the diagram-design drawing failed its checks \(/);
      expect(section).not.toContain("<p>");
      expect(appendixOf(sim)).toMatch(/<p>drawn by the plugin: the diagram-design drawing failed its checks \(/);
      expect(section).toContain("<svg");
      expect(section).not.toContain('class="dd"');
      expect(section).toContain("Nightly sweep");
    });
  });

  describe("a skill check that fails once (diagram-skill-check-fails)", () => {
    const sim = simulate({ scenarioName: "diagram-skill-check-fails" });

    it("sends the skill's findings back, then runs the checks on the correction, and the state diagrams are the skill's", () => {
      expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
      const jobs = diagramJobs(sim);
      expect(jobs).toHaveLength(2);
      expect((jobs[1]!.input as { assignment: string }).assignment).toMatch(/the skill's checks failed: .*self_check\.py: finding/);
      const { doc } = reportOf(sim);
      expect(Object.values(doc!.diagrams!.states)).toHaveLength(2);
      expect(Object.values(doc!.diagrams!.states).every((d) => d.via === "diagram-design")).toBe(true);
      // The lifecycle diagrams are the appendix's; the briefing has no feature to draw.
      const html = appendixOf(sim);
      expect((html.match(/<svg class="dd"/g) ?? []).length).toBe(2);
      expect(html).not.toContain("drawn by the plugin");
      // review.html has no drawing of a feature: its only SVGs are the scope bar and the risk map.
      expect(htmlOf(sim)).not.toMatch(/<svg class="dd"/);
      expect(htmlOf(sim).slice(htmlOf(sim).indexOf("<h2>Data flow</h2>"), htmlOf(sim).indexOf("<h2>Risk map</h2>"))).not.toContain("<svg");
    });

    it("confines the check job: a read-only job with no network, the plugin's directory read-only, and the skill's own scripts on a scratch file", () => {
      const [job] = checkJobs(sim);
      expect(job).toMatchObject({ stageId: "report", readOnly: true, purpose: "diagnostic", confinement: { kind: "bwrap", network: false, binds: [{ path: "/plugin", readOnly: true }] } });
      const command = (job!.input as { commands: Array<{ argv: string[] }> }).commands[0]!;
      expect(command.argv[2]).toContain("self_check.py");
      expect(command.argv[2]).toContain("verify-geometry.py");
      expect(command.argv[2]).toContain('${TMPDIR:-/tmp}');
      expect(command.argv[4]).toBe("/plugin/vendor/diagram-design");
    });
  });

  describe("the job's assignment and confinement", () => {
    const sim = simulate({ scenarioName: "state-lifecycle" });
    const [job] = diagramJobs(sim);
    const assignment = (job!.input as { assignment: string }).assignment;

    it("mounts the skill read-only, in a bwrap job with the repository's agent configuration masked", () => {
      expect(job!.confinement).toMatchObject({ kind: "bwrap", network: true, binds: [{ path: "/plugin/vendor/diagram-design", readOnly: true }] });
      expect(job).toMatchObject({ readOnly: true, executor: { id: "graphloom.coding-agent/run" } });
      expect((job!.confinement as { mask: string[] }).mask).toEqual(expect.arrayContaining(["/work/tree/CLAUDE.md", "/work/tree/.claude"]));
    });

    it("tells the agent where the skill is, which references to read and the fixed choices", () => {
      const mount = "/plugin/vendor/diagram-design";
      expect(assignment).toContain(`${mount}/SKILL.md`);
      for (const r of ["type-data-flow.md", "type-state.md", "style-guide.md", "primitives-core.md", "output-spec.md", "layout-budget.md"]) expect(assignment).toContain(`${mount}/references/${r}`);
      expect(assignment).toContain(`${mount}/assets/template.html`);
      expect(assignment).toMatch(/"keep default"/);
      expect(assignment).toMatch(/Font source: system/);
      expect(assignment).toMatch(/No Google Fonts link/);
      expect(assignment).toMatch(/no motion, no animation, no JavaScript/i);
      expect(assignment).toMatch(/light minimal one/);
      expect(assignment).toMatch(/nobody is here to ask/);
      expect(assignment).toMatch(/The label rule/);
    });

    it("hands over only the checked data: the lifecycle entries, with no citation or path", () => {
      expect(assignment).toContain('"name":"stored"');
      expect(assignment).toContain('"name":"firstErr"');
      expect(assignment).toContain("state:R");
      expect(assignment).not.toMatch(/"cite"|"paths"|\.go"/);
      expect(assignment).not.toContain("Server command");
    });

    it("constrains the result's ids to the diagrams asked for, and bounds its attempts", () => {
      const ids = Object.values(job!.knownReferences ?? {})[0]!.ids;
      expect(Object.keys(job!.knownReferences ?? {})).toEqual(["diagrams[].id"]);
      expect(ids).toHaveLength(2);
      expect(ids.every((id) => id.startsWith("state:R"))).toBe(true);
    });
  });

  it("gives the diagram job the diagrammer role: the reporter's harness, model and effort when the profile names none, its own when it does", () => {
    const base = simulate({ scenarioName: "feature-data-flow" });
    expect((diagramJobs(base)[0]!.input as { harness: string; harnessOptions?: unknown })).toMatchObject({ harness: "claude-code", harnessOptions: { model: "opus", effort: "high" } });
    const own = simulate({ scenarioName: "feature-data-flow", config: { harnesses: { ...(BANYANDB.harnesses as object), diagrammer: { harness: "claude-code", model: "sonnet", effort: "medium" } } } });
    expect(diagramJobs(own)[0]!.input).toMatchObject({ harness: "claude-code", harnessOptions: { model: "sonnet", effort: "medium" } });
    // The reporter's settings, whatever the profile once said of other reporters.
    const other = simulate({ scenarioName: "feature-data-flow", config: { harnesses: { ...(BANYANDB.harnesses as object), reporter: { harness: "claude-code", model: "haiku", effort: "low" } } } });
    expect(diagramJobs(other)[0]!.input).toMatchObject({ harnessOptions: { model: "haiku", effort: "low" } });
  });

  it("draws in large mode too, once, after the claim check, and draws the same on the same report", () => {
    const sim = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, { limits: LARGE_LIMITS }), config: { limits: LARGE_LIMITS }, maxSteps: 250 });
    expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
    expect(diagramJobs(sim)).toHaveLength(1);
    const order = sim.jobs.filter((j) => j.stageId === "report" && j.kind === "agent").map((j) => j.resultSchema);
    expect(order.at(-2)).toBe("claim-check-v1");
    expect(order.at(-1)).toBe("diagrams-v1");
    const html = htmlOf(sim);
    expect(html).toMatch(/<svg class="dd"/);
    expect(html).toContain("pkg/alpha rules");
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });

  it("counts the diagram job in large mode's budget pre-check", () => {
    // The questions are asked per high-level change (at most five), so the estimate does not grow with the areas.
    expect(largeNeeds(10)).toMatchObject({ agentInvocations: 9, jobs: 51 });
    // One area: 7 agent invocations before the diagrams (the reporter and its checker, questioner, N1's two, one batch's two), 2 more for them; 46 jobs before (the files the agents read among them), 4 more.
    expect(largeNeeds(1)).toMatchObject({ agentInvocations: 9, jobs: 51 });
  });

  it("draws nothing when the report has no feature and no lifecycle entry, and says nothing of it", () => {
    const sim = simulate({ scenarioName: "report" });
    expect(diagramJobs(sim)).toHaveLength(0);
    expect(checkJobs(sim)).toHaveLength(0);
    expect(reportOf(sim).doc!.diagrams).toBeUndefined();
  });
});

describe("the stop message", () => {
  it("names review.html first, and review.md as its plain-text copy for agents and session open", () => {
    const sim = simulate({ scenarioName: "report" });
    const stop = sim.final.action.type === "stop" ? sim.final.action.stop : undefined;
    expect(stop!.blocker).toMatch(/^the report is the briefing \.graphloom\/review\/review\.html, with the appendix \.graphloom\/review\/review-appendix\.html; review\.md beside them is the plain-text copy of both for agents and graphloom session open/);
    expect(stop!.blocker!.indexOf("review.html")).toBeLessThan(stop!.blocker!.indexOf("review.md"));
  });
});

describe("the flow, from the evidence alone", () => {
  it("resolves at once when there is nothing to draw, and notes the diagrams past the limit as the plugin's", () => {
    expect(diagramFlow([], { features: [], states: [] }, "/plugin")).toMatchObject({ state: "resolved", doc: { states: {} } });
    const many: DiagramInput = { features: [FEATURE], states: Array.from({ length: 14 }, (_, i) => ({ id: `state:R${i}:s`, item: `R${i}`, entry: { ...ENTRY, name: "s" } })) };
    const { drawn, overflow } = diagramSpecs(many);
    expect(drawn).toHaveLength(MAX_DIAGRAMS);
    expect(drawn[0]!.id).toBe(featureDiagramId("F1"));
    expect(overflow).toHaveLength(3);
    expect(diagramFlow([], many, "/plugin")).toMatchObject({ state: "agent", kind: "first" });
  });

  it("derives the diagrams of a report from what the claim check left: the features, and a state:<item>:<name> id for each entry", () => {
    const input = diagramInputOf({
      briefing: { whatsNew: [], features: [FEATURE], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] },
      sections: [{ id: "features", title: "Features", none: false, items: [{ id: "R1", text: "t", cites: [], facts: [], state: [ENTRY, ENTRY], behavior: [] }] }],
    });
    expect(input.states.map((s) => s.id)).toEqual(["state:R1:stored count", "state:R1:stored count:2"]);
    expect(diagramInputOf({ briefing: { whatsNew: [], features: [], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] }, sections: [] }).features).toEqual([]);
    expect(input.features.map((f) => f.id)).toEqual(["F1"]);
  });

  it("refuses a result that returns an id it was not asked for, or an id twice, or none", () => {
    const run = (diagrams: unknown) => ({ record: { ref: "e1", kind: "other" } as never, producer: {} as never, status: "completed", output: { diagrams } });
    const good = fixtureDiagrams(INPUT).diagrams;
    const specs = specsOf(INPUT);
    expect([...readAttempt(run(good), specs).values()].every((d) => "svg" in d)).toBe(true);
    const extra = readAttempt(run([...good, { id: "state:R9:x", html: "<svg/>" }]), specs);
    expect([...extra.values()].every((d) => "problems" in d)).toBe(true);
    const twice = readAttempt(run([...good, good[0]!]), specs);
    expect(twice.get(featureDiagramId("F1"))).toMatchObject({ problems: [expect.stringMatching(/2 diagrams were returned/)] });
    const none = readAttempt(run([good[0]!]), specs);
    expect(none.get(stateSpec.id)).toMatchObject({ problems: [expect.stringMatching(/no diagram was returned/)] });
    expect([...readAttempt({ ...run(good), status: "failed" }, specs).values()].every((d) => "problems" in d)).toBe(true);
  });
});

describe("report.json and review.html agree", () => {
  it("embeds exactly the svg report.json holds, at the Report stage and at the Answers stage", () => {
    const sim = simulate({ scenarioName: "diagram-corrected" });
    const { doc } = reportOf(sim);
    const flow = doc!.diagrams!.features.F1 as { svg: string };
    expect(htmlOf(sim)).toContain(flow.svg);
    const early = recordedHtml(sim.evidence, false);
    expect(early.state === "read" && early.value.includes(flow.svg)).toBe(true);
  });
});

describe("lifecycle diagram ids", () => {
  it("gives every entry its own id, even when a suffix collides with a literal name", () => {
    const ids = stateIds("R1", [{ name: "foo" }, { name: "foo" }, { name: "foo:2" }]);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["state:R1:foo", "state:R1:foo:3", "state:R1:foo:2"]);
    expect(stateIds("R1", [{ name: "foo:2" }, { name: "foo" }, { name: "foo" }])).toEqual(["state:R1:foo:2", "state:R1:foo", "state:R1:foo:3"]);
    expect(stateIds("R2", [{ name: "a" }, { name: "b" }])).toEqual(["state:R2:a", "state:R2:b"]);
  });
});
