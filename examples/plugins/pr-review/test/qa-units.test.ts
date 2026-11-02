// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { evidencePull } from "../src/analysis.js";
import { answerProblems, functionOf, readAnswerCheck, verificationPlan, type Answer } from "../src/answers.js";
import { GO_PACK, TS_PACK } from "../src/packs.js";
import { nameVariants, nameWords, planFor, rareTokens, signaturePattern, signatureTypes, tokenPopulation, excludeSpecs } from "../src/queries.js";
import { afterNecessity, answerContext, qaContext, questionSet, questionerFlow, type QaContext } from "../src/qaflow.js";
import { finalQuestions, quoteInPinned, requiredQuestions, statedPurposes, type QuestionerOutput } from "../src/questions.js";
import { jaccard, shingles, similarity, tokensOf } from "../src/similarity.js";
import { extractSymbols, type SymbolDef } from "../src/symbols.js";
import { mapTests, testMapContext } from "../src/testmap.js";
import { parsePatch } from "../src/patch.js";
import type { PullFile } from "../src/snapshot.js";
import { profileOf, simulate } from "./support.js";

describe("the query builder (design 7.2 item 2)", () => {
  it("splits a name into words and gives its camelCase and snake_case variants, never the name itself", () => {
    expect(nameWords("ParseTTL")).toEqual(["Parse", "TTL"]);
    expect(nameWords("parse_ttl_value")).toEqual(["parse", "ttl", "value"]);
    const v = nameVariants("ParseTTL");
    expect(v).toEqual(expect.arrayContaining(["parseTtl", "ParseTtl", "parse_ttl", "Parse_TTL", "parse-ttl"]));
    expect(v).not.toContain("ParseTTL");
    expect(nameVariants("flush")).toEqual(["Flush"]);
    expect(nameVariants("parse_ttl")).toEqual(expect.arrayContaining(["parseTtl", "ParseTtl"]));
  });

  it("normalizes a Go signature to its parameter and result types: grouped names, receivers, generics, unnamed", () => {
    const go = (signature: string) => signatureTypes({ language: "go", kind: "func", signature });
    expect(go("func ParseTTL(s string, max int) (int, error)")).toEqual({ params: ["string", "int"], results: ["int", "error"] });
    expect(go("func Dist(a, b float64) float64")).toEqual({ params: ["float64", "float64"], results: ["float64"] });
    expect(go("func (g *Group) Rename(n string)")).toEqual({ params: ["string"], results: [] });
    expect(go("func Map[K comparable, V any](m map[K]V) []K")).toEqual({ params: ["map[K]V"], results: ["[]K"] });
    expect(go("func Pair(string, int) error")).toEqual({ params: ["string", "int"], results: ["error"] });
    expect(go("func Run(ctx context.Context, opts ...Option) (err error)")).toEqual({ params: ["context.Context", "...Option"], results: ["error"] });
    expect(signatureTypes({ language: "go", kind: "type", signature: "type X struct" })).toBeUndefined();
  });

  it("normalizes a TypeScript signature the same way", () => {
    const ts = (signature: string) => signatureTypes({ language: "typescript", kind: "function", signature });
    expect(ts("function parse(input: string, max?: number): Promise<Result>")).toEqual({ params: ["string", "number"], results: ["Promise<Result>"] });
    expect(ts("export function add(a: number, b = 2): number")).toEqual({ params: ["number"], results: ["number"] });
  });

  it("builds an extended regular expression with the types in order and its special characters escaped", () => {
    expect(signaturePattern("go", { params: ["string", "int"], results: ["int", "error"] })).toBe("^func .*\\(.*string.*int.*\\).*int.*error");
    expect(signaturePattern("go", { params: ["map[K]V"], results: ["[]K"] })).toBe("^func .*\\(.*map\\[K\\]V.*\\).*\\[\\]K");
    expect(signaturePattern("go", { params: [], results: [] })).toBeUndefined();
  });

  it("takes the rarest identifiers and literals of the body: least common in the pull request's new bodies, then longest", () => {
    const a = 'func A() { for i := range xs { visit(i, "retention window") } }';
    const b = "func B() { for i := range ys { visit(i) } }";
    const pop = tokenPopulation([a, b]);
    expect(rareTokens(a, pop, 3)).toEqual(["retention window", "visit"]);
    expect(rareTokens("func Long() { alphaBetaGamma(); other(); alphaBetaGamma() }", new Map(), 2)).toEqual(["alphaBetaGamma", "other"]);
    // Keywords and short names are never tokens.
    expect(rareTokens("func f() { return err }", new Map())).toEqual([]);
  });

  it("plans name, variants, signature and body tokens for a new symbol, and only the base tests for a modified one", () => {
    const syms = extractSymbols("pkg/schema/ttl.go", 'package schema\n\nfunc ParseTTL(s string, max int) (int, error) {\n\treturn parseUnit("7d"), nil\n}\n', GO_PACK);
    const created = planFor({ ...syms[0]!, change: "new" }, new Map());
    expect(created.name).toBe("ParseTTL");
    expect(created.variants.length).toBeGreaterThan(0);
    expect(created.signature).toBe("^func .*\\(.*string.*int.*\\).*int.*error");
    expect(created.tokens).toContain("parseUnit");
    const modified = planFor({ ...syms[0]!, change: "modified" }, new Map());
    expect(modified).toMatchObject({ variants: [], signature: undefined, tokens: [], tests: true });
  });

  it("leaves out only the profile's excludeRoots: globs as glob pathspecs, paths as prefixes", () => {
    expect(excludeSpecs([])).toEqual(["."]);
    expect(excludeSpecs(["**/*.pb.go", "third_party"])).toEqual([".", ":(exclude,glob)**/*.pb.go", ":(exclude)third_party"]);
  });
});

describe("the similarity scorer: token shingles of 5, Jaccard (design 7.2 item 2)", () => {
  const a = "func Parse(s string) (int, error) {\n\tn := 0\n\tfor _, c := range s {\n\t\tn = n*10 + int(c-'0')\n\t}\n\treturn n, nil\n}";

  it("scores identical bodies 1 and disjoint ones 0", () => {
    expect(similarity(a, a)).toBe(1);
    expect(similarity(a, "package x\n")).toBe(0);
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });

  it("ignores comments and the text of strings, and is symmetric", () => {
    const b = a.replace("n := 0", "n := 0 // start at zero\n\t_ = \"a string\"");
    const c = a.replace("n := 0", "n := 0\n\t_ = \"another string\"");
    expect(similarity(a, `/* doc */\n${a}`)).toBe(1);
    expect(similarity(b, c)).toBe(1);
    expect(similarity(a, b)).toBe(similarity(b, a));
  });

  it("falls with the edits: one changed statement lowers it, a rewritten body lowers it more", () => {
    const edited = a.replace("return n, nil", "return n + 1, nil");
    const other = "func Parse(s string) (int, error) {\n\tparts := strings.Split(s, \",\")\n\treturn len(parts), nil\n}";
    expect(similarity(a, edited)).toBeGreaterThan(0.5);
    expect(similarity(a, edited)).toBeLessThan(1);
    expect(similarity(a, other)).toBeLessThan(similarity(a, edited));
  });

  it("uses 5-token shingles, and one shingle for a body shorter than that", () => {
    expect(shingles(tokensOf("a b c d e f".split(" ").join(" ")), 5).size).toBe(2);
    expect(shingles(["x", "y"]).size).toBe(1);
    expect(shingles([]).size).toBe(0);
  });
});

const goFile = (path: string, status: string, patch: string): PullFile => ({ path, status, previousPath: null, additions: 0, deletions: 0, patch, patchOmitted: false, parsed: parsePatch(patch) });
const added = (path: string, lines: string[]): PullFile => goFile(path, "added", [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"));
const sym = (over: Partial<SymbolDef>): SymbolDef => ({ id: "S1", path: "pkg/schema/ttl.go", language: "go", scope: "schema", dir: "pkg/schema", kind: "func", name: "ParseTTL", qualified: "schema.ParseTTL", exported: true, startLine: 3, endLine: 9, signature: "", body: "func ParseTTL() {}", change: "new", ...over });

describe("the test map (design 7.2 item 4)", () => {
  const packs = [GO_PACK, TS_PACK];

  it("finds a test file the pull request adds in the symbol's directory, as a find by itself", () => {
    const evidence = mapTests(sym({}), [sym({})], [added("pkg/schema/other_test.go", ["package schema", "func TestOther(t *testing.T) {}"])], packs);
    expect(evidence.map((e) => e.kind)).toEqual(["test-file"]);
  });

  it("finds added test lines that name the symbol, and ones that name its exported caller in the diff", () => {
    const caller = sym({ id: "S2", name: "Validate", qualified: "schema.Validate", body: "func Validate() { ParseTTL() }" });
    const test = added("pkg/schema/ttl_test.go", ["package schema", "func TestValidate(t *testing.T) {", "\tValidate()", "\tParseTTL()", "}"]);
    const byName = mapTests(sym({}), [sym({}), caller], [test], packs);
    expect(byName.filter((e) => e.kind === "reference").map((e) => e.line)).toEqual([4]);
    const viaCaller = mapTests(sym({}), [sym({}), caller], [added("test/validate_test.go", ["package x", "func TestV(t *testing.T) { Validate() }"])], packs);
    expect(viaCaller.map((e) => e.kind)).toEqual(["caller-reference"]);
  });

  it("finds a table-driven case name that holds every word of the symbol's name", () => {
    const test = added("elsewhere/table_test.go", ["package e", 'var cases = []struct{ name string }{{name: "parse ttl days"}, {name: "parse only"}}']);
    const found = mapTests(sym({}), [sym({})], [test], packs);
    expect(found.map((e) => [e.kind, e.text])).toEqual([["case-name", "parse ttl days"]]);
  });

  it("finds nothing when no test file of the pull request names the symbol, sits near it or has a case for it; base tests are context only", () => {
    const test = added("elsewhere/other_test.go", ["package e", "func TestOther(t *testing.T) { Unrelated() }"]);
    expect(mapTests(sym({}), [sym({})], [test], packs)).toEqual([]);
    expect(mapTests(sym({}), [sym({})], [goFile("pkg/schema/ttl.go", "added", "@@ -0,0 +1 @@\n+func ParseTTL() {}")], packs)).toEqual([]);
  });

  it("maps a TypeScript test named for the file, and not a name that only contains the symbol's", () => {
    const ts = sym({ path: "src/parser.ts", dir: "src", language: "typescript", name: "parse", qualified: "src/parser.parse" });
    const test = added("test/parser.test.ts", ["it('parse a number', () => { parse('1'); })"]);
    expect(mapTests(ts, [ts], [test], packs).map((e) => e.kind)).toEqual(expect.arrayContaining(["reference"]));
    const sub = added("test/other.test.ts", ["it('x', () => { parseAll(); })"]);
    expect(mapTests(ts, [ts], [sub], packs).filter((e) => e.kind === "reference")).toEqual([]);
  });

  /** A large pull request: `n` exported Go functions that call each other, and test files that name them. */
  function large(n: number): { symbols: SymbolDef[]; files: PullFile[] } {
    const symbols = Array.from({ length: n }, (_, i) =>
      sym({ id: `S${i + 1}`, name: `Handle${i}`, qualified: `schema.Handle${i}`, dir: `pkg/d${i % 7}`, path: `pkg/d${i % 7}/f${i}.go`, body: `func Handle${i}() {\n\t// Handle${(i + 5) % n} in a comment\n\tHandle${(i + 1) % n}()\n\ts := "handle ${i} done"\n}` }),
    );
    const files = Array.from({ length: 12 }, (_, f) =>
      added(`pkg/d${f % 7}/t${f}_test.go`, [
        "package t",
        ...Array.from({ length: Math.ceil((n * 6) / 12) }, (_, k) => {
          const i = (f * 31 + k) % n;
          return k % 3 === 0 ? `\tHandle${i}()` : k % 3 === 1 ? `\t{name: "handle ${i} twice"},` : `\tother${k}() // Handle${i}`;
        }),
      ]),
    );
    return { symbols, files };
  }

  it("gives the same evidence with a shared context as without, in the same order", () => {
    const { symbols, files } = large(60);
    const packs = [GO_PACK, TS_PACK];
    const ctx = testMapContext(symbols, files, packs);
    let finds = 0;
    for (const s of symbols) {
      const alone = mapTests(s, symbols, files, packs);
      expect(mapTests(s, symbols, files, packs, ctx)).toEqual(alone);
      finds += alone.length;
    }
    expect(finds).toBeGreaterThan(symbols.length);
    // A name with characters outside the word set takes the pattern path and still agrees.
    const odd = sym({ id: "S99", name: "a.b", qualified: "schema.a.b" });
    const oddFiles = [added("pkg/schema/x_test.go", ["\tx := a.b", "\ty := axb"])];
    expect(mapTests(odd, [odd, ...symbols], oddFiles, packs, testMapContext([odd, ...symbols], oddFiles, packs))).toEqual(mapTests(odd, [odd, ...symbols], oddFiles, packs));
  });

  it("maps a pull request of hundreds of symbols and thousands of test lines in seconds, not minutes", () => {
    const { symbols, files } = large(800);
    const packs = [GO_PACK, TS_PACK];
    const ctx = testMapContext(symbols, files, packs);
    const started = performance.now();
    for (const s of symbols) mapTests(s, symbols, files, packs, ctx);
    // Linear in symbols plus lines: well under a second here; the per-symbol rescan this guards against took tens of seconds.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

/** The real context of a scenario: its groundwork, report and measurement records, built from the evidence. */
function contextOf(name: string, config: Record<string, unknown> = {}): { ctx: QaContext; evidence: ReturnType<typeof simulate>["evidence"] } {
  const sim = simulate({ scenarioName: name, config });
  const profile = profileOf(config);
  const pr = evidencePull(sim.evidence, profile)!;
  const c = qaContext(sim.evidence, profile, pr);
  if (c.state !== "ready") throw new Error(`context is ${c.state}`);
  return { ctx: c.ctx, evidence: sim.evidence };
}

describe("the required questions (design 7.1)", () => {
  const complex = contextOf("complex-function");

  it("asks purpose per change item, the three of a new symbol, missing-test, split-function and complexity-coverage", () => {
    const types = requiredQuestions({ view: complex.ctx.view, groundwork: complex.ctx.groundwork }, new Map()).map((q) => q.type);
    expect(types).toEqual(["purpose", "existing-equivalent", "reuse-library", "common-logic", "missing-test", "split-function", "complexity-coverage"]);
  });

  it("asks split-function at complexity 10 and nesting 4, not below", () => {
    const base = { view: complex.ctx.view, groundwork: complex.ctx.groundwork };
    const ask = (change: { complexity: number; nesting: number }) =>
      requiredQuestions({ ...base, view: { ...base.view, records: base.view.records.map((r) => ({ ...r, ...change })) } }, new Map()).map((q) => q.type).filter((t) => t === "split-function" || t === "complexity-coverage");
    expect(ask({ complexity: 9, nesting: 3 })).toEqual([]);
    expect(ask({ complexity: 10, nesting: 3 })).toEqual(["split-function", "complexity-coverage"]);
    expect(ask({ complexity: 9, nesting: 4 })).toEqual(["split-function"]);
  });

  it("asks complexity-coverage for measured coverage at CRAP 30 or more, and for unknown coverage only at complexity 10 or more (an upper-bound CRAP alone asks nothing)", () => {
    const base = { view: complex.ctx.view, groundwork: complex.ctx.groundwork };
    const ask = (r: object) => requiredQuestions({ ...base, view: { ...base.view, records: base.view.records.map((x) => ({ ...x, ...r })) } }, new Map()).map((q) => q.type).includes("complexity-coverage");
    expect(ask({ complexity: 6, nesting: 1, coverage: { source: "unknown", reason: "x" } })).toBe(false);
    expect(ask({ complexity: 10, nesting: 1, coverage: { source: "unknown", reason: "x" } })).toBe(true);
    expect(ask({ complexity: 6, nesting: 1, coverage: { source: "measured", covered: 1, total: 10 } })).toBe(true);
    expect(ask({ complexity: 6, nesting: 1, coverage: { source: "measured", covered: 10, total: 10 } })).toBe(false);
  });

  it("asks a weak-test question for each surviving mutant, and none when no mutation result exists", () => {
    const base = { view: complex.ctx.view, groundwork: complex.ctx.groundwork };
    const withMutation = { ...base.view, records: base.view.records.map((r) => ({ ...r, mutation: { survivors: [{ line: 27, from: "n > max", to: "n <= max" }] } })) };
    const weak = requiredQuestions({ ...base, view: withMutation }, new Map()).filter((q) => q.type === "weak-test");
    expect(weak.map((q) => q.text)).toEqual(["Which assertion would fail when `n > max` at pkg/schema/ttl.go:27 becomes `n <= max`?"]);
    expect(requiredQuestions(base, new Map()).some((q) => q.type === "weak-test")).toBe(false);
  });

  it("asks no complexity-coverage for a function of complexity 6 (the crap-upper-bound scenario) and only a missing-test", () => {
    const sync = contextOf("crap-upper-bound");
    const asked = requiredQuestions({ view: sync.ctx.view, groundwork: sync.ctx.groundwork }, new Map(statedPurposes({ purposes: [{ item: "R1", source: "title", quote: "Reset when forced" }], questions: [] }, sync.ctx.view, sync.ctx.pinned).stated));
    expect(asked.map((q) => q.type)).toEqual(["missing-test"]);
    expect(sync.ctx.view.records[0]).toMatchObject({ complexity: 6, crap: 42 });
  });

  it("does not ask missing-test for a symbol the test map covers", () => {
    const covered = new Map(complex.ctx.groundwork.symbols.map((s) => [s.id, [{ kind: "reference" as const, path: "pkg/schema/ttl_test.go", line: 3, text: "ParseTTL()" }]] as [string, Array<{ kind: "reference"; path: string; line: number; text: string }>]));
    const types = requiredQuestions({ view: complex.ctx.view, groundwork: { ...complex.ctx.groundwork, testMap: covered } }, new Map()).map((q) => q.type);
    expect(types).not.toContain("missing-test");
  });
});

describe("a stated purpose (design 7.2 item 5)", () => {
  const pinned = [
    { source: "title" as const, text: "Add retention flag" },
    { source: "body" as const, text: "Adds a --retention-days flag so\n  retention can be   set per group." },
    { source: "commit" as const, text: "Wire the flag" },
  ];

  it("matches a quote after whitespace is collapsed, in the source it names", () => {
    expect(quoteInPinned("so retention can be set per group", "body", pinned)).toBe(true);
    expect(quoteInPinned("so retention can be set per group", "title", pinned)).toBe(false);
    expect(quoteInPinned("so retention can be set per team", "body", pinned)).toBe(false);
  });

  it("refuses a quote too short to support anything", () => {
    expect(quoteInPinned("per group", "body", pinned)).toBe(false);
  });

  it("records a purpose as stated only with a matching quote, else the purpose question is asked", () => {
    const ctx = contextOf("needs-author-purpose").ctx;
    const items = ctx.view.items.filter((i) => ["config", "background"].includes(i.section));
    const ok = { item: items[0]!.id, source: "body" as const, quote: "so retention can be set per group" };
    const forged = { item: items[1]!.id, source: "body" as const, quote: "the maintainers asked for this" };
    const out = statedPurposes({ purposes: [ok, forged], questions: [] }, ctx.view, [{ source: "body", text: "so retention can be set per group" }]);
    expect([...out.stated.keys()]).toEqual([ok.item]);
    expect(out.rejected).toEqual([`${forged.item}: the quote is not in the pull request's body`]);
    const asked = requiredQuestions({ view: ctx.view, groundwork: ctx.groundwork }, out.stated).filter((q) => q.type === "purpose").map((q) => q.item);
    expect(asked).toEqual([forged.item]);
  });
});

describe("the questioner asks and cannot drop (design 7.1)", () => {
  const { ctx } = contextOf("missing-test");
  const required = requiredQuestions({ view: ctx.view, groundwork: ctx.groundwork }, new Map());

  it("adds a required question the questioner left out, with the plugin's wording, and numbers all of them Q1…", () => {
    const output: QuestionerOutput = { purposes: [], questions: required.filter((r) => r.type !== "missing-test").map((r) => ({ key: r.key, type: r.type, item: r.item, symbol: r.symbol ?? "", text: `phrased ${r.type}` })) };
    const qs = finalQuestions(required, output, ctx.groundwork);
    expect(qs.map((q) => q.id)).toEqual(qs.map((_, i) => `Q${i + 1}`));
    const missing = qs.find((q) => q.type === "missing-test")!;
    expect(missing.text).toMatch(/^Which test covers quota\.Limit/);
    expect(qs.find((q) => q.type === "existing-equivalent")!.text).toBe("phrased existing-equivalent");
  });

  it("keeps a question the questioner adds, after the required ones, and reads an addition that repeats a required one as its phrasing", () => {
    const first = required[0]!;
    const output: QuestionerOutput = {
      purposes: [],
      questions: [
        { key: "", type: "other", item: first.item, symbol: "", text: "Is the clamp at zero the intended behaviour for negative requests?" },
        { key: "", type: first.type, item: first.item, symbol: first.symbol ?? "", text: "duplicate" },
      ],
    };
    const qs = finalQuestions(required, output, ctx.groundwork);
    expect(qs).toHaveLength(required.length + 1);
    expect(qs.at(-1)).toMatchObject({ type: "other", origin: "added", text: "Is the clamp at zero the intended behaviour for negative requests?" });
    expect(qs.find((q) => q.text === "duplicate")).toBeUndefined();
  });

  it("corrects a questioner that names an unknown item or key, and gives up to the supervisor after two corrections", () => {
    const bad = { purposes: [], questions: [{ key: "nope:1", type: "other", item: "R99", symbol: "S9", text: "" }] };
    const run = (n: number) => ({ ref: `q${n}`, kind: "other", resultSchema: "questions-v1", payload: { producer: { operationId: `o${n}`, stageId: "questions", purpose: "diagnostic", readOnly: true, kind: "agent", executorId: "graphloom.coding-agent/run" }, codingAgent: { status: "completed", output: bad } } }) as never;
    const flow = (n: number) => questionerFlow(Array.from({ length: n }, (_, i) => run(i)), ctx);
    expect(flow(0)).toMatchObject({ state: "questioner", kind: "first" });
    const one = flow(1);
    expect(one).toMatchObject({ state: "questioner", kind: "correction" });
    expect((one as { feedback: string[] }).feedback.join("|")).toMatch(/R99.*not a report item id.*S9.*not a symbol id.*text is empty.*names no required question/);
    expect(flow(2)).toMatchObject({ state: "questioner", kind: "correction" });
    expect(flow(3)).toMatchObject({ state: "supervise" });
  });
});

describe("the answer rules (design 7.3 checks)", () => {
  const { ctx } = contextOf("complex-function");
  const set = questionSet(ctx, undefined);
  const actx = answerContext(ctx, set.questions);
  const q = (type: string) => set.questions.find((x) => x.type === type)!;
  const answer = (type: string, over: Partial<Answer> = {}): Answer => ({
    question: q(type).id,
    answer: "answer",
    status: "answered",
    none_found: false,
    citations: [],
    searches: [{ pattern: "p", tree: "base", paths: [], ignoreCase: false, hits: 0 }],
    inventory: [],
    metrics: [],
    proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" },
    ...over,
  });
  const fn = ctx.groundwork.symbols[0]!;
  const split = (splits: Array<{ name: string; startLine: number; endLine: number }>): Answer => answer("split-function", { proposal: { kind: "split", splits: splits.map((s) => ({ ...s, responsibility: "one thing" })), testFile: "", testName: "", cases: [], assertion: "" } });
  const problems = (a: Answer): string[] => answerProblems([a], actx, new Set([a.question]));

  it("accepts a split inside the function with names new to the package, citing numbers that equal the record", () => {
    const ok = split([{ name: "tokenizeTTL", startLine: fn.startLine + 1, endLine: fn.startLine + 10 }, { name: "checkTTLRange", startLine: fn.startLine + 11, endLine: fn.endLine - 1 }]);
    expect(problems({ ...ok, metrics: [{ function: "schema.ParseTTL", path: "pkg/schema/ttl.go", name: "complexity", value: 12 }, { function: "schema.ParseTTL", path: "pkg/schema/ttl.go", name: "crap", value: 156 }] })).toEqual([]);
  });

  it("rejects a split with a range outside the function, a name already in the package, one function, or an empty responsibility", () => {
    expect(problems(split([{ name: "a1", startLine: fn.startLine - 2, endLine: fn.startLine + 3 }, { name: "b1", startLine: fn.startLine + 4, endLine: fn.endLine + 5 }])).join("|")).toMatch(/lines .* are not inside ParseTTL.*lines .* are not inside ParseTTL/);
    expect(problems(split([{ name: "ParseTTL", startLine: fn.startLine + 1, endLine: fn.startLine + 5 }, { name: "ok1", startLine: fn.startLine + 6, endLine: fn.startLine + 9 }])).join("|")).toMatch(/already exists in the package pkg\/schema/);
    expect(problems(split([{ name: "only", startLine: fn.startLine + 1, endLine: fn.endLine - 1 }])).join("|")).toMatch(/at least two functions/);
    const none = split([{ name: "a1", startLine: fn.startLine + 1, endLine: fn.startLine + 5 }, { name: "b1", startLine: fn.startLine + 6, endLine: fn.startLine + 9 }]);
    none.proposal.splits[0]!.responsibility = " ";
    expect(problems(none).join("|")).toMatch(/no single responsibility/);
  });

  it("rejects a cited number that is not the measurement record's, and a function no record has", () => {
    const base = split([{ name: "a1", startLine: fn.startLine + 1, endLine: fn.startLine + 5 }, { name: "b1", startLine: fn.startLine + 6, endLine: fn.startLine + 9 }]);
    expect(problems({ ...base, metrics: [{ function: "schema.ParseTTL", path: "pkg/schema/ttl.go", name: "complexity", value: 11 }] })).toEqual(["Q6: schema.ParseTTL complexity is 12 in its measurement record, not 11"]);
    expect(problems({ ...base, metrics: [{ function: "schema.ParseTTL", path: "pkg/other/ttl.go", name: "complexity", value: 12 }] })).toEqual([`${base.question}: the metric names "schema.ParseTTL" in "pkg/other/ttl.go", which no measurement record has`]);
    expect(problems({ ...base, metrics: [{ function: "schema.Nope", path: "pkg/schema/ttl.go", name: "nesting", value: 1 }] })).toEqual([`${base.question}: the metric names "schema.Nope" in "pkg/schema/ttl.go", which no measurement record has`]);
  });

  it("makes split-function answered with a split proposal, and a missing-test answer cite a test file or stay needs author with an outline", () => {
    expect(problems(answer("split-function", { status: "needs author" })).join("|")).toMatch(/is "answered" with a split proposal.*carries a split proposal/);
    expect(problems(answer("missing-test", { citations: [{ path: "pkg/schema/ttl.go", tree: "base", start: 1, end: 2, quote: "" }] })).join("|")).toMatch(/cites the covering test/);
    expect(problems(answer("missing-test", { status: "needs author" })).join("|")).toMatch(/carries a test outline/);
    const outline = { kind: "test" as const, splits: [], testFile: "pkg/schema/ttl_test.go", testName: "TestParseTTL", cases: [{ input: "7d", branches: "unit path" }], assertion: "" };
    expect(problems(answer("missing-test", { status: "needs author", proposal: outline }))).toEqual([]);
    expect(problems(answer("missing-test", { status: "needs author", proposal: { ...outline, testFile: "pkg/schema/ttl.go" } })).join("|")).toMatch(/not a test file path/);
    expect(problems(answer("missing-test", { status: "answered", citations: [{ path: "pkg/schema/ttl_test.go", tree: "head", start: 3, end: 9, quote: "ParseTTL" }] }))).toEqual([]);
  });

  it("makes a none-found answer list its whole-repository searches, and a library answer partial while a dependency's source is unavailable", () => {
    const one = answer("existing-equivalent", { none_found: true });
    expect(problems(one).join("|")).toMatch(/3 or more over the whole base tree.*not 1/);
    const three = answer("existing-equivalent", { none_found: true, searches: [1, 2, 3].map((n) => ({ pattern: `p${n}`, tree: "base", paths: [], ignoreCase: false as const, hits: 0 })) });
    expect(problems(three)).toEqual([]);
    expect(problems(answer("reuse-library", { none_found: true })).join("|")).toMatch(/source available here, so a "none found" library answer is "partially answered"/);
    expect(problems(answer("reuse-library", { none_found: true, status: "partially answered" }))).toEqual([]);
  });

  it("makes a library answer partial while the inventory is incomplete, even when every source is available", () => {
    const cut = { ...actx, groundwork: { ...actx.groundwork, inventory: { dependencies: [], packages: [], truncated: ["dependency manifests cut: 3 more manifests"] } } };
    const a = answer("reuse-library", { none_found: true });
    expect(answerProblems([a], cut, new Set([a.question])).join("|")).toMatch(/the dependency inventory is incomplete, so a "none found" library answer is "partially answered"/);
  });

  it("makes an answer name an equivalent it claims, with a citation, and an answer carry evidence", () => {
    expect(problems(answer("existing-equivalent", { citations: [], searches: [] })).join("|")).toMatch(/no evidence/);
    expect(problems(answer("existing-equivalent", { searches: [{ pattern: "p", tree: "base", paths: [], ignoreCase: false, hits: 2 }] })).join("|")).toMatch(/cites it/);
  });

  it("rejects a citation outside the tree it names: a parent path, an absolute base path, a dependency path outside the mounted directories, and a backwards range", () => {
    const cite = (c: Partial<Answer["citations"][number]>) => problems(answer("existing-equivalent", { citations: [{ path: "a.go", tree: "base", start: 1, end: 2, quote: "", ...c }] })).join("|");
    expect(cite({ path: "../secret" })).toMatch(/repository-relative/);
    expect(cite({ path: "/etc/passwd" })).toMatch(/repository-relative/);
    expect(cite({ tree: "dependency", path: "/etc/passwd" })).toMatch(/inside one of the inventory's source directories \(none is available here\)/);
    expect(cite({ start: 5, end: 2 })).toMatch(/not a range/);
  });

  it("asks for every question exactly once, and nothing else", () => {
    const all = set.questions.map((x) => ({ ...answer(x.type), question: x.id }));
    expect(answerProblems(all.slice(1), actx)).toContain(`${set.questions[0]!.id} has no answer`);
    expect(answerProblems([...all, all[0]!], actx)).toContain(`${all[0]!.question} is answered twice`);
    expect(answerProblems([{ ...all[0]!, question: "Q99" }, ...all.slice(1)], actx).join("|")).toMatch(/"Q99" is not a question id.*has no answer/);
  });
});

describe("a closure question keeps its file", () => {
  it("resolves to the record of its own file when two files measure a function of the same name", () => {
    const { ctx } = contextOf("complex-function");
    const record = ctx.view.records[0]!;
    const other = { ...record, path: "pkg/other/init.go", function: "p.glob.func1", startLine: 40, endLine: 50 };
    const mine = { ...record, path: "pkg/schema/ttl.go", function: "p.glob.func1", startLine: 6, endLine: 30 };
    const view = { ...ctx.view, items: [...ctx.view.items, { id: "R9", section: "features", text: "x", cites: [{ path: "pkg/other/init.go", side: "head" as const, start: 0, end: 0, symbol: "" }], facts: [] }], records: [other, mine] };
    const q = { id: "Q1", type: "split-function" as const, item: "R1", fn: "p.glob.func1", fnPath: "pkg/schema/ttl.go", text: "?", origin: "required" as const, key: "k" };
    expect(functionOf(q, { groundwork: { ...ctx.groundwork, symbols: [] }, view })).toMatchObject({ path: "pkg/schema/ttl.go", start: 6, end: 30 });
    const required = requiredQuestions({ view: { ...view, records: [{ ...other, complexity: 12, nesting: 4 }, { ...mine, complexity: 12, nesting: 4 }] }, groundwork: { ...ctx.groundwork, symbols: [] } }, new Map());
    expect(required.filter((r) => r.type === "split-function").map((r) => [r.fn, r.fnPath])).toEqual([["p.glob.func1", "pkg/schema/ttl.go"], ["p.glob.func1", "pkg/other/init.go"]]);
  });
});

describe("the verification commands fit the command executor's input contract", () => {
  it("carries at most 14 citations a command: 61 arguments, within the executor's 64, however many are cited", () => {
    const { ctx } = contextOf("complex-function");
    const actx = answerContext(ctx, questionSet(ctx, undefined).questions);
    const cites = Array.from({ length: 40 }, (_, i) => ({ path: `pkg/p${i}.go`, tree: "base" as const, start: 1, end: 2, quote: "" }));
    const a = { question: "Q1", answer: "x", status: "answered", none_found: false, citations: cites, searches: [], inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" } } as Answer;
    const plan = verificationPlan([a], actx, "b".repeat(40));
    expect(plan.map((p) => p.command.argv.length)).toEqual([61, 61, 53]);
    expect(plan.flatMap((p) => p.entries)).toHaveLength(40);
    for (const p of plan) for (const arg of p.command.argv) expect(arg.length).toBeLessThanOrEqual(4096);
  });
});

describe("reading the answer checker", () => {
  const { ctx } = contextOf("missing-test");
  // The answers after N1, whose check has its own flow (necessity.test.ts).
  const set = { questions: afterNecessity(questionSet(ctx, undefined)) };
  const answers = new Map(set.questions.map((x) => [x.id, { question: x.id, none_found: x.type === "existing-equivalent" } as Answer] as const));

  it("leaves a question unchecked when it has no verdict, or a none-found or test answer has no searches of the checker's own", () => {
    const verdicts = set.questions.map((x) => ({ question: x.id, verdict: "supported", note: "", searches: [], principles: [], parts: [] }));
    const reading = readAnswerCheck({ verdicts }, set.questions, answers) as { unchecked: string[] };
    const needing = set.questions.filter((x) => x.type === "existing-equivalent" || x.type === "missing-test").map((x) => x.id);
    expect(reading.unchecked).toEqual(needing);
    const less = readAnswerCheck({ verdicts: verdicts.slice(1) }, set.questions, answers) as { unchecked: string[] };
    expect(less.unchecked).toContain(set.questions[0]!.id);
  });

  it("takes the weaker of two verdicts for one question", () => {
    const id = set.questions.find((x) => x.type === "common-logic")!.id;
    const verdicts = [{ question: id, verdict: "supported", note: "", searches: [], principles: [], parts: [] }, { question: id, verdict: "unsupported", note: "found one", searches: [], principles: [], parts: [] }];
    const reading = readAnswerCheck({ verdicts }, set.questions, answers) as { unsupported: Map<string, string> };
    expect(reading.unsupported.get(id)).toBe("found one");
  });

  it("refuses a result the contract refuses", () => {
    expect(readAnswerCheck({ verdicts: [{ question: "Q1", verdict: "maybe", note: "", searches: [], principles: [], parts: [] }] }, set.questions, answers)).toMatchObject({ problems: [expect.stringMatching(/verdict must be one of/)] });
  });
});
