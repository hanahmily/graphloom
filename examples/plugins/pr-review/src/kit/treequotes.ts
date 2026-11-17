// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The claim check's quotes, verified against the trees (design §6.9): in a large report a claim may rest on lines no patch
 * shown to the reporter holds, so each quote of a supported claim is looked up, by a read-only command, in the file its cite
 * names in the head's working tree or at the pinned base. A claim whose quote the tree does not show is unsupported.
 */
import type { EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";

/** Entries one `tree-quote` command takes: 4 argv elements each, within the executor's 64. */
const ENTRIES_PER_COMMAND = 14;

const normal = (p: string): string => p.replace(/\/+$/, "").replace(/^\.\//, "");

export interface TreeQuoteEntry {
  id: string;
  tree: "head" | "base" | "either";
  path: string;
  line: number;
  text: string;
}

export interface TreeQuotePlan {
  unavailable?: string;
  commands: EnvironmentCommand[];
  entries: TreeQuoteEntry[];
  sizes: number[];
}

/**
 * Whether each quote is on a line of its file in the tree the cite names, within three lines of the one it gives, as
 * the diff's own quotes are matched (whitespace collapsed). The quote travels in the environment, not in awk's `-v`,
 * which would read its backslashes. Read-only; no repository code runs.
 */
const QUOTE_SCRIPT = String.raw`set -u; base="$1"; shift
g() { git -c core.hooksPath=/dev/null "$@"; }
chk() {
  if [ "$1" = base ]; then
    if ! g cat-file -e "$base:$path" 2>/dev/null; then echo missing; return; fi
    g show "$base:$path" 2>/dev/null > "$GRAPHLOOM_REPORT_FILE.q"
  else
    if [ ! -f "$path" ]; then echo missing; return; fi
    cat "$path" > "$GRAPHLOOM_REPORT_FILE.q"
  fi
  awk -v at="$line" 'function c(s) { gsub(/[ \t\r\n]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s); return s } BEGIN { w = c(ENVIRON["QUOTE"]) } NR >= at - 3 && NR <= at + 3 { if (index(c($0), w) > 0) f = 1 } END { print (f ? "ok" : "nomatch") }' "$GRAPHLOOM_REPORT_FILE.q"
}
{ i=0
while [ "$#" -ge 4 ]; do
  tree="$1"; path="$2"; line="$3"; QUOTE="$4"; shift 4; i=$((i + 1))
  export QUOTE
  if [ "$tree" = either ]; then
    v=$(chk head)
    if [ "$v" != ok ]; then w=$(chk base); if [ "$w" = ok ] || [ "$v" = missing ]; then v=$w; fi; fi
  else
    v=$(chk "$tree")
  fi
  echo "$i $v"
done; rm -f "$GRAPHLOOM_REPORT_FILE.q"; echo "checked $i"; } > "$GRAPHLOOM_REPORT_FILE"`;

/** The commands that verify the supported claims' quotes against their trees (at most 14 quotes each); their ids are `<idPrefix>-<n>`, `tree-quote-<n>` for the claim check. */
export function treeQuotePlan(claims: ReadonlyArray<{ id: string; tree: "head" | "base" | "either"; quotes: ReadonlyArray<{ path: string; line: number; text: string }> }>, base: string | undefined, idPrefix: string = COMMAND.treeQuote): TreeQuotePlan {
  const entries: TreeQuoteEntry[] = claims.flatMap((c) => c.quotes.map((q) => ({ id: c.id, tree: c.tree, path: normal(q.path), line: q.line, text: q.text })));
  if (entries.length === 0) return { commands: [], entries: [], sizes: [] };
  if (base === undefined) return { unavailable: "the checkout recorded no pinned base, so the claims' quotes cannot be verified in their trees", commands: [], entries, sizes: [] };
  const commands: EnvironmentCommand[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < entries.length; i += ENTRIES_PER_COMMAND) {
    const chunk = entries.slice(i, i + ENTRIES_PER_COMMAND);
    const id = `${idPrefix}-${commands.length + 1}`;
    commands.push({ id, argv: ["sh", "-c", QUOTE_SCRIPT, id, base, ...chunk.flatMap((e) => [e.tree, e.path, String(e.line), e.text])] });
    sizes.push(chunk.length);
  }
  return { commands, entries, sizes };
}

/** The claims whose quotes the tree does not show, with why (a claim with one bad quote is unsupported), from the outputs of a plan's commands. */
export function readTreeQuotes(plan: TreeQuotePlan, outputs: readonly string[]): Map<string, string> {
  const failed = new Map<string, string>();
  let offset = 0;
  plan.sizes.forEach((size, c) => {
    const lines = (outputs[c] ?? "").split("\n");
    const checked = lines.map((l) => /^checked (\d+)$/.exec(l)).find((m) => m !== null);
    for (let k = 1; k <= size; k += 1) {
      const e = plan.entries[offset + k - 1]!;
      const verdict = lines.find((l) => l.startsWith(`${k} `))?.slice(`${k} `.length);
      if (checked === undefined || Number(checked[1]) !== size || verdict === undefined) failed.set(e.id, failed.get(e.id) ?? `its quote ${JSON.stringify(e.text.slice(0, 60))} was not checked against the ${e.tree === "either" ? "head or base" : e.tree} tree`);
      else if (verdict === "missing") failed.set(e.id, failed.get(e.id) ?? `its quote names no such file in the ${e.tree === "either" ? "head or base" : e.tree} tree (${e.path})`);
      else if (verdict !== "ok") failed.set(e.id, failed.get(e.id) ?? `its quote ${JSON.stringify(e.text.slice(0, 60))} is not in the ${e.tree === "either" ? "head or base" : e.tree} tree at ${e.path}:${e.line} (within three lines)`);
    }
    offset += size;
  });
  return new Map([...failed].map(([id, why]) => [id, `unsupported: ${why}`]));
}
