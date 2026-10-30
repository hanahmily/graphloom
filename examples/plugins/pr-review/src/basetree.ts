// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The base tree (design §7.3): the pinned base commit's files exported once per run into a directory of the
 * review's own, so a read-only agent can open a base file with Read, Grep and Glob (or `cat` and `grep`) beside
 * `git show <base>:<path>` and `git grep <base>`, and quote exact base line numbers instead of estimating them
 * from the head. The agents' jobs run under a read-only bwrap confinement; the directory is also bound read-only.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import path from "node:path";
import { BASE_DIR, COMMAND } from "./constants.js";
import { commandRuns, reportText, succeeded } from "./evidence.js";

/** Repository agent-configuration names (design §12.1); never exported, so an agent that reads the base tree loads none of them. */
export const AGENT_CONFIG_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", ".claude", ".codex", ".agents", ".pi", ".mcp.json", ".opencode"] as const;

const WITHHELD = AGENT_CONFIG_NAMES.map((n) => `-name '${n}'`).join(" -o ");

/**
 * Exports the base commit's tree with no repository code run: a temporary index and `git checkout-index` (not
 * `git archive`, whose `export-ignore` attribute would drop files, and not `git worktree add`, which would
 * write the repository's own administrative state), with hooks off and attributes read from the empty tree
 * (the job's env), so no filter or hook runs. It checks that every entry arrived, withholds agent
 * configuration, adds an `.ignore` that lets Grep see the directory under the review directory's own
 * `.gitignore`, and reports the base tree's object id, the digest of what was exported.
 */
const EXPORT =
  String.raw`set -eu; base="$1"; dir="$2"
g() { git -c core.hooksPath=/dev/null "$@"; }
tree=$(g rev-parse --verify "$base^{tree}")
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp/index"
[ -f .graphloom/review/.gitignore ] || { mkdir -p .graphloom/review; printf '*\n' > .graphloom/review/.gitignore; }
chmod -R u+w "$dir" 2>/dev/null || true
rm -rf "$dir"; mkdir -p "$dir"
g read-tree "$base"
g checkout-index -a --prefix="$dir/"
entries=$(g ls-files -z | tr -cd '\0' | wc -c)
links=$(g ls-files -s -z | tr '\0' '\n' | grep -c '^160000 ' || true)
found=$(find "$dir" ! -type d -print0 | tr -cd '\0' | wc -c)
if [ "$found" -ne $((entries - links)) ]; then echo "base export holds $found files, the base tree has $((entries - links))" >&2; exit 1; fi
withheld=$(find "$dir" \( ` + WITHHELD + String.raw` \) -prune -print0 | tr -cd '\0' | wc -c)
find "$dir" \( ` + WITHHELD + String.raw` \) -prune -exec rm -rf {} +
found=$(find "$dir" ! -type d -print0 | tr -cd '\0' | wc -c)
printf '!*\n' > "$dir/.ignore"
{ printf 'base=%s\ntree=%s\nfiles=%s\nwithheld=%s\n' "$base" "$tree" "$found" "$withheld"; echo '# end'; } > "$GRAPHLOOM_REPORT_FILE"`;

export const baseExportCommand = (base: string): EnvironmentCommand => ({ id: COMMAND.baseExport, argv: ["sh", "-c", EXPORT, COMMAND.baseExport, base, BASE_DIR] });

export interface BaseExport {
  base: string;
  /** The base tree's object id: the digest of the exported content. */
  tree: string;
  files: number;
  /** Agent-configuration entries left out. */
  withheld: number;
}

export function parseBaseExport(text: string): BaseExport | undefined {
  const kv = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = /^([a-z]+)=(\S+)$/.exec(raw.trim());
    if (m !== null) kv.set(m[1]!, m[2]!);
  }
  const base = kv.get("base");
  const tree = kv.get("tree");
  const files = Number(kv.get("files"));
  const withheld = Number(kv.get("withheld"));
  if (base === undefined || tree === undefined || !/^[0-9a-f]{40,64}$/.test(tree) || !/^# end$/m.test(text) || !Number.isInteger(files) || !Number.isInteger(withheld)) return undefined;
  return { base, tree, files, withheld };
}

/** What the run's recorded export of `base` shows, when it succeeded. */
export function recordedBaseExport(evidence: readonly EvidenceRecord[], base: string): BaseExport | undefined {
  const run = commandRuns(evidence, COMMAND.baseExport).at(-1);
  if (run === undefined || !succeeded(run.command)) return undefined;
  const parsed = parseBaseExport(reportText(run).text);
  return parsed !== undefined && parsed.base === base ? parsed : undefined;
}

/** Where the base tree is, as the agents see it (absolute, in the worktree). */
export const baseDirIn = (worktree: string): string => path.join(worktree, BASE_DIR);
