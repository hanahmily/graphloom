// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The three review aspects and their rule files (design §8.1). The aspects' focus and out-of-scope lists are
 * data; each aspect ships one rule file with one entry per language glob and a final `**` entry, in the format
 * open-code-review 1.13.3 honors. A profile's `review.aspects.<aspect>.rules` entries replace the shipped entry with
 * the same `path` or add one. The effective file is written to `.graphloom/review/rules/<aspect>.json`, so its
 * bytes are evidence, and plugin code (never the reviewer) resolves which rule each file in scope falls under.
 */
import { globToRegExp } from "./metrics/generated.js";

/** The aspects in the order their reviewers are dispatched (design §8.1's table). */
export const ASPECTS = ["correctness", "maintainability", "security"] as const;
export type Aspect = (typeof ASPECTS)[number];
/** The order a draft lists them in (design §10.1). */
export const DRAFT_ORDER: readonly Aspect[] = ["correctness", "security", "maintainability"];

export const isAspect = (v: unknown): v is Aspect => typeof v === "string" && (ASPECTS as readonly string[]).includes(v);

/** What each aspect reviews and leaves out (design §8.1). */
export const ASPECT_TEXT: Readonly<Record<Aspect, { focus: string; out: string }>> = {
  correctness: {
    focus: "Each feature does what the report and the pull request say: logic, edge cases, error handling, concurrency, data integrity, API contracts.",
    out: "Readability and structure; exploitability.",
  },
  maintainability: {
    focus: "Readability, structure and naming, duplication, coupling, test quality.",
    out: "What the Q&A already answers (reuse, duplication against the codebase, complexity splits, missing tests), unless this pass adds something the answer lacks; whether behavior is correct or safe.",
  },
  security: {
    focus: "Input validation, injection, authentication and authorization, secrets, unsafe deserialization, resource exhaustion and denial of service, dependency risk.",
    out: "Defects with no attacker-controlled input or trust boundary, which are correctness.",
  },
};

export interface RuleEntry {
  /** A glob over repository-relative paths; the last entry of a file is `**`. */
  path: string;
  rule: string;
}

/** The language globs a rule file has an entry for, before its final `**`. */
export const RULE_GLOBS: ReadonlyArray<{ path: string; language: string }> = [
  { path: "**/*.go", language: "Go" },
  { path: "**/*.ts", language: "TypeScript" },
  { path: "**/*.tsx", language: "TypeScript (TSX)" },
];

const ruleText = (aspect: Aspect, language: string | undefined): string => {
  const t = ASPECT_TEXT[aspect];
  const lang = language === undefined ? "Any other file (documentation, configuration, schema)" : `${language} code`;
  return `Aspect: ${aspect}. ${lang}: review only this: ${t.focus} Out of scope: ${t.out} A finding outside the ${aspect} aspect is left out.`;
};

/** The entries an aspect ships: one for each language glob, then `**`. */
export function shippedRules(aspect: Aspect): RuleEntry[] {
  return [...RULE_GLOBS.map((g) => ({ path: g.path, rule: ruleText(aspect, g.language) })), { path: "**", rule: ruleText(aspect, undefined) }];
}

/** The effective entries: the profile's replace the shipped entry with the same `path`, or are added before the final `**`. */
export function effectiveRules(aspect: Aspect, overrides: readonly RuleEntry[] = []): RuleEntry[] {
  const out = shippedRules(aspect);
  for (const o of overrides) {
    const at = out.findIndex((e) => e.path === o.path);
    if (at >= 0) out[at] = { path: o.path, rule: o.rule };
    else out.splice(out.length - 1, 0, { path: o.path, rule: o.rule });
  }
  return out;
}

/** The text of `rules/<aspect>.json`: the format ocr 1.13.3 honors (`merge_system_rule: false` with `path`/`rule` entries). */
export const ruleFileText = (aspect: Aspect, overrides: readonly RuleEntry[] = []): string => `${JSON.stringify({ merge_system_rule: false, rules: effectiveRules(aspect, overrides) }, null, 2)}\n`;

export interface RuleGroup {
  /** The entry's glob and its rule text, from the file the evidence holds. */
  path: string;
  rule: string;
  files: string[];
}

export type RuleGroups = { state: "ok"; groups: RuleGroup[] } | { state: "failed"; problems: string[] };

/**
 * Which rule each file of the scope falls under, from the rule file's own text: the first entry, in file order, whose
 * glob matches (the `**` entry last, so it takes what no language entry does). A file in no group, a file text that is
 * not a custom rule file, or an entry with no rule text fails the aspect before any reviewer runs, naming the files:
 * the silent fallback to a generic rule is what the plugin resolves the rules itself to rule out.
 */
export function ruleGroups(fileText: string, files: readonly string[]): RuleGroups {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return { state: "failed", problems: ["the rule file is not JSON"] };
  }
  const doc = parsed as { merge_system_rule?: unknown; rules?: unknown } | null;
  if (doc === null || typeof doc !== "object" || doc.merge_system_rule !== false || !Array.isArray(doc.rules) || doc.rules.length === 0) {
    return { state: "failed", problems: ["the rule file is not a custom rule file (merge_system_rule must be false, with a non-empty rules list)"] };
  }
  const entries: RuleEntry[] = [];
  for (const [i, raw] of (doc.rules as unknown[]).entries()) {
    const e = raw as { path?: unknown; rule?: unknown } | null;
    if (e === null || typeof e !== "object" || typeof e.path !== "string" || e.path === "" || typeof e.rule !== "string" || e.rule.trim() === "") {
      return { state: "failed", problems: [`rules[${i}] has no path or no rule text`] };
    }
    entries.push({ path: e.path, rule: e.rule });
  }
  const matchers = entries.map((e) => globToRegExp(e.path));
  const groups: RuleGroup[] = entries.map((e) => ({ path: e.path, rule: e.rule, files: [] }));
  const unmatched: string[] = [];
  for (const f of files) {
    const at = matchers.findIndex((m) => m.test(f));
    if (at < 0) unmatched.push(f);
    else groups[at]!.files.push(f);
  }
  if (unmatched.length > 0) return { state: "failed", problems: [`${unmatched.length} file(s) fall under no rule: ${unmatched.slice(0, 5).join(", ")}`] };
  return { state: "ok", groups: groups.filter((g) => g.files.length > 0) };
}
