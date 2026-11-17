# pr-design-review metrics tools

Static code metrics for the pr-design-review graph (complexity and nesting only: coverage, CRAP and mutation are `pr-review`'s; a copy of `pr-review`'s `tools/gometrics`), defined in
[code quality metrics](../../../../docs/design-code-quality-metrics.md) (§1 scope,
§2.1 complexity, §2.2 nesting, §2.4 CRAP, §5 records) and used by the
Measurements section of the [design review](../../../../docs/design-pr-design-review.md#6-measurements-in-round-1).
They parse; they never execute the measured code.

| Tool | Where | Run |
|---|---|---|
| `gometrics` | `tools/gometrics/` (Go standard library only, no `require`) | `go run . --head <dir> --hunks <file> [--generated <globs>]` |
| `tsmetrics` | `src/kit/metrics/tsmetrics.ts` with the entry `src/metrics/tsmetrics-cli.ts`, built to `dist/metrics/tsmetrics-cli.js` | `node dist/metrics/tsmetrics-cli.js --head <dir> --hunks <file> [--generated <globs>]` |

`tsmetrics` loads the `typescript` package (a dependency of this package, as
of `@graphloom/cli`) and nothing else.

## Inputs

- `--head`: the head checkout.
- `--hunks`: a file (or `-` for stdin) of head-side changed line ranges, one
  `path:start-end` (or `path:line`) per line, 1-based, inclusive. Build it from
  `git diff -U0 -w <base> <head>` with `hunksFromUnifiedDiff` and
  `formatHunkFile`; with `-w`, a whitespace-only change is not a hunk, so it
  does not make a function modified.
- `--generated`: comma-separated profile globs (`**` crosses directories; a
  glob without `/` also matches the base name). A file matching one, or
  carrying Go's `// Code generated ... DO NOT EDIT.` header before the package
  clause (TypeScript: that marker or `@generated` in the first ten lines), is
  skipped.

## Output

One `graphloom-metrics-v1` document:

```json
{ "schema": "graphloom-metrics-v1", "tool": "gometrics",
  "records": [ { "path": "pkg/ttl.go", "function": "schema.(*T).Parse", "startLine": 14, "endLine": 61,
                 "change": "added", "test": false, "complexity": 3,
                 "decisions": [{ "line": 18, "kind": "if" }, { "line": 18, "kind": "&&" }],
                 "nesting": 1, "nestingPath": [{ "line": 18, "kind": "if" }] } ],
  "files": [ { "path": "pkg/ttl.go", "language": "go", "test": false,
               "functions": [["schema.(*T).Parse", 14, 61]] } ],
  "skipped": [ { "path": "pkg/x.pb.go", "reason": "generated" } ] }
```

- `records`: one per function the change adds or modifies (§1). `change` is
  `added` when every line of the function is in the hunks, otherwise
  `modified` when one of its own lines is. A function's own lines exclude the
  interior of nested closures; a closure's first and last lines are shared
  with its enclosing function. `test` marks test files, which carry
  complexity and nesting only.
- `files`: every function of each changed, measured file as
  `[name, startLine, endLine]`, closures included, so scope can be checked.
- `skipped`: `generated`, `unsupported-language` or `not-in-head`.
- This graph takes no coverage, `crap` or `mutation`: `pr-review` measures them in its Docker sandbox.

Names: Go `pkg.Func`, `pkg.Recv.Method`, `pkg.(*Recv).Method`, type
parameters as `[...]`. TypeScript `<module path>.<Class>.<member>`, with the
module path being the repository path without its extension. Closures are
`<enclosing>.func<n>`, numbered per enclosing function in source order. A
package-level or module-level literal belongs to `<pkg|module>.glob`.

