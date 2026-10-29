// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Symbol extraction (design §7.2 item 1). A language pack's definition
 * patterns run over the head file, plugin code cuts each body by brace
 * matching, and a symbol the patch touches is `new` when the base file does
 * not define its qualified name and `modified` when it does. No parser runs: a
 * regular expression's recall is what the P1 live trial measures.
 */
import { matchesGeneratedGlob } from "./metrics/generated.js";
import { NOT_MEMBERS, type FullPack } from "./packs.js";
import type { ParsedPatch } from "./patch.js";

/** The text with comments and the insides of strings blanked, line breaks and positions kept. */
export function maskCode(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  const blank = (c: string): string => (c === "\n" || c === "\r" ? c : " ");
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
    } else if (c === "/" && d === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(blank(text[i]!));
        i += 1;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      i += 1;
      while (i < n && text[i] !== c) {
        if (text[i] === "\\" && c !== "`" && i + 1 < n) {
          out.push(" ", blank(text[i + 1]!));
          i += 2;
          continue;
        }
        // A quote never runs past the line, but a raw or template string does.
        if (text[i] === "\n" && c !== "`") break;
        out.push(blank(text[i]!));
        i += 1;
      }
      if (i < n && text[i] === c) {
        out.push(c);
        i += 1;
      }
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out.join("");
}

/** The brace depth at the start of each line (index 0 is line 1) of masked text. */
export function depthAtLineStart(masked: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  depths.push(0);
  for (const c of masked) {
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === "\n") depths.push(depth);
  }
  return depths;
}

const CONTINUES = /[=,+\-*/&|?:(<>.]\s*$/;

/**
 * The last line (1-based) of the declaration that starts at `startLine`: the
 * line the first `{` closes, or the line that ends a declaration with no body
 * (a `;`, or a line break with brackets balanced and nothing to continue it).
 */
export function declarationEnd(maskedLines: readonly string[], startLine: number): number | undefined {
  let paren = 0;
  let brace = 0;
  let sawBrace = false;
  for (let li = startLine - 1; li < maskedLines.length; li += 1) {
    const line = maskedLines[li]!;
    for (let ci = 0; ci < line.length; ci += 1) {
      const c = line[ci]!;
      if (c === "(" || c === "[") paren += 1;
      else if (c === ")" || c === "]") paren -= 1;
      else if (c === "{") {
        brace += 1;
        sawBrace = true;
      } else if (c === "}") {
        brace -= 1;
        if (brace === 0 && sawBrace && paren <= 0) {
          // A block that a `{`, `=>`, `|`, `&` or `>` follows is a type in the declaration's header (`): { a: number } {`), not its body.
          if (/^\s*(\{|=>|\||&|>)/.test(line.slice(ci + 1))) {
            sawBrace = false;
            continue;
          }
          return li + 1;
        }
        if (brace < 0) return undefined;
      } else if (c === ";" && paren <= 0 && brace === 0) return li + 1;
    }
    if (brace === 0 && paren <= 0 && !sawBrace) {
      // A declaration that has not opened its body yet continues only when the line says so.
      const next = maskedLines[li + 1];
      if (!CONTINUES.test(line) && !(next !== undefined && /^\s*(\{|=>|\.|\?|:)/.test(next))) return li + 1;
    }
  }
  return undefined;
}

export interface FileSymbol {
  path: string;
  language: string;
  /** The Go package, or the TypeScript module path. */
  scope: string;
  dir: string;
  kind: string;
  name: string;
  /** The Go receiver type as written (`*T`, `T[K]`), or the TypeScript class. */
  receiver?: string;
  qualified: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  signature: string;
  body: string;
}

export interface SymbolDef extends FileSymbol {
  /** `S1`, `S2`, …, by file then line. */
  id: string;
  change: "new" | "modified";
  /** The report item whose citation covers it, when one does. */
  item?: string;
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

/** The TypeScript module path of a file, as the metrics tool names it: the path without its extension. */
export function modulePath(path: string): string {
  return path.replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
}

/** The Go receiver text `r *T[K, V]` as the metrics tool prints it: `(*T[...])`. */
export function goReceiver(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  let type = parts.length > 1 ? parts.slice(1).join(" ") : parts[0] ?? "?";
  let pointer = false;
  type = type.replace(/^\(+|\)+$/g, "");
  if (type.startsWith("*")) {
    pointer = true;
    type = type.slice(1).trim();
  }
  const generic = type.includes("[");
  const bare = type.replace(/\[.*$/, "");
  const named = `${bare}${generic ? "[...]" : ""}`;
  return pointer ? `(*${named})` : named;
}

type Regexes = { definitions: RegExp[]; members: RegExp[]; tests: RegExp[] };
const cache = new WeakMap<FullPack, Regexes>();
function regexesOf(pack: FullPack): Regexes {
  let r = cache.get(pack);
  if (r === undefined) {
    r = { definitions: pack.definitions.map((p) => new RegExp(p)), members: pack.members.map((p) => new RegExp(p)), tests: pack.testNames.map((p) => new RegExp(p)) };
    cache.set(pack, r);
  }
  return r;
}

export const packOf = (packs: readonly FullPack[], path: string): FullPack | undefined => packs.find((p) => matchesGeneratedGlob(p.globs, path));
export const isTestFile = (pack: FullPack | undefined, path: string): boolean => pack !== undefined && pack.testFiles.length > 0 && matchesGeneratedGlob(pack.testFiles, path);

function goPackage(maskedLines: readonly string[]): string {
  for (const line of maskedLines) {
    const m = /^package\s+([A-Za-z_]\w*)/.exec(line);
    if (m !== null) return m[1]!;
  }
  return "";
}

/** A symbol's qualified name, as `gometrics` and `tsmetrics` name functions, so records and symbols join. */
export function qualify(pack: Pick<FullPack, "language">, scope: string, dir: string, kind: string, name: string, receiver: string | undefined, generic: boolean): string {
  if (pack.language === "go") {
    const shown = `${name}${generic && kind === "func" ? "[...]" : ""}`;
    return receiver !== undefined ? `${scope}.${goReceiver(receiver)}.${shown}` : `${scope}.${shown}`;
  }
  if (pack.language === "typescript") return [scope, ...(receiver !== undefined ? [receiver] : []), name].join(".");
  return [dir === "." ? "" : dir.replace(/\//g, "."), ...(receiver !== undefined ? [receiver] : []), name].filter((s) => s !== "").join(".");
}

/** Whether a declaration is something the questions are about: functions, methods and types; constants and variables only when exported (design §7.1). */
export function ofInterest(kind: string, exported: boolean): boolean {
  return kind === "const" || kind === "var" || kind === "let" ? exported : true;
}

/** Every definition of `text`'s file the pack's patterns find, with the lines each covers. */
export function extractSymbols(path: string, text: string, pack: FullPack): FileSymbol[] {
  const rx = regexesOf(pack);
  const masked = maskCode(text);
  const maskedLines = masked.split("\n");
  const rawLines = text.split("\n");
  const depths = depthAtLineStart(masked);
  const scope = pack.language === "go" ? goPackage(maskedLines) : pack.language === "typescript" ? modulePath(path) : "";
  const dir = dirOf(path);
  const out: FileSymbol[] = [];
  const build = (li: number, g: Record<string, string | undefined>, kind: string, receiver: string | undefined): FileSymbol | undefined => {
    const name = g.name;
    if (name === undefined) return undefined;
    const end = declarationEnd(maskedLines, li + 1) ?? li + 1;
    const exported = pack.language === "go" ? /^\p{Lu}/u.test(name) : pack.language === "typescript" ? g.exp !== undefined : true;
    const body = rawLines.slice(li, end).join("\n");
    const head = maskedLines.slice(li, end).join(" ");
    const brace = head.indexOf("{");
    const signature = (brace >= 0 ? head.slice(0, brace) : head).replace(/\s+/g, " ").trim();
    return { path, language: pack.language, scope, dir, kind, name, ...(receiver !== undefined ? { receiver } : {}), qualified: qualify(pack, scope, dir, kind, name, receiver, g.tp !== undefined), exported, startLine: li + 1, endLine: end, signature, body };
  };
  const classes: FileSymbol[] = [];
  for (let li = 0; li < maskedLines.length; li += 1) {
    if ((depths[li] ?? 0) !== 0) continue;
    const line = maskedLines[li]!;
    for (const re of rx.definitions) {
      const m = re.exec(line);
      if (m === null) continue;
      const g = m.groups ?? {};
      const kw = g.kw ?? "symbol";
      const recv = pack.language === "go" && kw === "func" && g.recv !== undefined ? g.recv : undefined;
      const kind = recv !== undefined ? "method" : kw;
      const sym = build(li, g, kind, recv);
      if (sym === undefined) break;
      out.push(sym);
      if (kw === "class") classes.push(sym);
      break;
    }
  }
  // Class members, at the depth just inside a class.
  for (const cls of classes) {
    const inner = (depths[cls.startLine - 1] ?? 0) + 1;
    for (let li = cls.startLine; li < cls.endLine - 1; li += 1) {
      if ((depths[li] ?? 0) !== inner) continue;
      for (const re of rx.members) {
        const m = re.exec(maskedLines[li]!);
        if (m === null) continue;
        const g = m.groups ?? {};
        if (g.name === undefined || NOT_MEMBERS.has(g.name)) continue;
        const sym = build(li, g, g.name === "constructor" ? "constructor" : "member", cls.name);
        // A member has a body: a property or a declaration without one is not a function to ask about.
        if (sym === undefined || !maskedLines.slice(li, sym.endLine).join(" ").includes("{")) continue;
        out.push({ ...sym, exported: cls.exported });
        break;
      }
    }
  }
  // Go: exported constants and variables inside `const ( … )` and `var ( … )` blocks.
  if (pack.language === "go") {
    for (let li = 0; li < maskedLines.length; li += 1) {
      const m = /^(const|var)\s*\(\s*$/.exec(maskedLines[li]!);
      if (m === null) continue;
      for (let lj = li + 1; lj < maskedLines.length && !/^\)/.test(maskedLines[lj]!); lj += 1) {
        const e = /^\s+(\p{Lu}\w*)\b/u.exec(maskedLines[lj]!);
        if (e === null) continue;
        out.push({ path, language: pack.language, scope, dir, kind: m[1]!, name: e[1]!, qualified: qualify(pack, scope, dir, m[1]!, e[1]!, undefined, false), exported: true, startLine: lj + 1, endLine: lj + 1, signature: rawLines[lj]!.trim(), body: rawLines[lj]! });
      }
    }
  }
  return out.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
}

/** The head-side lines a patch changes: every added line, and each deletion by the head line it sits before. */
export function changedHeadLines(parsed: ParsedPatch): { added: Set<number>; deletedBefore: Set<number> } {
  const added = new Set<number>();
  const deletedBefore = new Set<number>();
  let pending = false;
  let lastHead = 0;
  for (const l of parsed.lines) {
    if (l.kind === "del") {
      pending = true;
      continue;
    }
    // A head line that does not follow the last one starts another hunk: the deletion belonged to the end of the last.
    if (pending) deletedBefore.add(lastHead > 0 && l.line !== lastHead + 1 ? lastHead + 1 : l.line);
    pending = false;
    if (l.kind === "add") added.add(l.line);
    lastHead = l.line;
  }
  if (pending) deletedBefore.add(lastHead + 1);
  return { added, deletedBefore };
}

/** Whether the patch changes a line inside the symbol: an added line within it, or a deletion between two of its lines. */
export function touches(sym: Pick<FileSymbol, "startLine" | "endLine">, changed: ReturnType<typeof changedHeadLines>): boolean {
  for (const l of changed.added) if (l >= sym.startLine && l <= sym.endLine) return true;
  for (const l of changed.deletedBefore) if (l > sym.startLine && l <= sym.endLine) return true;
  return false;
}

export interface BaseDefinitions {
  /** Qualified names the base file defines, by path in the base. */
  byPath: Map<string, Set<string>>;
}

/**
 * What a `git grep -n -E <pack.grep> <base> -- <files>` printed, as the
 * qualified names each file defines. The lines come in file order, so a
 * class member belongs to the latest class seen above it.
 */
export function parseBaseDefinitions(output: string, pack: FullPack): BaseDefinitions {
  const rx = regexesOf(pack);
  const byPath = new Map<string, Set<string>>();
  const filesLines = new Map<string, Array<{ line: number; text: string }>>();
  for (const raw of output.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(raw.replace(/^[0-9a-f]{40}:/, ""));
    if (m === null) continue;
    const list = filesLines.get(m[1]!) ?? [];
    list.push({ line: Number(m[2]), text: m[3]! });
    filesLines.set(m[1]!, list);
  }
  for (const [path, lines] of filesLines) {
    const names = new Set<string>();
    const dir = dirOf(path);
    let scope = pack.language === "typescript" ? modulePath(path) : "";
    let cls: string | undefined;
    let block: string | undefined;
    for (const { text } of lines) {
      const masked = maskCode(text);
      if (pack.language === "go") {
        const p = /^package\s+([A-Za-z_]\w*)/.exec(masked);
        if (p !== null) {
          scope = p[1]!;
          continue;
        }
        const b = /^(const|var)\s*\(\s*$/.exec(masked);
        if (b !== null) {
          block = b[1]!;
          continue;
        }
        if (block !== undefined && /^\)/.test(masked)) block = undefined;
        const e = /^\s+(\p{Lu}\w*)\b/u.exec(masked);
        if (e !== null && block !== undefined) {
          names.add(qualify(pack, scope, dir, block, e[1]!, undefined, false));
          continue;
        }
      }
      let matched = false;
      for (const re of rx.definitions) {
        const m = re.exec(masked);
        if (m === null) continue;
        const g = m.groups ?? {};
        const kw = g.kw ?? "symbol";
        if (g.name === undefined) continue;
        const recv = pack.language === "go" && kw === "func" && g.recv !== undefined ? g.recv : undefined;
        names.add(qualify(pack, scope, dir, recv !== undefined ? "method" : kw, g.name, recv, g.tp !== undefined));
        if (kw === "class") cls = g.name;
        matched = true;
        break;
      }
      if (matched) continue;
      if (cls !== undefined) {
        for (const re of rx.members) {
          const m = re.exec(masked);
          const name = m?.groups?.name;
          if (name === undefined || NOT_MEMBERS.has(name)) continue;
          names.add(qualify(pack, scope, dir, "member", name, cls, false));
          break;
        }
      }
    }
    byPath.set(path, names);
  }
  return { byPath };
}

export interface ChangedFile {
  path: string;
  /** The path in the base, for a rename. */
  previousPath: string | null;
  status: string | null;
  parsed: ParsedPatch;
  /** The head file's text, when the graph observed it. */
  text: string | undefined;
}

/**
 * The symbols the pull request adds or modifies in one file. With the base
 * file's definitions, a touched symbol is new when the base does not define
 * its qualified name. Without them (the base could not be read), the patch
 * decides: a symbol whose definition line is added and whose name no
 * deleted line defines is new.
 */
export function changedSymbols(file: ChangedFile, pack: FullPack, base: ReadonlySet<string> | undefined): Array<FileSymbol & { change: "new" | "modified" }> {
  if (file.text === undefined || file.status === "removed") return [];
  const all = extractSymbols(file.path, file.text, pack);
  const changed = changedHeadLines(file.parsed);
  const rx = regexesOf(pack);
  const deletedNames = new Set<string>();
  for (const l of file.parsed.lines) {
    if (l.kind !== "del") continue;
    const masked = maskCode(l.text);
    for (const re of [...rx.definitions, ...rx.members]) {
      const n = re.exec(masked)?.groups?.name;
      if (n !== undefined) deletedNames.add(n);
    }
  }
  const out: Array<FileSymbol & { change: "new" | "modified" }> = [];
  for (const s of all) {
    if (!ofInterest(s.kind, s.exported)) continue;
    if (!touches(s, changed)) continue;
    let isNew: boolean;
    if (file.status === "added") isNew = true;
    else if (base !== undefined) isNew = !base.has(s.qualified);
    else isNew = changed.added.has(s.startLine) && !deletedNames.has(s.name);
    out.push({ ...s, change: isNew ? "new" : "modified" });
  }
  return out;
}
