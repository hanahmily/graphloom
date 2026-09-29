/**
 * Write scope entries, relative to the workspace root:
 * - `path` allows that file or directory and everything below it;
 * - `.` allows the whole workspace;
 * - `!path` forbids that file or directory and everything below it, even
 *   when another entry allows it.
 */

/** The canonical relative form of an entry: no `.` segments or repeated slashes; the root is `.`. */
function normalize(entry: string): string {
  if (entry.startsWith("/")) return entry;
  const segments = entry.split("/").filter((s) => s !== "" && s !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

function covers(entry: string, rel: string): boolean {
  return entry === "." || rel === entry || rel.startsWith(`${entry}/`);
}

/** Whether a scope lets a job change `rel`. */
export function writeScopeAllows(rel: string, scope: readonly string[]): boolean {
  let allowed = false;
  for (const raw of scope) {
    if (raw.startsWith("!")) {
      if (covers(normalize(raw.slice(1)), rel)) return false;
    } else if (covers(normalize(raw), rel)) {
      allowed = true;
    }
  }
  return allowed;
}

/** Entries that allow paths, without exclusions. */
export function writeScopeIncludes(scope: readonly string[]): string[] {
  return scope.filter((entry) => !entry.startsWith("!")).map(normalize);
}

/** Entries that forbid paths, without their `!`. */
export function writeScopeExcludes(scope: readonly string[]): string[] {
  return scope.filter((entry) => entry.startsWith("!")).map((entry) => normalize(entry.slice(1)));
}

/** Why a scope is malformed, or undefined when it is usable. */
export function writeScopeProblem(scope: readonly string[]): string | undefined {
  for (const raw of scope) {
    const body = raw.startsWith("!") ? raw.slice(1) : raw;
    if (body.length === 0) return `write scope entry ${JSON.stringify(raw)} names no path`;
    const entry = normalize(body);
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      return `write scope entry ${JSON.stringify(raw)} must stay inside the workspace`;
    }
    if (raw.startsWith("!") && entry === ".") return "write scope cannot exclude the whole workspace";
  }
  if (writeScopeIncludes(scope).length === 0) return "write scope allows no paths";
  return undefined;
}
