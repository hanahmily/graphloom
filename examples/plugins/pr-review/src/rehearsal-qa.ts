// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Questions and Answers part of the rehearsal scenarios (design §16).
 * A scenario is data: a small base repository fixture the searches read, the
 * stated purposes, and how the answerer and its checker behave. Everything
 * else (the symbols, the required questions, their ids, the commands the graph
 * will run and so the canned outputs they need) is derived here with the
 * plugin's own functions, so a scenario cannot drift from the graph.
 */
import type { RehearsalCommandResult, RehearsalReply } from "@graphloom/sdk";
import { needsOwnSearch, verificationPlan, type Answer, type CheckVerdict } from "./answers.js";
import { candidatePlan, type Groundwork } from "./groundwork.js";
import { declaredDependencies, parseManifests, siteCommands } from "./inventory.js";
import type { MetricsRecord } from "./metrics/record.js";
import { effectivePacks } from "./packs.js";
import type { Profile } from "./profile.js";
import { parseSearch, type SearchSection } from "./queries.js";
import { finalQuestions, itemOfSymbol, pinnedTexts, requiredQuestions, statedPurposes, type Question, type QuestionerOutput, type QuestionType } from "./questions.js";
import { changeItems, type ReportView } from "./reportview.js";
import type { ReporterOutput } from "./report.js";
import { numbered } from "./report.js";
import type { PullFile } from "./snapshot.js";
import { changedSymbols, parseBaseDefinitions, type SymbolDef } from "./symbols.js";
import { sourceFiles } from "./groundwork.js";
import { mapTests } from "./testmap.js";
import type { Section } from "./template.js";

export interface Hit {
  path: string;
  line: number;
  text: string;
}

/** The small base repository the searches read. */
export interface BaseFixture {
  /** The base's declarations of the modified files, as `git grep -n` prints them. */
  defs?: string;
  /** Hits of each query, by the symbol's name. */
  hits?: Record<string, Partial<Record<"name" | "variants" | "signature" | "tokens" | "tests", Hit[]>>>;
  /** What fetching a candidate prints, by `path:line`: the definition and the lines after it. */
  snippets?: Record<string, string>;
  /** Dependency manifests by path. */
  manifests?: Record<string, string>;
  dirs?: string[];
  /** The first use of a dependency, by name. */
  sites?: Record<string, string>;
}

export const DEFAULT_GO_MOD = `module github.com/apache/skywalking-banyandb

go 1.24.0

require (
	github.com/spf13/cobra v1.9.1
	github.com/robfig/cron/v3 v3.0.1
	go.uber.org/multierr v1.11.0 // indirect
)
`;

export interface QaSpec {
  base?: BaseFixture;
  /** Purposes the pull request's text states: the section of the change item, the source and a quote from it. */
  purposes?: Array<{ section: string; source: "title" | "body" | "commit"; quote: string }>;
  /** Required questions the questioner leaves out, by type. */
  omit?: QuestionType[];
  /** Changes an answer the answerer gives; the argument is the plugin's default for that question. */
  answer?: (q: Question, sym: SymbolDef | undefined, record: MetricsRecord | undefined, dflt: Answer) => Answer;
  /** The checker's verdict for a question, by round; a round it does not list judges everything supported. */
  checks?: Array<(q: Question, a: Answer) => { verdict: "supported" | "partial" | "unsupported"; note: string; searches?: CheckVerdict["searches"] } | undefined>;
  /** The corrected answers after the checker's first round. */
  revise?: (q: Question, sym: SymbolDef | undefined, prev: Answer) => Answer;
}

export interface QaInput {
  profile: Profile;
  files: readonly PullFile[];
  headFiles: Readonly<Record<string, string>>;
  sections: readonly Section[];
  good: ReporterOutput;
  records: readonly MetricsRecord[];
  pull: { title: string; body: string; commits: readonly string[] };
  mergeBase: string;
  spec: QaSpec;
}

const emptyProposal = { kind: "none" as const, splits: [], testFile: "", testName: "", cases: [], assertion: "" };

const stemOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1).replace(/\.go$/, "");
const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

function defaultAnswer(q: Question, sym: SymbolDef | undefined, record: MetricsRecord | undefined, hasDeps: boolean): Answer {
  const searches = (names: string[]): Answer["searches"] => names.map((pattern) => ({ pattern, scope: "base" as const, hits: 0 }));
  const base: Answer = { question: q.id, answer: "", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { ...emptyProposal } };
  const name = sym?.name ?? "the function";
  switch (q.type) {
    case "purpose":
      return { ...base, answer: "Nothing the pull request's text, its commits or the code comments state why this change is made.", status: "needs author", searches: searches(["retention|purpose|why", "the pull request's title, body and commit messages (read)", "comments next to the change (read)"]) };
    case "existing-equivalent":
      return { ...base, answer: `No existing equivalent of ${name} was found: no declaration with its name or variants, its signature or its key tokens.`, none_found: true, searches: searches([`\\b${name}\\b`, `func .*\\(.*\\).*`, "key body tokens"]) };
    case "reuse-library":
      return { ...base, answer: `No internal package or declared library provides what ${name} does; no dependency's source is available here to read, so this is only what the searches and the manifests show.`, none_found: true, status: hasDeps ? "partially answered" : "answered", searches: searches([`\\b${name}\\b`]) };
    case "common-logic":
      return { ...base, answer: `No logic elsewhere in the base or in the pull request duplicates ${name}.`, none_found: true, searches: searches([`\\b${name}\\b`, "signature", "key body tokens"]) };
    case "missing-test": {
      const path = sym?.path ?? record?.path ?? "pkg/x/x.go";
      return { ...base, answer: `No test references ${name} or its callers: every *_test.go in the base and in the pull request was searched. A test would live beside it, in ${dirOf(path)}.`, status: "needs author", searches: [{ pattern: `\\b${name}\\b`, scope: "tests", hits: 0 }, { pattern: `\\b${name}\\b`, scope: "base", hits: 0 }], proposal: { ...emptyProposal, kind: "test", testFile: `${dirOf(path)}/${stemOf(path)}_test.go`, testName: `Test${upper(name)}`, cases: [{ input: "a typical value", branches: "the main path" }, { input: "an empty or invalid value", branches: "the error path" }] } };
    }
    case "split-function": {
      const start = sym?.startLine ?? record?.startLine ?? 1;
      const end = sym?.endLine ?? record?.endLine ?? 2;
      const mid = Math.floor((start + end) / 2);
      return {
        ...base,
        answer: `${name} mixes tokenizing with range checking; they split cleanly.`,
        metrics: record !== undefined ? [{ function: record.function, name: "complexity", value: record.complexity }, { function: record.function, name: "nesting", value: record.nesting }] : [],
        searches: searches([`\\b${name}Tokens\\b`]),
        proposal: {
          ...emptyProposal,
          kind: "split",
          splits: [
            { name: `${name}Tokenize`, startLine: start + 1, endLine: mid, responsibility: "separate the number from the unit" },
            { name: `${name}CheckRange`, startLine: mid + 1, endLine: end - 1, responsibility: "apply the range limit of each unit" },
          ],
        },
      };
    }
    case "complexity-coverage":
      return { ...base, answer: `No test exercises the branches of ${name}; coverage is not measured in this version.`, status: "needs author", metrics: record !== undefined ? [{ function: record.function, name: "complexity", value: record.complexity }] : [], searches: [{ pattern: `\\b${name}\\b`, scope: "tests", hits: 0 }], proposal: { ...emptyProposal, kind: "test", testFile: `${dirOf(sym?.path ?? record?.path ?? "pkg/x/x.go")}/${stemOf(sym?.path ?? record?.path ?? "x.go")}_test.go`, testName: `Test${upper(name)}Branches`, cases: [{ input: "each unit", branches: "the unit path" }] } };
    default:
      return { ...base, answer: "Answered from the code.", searches: searches(["other"]) };
  }
}

const formatHits = (hits: readonly Hit[]): string => hits.map((h) => `${h.path}:${h.line}:${h.text}`).join("\n");

const SECTION_ORDER = ["name", "variants", "signature", "tokens", "tests"] as const;

export interface QaScenario {
  results: Record<string, RehearsalReply[]>;
  commands: Record<string, RehearsalCommandResult>;
  /** The symbols and questions the graph will derive, for the scenario's own assertions. */
  questions: Question[];
  symbols: SymbolDef[];
}

/** The replies and canned command outputs of one scenario's Questions and Answers stages. */
export function qaScenario(i: QaInput): QaScenario {
  const { spec, profile } = i;
  const packs = effectivePacks(profile);
  const base = spec.base ?? {};
  // The report as the Report stage wrote it: every item, with the ids the Q&A refers to.
  const items = numbered(i.good, { sections: i.sections }).map(({ id, section, item }) => ({ id, section, text: item.text, cites: item.cites, facts: item.facts }));
  const view: ReportView = { items, records: [...i.records] };
  // Symbols, as the graph derives them from the head files, the patches and the base's declarations.
  const baseByPath = new Map<string, Set<string>>();
  const parsed = parseBaseDefinitions(base.defs ?? "", packs[0]!);
  for (const [p, names] of parsed.byPath) baseByPath.set(p, names);
  const raw = sourceFiles(i.files, packs, profile.metrics.generated).flatMap(({ file, pack }) => changedSymbols({ path: file.path, previousPath: file.previousPath, status: file.status, parsed: file.parsed, text: i.headFiles[file.path] }, pack, file.status === "added" ? undefined : baseByPath.get(file.path)));
  const symbols: SymbolDef[] = raw.map((s, n) => ({ ...s, id: `S${n + 1}`, ...(itemOfSymbol(s, items) !== undefined ? { item: itemOfSymbol(s, items)! } : {}) }));
  const groundwork = { symbols, testMap: new Map(symbols.map((s) => [s.id, mapTests(s, symbols, i.files, packs)] as const)) } as unknown as Groundwork;
  // The questioner.
  const pinned = pinnedTexts({ title: i.pull.title, body: i.pull.body }, i.pull.commits.map((message) => ({ message })));
  const purposes: QuestionerOutput["purposes"] = (spec.purposes ?? []).flatMap((p) => {
    const item = changeItems(view).find((x) => x.section === p.section);
    return item === undefined ? [] : [{ item: item.id, source: p.source, quote: p.quote }];
  });
  const stated = statedPurposes({ purposes, questions: [] }, view, pinned).stated;
  const required = requiredQuestions({ view, groundwork }, stated);
  const asked = required.filter((r) => !(spec.omit ?? []).includes(r.type));
  const questionerOutput: QuestionerOutput = { purposes, questions: asked.map((r) => ({ key: r.key, type: r.type, item: r.item, symbol: r.symbol ?? "", text: r.text })) };
  const questions = finalQuestions(required, questionerOutput, groundwork);
  // The answerer and its checker.
  const manifest = base.manifests ?? { "go.mod": DEFAULT_GO_MOD };
  const deps = declaredDependencies(parseManifests(Object.entries(manifest).map(([p, t]) => `===== graphloom manifest ${p}\n${t}`).join("\n") + "\n# end\n").files);
  const recordOf = (q: Question): MetricsRecord | undefined => (q.symbol !== undefined ? i.records.find((r) => r.function === symbols.find((s) => s.id === q.symbol)?.qualified) : i.records.find((r) => r.function === q.fn && (q.fnPath === undefined || r.path === q.fnPath)));
  const symOf = (q: Question): SymbolDef | undefined => symbols.find((s) => s.id === q.symbol);
  const first: Answer[] = questions.map((q) => {
    const dflt = defaultAnswer(q, symOf(q), recordOf(q), deps.length > 0);
    return spec.answer !== undefined ? spec.answer(q, symOf(q), recordOf(q), dflt) : dflt;
  });
  const revised = spec.revise !== undefined ? questions.flatMap((q, n) => (spec.checks?.[0]?.(q, first[n]!)?.verdict === "unsupported" ? [spec.revise!(q, symOf(q), first[n]!)] : [])) : [];
  const final = first.map((a) => revised.find((r) => r.question === a.question) ?? a);
  const verdicts = (round: number, set: readonly Answer[]): CheckVerdict[] =>
    questions.map((q, n) => {
      const a = set[n]!;
      const given = spec.checks?.[round]?.(q, a);
      const searches = given?.searches ?? (needsOwnSearch(q, a) ? [{ pattern: `\\b${symOf(q)?.name ?? "x"}\\b|test`, scope: "base" as const, hits: 0 }] : []);
      return { question: q.id, verdict: given?.verdict ?? "supported", note: given?.note ?? "", searches };
    });
  const rounds = revised.length > 0 || (spec.checks?.length ?? 0) > 1 ? [verdicts(0, first), verdicts(1, final)] : [verdicts(0, final)];
  const results: QaScenario["results"] = {
    "questions-v1": [{ output: questionerOutput }],
    "answers-v1": [{ output: { answers: first } }],
    "answer-check-v1": rounds.map((verdict) => ({ output: { verdicts: verdict } })),
    ...(revised.length > 0 ? { "answers-revision-v1": [{ output: { answers: revised } }] } : {}),
  };
  // Canned outputs of the read-only commands, by id, for the commands the graph will run.
  const commands: QaScenario["commands"] = {};
  const ok = (stdout: string): RehearsalCommandResult => ({ exitCode: 0, stdout });
  commands["base-defs-1"] = ok(`${base.defs ?? ""}\n# end\n`);
  commands["base-tree"] = ok(`${(base.dirs ?? ["pkg", "banyand"]).join("\n")}\n# end\n`);
  commands["base-manifests"] = ok(`${Object.entries(manifest).map(([p, t]) => `===== graphloom manifest ${p}\n${t}`).join("\n")}\n# end\n`);
  const searches = new Map<string, SearchSection[]>();
  for (const s of symbols) {
    const mine = base.hits?.[s.name] ?? {};
    const text = SECTION_ORDER.filter((k) => mine[k] !== undefined).map((k) => `== ${k} hits=${mine[k]!.length}\n${formatHits(mine[k]!)}`).join("\n");
    commands[`search-${s.id}`] = ok(`${text}\n`);
    searches.set(s.id, parseSearch(text));
  }
  candidatePlan(symbols, searches, packs).forEach((c, n) => {
    commands[`cand-${n + 1}`] = ok(`${base.snippets?.[`${c.path}:${c.line}`] ?? ""}\n`);
  });
  for (const c of siteCommands(i.mergeBase, deps)) {
    const names = c.argv.slice(6);
    commands[c.id] = ok(`${names.map((n) => `${n}\t${base.sites?.[n] ?? "-"}`).join("\n")}\n# end\n`);
  }
  if (deps.some((d) => d.ecosystem === "go")) commands["dep-source-go-1"] = ok("# end\n");
  const ctx = { questions, groundwork, view, packs };
  for (const item of verificationPlan(final, ctx, i.mergeBase)) {
    const lines = item.entries.map((_, n) => (item.kind === "cite" ? `${n + 1} ok` : "")).filter((l) => l !== "");
    commands[item.command.id] = ok(`${lines.join("\n")}${lines.length > 0 ? "\n" : ""}checked ${item.entries.length}\n`);
  }
  commands["qa-write"] = ok("written\n");
  commands["ledger-write"] = ok(`advanced ${"b".repeat(40)}\n`);
  return { results, commands, questions, symbols };
}
