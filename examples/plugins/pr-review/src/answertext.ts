// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * An answer as posted text (design §8.5, §9.4): the whole answer, then every citation as a link to the file at the pinned
 * commit of its tree, then the proposal when there is one. The text is kept as parts so that a posted item that must be
 * shortened is shortened by what matters least first (the proposal's detail, then the answer's tail), at a sentence end or a
 * word boundary, with a note that says so and where the whole answer is; a citation link is never dropped without a count.
 */
import { cutAt } from "./escape.js";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The pinned commits citations are linked at; without them a citation is named, not linked. */
export interface GithubPin {
  owner: string;
  repo: string;
  head: string;
  base?: string | undefined;
}

export interface CitationLike {
  path: string;
  start: number;
  end: number;
  tree: string;
}

export interface ProposalLike {
  kind?: string;
  splits?: Array<{ name: string; startLine: number; endLine: number; responsibility: string }>;
  testFile?: string;
  testName?: string;
  cases?: Array<{ input: string; branches: string }>;
  assertion?: string;
}

const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/** The citations as markdown: a link into GitHub at the pinned head or base, a dependency as `name@version` text. */
export function citationLinks(cites: readonly CitationLike[], g: GithubPin | undefined, inventory: ReadonlyArray<{ name: string; version: string }> = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cites) {
    if (c.path === "") continue;
    const range = c.start >= 1 ? (c.start === c.end || c.end < c.start ? `:${c.start}` : `:${c.start}-${c.end}`) : "";
    let text: string;
    if (c.tree === "dependency") {
      const dep = inventory.find((d) => c.path.includes(`${d.name}@${d.version}`) || c.path.includes(`/${d.name}/`)) ?? (inventory.length === 1 ? inventory[0] : undefined);
      text = dep !== undefined ? `\`${dep.name}@${dep.version}\` (dependency, \`${c.path}${range}\`)` : `\`${c.path}${range}\` (dependency)`;
    } else {
      const base = c.tree === "base";
      const sha = base ? g?.base : g?.head;
      const label = `\`${c.path}${range}\`${base ? " (base)" : ""}`;
      if (g === undefined || sha === undefined || !/^[0-9a-f]{7,64}$/.test(sha)) text = label;
      else text = `[${label}](https://github.com/${g.owner}/${g.repo}/blob/${sha}/${encodePath(c.path)}${c.start >= 1 ? `#L${c.start}${c.end > c.start ? `-L${c.end}` : ""}` : ""})`;
    }
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/** The proposal as a review comment's paragraph (the content of the Q&A's proposal line); empty when there is none. */
export function proposalText(p: ProposalLike | undefined): string {
  if (p === undefined) return "";
  if (p.kind === "split" && (p.splits ?? []).length > 0) return `Proposal: split into\n${p.splits!.map((s) => `- \`${s.name}\` (lines ${s.startLine}–${s.endLine}): ${oneLine(s.responsibility)}`).join("\n")}`;
  if (p.kind === "test" && (p.testName ?? "") !== "") {
    const cases = p.cases ?? [];
    return `Proposal: add the test \`${p.testName}\` in \`${p.testFile ?? ""}\`${cases.length > 0 ? `, covering ${cases.map((c) => `${oneLine(c.input)} (${oneLine(c.branches)})`).join("; ")}` : ""}.`;
  }
  if (p.kind === "assertion" && (p.assertion ?? "") !== "") return `Proposal: ${oneLine(p.assertion!)}`;
  return "";
}

/** One posted item as its parts; `composeParts` joins them whole. */
export interface ItemParts {
  /** The question's id (`Q21`): where the whole answer is in the report's Q&A. */
  id: string;
  /** The opening paragraph: the kinds and the question. */
  head: string;
  /** What introduces the answer, such as `Answer (answered)`. */
  label: string;
  answer: string;
  /** The citations, one markdown fragment each. */
  cites: string[];
  proposal: string;
  /** What follows (the questions a merged issue also covers), as a paragraph; `tailIds` names them when it must be dropped. */
  tail?: string;
  tailIds?: string[];
}

const citeParagraph = (cites: readonly string[], dropped: number, where: string): string =>
  cites.length === 0 ? "" : `Citations: ${cites.join(", ")}${dropped > 0 ? `, and ${dropped} more in ${where}` : ""}`;

const join = (xs: ReadonlyArray<string | undefined>): string => xs.filter((x): x is string => x !== undefined && x !== "").join("\n\n");

/** The whole item. */
export const composeParts = (p: ItemParts): string => join([p.head, `${p.label}: ${p.answer}`, citeParagraph(p.cites, 0, ""), p.proposal, p.tail]);

/**
 * The item within `limit` characters when it can be, else as near as it gets, never silently: the proposal's detail goes
 * first (shortened, then replaced by a note), then the answer's end (cut at a sentence end, else a word boundary, with a note
 * naming the whole answer), then all but the first citation links (counted), then a merged issue's list of questions
 * (their ids stay), then the opening paragraph.
 */
export function fitParts(p: ItemParts, limit: number): string {
  const whole = composeParts(p);
  if (whole.length <= limit) return whole;
  const where = `the report's Q&A, ${p.id}`;
  const answerNote = ` (answer shortened; the full answer is in ${where})`;
  interface Shape {
    answer: string;
    cut: boolean;
    proposal: string;
    cites: number;
    tail: string | undefined;
    head: string;
  }
  const make = (o: Shape): string => join([o.head, `${p.label}: ${o.answer}${o.cut ? answerNote : ""}`, citeParagraph(p.cites.slice(0, o.cites), p.cites.length - o.cites, where), o.proposal, o.tail]);
  const base: Shape = { answer: p.answer, cut: false, proposal: "", cites: p.cites.length, tail: p.tail, head: p.head };
  // 1. The proposal shortened to the room the whole answer leaves, or replaced by a note.
  if (p.proposal !== "") {
    const noteP = `(proposal shortened; the rest is in ${where})`;
    const room = limit - make(base).length - 2;
    const cut = cutAt(p.proposal, room - noteP.length - 1);
    if (room >= 150 && cut.text.length >= 60) {
      const text = make({ ...base, proposal: `${cut.text}${cut.sentence ? "" : "…"} ${noteP}` });
      if (text.length <= limit) return text;
    }
    base.proposal = `(proposal omitted; it is in ${where})`;
    if (make(base).length <= limit) return make(base);
  }
  // 2. The answer's end, then fewer citations, then the merged list.
  const idsTail = p.tailIds !== undefined ? `Also covers ${p.tailIds.join(", ")} (see ${where}).` : undefined;
  const attempt = (s: Shape): string | undefined => {
    const spare = limit - make({ ...s, answer: "" }).length;
    return spare < 60 ? undefined : make({ ...s, answer: cutAt(p.answer, spare).text });
  };
  const tails = idsTail !== undefined && p.tail !== undefined ? [p.tail, idsTail] : [p.tail];
  for (const tail of tails) {
    for (let n = p.cites.length; n >= Math.min(1, p.cites.length); n -= 1) {
      const t = attempt({ ...base, cut: true, cites: n, tail });
      if (t !== undefined) return t;
    }
  }
  // 3. Nothing fits with an answer left: the least that names the issue, its citations and where the answer is.
  const least: Shape = { ...base, answer: "", cut: true, cites: Math.min(1, p.cites.length), tail: idsTail ?? p.tail };
  const headRoom = limit - make({ ...least, head: "" }).length - 2;
  const head = headRoom >= 40 && p.head.length > headRoom ? `${cutAt(p.head, headRoom - 1).text}…` : p.head;
  return make({ ...least, head });
}
