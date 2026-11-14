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
import { needsOwnSearch, searchItems, verificationPlan, type Answer, type CheckVerdict, type VerifyItem } from "./answers.js";
import { COMMAND } from "./constants.js";
import { isLarge, questionsMode, STANDARD, type ReviewMode } from "./mode.js";
import { answerBatches, batchCitePrefix, batchRecordId } from "./qaflow.js";
import { effectiveConclusion, necessityAnswer, necessityQuestion, type Necessity, type PrincipleVerdict } from "./necessity.js";
import { applies, parsePrinciples } from "./principles.js";
import { candidatePlan, type Groundwork } from "./groundwork.js";
import { declaredDependencies, parseManifests, siteCommands } from "./inventory.js";
import type { MetricsRecord } from "./metrics/record.js";
import { effectivePacks } from "./packs.js";
import type { Profile } from "./profile.js";
import { parseSearch, type SearchSection } from "./queries.js";
import { REUSE_TYPE, finalQuestions, itemOfSymbol, pinnedTexts, requiredQuestions, statedPurposes, type Question, type QuestionerOutput, type QuestionType } from "./questions.js";
import { changeItems, highLevelId, type ReportView } from "./reportview.js";
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

/** How the answerer and the checker treat the necessity question N1 (design §7.5, §16). */
export interface NecessitySpec {
  /** The answerer's result; the argument is the plugin's default (necessary, on the pull request's title). */
  result?: (dflt: Necessity) => Necessity;
  /** The checker's verdict on N1 by round; a round it does not list is supported. */
  checks?: Array<{ verdict: "supported" | "partial" | "unsupported"; note: string }>;
  /** The corrected result after an unsupported verdict. It keeps the number of citations, so the verification command is the same. */
  revise?: (prev: Necessity) => Necessity;
  /**
   * The repository has a design principles file with this text at the profile's ref. The answerer judges each principle that
   * applies (`preserves` unless `verdicts` says otherwise) and the checker supports each verdict unless `checks` says otherwise.
   */
  principles?: { text: string; verdicts?: Record<string, PrincipleVerdict["verdict"]>; checks?: Record<string, "supported" | "partial" | "unsupported"> };
}

export interface QaSpec {
  necessity?: NecessitySpec;
  base?: BaseFixture;
  /** Purposes the pull request's text states: the section of the change item (or, to name one of several in a section, its id), the source and a quote from it. */
  purposes?: Array<{ section: string; item?: string; source: "title" | "body" | "commit"; quote: string }>;
  /** Required questions the questioner leaves out, by type. */
  omit?: QuestionType[];
  /** Changes an answer the answerer gives; the argument is the plugin's default for that question. */
  answer?: (q: Question, sym: SymbolDef | undefined, record: MetricsRecord | undefined, dflt: Answer) => Answer;
  /** The checker's verdict for a question, by round; a round it does not list judges everything supported. */
  checks?: Array<(q: Question, a: Answer) => { verdict: "supported" | "partial" | "unsupported"; note: string; searches?: CheckVerdict["searches"] } | undefined>;
  /** The corrected answers after the checker's first round. */
  revise?: (q: Question, sym: SymbolDef | undefined, prev: Answer) => Answer;
  /** Round 1 on a later head (design §9.3): only the questions this returns true for are asked; the others are carried, so the replies and canned checks leave them out. */
  asked?: (q: Question) => boolean;
  /** N1 is carried too: no N1 job runs, so the checker has no verdict for it. */
  necessityCarried?: boolean;
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
  /** The mode the Report stage ran in; the questions run in large mode too when it was large or the new symbols pass the limit. */
  reportMode?: ReviewMode;
}

const emptyProposal = { kind: "none" as const, splits: [], testFile: "", testName: "", cases: [], assertion: "" };

const stemOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1).replace(/\.go$/, "");
const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

function defaultAnswer(q: Question, sym: SymbolDef | undefined, record: MetricsRecord | undefined, hasDeps: boolean): Answer {
  const searches = (names: string[]): Answer["searches"] => names.map((pattern) => ({ pattern, tree: "base", paths: [], ignoreCase: false as const, hits: 0 }));
  const base: Answer = { question: q.id, answer: "", status: "answered", none_found: false, reusable: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { ...emptyProposal } };
  const name = sym?.name ?? "the function";
  switch (q.type) {
    case "purpose":
      return { ...base, answer: "Nothing the pull request's text, its commits or the code comments state why this change is made.", status: "needs author", searches: searches(["retention|purpose|why", "the pull request's title, body and commit messages (read)", "comments next to the change (read)"]) };
    case REUSE_TYPE:
      return { ...base, answer: `No existing equivalent of ${name} was found (no declaration with its name or variants, its signature or its key tokens), no internal package or declared library provides what it does${hasDeps ? "; no dependency's source is available here to read, so that is only what the searches and the manifests show" : ""}, and no logic elsewhere in the base or in the pull request duplicates it.`, none_found: true, status: hasDeps ? "partially answered" : "answered", searches: searches([`\\b${name}\\b`, `func .*\\(.*\\).*`, "key body tokens"]) };
    case "missing-test": {
      const path = sym?.path ?? record?.path ?? "pkg/x/x.go";
      return { ...base, answer: `No test references ${name} or its callers: every *_test.go in the base and in the pull request was searched. A test would live beside it, in ${dirOf(path)}.`, status: "needs author", searches: [{ pattern: `\\b${name}\\b`, tree: "base", paths: ["*_test.go"], ignoreCase: false, hits: 0 }, { pattern: `\\b${name}\\b`, tree: "base", paths: [], ignoreCase: false, hits: 0 }], proposal: { ...emptyProposal, kind: "test", testFile: `${dirOf(path)}/${stemOf(path)}_test.go`, testName: `Test${upper(name)}`, cases: [{ input: "a typical value", branches: "the main path" }, { input: "an empty or invalid value", branches: "the error path" }] } };
    }
    case "split-function": {
      const start = sym?.startLine ?? record?.startLine ?? 1;
      const end = sym?.endLine ?? record?.endLine ?? 2;
      const mid = Math.floor((start + end) / 2);
      return {
        ...base,
        answer: `${name} mixes tokenizing with range checking; they split cleanly.`,
        metrics: record !== undefined ? [{ function: record.function, path: record.path, name: "complexity", value: record.complexity }, { function: record.function, path: record.path, name: "nesting", value: record.nesting }] : [],
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
      return { ...base, answer: `No test exercises the branches of ${name}; ${record?.coverage?.source === "measured" ? `the sandbox measured ${record.coverage.covered} of ${record.coverage.total} statements covered` : "its coverage was not measured"}.`, status: "needs author", metrics: record !== undefined ? [{ function: record.function, path: record.path, name: "complexity", value: record.complexity }, ...(record.coverage?.source === "measured" && record.crap !== undefined ? [{ function: record.function, path: record.path, name: "crap" as const, value: record.crap }] : [])] : [], searches: [{ pattern: `\\b${name}\\b`, tree: "base", paths: ["*_test.go"], ignoreCase: false, hits: 0 }], proposal: { ...emptyProposal, kind: "test", testFile: `${dirOf(sym?.path ?? record?.path ?? "pkg/x/x.go")}/${stemOf(sym?.path ?? record?.path ?? "x.go")}_test.go`, testName: `Test${upper(name)}Branches`, cases: [{ input: "each unit", branches: "the unit path" }] } };
    default:
      return { ...base, answer: "Answered from the code.", searches: searches(["other"]) };
  }
}

/** The necessity answer a scenario gives unless it says otherwise: the problem is possible on the base, the design says nothing about it, nothing existing does it. */
export function defaultNecessity(title: string): Necessity {
  return {
    conclusion: "necessary",
    rationale: "The failure the pull request describes is possible on the base, the change keeps the system's design, and no existing way does it.",
    problem: {
      claim: `The pull request is titled "${title}": it describes a behavior the base lacks.`,
      quotes: [{ source: "title", quote: title }],
      trace: [{ step: "The base code path the change touches has no handling for the case the title names", path: "pkg/timestamp/duration.go", tree: "base", start: 30, end: 42, quote: "func ParseDuration" }],
      canHappen: "yes",
      explanation: "Following the callers of the touched code in the base, nothing else handles the case, so it can happen.",
    },
    reproduction: "not attempted: no reproduction mechanism in this version",
    principles: [],
    design: { statements: [], changed: [], effect: "unrelated", explanation: "No design or architecture statement concerns this behavior.", searches: [{ pattern: "design|architecture|write path", tree: "base", paths: [], ignoreCase: false, hits: 4 }] },
    alternatives: { exists: false, explanation: "No caller or other layer already handles it, and the change belongs where it is made.", citations: [] },
    searches: [{ pattern: "callers of the touched code", tree: "base", paths: [], ignoreCase: false, hits: 3 }],
  };
}

const formatHits = (hits: readonly Hit[]): string => hits.map((h) => `${h.path}:${h.line}:${h.text}`).join("\n");

const SECTION_ORDER = ["name", "variants", "signature", "tokens", "tests"] as const;

export interface QaScenario {
  results: Record<string, RehearsalReply[]>;
  commands: Record<string, RehearsalCommandResult>;
  /** The symbols and the questions after N1 the graph will derive, for the scenario's own assertions. */
  questions: Question[];
  /** N1's results by round, and whether the other questions are asked after it. */
  necessity: { first: Necessity; final: Necessity; asked: boolean };
  symbols: SymbolDef[];
}

/** The replies and canned command outputs of one scenario's Questions and Answers stages. */
export function qaScenario(i: QaInput): QaScenario {
  const { spec, profile } = i;
  const packs = effectivePacks(profile);
  const base = spec.base ?? {};
  // The report as the Report stage wrote it: every item, with the ids the Q&A refers to.
  const items = numbered(i.good, { sections: i.sections }).map(({ id, section, item }) => ({ id, section, text: item.text, cites: item.cites, facts: item.facts }));
  const view: ReportView = { items, changes: i.good.whatsNew.map((w, n) => ({ id: highLevelId(n + 1), section: "highlevel", text: w.text, cites: w.cites, facts: [] })), records: [...i.records] };
  // Symbols, as the graph derives them from the head files, the patches and the base's declarations.
  const baseByPath = new Map<string, Set<string>>();
  const parsed = parseBaseDefinitions(base.defs ?? "", packs[0]!);
  for (const [p, names] of parsed.byPath) baseByPath.set(p, names);
  const raw = sourceFiles(i.files, packs, profile.metrics.generated).flatMap(({ file, pack }) => changedSymbols({ path: file.path, previousPath: file.previousPath, status: file.status, parsed: file.parsed, text: i.headFiles[file.path] }, pack, file.status === "added" ? undefined : baseByPath.get(file.path)));
  const symbols: SymbolDef[] = raw.map((s, n) => ({ ...s, id: `S${n + 1}`, ...(itemOfSymbol(s, items) !== undefined ? { item: itemOfSymbol(s, items)! } : {}) }));
  const groundwork = { symbols, testMap: new Map(symbols.map((s) => [s.id, mapTests(s, symbols, i.files, packs)] as const)) } as unknown as Groundwork;
  // The questioner.
  const pinned = pinnedTexts({ title: i.pull.title, body: i.pull.body }, i.pull.commits.map((message) => ({ message })));
  const large = isLarge(questionsMode(i.reportMode ?? STANDARD, symbols.filter((s) => s.change === "new").length, profile.limits));
  const purposes: QuestionerOutput["purposes"] = (spec.purposes ?? []).flatMap((p) => {
    const item = changeItems(view, large).find((x) => (p.item !== undefined ? x.id === p.item : x.section === p.section));
    return item === undefined ? [] : [{ item: item.id, source: p.source, quote: p.quote }];
  });
  const stated = statedPurposes({ purposes, questions: [] }, view, pinned, large).stated;
  const required = requiredQuestions({ view, groundwork, large }, stated);
  const asked = required.filter((r) => !(spec.omit ?? []).includes(r.type));
  const questionerOutput: QuestionerOutput = { purposes, questions: asked.map((r) => ({ key: r.key, type: r.type, item: r.item, symbol: r.symbol ?? "", text: r.text })) };
  // A later head asks only some of them (design §9.3); the others are carried from an earlier head and have no reply here.
  const questions = finalQuestions(required, questionerOutput, groundwork, large).filter((q) => spec.asked?.(q) ?? true);
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
  // N1 comes first: its answerer, its checker (one correction when the first round is unsupported), and its verification.
  const nspec = spec.necessity ?? {};
  const principled = nspec.principles !== undefined && profile.questions.principles !== undefined ? parsePrinciples(nspec.principles.text).principles.filter((p) => applies(p, i.files)) : [];
  const verdictOf = (id: string): PrincipleVerdict["verdict"] => nspec.principles?.verdicts?.[id] ?? "preserves";
  const principleVerdicts: PrincipleVerdict[] = principled.map((p) => ({ id: p.id, verdict: verdictOf(p.id), explanation: `The change ${verdictOf(p.id) === "breaks" ? "violates" : "keeps"} the principle ${p.id}.`, citations: verdictOf(p.id) === "not-applicable" ? [] : [{ path: "pkg/timestamp/duration.go", tree: "base", start: 30, end: 42, quote: "func ParseDuration" }] }));
  const dflt = { ...defaultNecessity(i.pull.title), principles: principleVerdicts };
  const n1First = nspec.result !== undefined ? nspec.result(dflt) : dflt;
  const nChecks = nspec.checks ?? [];
  const n1Revised = nChecks[0]?.verdict === "unsupported" && nspec.revise !== undefined ? nspec.revise(n1First) : undefined;
  const n1Final = n1Revised ?? n1First;
  const n1Verdicts = (round: number, n: Necessity): CheckVerdict[] => {
    const given = nChecks[round];
    const principles = n.principles.map((p) => ({ id: p.id, verdict: nspec.principles?.checks?.[p.id] ?? "supported", note: nspec.principles?.checks?.[p.id] === undefined ? "" : `the checker's note on ${p.id}` }));
    return [{ question: necessityQuestion().id, verdict: given?.verdict ?? "supported", note: given?.note ?? "", principles, searches: [{ pattern: "design|flush|write path|acknowledg", tree: "base", paths: [], ignoreCase: false, hits: 4 }, { pattern: n.problem.trace[0]?.path ?? "path", tree: "base", paths: [], ignoreCase: false, hits: 1 }] }];
  };
  const n1Rounds = [n1Verdicts(0, n1First), ...(n1Revised !== undefined ? [n1Verdicts(1, n1Revised)] : [])];
  const lastN1 = nChecks[n1Rounds.length - 1];
  const n1Supported = (lastN1?.verdict ?? "supported") === "supported";
  const n1Asked = !(effectiveConclusion({ necessity: n1Final, check: { verdict: lastN1?.verdict === "unsupported" ? "downgraded" : (lastN1?.verdict ?? "supported") } }) === "unnecessary" && n1Supported);
  const verdicts = (round: number, set: readonly Answer[]): CheckVerdict[] =>
    questions.map((q, n) => {
      const a = set[n]!;
      const given = spec.checks?.[round]?.(q, a);
      const searches = given?.searches ?? (needsOwnSearch(q, a) ? [{ pattern: `\\b${symOf(q)?.name ?? "x"}\\b|test`, tree: "base", paths: [], ignoreCase: false as const, hits: 0 }] : []);
      return { question: q.id, verdict: given?.verdict ?? "supported", note: given?.note ?? "", searches, principles: [] };
    });
  const rounds = revised.length > 0 || (spec.checks?.length ?? 0) > 1 ? [verdicts(0, first), verdicts(1, final)] : [verdicts(0, final)];
  // Large mode (design §7.6): the answerer takes the questions in batches, each checked in a fresh session; a scenario revises none.
  const batches = large ? answerBatches(questions) : [];
  const idsOf = (b: readonly Question[]): Set<string> => new Set(b.map((q) => q.id));
  const batchAnswers = (b: readonly Question[]): Answer[] => first.filter((a) => idsOf(b).has(a.question));
  const batchRounds = batches.map((b) => verdicts(0, final).filter((v) => idsOf(b).has(v.question)));
  const results: QaScenario["results"] = {
    "necessity-v1": [{ output: n1First }],
    ...(n1Revised !== undefined ? { "necessity-revision-v1": [{ output: n1Revised }] } : {}),
    "questions-v1": [{ output: questionerOutput }],
    "answers-v1": large ? batches.map((b) => ({ output: { answers: batchAnswers(b) } })) : [{ output: { answers: first } }],
    // N1's rounds come first, then the other answers' (a run that skips them never asks for those).
    "answer-check-v1": [...(spec.necessityCarried === true ? [] : n1Rounds), ...(large ? batchRounds : rounds)].map((verdict) => ({ output: { verdicts: verdict } })),
    ...(revised.length > 0 ? { "answers-revision-v1": [{ output: { answers: revised } }] } : {}),
  };
  // Canned outputs of the read-only commands, by id, for the commands the graph will run.
  const commands: QaScenario["commands"] = {};
  const ok = (stdout: string): RehearsalCommandResult => ({ exitCode: 0, stdout });
  // The base tree export the answerer, N1 and their checkers read (design §7.3): the exported directory exists, and says its tree.
  commands["base-export"] = ok(`base=${i.mergeBase}\ntree=${"b".repeat(40)}\nfiles=${(base.dirs ?? ["pkg", "banyand"]).length}\nwithheld=0\n# end\n`);
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
  // A canned verification: citations resolve, and a re-run search measures what the scenario's agent reported (a scenario
  // that wants a mismatch says so in the search's own hits and its fixture's).
  const canned = (item: VerifyItem): void => {
    if (item.kind === "search") {
      const hits = item.search?.hits ?? 0;
      commands[item.command.id] = ok(`count ${hits} ${hits > 0 ? 1 : 0}\nchecked 1\n`);
      return;
    }
    const lines = item.entries.map((_, n) => (item.kind === "cite" ? `${n + 1} ok` : "")).filter((l) => l !== "");
    commands[item.command.id] = ok(`${lines.join("\n")}${lines.length > 0 ? "\n" : ""}checked ${item.entries.length}\n`);
  };
  if (large) {
    batches.forEach((b, k) => {
      for (const item of verificationPlan(batchAnswers(b), { ...ctx, questions: b }, i.mergeBase, batchCitePrefix(k))) canned(item);
      commands[batchRecordId(k)] = ok("written\n");
    });
  } else {
    for (const set of [first, revised, final]) for (const item of verificationPlan(set, ctx, i.mergeBase)) canned(item);
  }
  const nctx = { questions: [necessityQuestion()], groundwork, view, packs };
  for (const n of [n1First, ...(n1Revised !== undefined ? [n1Revised] : [])]) for (const item of verificationPlan([necessityAnswer(n)], nctx, i.mergeBase, COMMAND.citeNecessity)) canned(item);
  // The searches the checker reports are re-run too.
  if (large) {
    batchRounds.forEach((round, k) => {
      for (const item of searchItems(round.flatMap((v) => v.searches.map((search) => ({ question: v.question, search }))), i.mergeBase, batchCitePrefix(k), [], true)) canned(item);
    });
  } else {
    for (const round of rounds) for (const item of searchItems(round.flatMap((v) => v.searches.map((search) => ({ question: v.question, search }))), i.mergeBase, COMMAND.cite, [], true)) canned(item);
  }
  for (const round of n1Rounds) for (const item of searchItems(round.flatMap((v) => v.searches.map((search) => ({ question: v.question, search }))), i.mergeBase, COMMAND.citeNecessity, [], true)) canned(item);
  commands["necessity-write"] = ok("written\n");
  if (nspec.principles !== undefined) commands["principles-read"] = ok(`commit ${i.mergeBase}\npresent\n${nspec.principles.text}`);
  commands["qa-write"] = ok("written\n");
  commands["ledger-write"] = ok(`advanced ${"b".repeat(40)}\n`);
  return { results, commands, questions, symbols, necessity: { first: n1First, final: n1Final, asked: n1Asked } };
}
