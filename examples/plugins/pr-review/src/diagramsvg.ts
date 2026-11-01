// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the plugin does with a diagram document the diagram-design skill drew (design §6.10, §6.11, §12.3): it reads
 * the document's `<svg>` into a tree, keeps only the elements and attributes an inert drawing needs, checks every
 * visible text against the labels of the checked data the job was given (the label rule), and writes the tree
 * back out as the markup `review.html` embeds, with its ids prefixed so several drawings share one document. Plugin
 * code only: the markup a model wrote is never copied into the report, only what this module re-serializes.
 */
import { clip, esc } from "./escape.js";

// ---- the tree ----

export interface SvgElement {
  tag: string;
  attrs: Array<[string, string]>;
  children: Array<SvgElement | string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const NAME_START = /[A-Za-z]/;
const TAG_NAME = /[^\s/>]*/y;
/** Deepest nesting and most elements a drawing may have: bounded while reading, so no later walk can run out of stack or time. */
export const MAX_DEPTH = 64;
export const MAX_ELEMENTS = 6_000;

/** The first `<svg>` element of a document as a tree, or the problem. Comments are dropped; CDATA, processing instructions and a second `<svg>` are refused. */
export function parseSvg(markup: string): { root: SvgElement } | { problem: string } {
  const start = markup.search(/<svg[\s>/]/i);
  if (start < 0) return { problem: "the document holds no <svg>" };
  const stack: SvgElement[] = [];
  let root: SvgElement | undefined;
  let elements = 0;
  let at = start;
  while (at < markup.length) {
    const lt = markup.indexOf("<", at);
    const text = markup.slice(at, lt < 0 ? markup.length : lt);
    if (text !== "" && stack.length > 0) stack[stack.length - 1]!.children.push(decode(text));
    if (lt < 0) break;
    if (markup.startsWith("<!--", lt)) {
      const end = markup.indexOf("-->", lt + 4);
      if (end < 0) return { problem: "an unclosed comment in the <svg>" };
      at = end + 3;
      continue;
    }
    if (markup[lt + 1] === "!" || markup[lt + 1] === "?") return { problem: `markup the drawing may not hold (${JSON.stringify(markup.slice(lt, lt + 12))}) in the <svg>` };
    if (markup[lt + 1] === "/") {
      const end = markup.indexOf(">", lt);
      if (end < 0) return { problem: "an unclosed end tag in the <svg>" };
      const name = markup.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.tag.toLowerCase() !== name.toLowerCase()) return { problem: `the end tag </${name}> closes ${open === undefined ? "nothing" : `<${open.tag}>`}` };
      at = end + 1;
      if (stack.length === 0) return { root: root! };
      continue;
    }
    if (!NAME_START.test(markup[lt + 1] ?? "")) return { problem: `a stray "<" in the <svg> near ${JSON.stringify(markup.slice(lt, lt + 20))}` };
    TAG_NAME.lastIndex = lt + 1;
    const tag = TAG_NAME.exec(markup)![0];
    if (lt + 1 + tag.length >= markup.length) return { problem: "an unclosed tag in the <svg>" };
    let pos = lt + 1 + tag.length;
    const attrs: Array<[string, string]> = [];
    const ATTR = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/]+)))?/y;
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(markup[pos] ?? "")) pos += 1;
      if (markup[pos] === ">") {
        pos += 1;
        break;
      }
      if (markup[pos] === "/" && markup[pos + 1] === ">") {
        selfClosing = true;
        pos += 2;
        break;
      }
      if (pos >= markup.length) return { problem: `an unclosed <${tag}> in the <svg>` };
      ATTR.lastIndex = pos;
      const m = ATTR.exec(markup);
      if (m === null || m[0] === "") return { problem: `malformed attributes on <${tag}>` };
      attrs.push([m[1]!, decode(m[2] ?? m[3] ?? m[4] ?? "")]);
      pos += m[0].length;
    }
    const el: SvgElement = { tag, attrs, children: [] };
    elements += 1;
    if (elements > MAX_ELEMENTS) return { problem: `the drawing has more than the ${MAX_ELEMENTS} elements the report embeds` };
    if (!selfClosing && stack.length >= MAX_DEPTH) return { problem: `elements nested more than ${MAX_DEPTH} deep` };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(el);
    else if (root === undefined) root = el;
    else return { problem: "a second root element" };
    if (!selfClosing) stack.push(el);
    else if (stack.length === 0) return { root: el };
    at = pos;
  }
  return { problem: "the <svg> is not closed" };
}

// ---- what a drawing may hold ----

const TAGS = new Map(["svg", "g", "rect", "line", "path", "polygon", "polyline", "circle", "ellipse", "text", "tspan", "defs", "marker", "pattern", "title", "desc"].map((t) => [t.toLowerCase(), t] as const));

/** The attributes a drawing may carry. `data-*` and `aria-*` are allowed by prefix; `href`, `style`, `on…` and every other are not. */
export const DIAGRAM_ATTRS: ReadonlySet<string> = new Set([
  "id", "class", "role", "aria-labelledby", "viewBox", "preserveAspectRatio",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points", "transform",
  "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "fill-opacity", "opacity", "paint-order", "fill-rule",
  "marker-end", "marker-start", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient", "patternUnits",
  "text-anchor", "dominant-baseline", "font-size", "font-weight", "font-family", "font-style", "letter-spacing", "dx", "dy", "textLength",
]);
const DATA_OR_ARIA = /^(?:data-[a-z][a-z0-9-]*|aria-[a-z]+)$/;
const ID = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const REFERENCING = new Set(["fill", "stroke", "marker-end", "marker-start"]);

function badValue(value: string): string | undefined {
  if (/javascript:|vbscript:|data:|expression\s*\(|@import|behavior\s*:/i.test(value)) return "a script or data URL";
  for (const m of value.matchAll(/url\(\s*([^)]*)\)/gi)) if (!/^["']?#[A-Za-z][A-Za-z0-9_.:-]*["']?$/.test(m[1]!.trim())) return "a url( that is not a reference inside the drawing";
  return undefined;
}

/** What the drawing holds that an inert report may not: an element or attribute outside the lists, a reference that leaves the drawing. */
export function svgProblems(root: SvgElement): string[] {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (problems.length < 12 && !problems.includes(p)) problems.push(p);
  };
  let count = 0;
  const ids = new Set<string>();
  const refs: string[] = [];
  const visit = (el: SvgElement, depth: number): void => {
    count += 1;
    const tag = TAGS.get(el.tag.toLowerCase());
    if ((tag === "title" || tag === "desc") && depth !== 1) add(`a <${tag}> inside the drawing: a title or description is the <svg>'s own, and its text is set by the plugin`);
    if (tag === undefined || el.tag !== tag) add(`the element <${el.tag}> is not one a drawing may hold (script, style, a link, an image or a foreign object, for example)`);
    for (const [key, value] of el.attrs) {
      if (key === "xmlns") {
        if (value !== "http://www.w3.org/2000/svg") add(`xmlns is ${JSON.stringify(clip(value, 60))}, not the SVG namespace`);
        continue;
      }
      if (!DIAGRAM_ATTRS.has(key) && !DATA_OR_ARIA.test(key)) {
        add(`the attribute ${key} on <${el.tag}> is not one a drawing may carry`);
        continue;
      }
      const bad = badValue(value);
      if (bad !== undefined) add(`the attribute ${key} on <${el.tag}> holds ${bad}`);
      if (key === "id") {
        if (!ID.test(value)) add(`the id ${JSON.stringify(clip(value, 40))} is not a plain name`);
        else if (ids.has(value)) add(`the id ${value} is defined twice`);
        ids.add(value);
      }
      if (REFERENCING.has(key) || key === "aria-labelledby") for (const m of value.matchAll(/url\(\s*["']?#([^)"'\s]+)["']?\s*\)/g)) refs.push(m[1]!);
      if (key === "aria-labelledby") refs.push(...value.split(/\s+/).filter((s) => s !== ""));
    }
    for (const child of el.children) if (typeof child !== "string") visit(child, depth + 1);
  };
  visit(root, 0);
  if (root.tag !== "svg") add("the root element is not <svg>");
  if (count > MAX_ELEMENTS) add(`the drawing has more than the ${MAX_ELEMENTS} elements the report embeds`);
  for (const ref of refs) if (!ids.has(ref)) add(`it refers to #${ref}, which the drawing does not define`);
  return problems;
}

/** `viewBox="0 0 W H"` as numbers, or undefined. */
function viewBoxOf(root: SvgElement): { w: number; h: number } | undefined {
  const v = root.attrs.find(([k]) => k === "viewBox")?.[1];
  const n = v?.trim().split(/[\s,]+/).map(Number);
  if (n === undefined || n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2]! <= 0 || n[3]! <= 0 || Math.abs(n[0]!) > 1e6 || Math.abs(n[1]!) > 1e6 || n[2]! > 20_000 || n[3]! > 20_000) return undefined;
  return { w: n[2]!, h: n[3]! };
}

// ---- the document ----

/**
 * What the whole document the skill produced holds that an inert report may not (design §6.11): a script, an external
 * stylesheet, font, image or frame, an `@import`, a `url(` that leaves the document, any address but the SVG
 * namespace, a handler attribute. The document is only ever checked and read; the report embeds the re-serialized `<svg>`.
 */
export function documentProblems(html: string): string[] {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (!problems.includes(p)) problems.push(p);
  };
  const bare = html.replace(/<!--[\s\S]*?-->/g, "").replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
  if (/<\s*script/i.test(bare)) add("it holds a <script");
  if (/<\s*(link|iframe|frame|object|embed|img|image|video|audio|source|base|form|input|button|foreignObject|use|animate|set)\b/i.test(bare)) add("it holds an element that loads or animates something (link, img, iframe, object, embed, use, animate or the like)");
  if (/@import|@font-face/i.test(bare)) add("its stylesheet imports or declares a font");
  if (/url\(\s*(?!["']?#)/i.test(bare)) add("it holds a url( that is not a reference inside the document");
  if (/https?:\/\/|\/\/[A-Za-z0-9.-]+\.[a-z]{2,}\//i.test(bare)) add("it names a network address (a font, stylesheet or link)");
  if (/\son[a-z]+\s*=|\ssrc\s*=|\ssrcset\s*=|\sxlink:href\s*=|\shref\s*=|javascript:/i.test(bare)) add("it holds a handler, src or href attribute");
  if (/<meta[^>]+http-equiv/i.test(bare)) add("it holds a meta refresh or policy");
  return problems;
}

// ---- the label rule ----

/**
 * Words the skill's own types print that no data carries: the panel and ledger headings, its change words, its type
 * tags. Nothing else is free text in a drawing.
 */
export const STRUCTURAL_WORDS: readonly string[] = [
  "before", "after", "changes", "change", "added", "removed", "changed", "modified", "moved", "rewired", "unchanged",
  "component", "components", "relationship", "relationships", "legend", "state", "start", "end", "initial", "read", "reads", "transition", "transitions",
];

/** Tokens that only separate the parts of one text: a dot, an arrow, a plus. */
const SEPARATORS = new Set(["·", "•", "→", "->", "⇒", "↦", "+", "−", "-", "–", "—", "Δ", "|", "/", ":", "~", "*"]);

/** A label as the rule compares it: lower case, one space between words, punctuation that only decorates a word removed. */
export function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?()[\]{}"'`“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The segments of a text the rule judges: the text split at its standalone separators, each normalized. */
function segments(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (SEPARATORS.has(word)) {
      if (cur.length > 0) out.push(cur.join(" "));
      cur = [];
    } else cur.push(word);
  }
  if (cur.length > 0) out.push(cur.join(" "));
  return out.map(normalizeLabel).filter((s) => s !== "");
}

/**
 * The labels a drawing may print, from the checked data it was given (`phrases`) and the skill's fixed words. A
 * text node passes when each of its segments is a fixed word, or a run of whole words of one label (a label wrapped
 * over lines, or one half of a `from → to` pair); anything else is a claim the checker never saw.
 */
export function labelProblems(texts: readonly string[], phrases: readonly string[]): string[] {
  const allowed = [...new Set([...phrases.flatMap((p) => segments(p).concat(normalizeLabel(p))), ...STRUCTURAL_WORDS])].filter((p) => p !== "").map((p) => ` ${p} `);
  const fixed = new Set(STRUCTURAL_WORDS);
  const bad: string[] = [];
  for (const text of texts) {
    for (const seg of segments(text)) {
      if (fixed.has(seg) || allowed.some((a) => a.includes(` ${seg} `))) continue;
      if (!bad.includes(text)) bad.push(text);
    }
  }
  return bad.slice(0, 6).map((t) => `the text ${JSON.stringify(clip(t, 80))} is not a label of the data you were given`);
}

/** The visible text nodes of a drawing: each `<text>` without a `<tspan>`, and each `<tspan>`; `<title>` and `<desc>` are set by the plugin. */
export function textNodes(root: SvgElement): string[] {
  const out: string[] = [];
  const own = (el: SvgElement): string => el.children.filter((c): c is string => typeof c === "string").join("");
  const visit = (el: SvgElement): void => {
    const tag = el.tag.toLowerCase();
    if (tag === "title" || tag === "desc") return;
    if (tag === "text" || tag === "tspan") {
      const inner = el.children.filter((c): c is SvgElement => typeof c !== "string");
      const t = own(el).trim();
      if (t !== "") out.push(t);
      for (const c of inner) visit(c);
      return;
    }
    for (const c of el.children) if (typeof c !== "string") visit(c);
  };
  visit(root);
  return out;
}

// ---- the document's stylesheet ----

/** The CSS properties that have a presentation attribute of the same name: what a class rule may set on a drawing's element. */
const PRESENTATION = new Set([
  "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "fill-opacity", "opacity", "paint-order",
  "text-anchor", "dominant-baseline", "font-size", "font-weight", "font-family", "font-style", "letter-spacing",
]);
/** Selectors of the page's own chrome, which style no part of the drawing. */
const PAGE_SELECTORS = /^(?:\*|\*::?before|\*::?after|body|html|svg|h[1-6]|p|\.frame|\.eyebrow|\.diagram-container|\.legend|\.sr-only)$/;
const SVG_TAGS = /(?:^|[^\w-])(?:text|tspan|rect|path|line|circle|ellipse|polygon|polyline|g|marker|defs|pattern)(?![\w-])/;

interface Rule {
  selector: string;
  body: string;
}

/** The rules of a stylesheet, flat: an at-rule (`@media print`) is skipped whole. */
function cssRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    const selector = text.slice(i, open).trim();
    if (!selector.startsWith("@")) out.push({ selector, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

const declarations = (body: string): Array<[string, string]> =>
  body.split(";").flatMap((d) => {
    const at = d.indexOf(":");
    return at < 0 || d.slice(0, at).trim() === "" ? [] : [[d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).replace(/!important/gi, "").trim()] as [string, string]];
  });

/** The `class` names a drawing's elements use. */
function classesUsed(root: SvgElement): Set<string> {
  const used = new Set<string>();
  const visit = (el: SvgElement): void => {
    for (const [k, v] of el.attrs) if (k === "class") for (const c of v.split(/\s+/)) if (c !== "") used.add(c);
    for (const c of el.children) if (typeof c !== "string") visit(c);
  };
  visit(root);
  return used;
}

/**
 * What the document's `<style>` blocks do to the drawing, as presentation attributes, since the embedded `<svg>` keeps no
 * stylesheet: for each class the drawing uses, the declarations of its simple `.class` rules, with `var(--x)` resolved from
 * `:root`. Anything that cannot be written as an attribute, or that the plugin does not resolve (a selector with a tag, an
 * attribute or a combinator that reaches a class the drawing uses, a property with no presentation attribute, an undefined
 * variable), is a problem, so the correction or the fallback handles the drawing. The page's own rules are ignored.
 */
export function stylesFor(html: string, root: SvgElement): { classes: Map<string, Array<[string, string]>> } | { problems: string[] } {
  const used = classesUsed(root);
  const problems: string[] = [];
  const add = (p: string): void => {
    if (problems.length < 8 && !problems.includes(p)) problems.push(p);
  };
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join("\n");
  const rules = cssRules(css);
  const vars = new Map<string, string>();
  for (const r of rules) if (r.selector.split(",").every((s) => /^(?::root|html)$/.test(s.trim()))) for (const [k, v] of declarations(r.body)) if (k.startsWith("--")) vars.set(k, v);
  const resolve = (value: string, owner: string): string => {
    let v = value;
    for (let n = 0; n < 4 && /var\(/.test(v); n += 1) {
      v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name: string, fallback: string | undefined) => vars.get(name) ?? fallback?.trim() ?? `\u0000${name}`);
    }
    const missing = /\u0000(--[\w-]+)/.exec(v);
    if (missing !== null) add(`${owner}: var(${missing[1]}) is not defined by :root, and has no fallback`);
    else if (/var\(/.test(v)) add(`${owner}: a var() the plugin does not resolve`);
    return v;
  };
  const classes = new Map<string, Array<[string, string]>>();
  for (const r of rules) {
    for (const raw of r.selector.split(",")) {
      const sel = raw.trim();
      const cls = /^\.([A-Za-z_][\w-]*)$/.exec(sel)?.[1];
      if (cls !== undefined) {
        if (!used.has(cls)) continue;
        const list = classes.get(cls) ?? [];
        for (const [prop, value] of declarations(r.body)) {
          if (prop.startsWith("--")) continue;
          if (!PRESENTATION.has(prop)) {
            add(`the rule ${sel} sets ${prop}, which the report cannot carry into the drawing (only ${[...PRESENTATION].slice(0, 6).join(", ")} and the like)`);
            continue;
          }
          const resolved = resolve(value, sel);
          const bad = badValue(resolved);
          if (bad !== undefined) add(`the rule ${sel} sets ${prop} to ${bad}`);
          list.push([prop, resolved]);
        }
        classes.set(cls, list);
      } else if (/^(?::root|html)$/.test(sel) || PAGE_SELECTORS.test(sel)) continue;
      else if (SVG_TAGS.test(sel) || sel.includes("[") || [...used].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel))) add(`the rule ${JSON.stringify(sel)} styles the drawing's elements; give each element its presentation attributes instead`);
    }
  }
  return problems.length > 0 ? { problems } : { classes };
}

// ---- the embedded markup ----

const serialize = (el: SvgElement): string => {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  if (el.children.length === 0) return `<${el.tag}${attrs}/>`;
  return `<${el.tag}${attrs}>${el.children.map((c) => (typeof c === "string" ? esc(c) : serialize(c))).join("")}</${el.tag}>`;
};

const withPrefix = (value: string, uid: string): string => value.replace(/url\(\s*["']?#([^)"'\s]+)["']?\s*\)/g, (_m, id: string) => `url(#${uid}-${id})`);

/**
 * The `<svg>` of a drawing that passed its checks, as `review.html` embeds it: only the allowed elements and attributes,
 * every id prefixed with `uid`, the title and description the plugin writes (`title`, `description`: from the data, never the
 * model's), `role="img"`, and a width that scales the viewBox to the container (inside a scrolling wrapper). The drawing keeps
 * no stylesheet: `styles` (from `stylesFor`) is written into each element as presentation attributes, over the ones it
 * had, as the cascade would, and no `class` is left.
 */
export function embeddedSvg(root: SvgElement, uid: string, title: string, description: string, styles?: ReadonlyMap<string, ReadonlyArray<readonly [string, string]>>): { svg: string } | { problems: string[] } {
  const problems = svgProblems(root);
  const box = viewBoxOf(root);
  if (box === undefined) problems.push("the <svg> has no usable viewBox (four numbers, each side at most 20000)");
  const kids = root.children.filter((c): c is SvgElement => typeof c !== "string");
  if (!kids.some((k) => k.tag === "title") || !kids.some((k) => k.tag === "desc")) problems.push("the <svg> has no <title> and <desc> as its direct children (the skill's accessible-SVG contract)");
  if (problems.length > 0 || box === undefined) return { problems };
  const rename = (el: SvgElement, depth: number): SvgElement => {
    const attrs: Array<[string, string]> = [];
    for (const [k, v] of el.attrs) {
      if (k === "xmlns" || (k === "class" && depth > 0)) continue;
      if (depth === 0 && ["role", "aria-labelledby", "id", "width", "height", "class"].includes(k)) continue;
      attrs.push([k, k === "id" ? `${uid}-${v}` : k === "aria-labelledby" ? v.split(/\s+/).filter((s) => s !== "").map((s) => `${uid}-${s}`).join(" ") : REFERENCING.has(k) ? withPrefix(v, uid) : v]);
    }
    if (depth > 0 && styles !== undefined) {
      const cls = el.attrs.find(([k]) => k === "class")?.[1].split(/\s+/) ?? [];
      for (const c of cls) {
        for (const [prop, value] of styles.get(c) ?? []) {
          const at = attrs.findIndex(([k]) => k === prop);
          if (at >= 0) attrs[at] = [prop, REFERENCING.has(prop) ? withPrefix(value, uid) : value];
          else attrs.push([prop, REFERENCING.has(prop) ? withPrefix(value, uid) : value]);
        }
      }
    }
    let children: Array<SvgElement | string> = el.children.map((c) => (typeof c === "string" ? c : rename(c, depth + 1)));
    if (depth === 1 && (el.tag === "title" || el.tag === "desc")) {
      children = [el.tag === "title" ? title : description];
      return { tag: el.tag, attrs: [["id", `${uid}-${el.tag}`]], children };
    }
    return { tag: el.tag, attrs, children };
  };
  const out = rename(root, 0);
  out.attrs.unshift(["class", "dd"], ["role", "img"], ["aria-labelledby", `${uid}-title ${uid}-desc`], ["style", "width:100%;height:auto"]);
  // The title and description are exactly one each, first: the skill's contract.
  const rest = out.children.filter((c) => typeof c === "string" || (c.tag !== "title" && c.tag !== "desc"));
  out.children = [{ tag: "title", attrs: [["id", `${uid}-title`]], children: [title] }, { tag: "desc", attrs: [["id", `${uid}-desc`]], children: [description] }, ...rest.filter((c) => typeof c !== "string" || c.trim() !== "")];
  return { svg: serialize(out) };
}
