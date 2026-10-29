# Code quality metrics

Status: proposed, 2026-10-28. Not implemented.

This document defines four metrics once, so that every graph measures the
same thing:

- cyclomatic complexity;
- nesting depth;
- CRAP;
- mutation survival.

Graphs differ only in what they do with a measurement:

| Graph | Use |
|---|---|
| [pr-review](design-pr-review-graph.md) | Facts in the change report's Measurements section, and questions for the author. Never a rejection |
| [issue-fix](design-issue-fix-graph.md) | Gates on the graph's own change, designed in the issue-fix document |

The thresholds are the operator's ("ub-mode") rules. A profile may tighten
them but not loosen them.

## 1. Scope: changed functions only

A metric applies only to a function that the change **adds or modifies**. A
function counts as modified when any of its body or signature lines on the
head side are added or changed in the diff. Untouched legacy code is never
measured, even in a changed file. The scope also excludes:

- **Deleted functions.** They are reported by the change report, not
  measured.
- **Generated files.** These are files matching the profile's `generated`
  globs, or starting with Go's `// Code generated … DO NOT EDIT.` line.
- **Test files**, from coverage, CRAP and mutation. Tests are the
  instrument, not the subject. Test files are still measured for complexity
  and nesting.

Function identity is the language-qualified name: the package (Go) or the
module path (TypeScript), the receiver or class, and the name. A closure or
function literal is its own function, named `<enclosing>.func<n>` in source
order, as Go's runtime names them.

## 2. Definitions

### 2.1 Cyclomatic complexity, `comp(m)`

`comp(m)` is 1 plus the number of decision points in the function's own body.
Nested function literals are excluded, since they are measured on their own.

| Decision point | Go | TypeScript |
|---|---|---|
| Conditional branch | `if` (each `else if` too) | `if` (each `else if` too), `?:` |
| Loop | `for` (all forms) | `for`, `for…in`, `for…of`, `while`, `do…while` |
| Case | each `case` and `select` `case` with an expression or channel; not `default` | each `case` with a test; not `default` |
| Short-circuit | each `&&`, `\|\|` | each `&&`, `\|\|`, `??` |
| Exception | — | each `catch` |

The Go column is gocyclo's counting rule
([fzipp/gocyclo](https://github.com/fzipp/gocyclo)). Its tests compare the
plugin tool with gocyclo on a fixture corpus. The TypeScript column is fixed
here rather than borrowed from a linter, so a linter upgrade cannot change a
gate.

**Rule:** `comp(m) < 10`.

### 2.2 Nesting depth

Nesting depth is the deepest chain of nested control blocks in the
function's own body, where a body with no control block has depth 0:

- `if`, `for`/loops, `switch`, `select` and `try` each add one level.
- An `else if` or `else` stays at its `if`'s level.
- A `case` clause does not add a level beyond its `switch`.
- Bare `{}` blocks and function literals add nothing; a literal is measured
  as its own function.

**Rule:** `depth(m) <= 3`.

### 2.3 Coverage, `cov(m)`

`cov(m)` is the fraction, from 0 to 1, of the function's executable statements
that the tests of the touched packages executed, in a checkout of the head
inside the Docker sandbox (§4).

- **Go:** `go test -coverprofile -covermode=set -coverpkg=<touched packages>
  <touched packages>`. A statement is covered when its coverprofile block is
  covered. Blocks are attributed to a function by line range.
- **TypeScript:** the repository's own vitest, run as `vitest run
  --coverage.enabled --coverage.provider=v8 --coverage.reporter=json` in
  each touched workspace. The provider is
  [`@vitest/coverage-v8`](https://vitest.dev/guide/coverage), the one
  approved third-party metrics tool (§3), installed in the repository's own
  dependencies at the repository's vitest major version. Beyond those flags
  the plugin adds three things and nothing else:
  `--coverage.reportsDirectory` under the job's temporary directory, so
  `coverage-final.json` and every other report file land outside the
  checkout; `--coverage.include` naming the changed non-test files, so a
  file no test loads is reported with zero hits rather than left out; and a
  generated config (§3.1) that moves vitest's cache out of the checkout.
  `coverage-final.json` is Istanbul's format, and `cov(m)` is **statement
  coverage** over it: the statements of `statementMap` whose start line
  falls in the function's line range, less those inside a nested function
  literal, which belong to that literal; a statement is covered when its `s`
  count is above zero. `@vitest/coverage-v8` converts V8's byte ranges into
  one Istanbul statement per executable source line, so these statements
  are line-granular, and every TypeScript record's `coverage` says so
  (`"unit": "line-statement", "provider": "@vitest/coverage-v8@<version>"`).
  - **No provider, no coverage.** GraphLoom never installs the provider into
    a measured repository, at run time or otherwise. When
    `@vitest/coverage-v8` does not resolve from the workspace, the tool does
    not start vitest, which would otherwise offer to install it, and the
    record says `not run (no vitest coverage provider in the repository)`.
    When its major version differs from the workspace's vitest, the record
    says `not run (@vitest/coverage-v8 <x> does not match vitest <y>)`.

When coverage was not measured, the record says `unknown` with the reason,
for example "coverage disabled by the profile", "docker unavailable",
"image not available", "package did not build offline" or "no vitest
coverage provider in the repository". CRAP then uses `cov = 0`, stated as the
**upper bound**. A test that fails in the confined run does not void the
coverage of the tests that ran. The failures are recorded as facts.


### 2.4 CRAP

```text
CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)
```

**Threshold:** 30. The value is always reported with its coverage source:
`measured`, or `unknown (upper bound, cov = 0)`. At `cov = 0` the formula is
`comp^2 + comp`, so any function with `comp >= 5` reaches 30 when coverage is
unknown. Records say so rather than leaving the reader to infer it.

**Unknown-coverage rule.** With unknown coverage, the upper-bound CRAP is
always *shown*. It *triggers* follow-up only when `comp >= 10`, where the
complexity rule already applies. Below that, an upper bound of 30 or more
reflects the missing measurement, not the function. With measured coverage,
`CRAP >= 30` triggers follow-up as stated. A graph's follow-up is its own:
pr-review asks a question, and issue-fix applies a gate.

### 2.5 Mutation testing

Mutation testing applies **operator inversion**, the operator's rule
("把 > 改成 <=，把 true 改成 false"), to the changed functions only. Each
operator site gives exactly one **mutant**, applied one at a time. Each mutant
runs the tests of the touched packages in the Docker sandbox (§4).

| Operator | Mutation (each direction) |
|---|---|
| Relational inversion | `<` ↔ `>=`, `>` ↔ `<=`, `==` ↔ `!=` |
| Boolean literal flip | `true` ↔ `false` |

Inversion is the logical complement: `a > b` becomes `a <= b`, never
`a >= b`. In TypeScript, `===` ↔ `!==` is the same inversion as `==` ↔ `!=`.

**The operator set is exactly this rule.** Statement removal, return-value
replacement, arithmetic swaps, condition negation and every other operator
are excluded. Adding one changes what "no surviving mutant" means for every
graph and every profile, so it is a design decision that needs the operator's
approval. It is not a profile setting.

Each mutant has exactly one outcome:

| Outcome | Meaning |
|---|---|
| `killed` | A test failed |
| `timeout` | The tests ran past three times the baseline duration (at least 30 s). Counted as killed |
| `survived` | All tests passed. The covering tests do not assert the mutated behaviour |
| `invalid` | The mutant did not compile (rare for inversions, for example a constant expression the compiler checks). Excluded from the score |
| `not-run` | The time budget ran out first. Listed, with the reason |

**Mutation score** = (killed + timeout) / (killed + timeout + survived).

**Rule:** no surviving mutant.

A survivor may be *equivalent*: a mutation that changes no observable
behaviour, for example inverting a condition whose two branches do the same
thing, or `x == nil` → `x != nil` on a value that is never nil and whose
both outcomes are handled alike. Only a
reader can tell, so a survivor is never dropped automatically. A graph may
record a reasoned "possibly equivalent" claim that an independent checker
verifies.

## 3. Tools

These are the plugin defaults. A profile can override `argv` per language,
but the definitions above stay fixed.

| Metric | Go | TypeScript |
|---|---|---|
| Complexity, nesting | `gometrics`: a small stdlib-only `go/ast` program in the plugin's source | `tsmetrics`: a Node script on the TypeScript compiler API |
| Coverage | `go test -coverprofile` | The repository's own `vitest run --coverage` with `@vitest/coverage-v8` from its own dependencies (§2.3) |
| Mutation | `gomutate`: a stdlib-only `go/ast` mutator that implements exactly the §2.5 inversions and runs `go test -overlay` | `tsmutate`: a Node script on the TypeScript compiler API that implements exactly the §2.5 inversions and serves each mutant to the repository's own vitest through a Vite `load` hook (below) |

`tsmetrics` and `tsmutate` load the `typescript` package that GraphLoom
already ships as a runtime dependency of the CLI
([`apps/graphloom/package.json`](../apps/graphloom/package.json),
[release design](design-release.md)). They add no package to GraphLoom.

**Third-party tools need the operator's approval.** The metrics toolchain is
the plugin's own tools, the language toolchains (`go`, `node`), the
`typescript` package GraphLoom already ships, the measured repository's own
test runner (vitest), and the approved third-party tools listed below.
Adding a third-party tool to it, such as a mutation framework, a coverage
wrapper or a linter, is a design decision that needs the operator's
approval, as adding a mutation operator is (§2.5). It is not a profile
setting, and a design may not add one on its own.

Approved third-party metrics tools:

| Tool | Approved for | Reason | Version rule |
|---|---|---|---|
| [`@vitest/coverage-v8`](https://github.com/vitest-dev/vitest/tree/main/packages/coverage-v8) | TypeScript coverage (§2.3) | Vitest's official coverage package, from the same project as vitest; it reads V8's own coverage inside the repository's test run, so nothing wraps or replaces the runner. Approved explicitly by the operator | Must match the repository's vitest major version. It is a dependency of the measured repository (GraphLoom's own included), never installed by GraphLoom into a target repository |

It is the only one.

### 3.1 `tsmutate`

`tsmutate` is `gomutate`'s TypeScript counterpart. It takes the same inputs
(the diff hunks, the head files, the coverage report, the caps, the seed and
the time budget) and writes the same `graphloom-metrics-v1` mutation fields.

- **Sites.** It parses each changed non-test file with the compiler API and
  walks only the changed functions of §1, skipping nested function literals,
  which are their own functions. A site is a `BinaryExpression` whose
  operator token is `<`, `>=`, `>`, `<=`, `==`, `!=`, `===` or `!==`, or a
  `TrueKeyword` or `FalseKeyword` in expression position. Literal types
  (`x: true`, `T extends false ? …`) are types, not values, and never sites.
  Each site yields exactly one mutant, its §2.5 inversion, and nothing else
  is ever produced.
- **One mutant at a time.** The mutated text is the head file with that one
  token replaced, at the token's own offsets, so every other byte is
  unchanged. It is parsed again first; a syntax error makes the mutant
  `invalid` without a test run.
- **Identity, caps, sampling, clock.** As `gomutate`: the mutant id hashes
  `path`, `function`, `operator`, `original`, `mutated` and the occurrence
  index, not the line; the same per-function and per-change caps,
  deterministic round-robin sample, per-mutant timeout of three times the
  baseline (at least 30 s), and time budget
  ([issue-fix](design-issue-fix-graph.md#mutation-time-budget)). Sites the
  coverage run did not execute are `not-run (uncovered)` (§4).
- **Tests.** Each mutant runs the touched workspace's own vitest, the
  repository's installed binary, as `vitest run --bail=1 --config <generated
  config> --root <workspace>`. The first failing test kills the mutant.

**The overlay mechanism.** The checkout is never written. For each mutant,
`tsmutate` writes the mutated file and a generated vitest config into its own
directory under the job's temporary directory. The generated config imports
the workspace's own config file by absolute path, if it has one, resolves it
when it is a function, and returns it with two changes:

- one Vite plugin prepended, `enforce: "pre"`, whose `load(id)` hook
  returns the mutated text when `id` is the absolute path of the mutated
  file and defers to the normal load for every other module;
- `cacheDir` under the job's temporary directory, so vitest's results cache
  is not written into the checkout.

The coverage run (§2.3) uses the same generated config without the plugin.
The generated config imports nothing but the repository's config, so it
resolves from the temporary directory.

Vite resolves every import of the module, whatever its specifier
(`./ttl.js`, `../src/ttl`, a workspace package name through a symlink), to
the one absolute path before it calls `load`, and the mutated text then goes
through the repository's own transform pipeline (TypeScript stripping, JSX,
its plugins). This is `go test -overlay` for vitest: one substitution, keyed
by the real file, inside the repository's own test run. A fresh vitest
process per mutant has a fresh in-memory transform cache, so no mutant can
leak into the next run.

Two alternatives were rejected:

- *A `resolve.alias` entry.* An alias matches import specifiers, not files,
  so every specifier that reaches the module would need its own entry, and a
  missed one silently tests the unmutated file. The resolved path is the one
  key that cannot be missed.
- *A copy of the package under the temporary directory.* It breaks
  `node_modules` resolution, workspace links, `tsconfig` paths and test
  fixtures found relative to the source, and it costs a copy per mutant.

A test that reads the source file's bytes from disk (rather than importing
it) sees the unmutated file, and so cannot kill that mutant; the mutant
survives and is reported, never dropped. The clean-run rule holds: a check
that changes a checkout file fails, as for any check.

### 3.2 Why these tools

Both languages use the plugin's own tools, for the same reasons:

- **The exact operator set.** The mutators implement §2.5 and nothing else,
  so "no surviving mutant" means the operator's rule. The external mutators
  (gremlins and go-mutesting for Go, mutation frameworks for TypeScript)
  have operator sets and scoping that differ from it, and fitting one to it
  means filtering or patching a tool the supervisor cannot repair inside a
  run.
- **Line-level evidence.** One parser per language yields complexity,
  nesting, and the decision and nesting *evidence* that recomputation needs
  (§5). The same parser finds the mutation sites in the changed functions'
  line ranges, so every survivor names its line, operator and exact text.
- **No checkout writes.** `go test -overlay` and the Vite `load` hook
  substitute the mutated file without writing the checkout. The "checks
  change no file" rule therefore holds, an interrupted run leaves nothing
  behind, and mutants run one after another in one checkout.
- **Repairable plugin source.** The tools are plugin source, vendored with
  the review kit
  ([pr-review §14](design-pr-review-graph.md#14-sharing-code-with-issue-fix)),
  so they are source-repairable and pinned with the plugin.
- **Offline in the Docker sandbox.** The Go tools are stdlib-only, so `go
  run` builds them offline inside the confinement. The TypeScript tools need
  only Node, the shipped `typescript`, and the repository's own installed
  vitest and `@vitest/coverage-v8`, so nothing is downloaded in a
  `--network none` job.
- **No unapproved third-party dependency.** Coverage is the language's own
  (`go test -coverprofile`) or vitest's official provider, the one approved
  tool, installed by the repository itself. No mutation framework or
  coverage wrapper is added to GraphLoom or to a measured repository.

gocyclo stays as a cross-check in `gometrics`' tests. A test fixture for each
mutator fails if any mutant outside §2.5 appears.

## 4. Execution and confinement

| Measurement | Executes PR code? | Where it runs |
|---|---|---|
| Complexity, nesting | No. The plugin's tool parses only | A read-only bwrap command with no network, over the head tree. It always runs, on every profile, with or without Docker |
| Coverage, mutation | Yes: the PR's tests | Only in the **Docker sandbox**: one `docker run` per job with `--network none`, `--cpus`, `--memory` (equal `--memory-swap`), `--pids-limit`, a read-only root, a sized tmpfs `/tmp`, the operator's uid and gid, `--cap-drop ALL`, `no-new-privileges`, `--pull never`, and an image pinned by digest. The candidate checkout and a per-run build cache are its only writable mounts. Dependency caches are mounted read-only, and no credentials, host environment or host home are passed. The limits are profile data (`metrics.sandbox`); its CPU and memory defaults are the ones the issue-fix banyandb-ql `bench-gates` command already uses. Each run has its own switch, `metrics.coverage` and `metrics.mutation.enabled`. The defaults are the graph's; pr-review turns both on |

Images are checked, and pulled by digest if missing, before the run's first
sandboxed job, never during one. The full sandbox and its residual risks are
specified in [pr-review §12.2](design-pr-review-graph.md#122-confinement).
When a switch is off, Docker or its daemon is unavailable, the image is
missing, or a dependency is not in the cache, the record says `not run` with
the reason, and CRAP uses the upper bound (§2.4). PR code never runs outside
the sandbox.

**Ordering.** Coverage runs first, and mutation uses its result. Mutants are
generated only at sites that the coverage run executed. A site no test
executed would survive by construction, so it is recorded
`not-run (uncovered)` and left to the missing-test follow-up instead of
costing a test run. When coverage did not run, mutation does not run either
(`not run: no coverage`).

Mutation runs within `metrics.mutation.timeBudgetMs` (default 30 minutes per
run):

- mutants are visited function by function in source order, one operator
  site at a time, so a cut-off still covers every function a little;
- each mutant costs one test run of the touched packages.

The estimates below are for BanyanDB-sized Go packages:

- the coverage run of the touched packages takes 2 to 15 minutes;
- each relational operator and boolean literal at a covered site gives one
  mutant, typically 2 to 8 per changed function, so a PR of 10 to 30 changed
  functions has about 20 to 150 mutants;
- a mutant takes 10 to 40 seconds after the first build, so the 30-minute
  default fits about 45 to 180 mutants.

Most PRs therefore finish inside the budget. A larger one ends with
`not-run` mutants listed.

## 5. Records and recomputation

Every tool emits `graphloom-metrics-v1`, one record per changed function:

```json
{ "path": "pkg/schema/ttl.go", "function": "schema.ParseTTL", "startLine": 14, "endLine": 61,
  "change": "added",
  "complexity": 12, "decisions": [{ "line": 18, "kind": "if" }, { "line": 18, "kind": "&&" }],
  "nesting": 4, "nestingPath": [{ "line": 20, "kind": "for" }, { "line": 22, "kind": "if" }],
  "coverage": { "source": "measured", "covered": 21, "total": 30 },
  "crap": 12.06,
  "mutation": { "status": "run", "killed": 9, "timeout": 0, "invalid": 1,
    "survivors": [{ "line": 27, "operator": "relational-inversion", "original": "n > max", "mutated": "n <= max" }] } }
```

A graph accepts a measurement only after deterministic recomputation from
evidence:

- `complexity` is 1 plus the number of listed decisions, and each decision's
  line holds its keyword or operator in the head file's bytes;
- `nesting` is the length of `nestingPath`, each step's line holds its
  keyword, and the lines increase;
- `coverage` follows from the coverprofile (Go) or `coverage-final.json`
  (TypeScript), attributed by line range as §2.3 states;
- `crap` is recomputed with the formula;
- each survivor's `original` text is on its line, and `mutated` differs from
  it at exactly one site, by exactly that site's §2.5 inversion: `<`/`>=`,
  `>`/`<=`, `==`/`!=` (`===`/`!==`) or `true`/`false`. Any other difference
  rejects the record;
- the set of measured functions equals the changed functions of §1.

A record that does not recompute is rejected, never corrected by hand.

### 5.1 Static tool output (implemented in P1)

The static tools (`gometrics`, `tsmetrics`, source under
`examples/plugins/pr-review`, see its `tools/README.md`) settle points that
§1 to §5 left open:

- **Document.** A tool prints one `graphloom-metrics-v1` document:
  `records` (the §5 records, plus a `test` flag), `files` (an index of every
  function of each changed, measured file as `[name, startLine, endLine]`,
  closures included) and `skipped` (`generated`, `unsupported-language`,
  `not-in-head`). Scope recomputation needs the index.
- **Inputs.** Head-side changed line ranges (`path:start-end`), from
  `git diff -U0 -w`, so whitespace-only edits never modify a function.
- **Added versus modified.** `added` when every line of the function is in
  the hunks, else `modified`. A function's own lines exclude the interior of
  nested closures; a closure's first and last lines belong to both it and
  its enclosing function.
- **Names.** Go as the runtime prints them (`pkg.(*T).M`, type parameters
  as `[...]`); closures `<enclosing>.func<n>`, numbered per enclosing
  function; package-level literals under `<pkg>.glob`. TypeScript:
  `<repo path without extension>.<Class>.<member>`.
- **Nesting evidence.** `nestingPath` is the first deepest chain; its lines
  must not decrease (two blocks may share a line in TypeScript).
- **TypeScript logical assignment** (`&&=`, `||=`, `??=`) is not counted,
  since §2.1 lists only `&&`, `||` and `??`.
- **Coverage of an empty function.** With no executable statements,
  `cov = 1`.

### 5.2 Coverage as implemented in P1

The pr-review graph measures coverage as [pr-review §12.2](design-pr-review-graph.md#122-confinement) lists
("As built for coverage"). Points that §2.3 left open:

- **Report.** A coverage command writes `graphloom-coverage-v1`, line-based text: the test command's exit
  status and result lines, then the facts, reduced inside the sandbox to the changed functions' line ranges so
  that they fit a 64 KiB command report. Go: one `B <path>:<l>.<c>,<l>.<c> <statements> <count>` line per block;
  TypeScript: one `S <path> <line> <count>` line per statement. The report is what the graph recomputes
  coverage from; no coverage value is stored anywhere else.
- **Go, several modules and test binaries.** `go test` runs once per module that holds a touched package, with
  `-coverprofile -covermode=set -coverpkg=<its touched packages> <them>`. With several test binaries it appends one
  profile after another, so a block can occur once per binary; it counts once and is covered when any occurrence
  is. Module-path prefixes become repository paths.
- **Whose block.** A block belongs to the innermost function that holds its start line. Go starts a nested
  function's body block on the line of its opening brace, so a nested function owns its first line and not its
  last; TypeScript statements are whole lines, so a nested function's boundary lines are its enclosing function's
  statements. A nested function on one line owns nothing.
- **Empty and absent.** A function whose file the tool knew but that holds no statement has `cov = 1`. A file the
  tool did not know is `not run`: its package did not build offline (named), has no test files (named), or no
  test ran.
- **Not run.** Docker or its daemon unavailable, the image missing and not pullable, no cache directory on the
  host, a package that did not build, no coverage provider, a mismatched major (`not run (@vitest/coverage-v8
  <range> does not match vitest <range>)`), dependencies not installable offline, a report that did not fit:
  each is a per-function reason, and the unknown-coverage rule applies.
- **Limits.** At most 8 TypeScript workspaces per run, one install at the repository root (`package-lock.json` or
  `npm install --offline`), and the sandbox writes the one report file, so a pull request's test that outlives
  the tool could write a coverage report of its own: coverage is evidence about the run, not a proof against the
  code it ran.
