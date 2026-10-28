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
that the tests of the touched packages executed, in an untrusted-confined
checkout of the head.

- **Go:** `go test -coverprofile -covermode=set -coverpkg=<touched packages>
  <touched packages>`. A statement is covered when its coverprofile block is
  covered. Blocks are attributed to a function by line range.
- **TypeScript:** V8 coverage collected by [c8](https://github.com/bcoe/c8)
  around the profile's test command. c8 reports lines rather than
  statements, so this uses executed lines over executable lines in the
  function's range, stated as line coverage in every record.

When coverage was not measured, the record says `unknown` with the reason
(for example "profile disallows executing PR code"). CRAP then uses `cov = 0`,
stated as the **upper bound**.

### 2.4 CRAP

```text
CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)
```

**Threshold:** 30. The value is always reported with its coverage source:
`measured`, or `unknown (upper bound, cov = 0)`. At `cov = 0` the formula is
`comp^2 + comp`, so any function with `comp >= 5` reaches 30 when coverage is
unknown. Records say so rather than leaving the reader to infer it.

### 2.5 Mutation testing

Mutation testing applies the operators below, one at a time, to the changed
functions only. Each resulting **mutant** runs the tests of the touched
packages in an untrusted-confined checkout.

| Operator | Mutation |
|---|---|
| Relational flip | `<`↔`<=`, `>`↔`>=`, `==`↔`!=`, and the boundary forms (`>` → `<=` and the like) |
| Boolean literal flip | `true`↔`false` |
| Arithmetic swap | `+`↔`-`, `*`↔`/`, `%` → `*` |
| Condition negation | `if c` → `if !(c)`, likewise in loop conditions and `?:` |
| Statement removal | An expression or assignment statement deleted. Declarations are never removed, so the mutant still compiles |
| Return-value removal | `return x` → `return <zero value of its type>` |

Each mutant has exactly one outcome:

| Outcome | Meaning |
|---|---|
| `killed` | A test failed |
| `timeout` | The tests ran past three times the baseline duration (at least 30 s). Counted as killed |
| `survived` | All tests passed. The covering tests do not assert the mutated behaviour |
| `invalid` | The mutant did not compile. Excluded from the score |
| `not-run` | The time budget ran out first. Listed, with the reason |

**Mutation score** = (killed + timeout) / (killed + timeout + survived).

**Rule:** no surviving mutant.

A survivor may be *equivalent*: a mutation that changes no observable
behaviour, such as `i < n` → `i != n` in a loop that steps by one. Only a
reader can tell, so a survivor is never dropped automatically. A graph may
record a reasoned "possibly equivalent" claim that an independent checker
verifies.

## 3. Tools

These are the plugin defaults. A profile can override `argv` per language,
but the definitions above stay fixed.

| Metric | Go | TypeScript |
|---|---|---|
| Complexity, nesting | `gometrics`: a small stdlib-only `go/ast` program in the plugin's source | `tsmetrics`: a Node script on the TypeScript compiler API (`typescript`, a plugin dependency) |
| Coverage | `go test -coverprofile` | c8 (bundled with the plugin at an exact version) |
| Mutation | `gomutate`: a stdlib-only `go/ast` mutator that runs `go test -overlay` | [StrykerJS](https://stryker-mutator.io/) (bundled at an exact version), with `mutate` line ranges and a mutator allowlist matching §2.5 |

Why these tools:

- **The plugin's own Go tools, not gocyclo plus gremlins or go-mutesting.**
  - One stdlib-only program pair yields complexity, nesting and the decision
    and nesting *evidence* that recomputation needs (§5). Line-ranged mutation
    restricted to changed functions needs that evidence too.
  - The operator set is exactly §2.5. The external Go mutators' operator sets
    and scoping differ from it. Adapting one would mean patching a tool the
    supervisor cannot repair inside a run.
  - `go test -overlay` substitutes the mutated file without writing the
    checkout. The "checks change no file" rule therefore holds, and mutants
    can run one after another in one checkout.
  - The tools are plugin source, vendored with the review kit
    ([pr-review §14](design-pr-review-graph.md#14-sharing-code-with-issue-fix)),
    so they are source-repairable and pinned with the plugin.
  - Being stdlib-only, `go run` builds them offline inside the confinement.
  - gocyclo stays as a cross-check in the tool's tests.
- **StrykerJS for TypeScript.** It is the maintained mutation tool for the
  ecosystem. It accepts line ranges, and a mutator allowlist maps it onto
  §2.5. It is bundled, as open-code-review is
  ([issue-fix](design-issue-fix-graph.md#bundled-open-code-review)), so
  nothing is downloaded in a no-network job.
- **c8** reads V8's own coverage around any Node test command, so it does not
  depend on which coverage provider the repository configures.

## 4. Execution and confinement

| Measurement | Executes PR code? | Where it runs |
|---|---|---|
| Complexity, nesting | No. The tool parses only | A read-only command under `untrusted` confinement (no network), over the head tree. It always runs, on every profile |
| Coverage, mutation | Yes: the PR's tests | Only in a `{ from: "candidate" }` checkout under `untrusted` confinement (no network, no credentials, home hidden), with dependencies from the operator's read-only caches. Only when the profile allows executing PR code (`metrics.execute`) |

When execution is not allowed, or bwrap is missing, the coverage and mutation
records say `not run` with the reason, and CRAP uses the upper bound (§2.4).

Mutation runs within `metrics.mutation.timeBudgetMs` (default 30 minutes per
run):

- mutants are visited function by function in source order, one operator
  site at a time, so a cut-off still covers every function a little;
- a compile failure costs one build;
- each mutant costs one test run of the touched packages.

As an estimate for BanyanDB-sized Go packages, 10 to 40 seconds per mutant
after the first build, so about 50 to 150 mutants fit the default budget.

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
    "survivors": [{ "line": 27, "operator": "relational", "original": "n > max", "mutated": "n >= max" }] } }
```

A graph accepts a measurement only after deterministic recomputation from
evidence:

- `complexity` is 1 plus the number of listed decisions, and each decision's
  line holds its keyword or operator in the head file's bytes;
- `nesting` is the length of `nestingPath`, each step's line holds its
  keyword, and the lines increase;
- `coverage` follows from the coverprofile or c8 report attributed by line
  range;
- `crap` is recomputed with the formula;
- each survivor's `original` text is on its line, and `mutated` differs from
  it by exactly one operator of its kind;
- the set of measured functions equals the changed functions of §1.

A record that does not recompute is rejected, never corrected by hand.
