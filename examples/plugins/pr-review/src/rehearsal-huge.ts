// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Fixtures of a pull request at the scale of apache/skywalking-banyandb#1445 (207 files, about 27,000 added lines, about
 * 800 new symbols in 24 areas), for the test that every agent assignment fits the executor's bound (`fit.ts`). The files
 * are Go sources of trivial functions, so the symbols, the measurements and the searches are all derived by the plugin.
 */
import { BATCH_FILES } from "./measurements.js";
import { trivialDoc } from "./rehearsal-large.js";

export const HUGE_AREAS = 24;
export const HUGE_FILES_PER_AREA = 9;
export const HUGE_FUNCS_PER_FILE = 4;

/** The limits a task sets so that these files make 24 areas: the files are over the profile's own file limit already. */
export const HUGE_LIMITS = { areaMaxBytes: 9_000, areaMinBytes: 4_000 } as const;

const pad = (n: number): string => String(n).padStart(2, "0");

export const hugePath = (area: number, file: number): string => `pkg/area${pad(area)}/mod${file}.go`;
const hugePackage = (area: number): string => `area${pad(area)}`;
const hugePrefix = (area: number, file: number): string => `Area${pad(area)}Mod${file}Fn`;

/** One file: exported functions each with a comment, a few lines of body and a blank line. */
export function hugeSource(area: number, file: number): string {
  const prefix = hugePrefix(area, file);
  const funcs = Array.from({ length: HUGE_FUNCS_PER_FILE }, (_, i) =>
    [`// ${prefix}${i + 1} adds ${i + 1} to x for module ${file} of area ${area}.`, `func ${prefix}${i + 1}(x int) int {`, `\ty := x + ${i + 1}`, `\treturn y * ${file}`, "}", ""].join("\n"),
  );
  return [`package ${hugePackage(area)}`, "", ...funcs].join("\n");
}

/** Every file of the pull request, in order, by path. */
export function hugeSources(): Array<{ path: string; area: number; text: string }> {
  return Array.from({ length: HUGE_AREAS * HUGE_FILES_PER_AREA }, (_, k) => {
    const area = Math.floor(k / HUGE_FILES_PER_AREA) + 1;
    const file = (k % HUGE_FILES_PER_AREA) + 1;
    return { path: hugePath(area, file), area, text: hugeSource(area, file) };
  });
}

export const hugeHeadFiles = (): Record<string, string> => Object.fromEntries(hugeSources().map((s) => [s.path, s.text]));

/** The names of the exported functions the pull request adds, in order. */
export const hugeSymbolNames = (): string[] => hugeSources().flatMap((s) => Array.from({ length: HUGE_FUNCS_PER_FILE }, (_, i) => `${hugePrefix(s.area, Number(/mod(\d+)\.go$/.exec(s.path)![1]))}${i + 1}`));

/** What the static tool prints for each batch of files (`static-go-<k>`), and for all of them together. */
export function hugeStaticDocs(): { batches: Record<string, ReturnType<typeof trivialDoc>>; all: { schema: string; tool: string; records: unknown[]; files: unknown[]; skipped: unknown[] } } {
  const sources = hugeSources();
  const batches: Record<string, ReturnType<typeof trivialDoc>> = {};
  for (let i = 0; i < sources.length; i += BATCH_FILES) {
    const docs = sources.slice(i, i + BATCH_FILES).map((s) => trivialDoc(s.path, hugePackage(s.area), s.text));
    batches[`static-go-${i / BATCH_FILES + 1}`] = { schema: docs[0]!.schema, tool: docs[0]!.tool, records: docs.flatMap((d) => d.records), files: docs.flatMap((d) => d.files), skipped: [] };
  }
  const all = Object.values(batches);
  return { batches, all: { schema: all[0]!.schema, tool: all[0]!.tool, records: all.flatMap((d) => d.records), files: all.flatMap((d) => d.files), skipped: [] } };
}

/** `git diff -U0 -w` as the awk filter prints it: the file and hunk headers of every added file. */
export const hugeDiff = (): string => hugeSources().map((s) => `+++ b/${s.path}\n@@ -0,0 +1,${s.text.replace(/\n$/, "").split("\n").length} @@\n`).join("");

/** A pull request body near the longest GitHub allows and thirty long commit messages: the text every assignment shows. */
export const HUGE_TITLE = "feat(huge): add a family of rules, one module at a time, across twenty-four areas";
export const HUGE_BODY = Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1} of the description explains why module ${i % 9} of area ${i % 24} adds its rules, what they replace and how a reader can check them.`).join("\n\n");
export const HUGE_COMMITS = Array.from({ length: 40 }, (_, i) => `feat(area${pad((i % 24) + 1)}): add module ${(i % 9) + 1} with its four rules, each one a small function that the next module calls, so a maintainer can review it on its own`);

interface Hit {
  path: string;
  line: number;
  text: string;
}
type Hits = Record<string, Partial<Record<"name" | "variants" | "signature" | "tokens" | "tests", Hit[]>>>;

/** Hits the base has for each symbol's searches: a good many lines each, as a large repository gives. */
export function hugeHits(): Hits {
  const out: Hits = {};
  for (const name of hugeSymbolNames()) {
    const hits = (kind: string): Hit[] => Array.from({ length: 8 }, (_, i) => ({ path: `banyand/internal/${kind}/${name.toLowerCase()}_${i}.go`, line: 10 + i * 7, text: `\treturn ${name.toLowerCase()}.${kind}(ctx, ${i})` }));
    out[name] = { name: hits("name"), variants: hits("variants"), signature: hits("signature"), tokens: hits("tokens") };
  }
  return out;
}
