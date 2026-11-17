// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The deterministic groundwork (design §7.2), read from the evidence alone:
 * what it still needs (a file to observe, read-only commands to run), why it
 * failed, or the finished groundwork the questioner and the answerer both
 * receive. Every command is a fixed-argv read of the pinned base commit; no
 * repository code runs. The phases depend on each other (the symbols come from
 * the head files and the base's declarations, the searches from the symbols,
 * the candidate bodies from the searches), so each call plans the next phase.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { baseExportCommand, parseBaseExport, type BaseExport } from "./basetree.js";
import { commandRuns, describeCommand, latestFile, outputTail, reportText, succeeded, type CommandRun } from "./evidence.js";
import { buildInventory, manifestsCommand, parseManifests, parseSites, parseSources, parseTree, siteCommands, sourceCommands, treeCommand, declaredDependencies, type Inventory } from "./inventory.js";
import { observable } from "./measurements.js";
import { effectivePacks, type FullPack } from "./packs.js";
import { bodyFromSnippet, candidateCommand, parseSearch, planFor, searchCommand, tokenPopulation, type SearchSection } from "./queries.js";
import type { Profile } from "./profile.js";
import { jaccard, shingles, similarity, tokensOf } from "./similarity.js";
import { isDeleted, type PullFile } from "./snapshot.js";
import { changedSymbols, isTestFile, maskCode, packOf, parseBaseDefinitions, type FileSymbol, type SymbolDef } from "./symbols.js";
import { hasGeneratedHeader, matchesGeneratedGlob } from "./metrics/generated.js";
import { mapTests, testMapContext, type TestEvidence } from "./testmap.js";

/** Commands one job runs (the command executor's bound). */
export const COMMANDS_PER_JOB = 16;
const BASE_DEFS_FILES = 8;
const MAX_CANDIDATES_PER_SYMBOL = 6;
const MAX_CANDIDATES = 40;

export interface Candidate {
  symbol: string;
  path: string;
  line: number;
  /** The declaration's own text, cut by brace matching, when it could be. */
  body?: string;
  similarity: number;
  /** The queries that found it. */
  via: string[];
}

export interface Groundwork {
  base: string;
  symbols: SymbolDef[];
  searches: Map<string, SearchSection[]>;
  candidates: Candidate[];
  /** New symbols of the pull request that look alike, over the profile's similarity. */
  prSimilar: Array<{ a: string; b: string; score: number }>;
  inventory: Inventory;
  testMap: Map<string, TestEvidence[]>;
  notes: string[];
  /** The base commit's files exported into the review directory (design §7.3), when the export is recorded whole. */
  baseTree?: BaseExport;
}

export type GroundworkState =
  | { state: "observe"; paths: string[] }
  | { state: "run"; commands: EnvironmentCommand[]; why: string }
  | { state: "failed"; problems: string[]; refs: string[] }
  | { state: "incompatible"; problem: string }
  | { state: "ready"; groundwork: Groundwork; refs: string[] };

export interface GroundworkOptions {
  evidence: readonly EvidenceRecord[];
  files: readonly PullFile[];
  profile: Pick<Profile, "symbols" | "metrics" | "questions" | "limits">;
  base: string;
  /** Whether a failed command may be run again (the operator resumed since). */
  retryable?: (run: CommandRun) => boolean;
}

const runOf = (evidence: readonly EvidenceRecord[], id: string): CommandRun | undefined => commandRuns(evidence, id).at(-1);

const textOf = (evidence: readonly EvidenceRecord[], id: string): { text: string; truncated: boolean } => {
  const run = runOf(evidence, id);
  return run === undefined ? { text: "", truncated: false } : reportText(run);
};

/** The changed source files the groundwork reads: in a pack, not a test, not generated, with changed lines and a path the controller can observe. */
export function sourceFiles(files: readonly PullFile[], packs: readonly FullPack[], generated: readonly string[]): Array<{ file: PullFile; pack: FullPack }> {
  const out: Array<{ file: PullFile; pack: FullPack }> = [];
  for (const file of files) {
    if (isDeleted(file) || file.parsed.lines.length === 0) continue;
    const pack = packOf(packs, file.path);
    if (pack === undefined || isTestFile(pack, file.path) || !observable(file.path) || matchesGeneratedGlob(generated, file.path)) continue;
    out.push({ file, pack });
  }
  return out;
}

export function groundworkState(o: GroundworkOptions): GroundworkState {
  const retryable = o.retryable ?? (() => false);
  const packs = effectivePacks(o.profile);
  const sources = sourceFiles(o.files, packs, o.profile.metrics.generated);
  const unread = sources.filter(({ file }) => latestFile(o.evidence, file.path) === undefined).map(({ file }) => file.path);
  if (unread.length > 0) return { state: "observe", paths: unread };

  const failures = (list: CommandRun[]): GroundworkState => ({ state: "failed", problems: list.map((r) => `${describeCommand(r.command)}: ${outputTail(r.command, 300)}`).slice(0, 5), refs: list.map((r) => r.record.ref) });
  const step = (commands: EnvironmentCommand[], why: string): GroundworkState | undefined => {
    const { missing, failed } = pendingCommands(o.evidence, commands, retryable);
    if (failed.length > 0) return failures(failed);
    if (missing.length > 0) return { state: "run", commands: missing.slice(0, COMMANDS_PER_JOB), why: `${why} (${missing.length} command${missing.length === 1 ? "" : "s"} left)` };
    return undefined;
  };
  const refs: string[] = [];

  // Phase 1: what the base file declared, the base's directories and its dependency manifests.
  const baseDefsCmds: EnvironmentCommand[] = [];
  const batchesByPack = new Map<string, Array<{ path: string; basePath: string }>>();
  for (const { file, pack } of sources) {
    if (file.status === "added") continue;
    const list = batchesByPack.get(pack.language) ?? [];
    list.push({ path: file.path, basePath: file.previousPath ?? file.path });
    batchesByPack.set(pack.language, list);
  }
  const batchPlan: Array<{ id: string; language: string; files: Array<{ path: string; basePath: string }> }> = [];
  for (const [language, list] of batchesByPack) {
    for (let i = 0; i < list.length; i += BASE_DEFS_FILES) batchPlan.push({ id: `${COMMAND.baseDefs}-${batchPlan.length + 1}`, language, files: list.slice(i, i + BASE_DEFS_FILES) });
  }
  for (const b of batchPlan) {
    const pack = packs.find((p) => p.language === b.language)!;
    baseDefsCmds.push(baseDefsCommand(b.id, o.base, pack, b.files.map((f) => f.basePath)));
  }
  const phase1 = [baseExportCommand(o.base), ...baseDefsCmds, treeCommand(o.base), manifestsCommand(o.base)];
  const s1 = step(phase1, "read the base commit's declarations, directories and dependency manifests");
  if (s1 !== undefined) return s1;
  for (const c of phase1) refs.push(runOf(o.evidence, c.id)!.record.ref);

  // The symbols the pull request adds or modifies.
  const baseByPath = new Map<string, Set<string>>();
  const notes: string[] = [];
  for (const b of batchPlan) {
    const pack = packs.find((p) => p.language === b.language)!;
    const out = textOf(o.evidence, `${b.id}`);
    if (out.truncated || !/^# end$/m.test(out.text)) {
      notes.push(`the base's declarations of ${b.files.map((f) => f.basePath).join(", ")} did not fit the report whole, so new and modified symbols there were told apart from the patch alone`);
      continue;
    }
    const parsed = parseBaseDefinitions(out.text, pack);
    for (const f of b.files) baseByPath.set(f.path, parsed.byPath.get(f.basePath) ?? new Set());
  }
  const raw: Array<FileSymbol & { change: "new" | "modified" }> = [];
  for (const { file, pack } of sources) {
    const text = latestFile(o.evidence, file.path);
    if (text === undefined || text.missing) continue;
    if ((pack.language === "go" || pack.language === "typescript") && hasGeneratedHeader(pack.language, text.bytes)) continue;
    raw.push(...changedSymbols({ path: file.path, previousPath: file.previousPath, status: file.status, parsed: file.parsed, text: text.bytes }, pack, file.status === "added" ? undefined : baseByPath.get(file.path)));
  }
  const symbols: SymbolDef[] = raw.map((s, i) => ({ ...s, id: `S${i + 1}` }));
  const newCount = symbols.filter((s) => s.change === "new").length;
  // Past `maxNewSymbols` the questions run in large mode (design §7.6); only the hard cap refuses the pull request.
  if (newCount > o.profile.limits.hardMaxNewSymbols) return { state: "incompatible", problem: `the pull request adds ${newCount} symbols, past the profile's limits.hardMaxNewSymbols of ${o.profile.limits.hardMaxNewSymbols}` };

  // Phase 2: the whole-repository searches, and the inventory's call sites and local sources.
  const manifests = parseManifests(textOf(o.evidence, COMMAND.baseManifests).text);
  const deps = declaredDependencies(manifests.files);
  const population = tokenPopulation(symbols.filter((s) => s.change === "new").map((s) => s.body));
  const testSpecs = [...new Set(packs.flatMap((p) => p.testFiles))];
  const searchCmds = symbols.flatMap((s) => {
    const plan = planFor(s, population);
    if (s.change === "modified" && testSpecs.length === 0) return [];
    return [searchCommand(s.id, plan, o.base, o.profile.questions.maxCandidates, o.profile.questions.excludeRoots, packOf(packs, s.path)?.testFiles ?? testSpecs)];
  });
  const phase2 = [...searchCmds, ...siteCommands(o.base, deps), ...sourceCommands(deps)];
  const s2 = step(phase2, "search the whole base commit for equivalents, and find each dependency's use and local source");
  if (s2 !== undefined) return s2;
  for (const c of phase2) refs.push(runOf(o.evidence, c.id)!.record.ref);
  const searches = new Map<string, SearchSection[]>();
  for (const s of symbols) {
    const out = textOf(o.evidence, `${COMMAND.search}-${s.id}`);
    if (out.truncated) notes.push(`the searches for ${s.qualified} did not fit the report whole`);
    searches.set(s.id, parseSearch(out.text));
  }

  // Phase 3: the bodies of the candidate definitions the searches found.
  const wanted = candidatePlan(symbols, searches, packs);
  const phase3 = wanted.map((c, i) => candidateCommand(i + 1, o.base, c.path, c.line));
  const s3 = step(phase3, "read the candidate definitions the searches found");
  if (s3 !== undefined) return s3;
  for (const c of phase3) refs.push(runOf(o.evidence, c.id)!.record.ref);

  const bodies = wanted.map((c, i) => bodyFromSnippet(textOf(o.evidence, `${COMMAND.candidate}-${i + 1}`).text));
  const byLocation = new Map(wanted.map((c, i) => [`${c.path}:${c.line}`, bodies[i]] as const));
  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  const candidates: Candidate[] = [];
  for (const w of wanted) {
    const body = byLocation.get(`${w.path}:${w.line}`);
    for (const owner of w.owners) {
      const sym = symbolById.get(owner.symbol)!;
      candidates.push({ symbol: owner.symbol, path: w.path, line: w.line, ...(body !== undefined ? { body } : {}), similarity: body !== undefined ? similarity(sym.body, body) : 0, via: owner.via });
    }
  }
  const newOnes = symbols.filter((s) => s.change === "new");
  const sets = new Map(newOnes.map((s) => [s.id, shingles(tokensOf(s.body))] as const));
  const prSimilar: Groundwork["prSimilar"] = [];
  for (let i = 0; i < newOnes.length; i += 1) {
    for (let j = i + 1; j < newOnes.length; j += 1) {
      const score = Math.round(jaccard(sets.get(newOnes[i]!.id)!, sets.get(newOnes[j]!.id)!) * 100) / 100;
      if (score >= o.profile.questions.similarity) prSimilar.push({ a: newOnes[i]!.id, b: newOnes[j]!.id, score });
    }
  }
  const sourceRuns = [...phase2].filter((c) => c.id.startsWith(`${COMMAND.depSource}-`));
  const siteRuns = [...phase2].filter((c) => c.id.startsWith(`${COMMAND.depSites}-`));
  const sites = new Map<string, string>();
  for (const c of siteRuns) for (const [k, v] of parseSites(textOf(o.evidence, c.id).text)) sites.set(k, v);
  const inventory = buildInventory({
    manifests: manifests.files,
    tree: parseTree(textOf(o.evidence, COMMAND.baseTree).text),
    sites,
    sources: sourceRuns.flatMap((c) => parseSources(textOf(o.evidence, c.id).text)),
    manifestsComplete: manifests.complete,
    manifestCuts: manifests.cuts,
  });
  const testCtx = testMapContext(symbols, o.files, packs);
  const testMap = new Map(symbols.map((s) => [s.id, mapTests(s, symbols, o.files, packs, testCtx)] as const));
  const baseTree = parseBaseExport(textOf(o.evidence, COMMAND.baseExport).text);
  if (baseTree === undefined || baseTree.base !== o.base) notes.push("the base commit's files could not be exported to a directory, so base facts come from `git show` and `git grep` over the base commit only");
  return { state: "ready", groundwork: { base: o.base, symbols, searches, candidates, prSimilar, inventory, testMap, notes, ...(baseTree !== undefined && baseTree.base === o.base ? { baseTree } : {}) }, refs };
}

/** `pending`, with the failing runs listed by themselves. */
function pendingCommands(evidence: readonly EvidenceRecord[], commands: readonly EnvironmentCommand[], retryable: (r: CommandRun) => boolean): { missing: EnvironmentCommand[]; failed: CommandRun[] } {
  const missing: EnvironmentCommand[] = [];
  const failed: CommandRun[] = [];
  for (const c of commands) {
    const run = runOf(evidence, c.id);
    if (run === undefined || (!succeeded(run.command) && retryable(run))) missing.push(c);
    else if (!succeeded(run.command)) failed.push(run);
  }
  return { missing, failed };
}

/** The declarations of some base files, from the base commit: the lines the pack's `grep` selects, cut off with a marker. */
export function baseDefsCommand(id: string, base: string, pack: FullPack, paths: readonly string[]): EnvironmentCommand {
  return {
    id,
    argv: [
      "sh",
      "-c",
      String.raw`set -u; base="$1"; ere="$2"; shift 2
{ out=$(git -c core.hooksPath=/dev/null grep -n -I --no-color -E -e "$ere" "$base" -- "$@" 2>/dev/null); rc=$?
if [ "$rc" -gt 1 ]; then echo "git grep failed (exit $rc)" >&2; exit "$rc"; fi
printf '%s\n' "$out" | sed 's/^[0-9a-f]\{40\}://' | head -n 3000; echo '# end'; } > "$GRAPHLOOM_REPORT_FILE"`,
      id,
      base,
      pack.grep,
      ...paths,
    ],
  };
}

interface WantedCandidate {
  path: string;
  line: number;
  owners: Array<{ symbol: string; via: string[] }>;
}

/** The definitions among the hits that the searches found, bounded per symbol and in all, each fetched once. */
export function candidatePlan(symbols: readonly SymbolDef[], searches: ReadonlyMap<string, SearchSection[]>, packs: readonly FullPack[]): WantedCandidate[] {
  const order: SearchSection["kind"][] = ["name", "signature", "tokens", "variants"];
  const byLocation = new Map<string, WantedCandidate>();
  const rx = new Map(packs.map((p) => [p.language, p.definitions.map((d) => new RegExp(d))] as const));
  for (const s of symbols) {
    if (s.change !== "new") continue;
    const sections = searches.get(s.id) ?? [];
    let taken = 0;
    const seen = new Set<string>();
    for (const kind of order) {
      for (const hit of sections.find((x) => x.kind === kind)?.lines ?? []) {
        const key = `${hit.path}:${hit.line}`;
        const definition = packOf(packs, hit.path) !== undefined && (rx.get(packOf(packs, hit.path)!.language) ?? []).some((re) => re.test(maskCode(hit.text)));
        if (!definition) continue;
        const existing = byLocation.get(key);
        if (seen.has(key)) {
          existing?.owners.find((w) => w.symbol === s.id)?.via.push(kind);
          continue;
        }
        if (taken >= MAX_CANDIDATES_PER_SYMBOL || (existing === undefined && byLocation.size >= MAX_CANDIDATES)) continue;
        seen.add(key);
        taken += 1;
        if (existing === undefined) byLocation.set(key, { path: hit.path, line: hit.line, owners: [{ symbol: s.id, via: [kind] }] });
        else existing.owners.push({ symbol: s.id, via: [kind] });
      }
    }
  }
  return [...byLocation.values()];
}
