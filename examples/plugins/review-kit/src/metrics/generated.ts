// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Generated-file detection (design-code-quality-metrics.md §1): profile globs
// and Go's `// Code generated ... DO NOT EDIT.` header.

/** `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        i++;
        if (glob.charAt(i + 1) === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/** A glob without a slash also matches the file's base name. */
export function matchesGeneratedGlob(globs: readonly string[], path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return globs.some((glob) => {
    const re = globToRegExp(glob);
    return re.test(path) || (!glob.includes("/") && re.test(base));
  });
}

const GENERATED_HEADER = /^\/\/ Code generated .* DO NOT EDIT\.$/;

/**
 * Go: the marker line must come before the package clause. Other languages:
 * the marker (or `@generated`) within the first ten lines.
 */
export function hasGeneratedHeader(language: "go" | "typescript", source: string): boolean {
  const lines = source.split("\n");
  if (language === "go") {
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (/^package\s/.test(line)) return false;
      if (GENERATED_HEADER.test(line)) return true;
    }
    return false;
  }
  return lines.slice(0, 10).some((line) => /Code generated .* DO NOT EDIT|@generated\b/.test(line));
}

export function isGeneratedSource(
  path: string,
  language: "go" | "typescript",
  source: string,
  globs: readonly string[],
): boolean {
  return matchesGeneratedGlob(globs, path) || hasGeneratedHeader(language, source);
}
