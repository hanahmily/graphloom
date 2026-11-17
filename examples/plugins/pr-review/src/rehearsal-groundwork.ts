// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The groundwork part of the rehearsal scenarios (design §16; design-pr-review-split §4.3): a small base repository fixture the
 * groundwork's read-only commands read, the canned outputs of those commands, and the groundwork the leads are computed from. The
 * symbols, the searches the graph will run, the candidates and the test map are derived with the plugin's own functions, so a
 * scenario cannot drift from the graph.
 */
import type { RehearsalCommandResult } from "@graphloom/sdk";
import { candidatePlan, sourceFiles, type Candidate, type Groundwork } from "./kit/groundwork.js";
import { declaredDependencies, parseManifests, siteCommands } from "./kit/inventory.js";
import { effectivePacks } from "./kit/packs.js";
import type { Profile } from "./kit/profile.js";
import { bodyFromSnippet, parseSearch, type SearchSection } from "./kit/queries.js";
import { jaccard, shingles, similarity, tokensOf } from "./kit/similarity.js";
import type { PullFile } from "./kit/snapshot.js";
import { changedSymbols, parseBaseDefinitions, type SymbolDef } from "./kit/symbols.js";
import { mapTests } from "./kit/testmap.js";

export interface Hit {
  path: string;
  line: number;
  text: string;
}

/** The small base repository the groundwork reads. */
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

const formatHits = (hits: readonly Hit[]): string => hits.map((h) => `${h.path}:${h.line}:${h.text}`).join("\n");
const SECTION_ORDER = ["name", "variants", "signature", "tokens", "tests"] as const;

export interface GroundworkStubs {
  commands: Record<string, RehearsalCommandResult>;
  groundwork: Pick<Groundwork, "symbols" | "testMap" | "candidates" | "prSimilar">;
}

/** The canned outputs of the groundwork's commands for a pull request, and the groundwork the graph will derive from them. */
export function groundworkStubs(i: { profile: Profile; files: readonly PullFile[]; headFiles: Readonly<Record<string, string>>; mergeBase: string; base: BaseFixture }): GroundworkStubs {
  const { profile, base } = i;
  const packs = effectivePacks(profile);
  const baseByPath = new Map<string, Set<string>>();
  for (const [p, names] of parseBaseDefinitions(base.defs ?? "", packs[0]!).byPath) baseByPath.set(p, names);
  const raw = sourceFiles(i.files, packs, profile.metrics.generated).flatMap(({ file, pack }) => changedSymbols({ path: file.path, previousPath: file.previousPath, status: file.status, parsed: file.parsed, text: i.headFiles[file.path] }, pack, file.status === "added" ? undefined : baseByPath.get(file.path)));
  const symbols: SymbolDef[] = raw.map((s, n) => ({ ...s, id: `S${n + 1}` }));
  const testMap = new Map(symbols.map((s) => [s.id, mapTests(s, symbols, i.files, packs)] as const));
  const ok = (stdout: string): RehearsalCommandResult => ({ exitCode: 0, stdout });
  const commands: Record<string, RehearsalCommandResult> = {};
  const manifest = base.manifests ?? { "go.mod": DEFAULT_GO_MOD };
  const deps = declaredDependencies(parseManifests(Object.entries(manifest).map(([p, t]) => `===== graphloom manifest ${p}\n${t}`).join("\n") + "\n# end\n").files);
  // The base tree export the reviewers read (design §7.3): the exported directory exists, and says its tree.
  commands["base-export"] = ok(`base=${i.mergeBase}\ntree=${"b".repeat(40)}\nfiles=${(base.dirs ?? ["pkg", "banyand"]).length}\nwithheld=0\n# end\n`);
  commands["base-defs-1"] = ok(`${base.defs ?? ""}\n# end\n`);
  commands["base-tree"] = ok(`${(base.dirs ?? ["pkg", "banyand"]).join("\n")}\n# end\n`);
  commands["base-manifests"] = ok(`${Object.entries(manifest).map(([p, t]) => `===== graphloom manifest ${p}\n${t}`).join("\n")}\n# end\n`);
  // The searches run only up to `limits.maxNewSymbols` new symbols (design-pr-review-split §4.3).
  const searched = symbols.filter((s) => s.change === "new").length <= profile.limits.maxNewSymbols;
  const searches = new Map<string, SearchSection[]>();
  for (const s of searched ? symbols : []) {
    const mine = base.hits?.[s.name] ?? {};
    const text = SECTION_ORDER.filter((k) => mine[k] !== undefined).map((k) => `== ${k} hits=${mine[k]!.length}\n${formatHits(mine[k]!)}`).join("\n");
    commands[`search-${s.id}`] = ok(`${text}\n`);
    searches.set(s.id, parseSearch(text));
  }
  const wanted = searched ? candidatePlan(symbols, searches, packs) : [];
  const candidates: Candidate[] = [];
  wanted.forEach((c, n) => {
    const snippet = base.snippets?.[`${c.path}:${c.line}`] ?? "";
    commands[`cand-${n + 1}`] = ok(`${snippet}\n`);
    const body = bodyFromSnippet(`${snippet}\n`);
    for (const owner of c.owners) {
      const sym = symbols.find((s) => s.id === owner.symbol)!;
      candidates.push({ symbol: owner.symbol, path: c.path, line: c.line, ...(body !== undefined ? { body } : {}), similarity: body !== undefined ? similarity(sym.body, body) : 0, via: owner.via });
    }
  });
  const fresh = searched ? symbols.filter((s) => s.change === "new") : [];
  const sets = new Map(fresh.map((s) => [s.id, shingles(tokensOf(s.body))] as const));
  const prSimilar: Groundwork["prSimilar"] = [];
  for (let a = 0; a < fresh.length; a += 1) {
    for (let b = a + 1; b < fresh.length; b += 1) {
      const score = Math.round(jaccard(sets.get(fresh[a]!.id)!, sets.get(fresh[b]!.id)!) * 100) / 100;
      if (score >= profile.questions.similarity) prSimilar.push({ a: fresh[a]!.id, b: fresh[b]!.id, score });
    }
  }
  for (const c of siteCommands(i.mergeBase, deps)) {
    const names = c.argv.slice(6);
    commands[c.id] = ok(`${names.map((n) => `${n}\t${base.sites?.[n] ?? "-"}`).join("\n")}\n# end\n`);
  }
  if (deps.some((d) => d.ecosystem === "go")) commands["dep-source-go-1"] = ok("# end\n");
  return { commands, groundwork: { symbols, testMap, candidates, prSimilar } };
}
