// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The diagram job (design §6.10, §6.11, §12.3). After the claim check, a read-only agent job draws the checked
 * data flow of every checked feature and every checked lifecycle entry with the vendored diagram-design skill (`diagrams-v1`). Plugin code
 * then judges each drawing: the skill's own `self_check.py` and `verify-geometry.py` in a confined command job, the
 * inertness of the document and of the `<svg>` the report embeds, and the label rule (every visible text is a label
 * of the data the job was given). One correction goes back to the same session; a drawing that still fails is drawn by
 * the plugin instead, with a note. The graph and the validators ask the same function, `diagramFlow`, over the same evidence.
 */
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import type { FinalFeature } from "./briefing.js";
import { documentProblems, embeddedSvg, labelProblems, parseSvg, stylesFor, textNodes } from "./diagramsvg.js";
import { clip } from "./escape.js";
import { agentRuns, commandRuns, outputTail, succeeded, type AgentRun } from "./evidence.js";
import { feedbackBlock, UNTRUSTED_PREAMBLE, untrusted } from "./prompts.js";
import type { FileSpill, Fitted } from "./fit.js";
import type { FinalReport, StateEntry } from "./report.js";
import { writeChunks } from "./write.js";

export const DIAGRAMS_SCHEMA_NAME = "diagrams-v1";
export const DIAGRAMS_REFERENCES = ["diagrams[].id"] as const;
/** The diagram job's session key, so its correction continues its own session. */
export const DIAGRAMMER_JOB = "diagrammer";
/** The graph's command ids for the skill's checks: `diagram-check-<attempt>-<k>`. */
export const DIAGRAM_CHECK = "diagram-check";
/** Where the vendored skill lives under the plugin's directory (design §12.3). */
export const SKILL_DIR = "vendor/diagram-design";
export const skillMount = (pluginRoot: string): string => `${pluginRoot.replace(/\/+$/, "")}/${SKILL_DIR}`;

/** Most diagrams the job draws: the features' data flows, then the lifecycle entries in report order; the rest are drawn by the plugin. */
export const MAX_DIAGRAMS = 12;
/** Largest document, in characters, the job may return for one diagram: what one check command can carry, with its JSON escaping. */
export const MAX_DIAGRAM_BYTES = 160_000;
/** Attempts at drawing: the first and one correction. */
export const MAX_DIAGRAM_ATTEMPTS = 2;

const text = { type: "string" };
export const DIAGRAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diagrams"],
  properties: { diagrams: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "html"], properties: { id: text, html: text } } } },
};

// ---- what is drawn ----

export interface StateDrawing {
  /** `state:<item id>:<entry name>`. */
  id: string;
  item: string;
  entry: StateEntry;
}

/** The checked data of a report the diagrams are drawn from: nothing else reaches the job. */
export interface DiagramInput {
  features: FinalFeature[];
  states: StateDrawing[];
}

/**
 * The ids of an item's lifecycle entries, `state:<item id>:<entry name>`; a name an item uses twice gets `:2`, `:3`,
 * skipping any suffix another entry's name already occupies (`foo`, `foo`, `foo:2` give `foo`, `foo:3`, `foo:2`).
 */
export function stateIds(item: string, entries: ReadonlyArray<{ name: string }>): string[] {
  const literal = new Set(entries.map((e) => `state:${item}:${e.name}`));
  const taken = new Set<string>();
  return entries.map((e) => {
    const base = `state:${item}:${e.name}`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) {
      id = `${base}:${n}`;
      while (literal.has(id) && id !== base) id = `${base}:${(n += 1)}`;
    }
    taken.add(id);
    return id;
  });
}

/** What the claim check left of a report: the data flow of each feature and every lifecycle entry. */
export function diagramInputOf(final: Pick<FinalReport, "briefing" | "sections">): DiagramInput {
  const states: StateDrawing[] = [];
  for (const s of final.sections) {
    for (const item of s.items) {
      const ids = stateIds(item.id, item.state);
      item.state.forEach((entry, i) => states.push({ id: ids[i]!, item: item.id, entry }));
    }
  }
  return { features: final.briefing.features, states };
}

/** One diagram the job is asked for, with the labels it may print and the title and description the plugin writes. */
export interface DiagramSpec {
  /** `feature:<feature id>` or `state:<item id>:<entry name>`. */
  id: string;
  kind: "feature" | "state";
  title: string;
  description: string;
  phrases: string[];
}

export const featureDiagramId = (feature: string): string => `feature:${feature}`;

function featureSpec(f: FinalFeature): DiagramSpec {
  const first = f.stages[0];
  const last = f.stages[f.stages.length - 1];
  return {
    id: featureDiagramId(f.id),
    kind: "feature",
    title: `Data flow: ${clip(f.name, 50)}`,
    description: `Data flow of ${clip(f.name, 60)}: ${f.stages.length} stage${f.stages.length === 1 ? "" : "s"} and ${f.flows.length} flow${f.flows.length === 1 ? "" : "s"}${first !== undefined && last !== undefined ? `, from ${clip(first.label, 40)} to ${clip(last.label, 40)}` : ""}.`,
    phrases: [f.name, ...f.stages.flatMap((s) => [s.id, s.label, s.kind]), ...f.flows.map((fl) => fl.label)],
  };
}

function stateSpec(s: StateDrawing): DiagramSpec {
  const e = s.entry;
  return {
    id: s.id,
    kind: "state",
    title: `State machine: ${clip(e.name, 40)}`,
    description: `State machine of ${clip(e.name, 60)} (${clip(e.scope, 40)}): it starts ${clip(e.initial, 60)} and has ${e.transitions.length} transition${e.transitions.length === 1 ? "" : "s"}.`,
    phrases: [e.name, e.scope, e.initial, ...e.transitions.flatMap((t) => [t.when, t.effect]), ...e.reads.flatMap((r) => [r.where, r.decision, `${r.where} ${r.decision}`])],
  };
}

/** The characters of diagram data (the JSON of each feature and lifecycle entry) one diagram job's assignment holds (`fit.ts`). */
export const MAX_DIAGRAM_DATA_CHARS = 36_000;

/**
 * The diagrams the job draws, and the ids it leaves to the plugin: the first `MAX_DIAGRAMS` in order, as many as their
 * data fits one assignment (`MAX_DIAGRAM_DATA_CHARS`); the rest, from the first that does not fit, are drawn by the plugin.
 */
export function diagramSpecs(input: DiagramInput): { drawn: DiagramSpec[]; overflow: string[] } {
  const all = [
    ...input.features.map((f) => ({ spec: featureSpec(f), chars: featureData(f).length })),
    ...input.states.map((s) => ({ spec: stateSpec(s), chars: stateData(s).length })),
  ];
  const drawn: DiagramSpec[] = [];
  let used = 0;
  for (const { spec, chars } of all) {
    if (drawn.length >= MAX_DIAGRAMS || used + chars > MAX_DIAGRAM_DATA_CHARS) break;
    drawn.push(spec);
    used += chars;
  }
  return { drawn, overflow: all.slice(drawn.length).map((x) => x.spec.id) };
}

/** How a diagram is drawn in the report: by the skill, with its embedded `<svg>`, or by the plugin, with the note `review.html` shows. */
export type DrawnDiagram = { via: "diagram-design"; svg: string } | { via: "plugin"; note: string };

/** The drawings of a report, in `report.json` (design §6.6). */
export interface DiagramsDoc {
  /** The data flow of each feature, by feature id (`F1`). */
  features: Record<string, DrawnDiagram>;
  states: Record<string, DrawnDiagram>;
}

export const noDiagrams = (): DiagramsDoc => ({ features: {}, states: {} });

const failedNote = (reason: string): string => `drawn by the plugin: the diagram-design drawing failed its checks (${reason})`;

// ---- the job's instruction ----

const list = (items: readonly string[]): string => items.map((s) => `- ${s}`).join("\n");

function featureData(f: FinalFeature): string {
  return JSON.stringify({
    id: featureDiagramId(f.id),
    name: f.name,
    stages: f.stages.map((st) => ({ id: st.id, label: st.label, kind: st.kind })),
    flows: f.flows.map((fl) => ({ from: fl.from, to: fl.to, label: fl.label })),
  });
}

function stateData(s: StateDrawing): string {
  const e = s.entry;
  return JSON.stringify({ id: s.id, name: e.name, scope: e.scope, initial: e.initial, transitions: e.transitions.map((t) => ({ when: t.when, effect: t.effect })), reads: e.reads.map((r) => ({ where: r.where, decision: r.decision })) });
}

export interface DiagramsAssignment {
  owner: string;
  repo: string;
  number: number;
  /** The skill's directory, mounted read-only in the job. */
  mount: string;
  input: DiagramInput;
  specs: readonly DiagramSpec[];
  kind: "first" | "correction";
  feedback: readonly string[];
  reviewDir?: string;
}

/** The diagram job's assignment (design §6.10): the fixed choices, the data, the result. */
export const diagramsInstruction = (a: DiagramsAssignment): string => planDiagrams(a).text;

/** The diagram job's assignment and the file of its complete feedback, when the correction's problems do not fit. */
export function planDiagrams(a: DiagramsAssignment): Fitted {
  const feedback = feedbackBlock(a.feedback, 1, a.reviewDir);
  const spills: FileSpill[] = a.kind === "correction" ? feedback.spills : [];
  const features = a.specs.filter((s) => s.kind === "feature");
  const states = a.specs.filter((s) => s.kind === "state");
  const featureById = new Map(a.input.features.map((f) => [featureDiagramId(f.id), f] as const));
  const byId = new Map(a.input.states.map((s) => [s.id, s]));
  const text = [
    `You draw diagrams for the change report of ${a.owner}/${a.repo}#${a.number}. The data below was checked against the diff by an independent checker; it is the only thing you draw from. You are read-only: change nothing, and do not read the repository under review.`,
    "",
    UNTRUSTED_PREAMBLE,
    "",
    `The diagram-design skill is mounted read-only at ${a.mount}. Read ${a.mount}/SKILL.md first, then the references you need: ${a.mount}/references/type-data-flow.md, ${a.mount}/references/type-state.md, ${a.mount}/references/style-guide.md (Font source: offline/system fonts), ${a.mount}/references/primitives-core.md, ${a.mount}/references/output-spec.md and ${a.mount}/references/layout-budget.md. Start each document from ${a.mount}/assets/template.html (the light minimal template); ${a.mount}/assets/example-data-flow.html and ${a.mount}/assets/example-state.html show the two types. The skill's scripts are in ${a.mount}/scripts; you cannot run them (the plugin runs self_check.py --offline and verify-geometry.py on every document you return), so follow the skill's checklist by hand.`,
    "",
    "Choices already made; nobody is here to ask:",
    list([
      'Style: the skill\'s default. At its style-guide gate (SKILL.md section 0) the answer is "keep default"; do not customize, onboard or load a profile.',
      "Fonts: offline, system fonts (style-guide.md, Font source: system). No Google Fonts link, no <link>, no @import, nothing loaded from the network.",
      "Static: no motion, no animation, no JavaScript.",
      "Attribute values are literal: write fill, stroke and the other SVG attributes as plain values (\"#f5f5f5\"), never var(--x); the report embeds the <svg> without its stylesheet.",
      "Template: the light minimal one. A document is complete, self-contained HTML with one <svg> inside a local overflow-x: auto wrapper as output-spec.md asks.",
      "Size: the report shows a drawing scaled to a page about 1100 to 1400 pixels wide, so use a viewBox at most 1200 wide (output-spec.md presets: doc-inline 0 0 960 600, or doc-wide 0 0 1280 720 only when a three-panel delta cannot fit narrower) and tall as needed, wide enough that every label fits unclipped at that scale. The skill's complexity budgets do not apply, because every checked stage, flow and entry below must be drawn.",
      "Accessible SVG: role=\"img\", aria-labelledby, <title> then <desc> as the <svg>'s first children (the plugin replaces their text).",
    ]),
    "",
    "The label rule, checked by code. Every visible text in a drawing (every <text> and <tspan>) must be built only from the labels in the data below: stage ids, labels and kinds, flow labels, state names, scopes and initial values, transition conditions and effects, read descriptions, and the skill's own fixed words (STATE, START, END, INITIAL, READS, and a legend's words). Copy a label whole, in its own words; you may wrap it over several lines (each line is a run of its words), put a part of a pair on either side of an arrow (from → to), and print it in capitals, but do not shorten, reword, translate or add to it, and print no count, date, version, path, line number, code or sentence of your own. A text that is not a label is a claim the checker never saw, and the drawing fails. Where the skill asks for a short arrow label (14 characters), print the whole label wrapped instead.",
    "",
    `Draw ${a.specs.length} diagram${a.specs.length === 1 ? "" : "s"}, each as its own document, in this order:`,
    ...features.flatMap((f) => [
      `- id ${JSON.stringify(f.id)}: one Data flow (type-data-flow.md) of this feature's data path. The skill's type is made for roles in lanes and steps in columns; here the lanes are the kinds of the stages (only the kinds that occur, from the top in this order: source, process, transport, store, external, sink; each lane's label is its kind word in capitals) and the columns are the stages in the order the data reaches them, left to right. Every stage is a node whose title is its label, whole, with no sub-label, tool label or data-type chip of your own. Every flow is an arrow from its from stage to its to stage, with its label printed on the paper-filled mask the skill describes (the skill's one-labelled-arrow rule does not apply: every checked flow is drawn and labelled; use the skill's muted style for all but the focal arrow). Choose the first stage of kind store (the last stage when there is none) as the focal node and the flow into it as the focal arrow. Draw no step-header strip, no step numbers and no role chips, since they would print text that is no label of the data. Route every arrow as the skill's routing rules say, so that none crosses a node. The data of the feature:`,
      untrusted(`feature ${f.id}`, featureData(featureById.get(f.id)!)),
    ]),
    ...states.flatMap((s) => [
      `- id ${JSON.stringify(s.id)}: one State machine (type-state.md) of this lifecycle entry: the start dot, the initial state with the entry's name and initial value, one transition per recorded transition, each an arrow labelled with its condition (when) to a state labelled with its effect, and the reads noted in a Reads list below the machine, each as its where and decision. The data:`,
      untrusted(`lifecycle ${s.id}`, stateData(byId.get(s.id)!)),
    ]),
    "",
    `The result: diagrams, one entry for each id above and none other, each with id (exactly as given above) and html (the complete HTML document, at most ${MAX_DIAGRAM_BYTES} characters). Keep the quotes in the markup as the skill writes them.`,
    ...(a.kind === "correction" ? ["", "Your previous result failed the checks below, which are the plugin's and the skill's own. Return the whole set again: a diagram that did not fail may come back unchanged, and each one that failed must be fixed.", ...feedback.lines] : []),
  ].join("\n");
  return { text, spills };
}

// ---- the skill's checks as a command ----

/**
 * One command: the document's bytes into a scratch file (the run's own temporary directory: the workspace is read-only for
 * this job), then the skill's `self_check.py --offline` and `verify-geometry.py` on it. It fails when either does, printing
 * their findings; with no `python3` it fails and says so. No network, no repository code.
 */
export const DIAGRAM_CHECK_SCRIPT =
  'set -u; id="$0"; mount="$1"; n="$2"; shift 2; [ "$#" -eq "$n" ] || { echo "the document carries $# chunks, not $n" >&2; exit 6; }; ' +
  'command -v python3 >/dev/null 2>&1 || { echo "python3 is not available: the skill\'s checks cannot run" >&2; exit 127; }; ' +
  'dir=$(mktemp -d "${TMPDIR:-/tmp}/dd.XXXXXX") || exit 126; f="$dir/$id.html"; : > "$f"; for part in "$@"; do printf \'%s\' "$part" >> "$f"; done; ' +
  'export PYTHONDONTWRITEBYTECODE=1; rc=0; ' +
  'python3 -I "$mount/scripts/self_check.py" --offline "$f" || rc=1; ' +
  'python3 -I "$mount/scripts/verify-geometry.py" "$f" || rc=1; ' +
  'rm -rf "$dir"; exit $rc';

export const diagramCheckId = (attempt: number, k: number): string => `${DIAGRAM_CHECK}-${attempt}-${k}`;

/** The check command of the `k`th diagram's document in attempt `attempt`, or undefined when the document does not fit one command. */
export function diagramCheckCommand(attempt: number, k: number, html: string, mount: string): EnvironmentCommand | undefined {
  const chunks = writeChunks(html);
  const id = diagramCheckId(attempt, k);
  const command: EnvironmentCommand = { id, argv: ["sh", "-c", DIAGRAM_CHECK_SCRIPT, id, mount, String(chunks.length), ...chunks] };
  return command.argv.length <= 64 && Buffer.byteLength(JSON.stringify({ commands: [command] }), "utf8") <= MAX_EXECUTOR_INPUT_BYTES - 4_096 ? command : undefined;
}

/** The commands of one job: as many as fit one executor input, in order (at least one). */
export function checkBatch(commands: readonly EnvironmentCommand[]): EnvironmentCommand[] {
  const out: EnvironmentCommand[] = [];
  let bytes = 0;
  for (const c of commands) {
    const size = Buffer.byteLength(JSON.stringify(c), "utf8");
    if (out.length > 0 && (bytes + size > MAX_EXECUTOR_INPUT_BYTES - 16_000 || out.length >= 16)) break;
    out.push(c);
    bytes += size;
  }
  return out;
}

// ---- reading a result ----

/** What one attempt made of one diagram, before the skill's checks. */
type Drawing = { html: string; svg: string } | { problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The deterministic problems of one document, or its embedded `<svg>` (design §6.11, §12.3). */
export function drawingOf(html: string, spec: DiagramSpec, uid: string): Drawing {
  const problems: string[] = [];
  if (Buffer.byteLength(html, "utf8") > MAX_DIAGRAM_BYTES) return { problems: [`the document is ${Buffer.byteLength(html, "utf8")} bytes, more than the ${MAX_DIAGRAM_BYTES} allowed`] };
  problems.push(...documentProblems(html));
  const parsed = parseSvg(html);
  if ("problem" in parsed) return { problems: [...problems, parsed.problem] };
  try {
    const styles = stylesFor(html, parsed.root);
    if ("problems" in styles) problems.push(...styles.problems);
    const embedded = embeddedSvg(parsed.root, uid, spec.title, spec.description, "classes" in styles ? styles.classes : undefined);
    if ("problems" in embedded) problems.push(...embedded.problems);
    problems.push(...labelProblems(textNodes(parsed.root), spec.phrases));
    return problems.length > 0 || "problems" in embedded ? { problems: problems.slice(0, 12) } : { html, svg: embedded.svg };
  } catch (err) {
    // Whatever a hostile document does to the reading of it is a problem with the drawing, never a stop of the run.
    return { problems: [...problems, `the drawing could not be read: ${err instanceof Error ? err.message : String(err)}`].slice(0, 12) };
  }
}

/** The drawings a `diagrams-v1` run holds, by diagram id, with what is wrong with each. */
export function readAttempt(run: AgentRun, specs: readonly DiagramSpec[]): Map<string, Drawing> {
  const out = new Map<string, Drawing>();
  const all = (problems: string[]): Map<string, Drawing> => new Map(specs.map((s) => [s.id, { problems }] as const));
  if (run.status !== "completed") return all([`the diagram job did not complete (${run.status})`]);
  if (run.contract?.status === "invalid") return all([...run.contract.problems].slice(0, 6));
  const given = isObject(run.output) && Array.isArray(run.output.diagrams) ? run.output.diagrams : undefined;
  if (given === undefined) return all(["the result has no diagrams list"]);
  const docs = new Map<string, string[]>();
  const unknown: string[] = [];
  for (const d of given) {
    if (!isObject(d) || typeof d.id !== "string" || typeof d.html !== "string") continue;
    if (!specs.some((s) => s.id === d.id)) unknown.push(d.id);
    docs.set(d.id, [...(docs.get(d.id) ?? []), d.html]);
  }
  specs.forEach((spec, k) => {
    const have = docs.get(spec.id) ?? [];
    if (have.length === 0) out.set(spec.id, { problems: [`no diagram was returned for ${spec.id}`] });
    else if (have.length > 1) out.set(spec.id, { problems: [`${have.length} diagrams were returned for ${spec.id}, one is asked`] });
    else out.set(spec.id, drawingOf(have[0]!, spec, `dd${k + 1}`));
  });
  if (unknown.length > 0) for (const [id, d] of out) if ("html" in d) out.set(id, { problems: [`diagram ids that were not asked for: ${unknown.slice(0, 3).join(", ")}; return exactly the ids listed`] });
  return out;
}

// ---- the flow ----

export type DiagramFlow =
  | { state: "agent"; kind: "first" | "correction"; specs: DiagramSpec[]; feedback: string[] }
  | { state: "verify"; commands: EnvironmentCommand[] }
  | { state: "unavailable"; reason: string }
  | { state: "resolved"; doc: DiagramsDoc; refs: string[] };

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Where the diagrams stand (design §6.10), from the evidence alone: the job draws, the plugin's checks and the skill's judge
 * each document, one correction goes back to the same session, and what still fails is drawn by the plugin. It never fails: a
 * diagram that cannot be drawn by the skill has its note, and the run goes on.
 */
export function diagramFlow(evidence: readonly EvidenceRecord[], input: DiagramInput, pluginRoot?: string): DiagramFlow {
  const { drawn, overflow } = diagramSpecs(input);
  const doc: DiagramsDoc = noDiagrams();
  const set = (id: string, d: DrawnDiagram): void => {
    if (id.startsWith("feature:")) doc.features[id.slice("feature:".length)] = d;
    else doc.states[id] = d;
  };
  for (const id of overflow) set(id, { via: "plugin", note: `drawn by the plugin: this report has more diagrams than one diagram job takes (at most ${MAX_DIAGRAMS}, and ${MAX_DIAGRAM_DATA_CHARS} characters of data), and the diagram job draws the first ${drawn.length} (the features' data flows, then the lifecycle entries in report order)` });
  if (drawn.length === 0) return { state: "resolved", doc, refs: [] };
  const runs = agentRuns(evidence, DIAGRAMS_SCHEMA_NAME).slice(0, MAX_DIAGRAM_ATTEMPTS);
  const checks = commandRuns(evidence).filter((r) => r.command.id.startsWith(`${DIAGRAM_CHECK}-`));
  // The graph knows the plugin's directory from its environment check; a validator, which sees the checks that ran, reads the mount they were given.
  const mount = pluginRoot !== undefined ? skillMount(pluginRoot) : checks[0]?.command.argv[4];
  const refs: string[] = [];
  /** Per attempt, per diagram: the embedded svg, or why it failed. */
  const outcomes: Array<Map<string, { svg: string } | { problems: string[] }>> = [];
  for (let a = 0; a < runs.length; a += 1) {
    const run = runs[a]!;
    refs.push(run.record.ref);
    const read = readAttempt(run, drawn);
    const outcome = new Map<string, { svg: string } | { problems: string[] }>();
    const missing: EnvironmentCommand[] = [];
    let unavailable = false;
    drawn.forEach((spec, k) => {
      const d = read.get(spec.id)!;
      if ("problems" in d) {
        outcome.set(spec.id, d);
        return;
      }
      if (mount === undefined) {
        unavailable = true;
        return;
      }
      const command = diagramCheckCommand(a + 1, k, d.html, mount);
      if (command === undefined) {
        outcome.set(spec.id, { problems: ["the document does not fit one check command, so the skill's checks cannot run on it"] });
        return;
      }
      const ran = checks.filter((r) => r.command.id === command.id && sameArgv(r.command.argv, command.argv)).at(-1);
      if (ran === undefined) {
        missing.push(command);
        return;
      }
      refs.push(ran.record.ref);
      outcome.set(spec.id, succeeded(ran.command) ? { svg: d.svg } : { problems: [`the skill's checks failed: ${outputTail(ran.command, 700).replace(/\s+/g, " ")}`] });
    });
    if (unavailable) return { state: "unavailable", reason: "the environment check recorded no plugin directory, which the diagram skill is mounted from" };
    if (missing.length > 0) return { state: "verify", commands: missing };
    outcomes.push(outcome);
    if (drawn.every((s) => "svg" in outcome.get(s.id)!)) break;
  }
  const last = outcomes.at(-1);
  if (last === undefined) return { state: "agent", kind: "first", specs: drawn, feedback: [] };
  const allOk = drawn.every((s) => "svg" in last.get(s.id)!);
  if (!allOk && outcomes.length < MAX_DIAGRAM_ATTEMPTS) {
    const feedback = drawn.flatMap((s) => {
      const o = last.get(s.id)!;
      return "problems" in o ? [`${s.id}: ${o.problems.slice(0, 5).join("; ")}`] : [];
    });
    return { state: "agent", kind: "correction", specs: drawn, feedback };
  }
  for (const s of drawn) {
    // The latest attempt that passed stands; one that never passed is drawn by the plugin, with the last attempt's reason.
    const passed = [...outcomes].reverse().map((o) => o.get(s.id)!).find((o): o is { svg: string } => "svg" in o);
    if (passed !== undefined) set(s.id, { via: "diagram-design", svg: passed.svg });
    else {
      const why = last.get(s.id)!;
      set(s.id, { via: "plugin", note: failedNote("problems" in why ? clip(why.problems.slice(0, 2).join("; "), 400) : "no drawing") });
    }
  }
  return { state: "resolved", doc, refs: refs.slice(-10) };
}
