// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Fitting an agent assignment to the executor's bound (design §6.9, §7.6). The coding-agent executor declares
 * `assignment` at most 64,000 characters (`MAX_ASSIGNMENT_CHARS`, mirrored from `executors/coding-agent/src/run.ts`);
 * a job past it stops the run "incompatible task". Every job builder fits its assignment here, in this order: bulk
 * input is a workspace file the agent reads (written before the job, named in the assignment with what it holds),
 * what stays inline is a compact index, and what still does not fit is cut with an explicit note of what was left out
 * and where to read it. `assignmentProblem` is the one guard every agent job passes before dispatch.
 */
import { createHash } from "node:crypto";
import { REVIEW_DIR } from "./constants.js";

/** The executor's own bound on an assignment, in characters. */
export const MAX_ASSIGNMENT_CHARS = 64_000;
/** What the guard keeps free under the bound: the harness's own words and any escaping the executor adds. */
export const ASSIGNMENT_MARGIN_CHARS = 2_000;
/** The characters an assignment may hold. */
export const ASSIGNMENT_BUDGET_CHARS = MAX_ASSIGNMENT_CHARS - ASSIGNMENT_MARGIN_CHARS;

/** The sentence that says what to shrink when an assignment is over the budget, or undefined when it fits. */
export function assignmentProblem(what: string, assignment: string): string | undefined {
  if (assignment.length <= ASSIGNMENT_BUDGET_CHARS) return undefined;
  return `the assignment of ${what} is ${assignment.length} characters, over the ${ASSIGNMENT_BUDGET_CHARS} the plugin allows (the executor accepts ${MAX_ASSIGNMENT_CHARS}); shrink what it inlines: move bulk input to a workspace file the agent reads, or cut it with a note`;
}

/**
 * The lines that fit `budget` characters (each line counts its newline), then one line that counts the rest and says
 * where to read it. A line is never cut in two.
 */
export function fitLines(lines: readonly string[], budget: number, rest: (left: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.length < lines.length ? [...out, rest(lines.length - out.length)] : out;
}

/** `text` on one line, cut to `n` characters with an ellipsis. */
export const clipText = (text: string, n: number): string => {
  const one = text.replace(/\s*\n\s*/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1).trimEnd()}…`;
};

/** A bulk input an assignment points to instead of inlining: a file under `.graphloom/review/` the plugin writes before the job. */
export interface FileSpill {
  /** The file's name in `.graphloom/review/`. */
  name: string;
  text: string;
}

/** An assignment with the files it names, which must be written before the job runs. */
export interface Fitted {
  text: string;
  spills: FileSpill[];
}

/** A spill file named by its content: `<stem>-<8 hex digits of its SHA-256>.md`, so two different contents never share a file or a command. */
export const spillOf = (stem: string, text: string): FileSpill => ({ name: `${stem}-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8)}.md`, text });

/** Where an assignment names a file of the review directory: `dir` is the absolute directory when the worktree is known. */
export const reviewFile = (dir: string | undefined, name: string): string => `${dir ?? REVIEW_DIR}/${name}`;

/** The factors a variable part of an assignment shrinks by, in order, until the whole fits. */
const SCALES = [1, 0.75, 0.5, 0.3, 0.15, 0] as const;

/**
 * The assignment `build` makes at the largest scale at which it fits the budget. `build` multiplies the character
 * budget of each variable part it inlines by the scale, so a part that is too long is cut with its note, never the
 * fixed words around it. The last attempt (scale 0) is returned when none fits; the job guard then names the job.
 */
export function shrinkToFit(build: (scale: number) => Fitted): Fitted {
  let last: Fitted = build(1);
  for (const scale of SCALES) {
    last = scale === 1 ? last : build(scale);
    if (last.text.length <= ASSIGNMENT_BUDGET_CHARS) return last;
  }
  return last;
}
