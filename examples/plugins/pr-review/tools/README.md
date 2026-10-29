# pr-review metrics tools

Static code metrics for the pr-review graph, defined in
[code quality metrics](../../../../docs/design-code-quality-metrics.md) (§1 scope,
§2.1 complexity, §2.2 nesting, §2.4 CRAP, §5 records) and used by the
Measurements section of the [pr-review design](../../../../docs/design-pr-review-graph.md#68-measurements).
They parse; they never execute the measured code.

| Tool | Where | Run |
|---|---|---|
| `gometrics` | `tools/gometrics/` (Go standard library only, no `require`) | `go run . --head <dir> --hunks <file> [--generated <globs>]` |
| `tsmetrics` | `src/metrics/tsmetrics*.ts`, built to `dist/metrics/tsmetrics-cli.js` | `node dist/metrics/tsmetrics-cli.js --head <dir> --hunks <file> [--generated <globs>]` |

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
- Coverage and `crap` are added from the sandbox's coverage report (below); `mutation` by a later stage.

Names: Go `pkg.Func`, `pkg.Recv.Method`, `pkg.(*Recv).Method`, type
parameters as `[...]`. TypeScript `<module path>.<Class>.<member>`, with the
module path being the repository path without its extension. Closures are
`<enclosing>.func<n>`, numbered per enclosing function in source order. A
package-level or module-level literal belongs to `<pkg|module>.glob`.

## Coverage tools (run in the Docker sandbox)

Unlike the static tools, these run the measured repository's own tests, so they run only inside the Docker
sandbox ([pr-review design §12.2](../../../../docs/design-pr-review-graph.md#122-confinement)), over a
checkout of the head. Each is a plugin script, mounted read-only into the container, that writes a
`graphloom-coverage-v1` report to `$GRAPHLOOM_REPORT_FILE` and exits 0 once it has (the report carries the test
command's exit status):

| Script | Runs | Needs |
|---|---|---|
| `tools/cover/go.sh <n> <spec chunk…>` | `go test -coverprofile -covermode=set -coverpkg=<touched> <touched>` once per module, then `goprofile.awk` reduces the profile to the changed functions | the image's `go`, the host module cache (read-only), `GOFLAGS=-mod=readonly GOPROXY=off GOTOOLCHAIN=local` |
| `tools/cover/ts.sh <n> <spec chunk…>` | the repository's own `vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=json` in one workspace, installing its locked dependencies first with `npm ci --offline --ignore-scripts` when the checkout has no `node_modules`; `dist/metrics/tscover-cli.js` reduces `coverage-final.json` | the image's `node` and `npm`, the host npm cache (read-only); `@vitest/coverage-v8` in the repository, at vitest's major |

The spec (`pkg`, `ws`, `file`, `fn` lines; `formatSpec` in `src/metrics/coverage.ts`) travels in the command's
argv. `src/metrics/coverage.ts` also holds the report parser and the attribution that the graph and the
`measurements` validator share. `awk -f tools/cover/goprofile.awk -v mp=<module path> -v root=<module root> spec.txt cover.out` runs on its own.

## Library and validation

`src/metrics/` is the shared library, exported as `@graphloom/plugin-pr-review/metrics`.
Everything in it except `tsmetrics.ts` is dependency-free so it can be vendored
into the issue-fix review kit:

- `record.ts`: the record types, decision and nesting kinds, `isTestPath`.
- `crap.ts`: `crapValue`, `crapRounded`, `checkThresholds` (complexity < 10,
  nesting <= 3, CRAP 30, and the unknown-coverage rule).
- `validate.ts`: `validateMetricsDocument`, the §5 recomputation. It rejects,
  never corrects.
- `hunks.ts`, `generated.ts`, `scope.ts`: hunk files and diffs, generated-file
  detection, and the one changed-function rule that tools and validator share.

## Tests

`npm test -w @graphloom/plugin-pr-review` runs the vitest suite, which also
runs `go test` for `gometrics` (skipped with a warning when `go` is not on
`PATH`). `gometrics` is checked against gocyclo on `tools/gometrics/testdata/corpus`:
`testdata/gocyclo-expected.json` holds gocyclo's numbers, produced once with

```sh
cd tools/gometrics/testdata/corpus
go run github.com/fzipp/gocyclo/cmd/gocyclo@latest .
```

gocyclo counts a function literal inside its enclosing function, while the
spec measures it separately, so the test compares gocyclo's number with the
function's own complexity plus that of its nested closures. gocyclo is not a
dependency of the tool.

## Known limits

- `added` is decided from the hunks alone: a function whose every line is in
  the hunks. A renamed or moved function reads as added.
- TypeScript logical assignment (`&&=`, `||=`, `??=`) is not a decision point;
  §2.1 lists `&&`, `||` and `??` only.
- A closure's name depends on its position in the file, so adding a closure
  before it renames the later ones.
- Class static blocks are not functions; their decisions are not measured.
- The validator's own index check for Go is textual (a column-0 `func` line
  must be an indexed start line, so a raw string with such a line is a false
  reject); pass `reindex` (a second, independent index) for the full check.
- `hunksFromUnifiedDiff` needs a well-formed `-U0` diff, since it counts hunk
  body lines to tell added `+++ ` text from file headers.
- Keyword evidence is textual: the validator checks that the line holds the
  keyword, not that it is code rather than a comment or string.
