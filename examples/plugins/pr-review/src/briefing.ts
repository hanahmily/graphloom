// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The briefing fields of the change report (design §6.1, §6.6): what a maintainer needs in two minutes. The reporter
 * returns them with the report, in either mode: `whatsNew` (one bullet per new capability), `features` (the path the
 * data takes through each new feature, end to end), `check` (what the maintainer has to check, in five lists) and
 * `areas` (a short label for each area id of a large report). This module holds their contract fragments, their
 * deterministic validation, the claims the claim check judges (`W1`, `F1`, `F1.s2`, `F1.f3`, `C.risks.1`), the
 * assembly that drops what the check could not support, and their plain-text rendering for `review.md`.
 */
import type { ClaimTarget } from "./claims.js";
import { CITE_SCHEMA, citeProblem, type Cite } from "./cites.js";
import type { RemovedPart } from "./report.js";
import type { PullFile } from "./snapshot.js";

export const MAX_WHATS_NEW = 5;
export const MAX_FEATURES = 3;
export const MAX_STAGES = 8;
export const MAX_FLOWS = 12;
export const MAX_CHECK_PER_LIST = 8;
export const MAX_BULLET_CHARS = 240;
export const MAX_BULLET_CITES = 4;
export const MAX_AREA_LABELS = 40;
const MAX_NAME_CHARS = 80;
const MAX_SUMMARY_CHARS = 300;
const MAX_STAGE_LABEL_CHARS = 60;
const MAX_FLOW_LABEL_CHARS = 80;
const MAX_AREA_LABEL_CHARS = 80;

export const STAGE_KINDS = ["source", "process", "transport", "store", "external", "sink"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const CHECK_LISTS = ["surfaces", "behavior", "compatibility", "risks", "tests"] as const;
export type CheckList = (typeof CHECK_LISTS)[number];

/** What each list of `check` is, for the reporter's prompt and the report's headings. */
export const CHECK_TITLES: Record<CheckList, string> = {
  surfaces: "New surfaces (public APIs, RPCs, proto messages, CLI commands and flags, config)",
  behavior: "Changed behavior of existing code paths",
  compatibility: "Compatibility (wire format, on-disk or schema, mixed versions)",
  risks: "Risks (concurrency, retries, rate limiting, unbounded memory or resources, error handling that drops data)",
  tests: "Tests added, and what they cover",
};

/** One line with its cites: a new capability, or a thing to check. */
export interface Bullet {
  text: string;
  cites: Cite[];
}

export interface Stage {
  /** A short name the flows refer to. */
  id: string;
  label: string;
  kind: StageKind;
  cite: Cite;
}

export interface Flow {
  from: string;
  to: string;
  label: string;
  cite: Cite;
}

/** The path data takes through one new feature: where it enters, each hop, where it is stored. */
export interface Feature {
  name: string;
  summary: string;
  stages: Stage[];
  flows: Flow[];
}

export type Check = Record<CheckList, Bullet[]>;

export interface AreaLabel {
  id: string;
  label: string;
}

export interface Briefing {
  whatsNew: Bullet[];
  features: Feature[];
  check: Check;
  areas: AreaLabel[];
}

export const emptyCheck = (): Check => ({ surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] });
export const emptyBriefing = (): Briefing => ({ whatsNew: [], features: [], check: emptyCheck(), areas: [] });

// ---- the contract fragments ----

const text = { type: "string" };
const strict = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, required, properties });
const BULLET_SCHEMA = strict(["text", "cites"], { text, cites: { type: "array", items: CITE_SCHEMA } });

/** The properties the briefing adds to `change-report-v1`. */
export const BRIEFING_PROPERTIES: Record<string, unknown> = {
  whatsNew: { type: "array", items: BULLET_SCHEMA },
  features: {
    type: "array",
    items: strict(["name", "summary", "stages", "flows"], {
      name: text,
      summary: text,
      stages: { type: "array", items: strict(["id", "label", "kind", "cite"], { id: text, label: text, kind: { type: "string", enum: [...STAGE_KINDS] }, cite: CITE_SCHEMA }) },
      flows: { type: "array", items: strict(["from", "to", "label", "cite"], { from: text, to: text, label: text, cite: CITE_SCHEMA }) },
    }),
  },
  check: strict([...CHECK_LISTS], Object.fromEntries(CHECK_LISTS.map((l) => [l, { type: "array", items: BULLET_SCHEMA }]))),
  areas: { type: "array", items: strict(["id", "label"], { id: text, label: text }) },
};
export const BRIEFING_REQUIRED: string[] = ["whatsNew", "features", "check", "areas"];

/** What the reporter is told of the briefing fields: what each is for, and its bounds. */
export const BRIEFING_PROMPT = [
  `The first fields of your result are a briefing. A maintainer must grasp what this pull request does, and what to check in it, in two minutes. Write them first and for that reader; sections, items and lifecycles are the appendix they open afterwards, and they are not a substitute for the briefing. Be short and concrete: say what the code does, never how large the diff is.`,
  `- "whatsNew" (3 to ${MAX_WHATS_NEW} bullets, at most ${MAX_BULLET_CHARS} characters each): one bullet for each new capability, in the words a maintainer uses for it ("adds a retention policy for stream groups"), never one for each file or refactor. Each cites (1 to ${MAX_BULLET_CITES} places) the code that provides it.`,
  `- "features" (at most ${MAX_FEATURES}, the most important new capabilities; [] when the pull request adds none, for example a pure fix or refactor): the path the data takes through the feature, end to end, for a data-flow diagram. name (at most ${MAX_NAME_CHARS} characters), summary (one or two sentences, at most ${MAX_SUMMARY_CHARS}), stages (2 to ${MAX_STAGES}: id, a short name unique in the feature (letters, digits, "_" and "-", starting with a letter), label (at most ${MAX_STAGE_LABEL_CHARS} characters; what a maintainer calls it), kind ("source": where the data enters, "process": code that transforms or routes it, "transport": a hop over a wire or a queue, "store": where it is kept, "external": a system outside the repository, "sink": where it leaves or is consumed), and cite: a place that shows the stage) and flows (1 to ${MAX_FLOWS}: from and to (stage ids), label (what moves, a few words, at most ${MAX_FLOW_LABEL_CHARS} characters), cite: where the code moves it). Follow the data from where it enters to where it is stored or leaves; do not list components that only sit beside the path. Every stage and every flow is checked against the code as a claim of its own, and one that is not supported is dropped.`,
  `- "check" (five lists, at most ${MAX_CHECK_PER_LIST} entries each, one line of at most ${MAX_BULLET_CHARS} characters with its cites, each entry checked as a claim; [] for a list with nothing to say): "surfaces" (new public APIs, RPCs, proto messages, CLI commands and flags, configuration), "behavior" (changes to the behavior of EXISTING code paths, not new code), "compatibility" (wire format, on-disk or schema format, mixed-version operation), "risks" (concurrency, retries, rate limiting, unbounded memory or resources, error handling that drops data) and "tests" (the tests and end-to-end tests added, and what they cover). Say what the code does and where; leave verdicts to the maintainer.`,
].join("\n");

/** The line of the briefing prompt about `areas`, for a report with no areas. */
export const BRIEFING_NO_AREAS_PROMPT = `- "areas": [] (this pull request has no areas to label).`;

/** The same for a large report. */
export const BRIEFING_AREAS_PROMPT = `- "areas": one entry for each area id in the digest: id (exactly as listed) and label (at most ${MAX_AREA_LABEL_CHARS} characters; what the area is, in a maintainer's words, for example "stream write path").`;

// ---- validation ----

const isId = (s: string): boolean => /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(s);

function bulletProblems(b: Bullet, files: readonly PullFile[], at: string, problems: string[], tree: boolean): void {
  if (b.text.trim() === "") problems.push(`${at}: the text is empty`);
  else if (b.text.length > MAX_BULLET_CHARS) problems.push(`${at}: the text is ${b.text.length} characters, more than ${MAX_BULLET_CHARS}`);
  if (b.cites.length === 0) problems.push(`${at}: it cites nothing; every entry cites the code`);
  else if (b.cites.length > MAX_BULLET_CITES) problems.push(`${at}: ${b.cites.length} cites, more than ${MAX_BULLET_CITES}`);
  for (const c of b.cites) citeProblem(c, files, at, problems, true, tree);
}

function labelProblem(value: string, max: number, at: string, what: string, problems: string[]): void {
  if (value.trim() === "") problems.push(`${at}: ${what} is empty`);
  else if (value.length > max) problems.push(`${at}: ${what} is ${value.length} characters, more than ${max}`);
}

export interface BriefingContext {
  files: readonly PullFile[];
  /** Large mode: the briefing's claims are verified against the trees, so a cite need not lie in a hunk. */
  large?: boolean | undefined;
  /** The area ids of a large report, which `areas` labels; undefined when the report has no areas. */
  areaIds?: readonly string[] | undefined;
}

/**
 * The deterministic rules of the briefing fields: bounds, unique ids, flows between two stages, citations. `final` is
 * the report after the claim check, which keeps what was supported and so owes no minimum.
 */
export function briefingProblems(b: Briefing, ctx: BriefingContext, final = false): string[] {
  const problems: string[] = [];
  const tree = ctx.large === true;
  if (b.whatsNew.length > MAX_WHATS_NEW) problems.push(`whatsNew has ${b.whatsNew.length} bullets, more than ${MAX_WHATS_NEW}`);
  if (!final && b.whatsNew.length === 0) problems.push("whatsNew is empty: give one bullet for each new capability (3 to 5), or one for the change itself");
  b.whatsNew.forEach((w, i) => bulletProblems(w, ctx.files, `whatsNew ${i + 1}`, problems, tree));
  if (b.features.length > MAX_FEATURES) problems.push(`features has ${b.features.length} entries, more than ${MAX_FEATURES}`);
  b.features.forEach((f, i) => {
    const at = `feature ${i + 1}`;
    labelProblem(f.name, MAX_NAME_CHARS, at, "the name", problems);
    labelProblem(f.summary, MAX_SUMMARY_CHARS, at, "the summary", problems);
    if (f.stages.length > MAX_STAGES) problems.push(`${at}: ${f.stages.length} stages, more than ${MAX_STAGES}`);
    if (!final && f.stages.length < 2) problems.push(`${at}: ${f.stages.length} stage(s); a data path has at least two (where it enters, and where it goes)`);
    if (f.flows.length > MAX_FLOWS) problems.push(`${at}: ${f.flows.length} flows, more than ${MAX_FLOWS}`);
    if (!final && f.flows.length === 0) problems.push(`${at}: no flow; say how the data moves from stage to stage`);
    const ids = new Set<string>();
    f.stages.forEach((s, k) => {
      const here = `${at} stage ${k + 1} (${JSON.stringify(s.id)})`;
      if (!isId(s.id)) problems.push(`${here}: the id is a short name of letters, digits, "_" and "-", starting with a letter`);
      if (ids.has(s.id)) problems.push(`${here}: the id appears twice in this feature`);
      ids.add(s.id);
      labelProblem(s.label, MAX_STAGE_LABEL_CHARS, here, "the label", problems);
      if (!(STAGE_KINDS as readonly string[]).includes(s.kind)) problems.push(`${here}: the kind ${JSON.stringify(s.kind)} is none of ${STAGE_KINDS.join(", ")}`);
      citeProblem(s.cite, ctx.files, here, problems, true, tree);
    });
    f.flows.forEach((fl, k) => {
      const here = `${at} flow ${k + 1} (F${i + 1}.f${k + 1})`;
      if (!ids.has(fl.from)) problems.push(`${here}: from ${JSON.stringify(fl.from)} is not a stage id of this feature`);
      if (!ids.has(fl.to)) problems.push(`${here}: to ${JSON.stringify(fl.to)} is not a stage id of this feature`);
      if (fl.from === fl.to) problems.push(`${here}: it joins a stage to itself`);
      labelProblem(fl.label, MAX_FLOW_LABEL_CHARS, here, "the label", problems);
      citeProblem(fl.cite, ctx.files, here, problems, true, tree);
    });
  });
  for (const list of CHECK_LISTS) {
    const entries = b.check[list];
    if (entries.length > MAX_CHECK_PER_LIST) problems.push(`check.${list} has ${entries.length} entries, more than ${MAX_CHECK_PER_LIST}`);
    entries.forEach((e, i) => bulletProblems(e, ctx.files, `check.${list} ${i + 1}`, problems, tree));
  }
  if (b.areas.length > MAX_AREA_LABELS) problems.push(`areas has ${b.areas.length} entries, more than ${MAX_AREA_LABELS}`);
  const seen = new Set<string>();
  const known = ctx.areaIds === undefined ? undefined : new Set(ctx.areaIds);
  if (known === undefined && b.areas.length > 0) problems.push("areas labels the areas of a large pull request; this report has none, so leave it empty");
  b.areas.forEach((a, i) => {
    const at = `areas ${i + 1} (${JSON.stringify(a.id)})`;
    if (seen.has(a.id)) problems.push(`${at}: the id appears twice`);
    seen.add(a.id);
    if (known !== undefined && !known.has(a.id)) problems.push(`${at}: no area has this id (the areas are ${[...known].slice(0, 12).join(", ")})`);
    labelProblem(a.label, MAX_AREA_LABEL_CHARS, at, "the label", problems);
  });
  return problems;
}

// ---- claims ----

export const whatsNewClaimId = (n: number): string => `W${n}`;
export const featureClaimId = (feature: number): string => `F${feature}`;
export const stageClaimId = (feature: number, stage: number): string => `F${feature}.s${stage}`;
export const flowClaimId = (feature: number, flow: number): string => `F${feature}.f${flow}`;
export const checkClaimId = (list: CheckList, n: number): string => `C.${list}.${n}`;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The claims of the briefing fields, in the order the checker is shown them. */
export function briefingTargets(b: Briefing): ClaimTarget[] {
  const out: ClaimTarget[] = [];
  b.whatsNew.forEach((w, i) => out.push({ id: whatsNewClaimId(i + 1), text: `What is new: ${collapse(w.text)}`, cites: w.cites, quotes: "required" }));
  b.features.forEach((f, i) => {
    const label = new Map(f.stages.map((s) => [s.id, s.label] as const));
    out.push({
      id: featureClaimId(i + 1),
      text: `Feature "${collapse(f.name)}": ${collapse(f.summary)} (its data path: ${f.stages.map((s) => collapse(s.label)).join(" → ")})`,
      cites: f.stages.map((s) => s.cite),
      quotes: "required",
    });
    f.stages.forEach((s, k) => out.push({ id: stageClaimId(i + 1, k + 1), text: `Feature ${i + 1}, stage "${collapse(s.label)}" (${s.kind}): the cited code is this stage of the data's path`, cites: [s.cite], quotes: "required" }));
    f.flows.forEach((fl, k) =>
      out.push({ id: flowClaimId(i + 1, k + 1), text: `Feature ${i + 1}, flow from "${collapse(label.get(fl.from) ?? fl.from)}" to "${collapse(label.get(fl.to) ?? fl.to)}" (${collapse(fl.label)}): the cited code moves the data that way`, cites: [fl.cite], quotes: "required" }),
    );
  });
  for (const list of CHECK_LISTS) b.check[list].forEach((e, i) => out.push({ id: checkClaimId(list, i + 1), text: `Check, ${list}: ${collapse(e.text)}`, cites: e.cites, quotes: "required" }));
  return out;
}

// ---- assembly ----

/** A feature that stands after the claim check; `id` is its place in the reporter's list (`F1`), which its diagram and claims use. */
export interface FinalFeature extends Feature {
  id: string;
}

export interface FinalBriefing {
  whatsNew: Bullet[];
  features: FinalFeature[];
  check: Check;
  areas: AreaLabel[];
}

/**
 * The briefing once the claim check's verdicts are applied: an unsupported bullet or check entry leaves; an unsupported
 * stage leaves with its flows, an unsupported flow alone; a feature left with fewer than two stages or no flow, or one
 * whose own claim is unsupported, leaves whole. Each drop is a removed part, recorded under "Removed by the claim check".
 */
export function assembleBriefing(b: Briefing, removed: ReadonlyMap<string, string>): { briefing: FinalBriefing; parts: RemovedPart[] } {
  const parts: RemovedPart[] = [];
  const drop = (id: string, kind: RemovedPart["kind"], label: string, reason: string): void => {
    parts.push({ id, kind, item: "", label, reason });
  };
  const whatsNew = b.whatsNew.filter((w, i) => {
    const why = removed.get(whatsNewClaimId(i + 1));
    if (why !== undefined) drop(whatsNewClaimId(i + 1), "whatsNew", w.text, why);
    return why === undefined;
  });
  const features: FinalFeature[] = [];
  b.features.forEach((f, i) => {
    const id = featureClaimId(i + 1);
    const own = removed.get(id);
    if (own !== undefined) {
      drop(id, "feature", f.name, own);
      return;
    }
    const gone = new Set<string>();
    const stages = f.stages.filter((s, k) => {
      const why = removed.get(stageClaimId(i + 1, k + 1));
      if (why !== undefined) {
        gone.add(s.id);
        drop(stageClaimId(i + 1, k + 1), "stage", `${f.name}: ${s.label}`, why);
      }
      return why === undefined;
    });
    const flows = f.flows.filter((fl, k) => {
      const why = removed.get(flowClaimId(i + 1, k + 1));
      if (why !== undefined) {
        drop(flowClaimId(i + 1, k + 1), "flow", `${f.name}: ${fl.label}`, why);
        return false;
      }
      if (gone.has(fl.from) || gone.has(fl.to)) {
        drop(flowClaimId(i + 1, k + 1), "flow", `${f.name}: ${fl.label}`, "a stage it joins was dropped by the claim check");
        return false;
      }
      return true;
    });
    if (stages.length < 2 || flows.length === 0) {
      drop(id, "feature", f.name, `too little of its data path is left after the claim check (${stages.length} stage(s), ${flows.length} flow(s))`);
      return;
    }
    features.push({ id, name: f.name, summary: f.summary, stages, flows });
  });
  const check = emptyCheck();
  for (const list of CHECK_LISTS) {
    check[list] = b.check[list].filter((e, i) => {
      const why = removed.get(checkClaimId(list, i + 1));
      if (why !== undefined) drop(checkClaimId(list, i + 1), "check", `${list}: ${e.text}`, why);
      return why === undefined;
    });
  }
  return { briefing: { whatsNew, features, check, areas: b.areas }, parts };
}

// ---- plain text ----

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/** A cite as `path:3-9` (with `(base)` for the base side). */
export function briefingCite(c: Cite): string {
  const lines = c.start >= 1 && c.end >= c.start ? (c.start === c.end ? `:${c.start}` : `:${c.start}-${c.end}`) : "";
  return `${c.path}${lines}${c.side === "base" ? " (base)" : ""}`;
}

const bulletLine = (b: Bullet): string => `- ${oneLine(b.text)} — ${b.cites.map(briefingCite).join(", ")}`;

/** "What's new" for `review.md`: one bullet for each new capability. */
export function whatsNewLines(b: FinalBriefing): string[] {
  return ["## What's new", ...(b.whatsNew.length === 0 ? ["- None stated."] : b.whatsNew.map(bulletLine)), ""];
}

/** The data flow of each new feature as text: its stages, then its flows, each with its cite. */
export function featureLines(b: FinalBriefing): string[] {
  if (b.features.length === 0) return ["## Data flow per new feature", "- None: the report names no new feature with a data path.", ""];
  const out = ["## Data flow per new feature"];
  for (const f of b.features) {
    const label = new Map(f.stages.map((s) => [s.id, s.label] as const));
    out.push(`### ${f.id}. ${oneLine(f.name)}`, oneLine(f.summary), "Stages:", ...f.stages.map((s) => `- ${oneLine(s.label)} (${s.kind}) — ${briefingCite(s.cite)}`), "Flows:", ...f.flows.map((fl) => `- ${oneLine(label.get(fl.from) ?? fl.from)} → ${oneLine(label.get(fl.to) ?? fl.to)}: ${oneLine(fl.label)} — ${briefingCite(fl.cite)}`), "");
  }
  return out;
}

/** "What you need to check" for `review.md`: the five lists. */
export function checkLines(b: FinalBriefing): string[] {
  const out = ["## What you need to check"];
  for (const list of CHECK_LISTS) {
    out.push(`### ${CHECK_TITLES[list]}`, ...(b.check[list].length === 0 ? ["- None."] : b.check[list].map(bulletLine)));
  }
  out.push("");
  return out;
}
