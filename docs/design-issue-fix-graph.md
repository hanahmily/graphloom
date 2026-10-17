# Issue-fix graph

Status: implemented, 2026-10-15, as
[`examples/plugins/issue-fix`](../examples/plugins/issue-fix/). No live run has
been made with it yet; its banyandb profile reproduces
[banyandb-fix](design-banyandb-fix-graph.md), whose live runs it inherits.
Version 0.4.0, 2026-10-17, adds the [issues file](#the-issues-file).

## Purpose

`issue-fix` resolves one issue, a bug or an
[enhancement](#enhancement-issues), in any repository, given a repository
*profile*. It is [banyandb-fix](design-banyandb-fix-graph.md) with everything
BanyanDB-specific moved into the profile, so the same graph runs on BanyanDB
and on GraphLoom itself. The stages, requirements, review convergence, RED and
GREEN checks (including the revert patch), scope checks, delivery and
outcomes are banyandb-fix's; that design remains their reference.

## What is generic and what the profile supplies

The graph keeps, in code:

- the stages Fix and Review and the requirement ids;
- the issue snapshot, the unclear-issue policy and the decision record
  (`decision-record-v1`);
- RED in a base checkout with only test files, its revert-patch retry, GREEN
  and the further checks in a committed candidate checkout, and the clean-run
  rule (prepared, no file changed);
- the write scope with protected paths and recorded exceptions;
- the open-code-review delegation workflow, the findings ledger, independent
  verification, the sweep, the [discovery rounds](#review-discovery-rounds),
  the [issues file](#the-issues-file) and the acceptance rule;
- corrections, supervisor handoffs, and delivery to a local `fix/<issue>`
  branch with a pull request body.

The profile supplies, as data:

| Field | Meaning | banyandb | graphloom |
|---|---|---|---|
| `name`, `project` | Names for messages; the repository agents are told they work in | `apache/skywalking-banyandb` | `hanahmily/graphloom` |
| `issues` | Where issues live; the request names `owner/repo#N` | `apache/skywalking` | `hanahmily/graphloom` |
| `environment` | The SDK `EnvironmentDeclaration`: checks, preparation, pinned files. Must include an `ocr` check that prints open-code-review's path | BanyanDB's checklist, `make generate`, `CONTRIBUTING.md` pinned | Node.js 22+, npm, flock, git, ocr, codex, claude; `npm ci --include=dev`, `npm run build`; nothing pinned |
| `regression` | `runner` (a built-in, below) and `timeoutMs` | `go-test`, 30 min | `vitest`, 20 min |
| `commands` | GREEN's further checks and the build checks, run in order in the committed candidate checkout. Each has `id`, `argv`, `timeoutMs`, `requirement` (`passes` or `builds`), and optional `label`, `statement` and `summary` wording | `test-ci` (passes); `license-check`, `build`, `lint`, `check` (builds) | `npm run typecheck`, `npm run build`, `npm test` (builds; the full suite takes about ten minutes, so 45 min) |
| `testPaths` | `suffixes`, and `directories` whose contents count as test files; RED applies only these | `_test.go`, `testdata/` | `.test.ts`, `test/`, `fixtures/` |
| `protectedPaths` | Excluded from the write scope unless the record justifies one | `api/proto`, `go.mod`, `go.sum`, `.github` | `package-lock.json`, `.github`, `legacy` |
| `changelog` | Optional `{ path, rule }`; absent means no `changelog-entry` requirement. The one rule, `first-release-section-entry`, needs a new list entry inside the first `## ` section | `CHANGES.md` | none: the repository keeps no changelog |
| `planning` | `reach` (the reach question for the plan), optional `e2e` (what `needsE2E` means) and optional `notes` (guidance the planner and implementer both get) | Go lifecycle wording, Kind tests, no notes | TypeScript lifecycle wording, live-provider tests, [enhancement issues](#enhancement-issues) |
| `implementation` | `conventions`, optional `checks` (what the implementer is told is checked; generated from the commands when absent) and `cleanCheckHint` | `run.Go`, `make format` | AGENTS.md rules; generated checks text |
| `review` | `language`, `testFiles` and `rules`: the extra "what does the change break" rule | the Go rule | the same questions for TypeScript: resume, AbortSignal, rejected promises, locks, persisted state and wire formats, plugin notions in the controller |
| `pullRequest` | `checklist` after the title, `footer` (`{issue}` becomes the reference), optional `e2eNote` | BanyanDB's template | a short checklist and `Fixes {issue}.` |
| `harnesses` | Optional `implementer`, `reviewer`, `verifier`; the verifier must differ from the reviewer | Claude Code, Codex, Claude Code | same |

`parseProfile` checks every field and names the first problem; `describe`
refuses a missing or unusable profile, so a run cannot start on one.

### Requirements from the profile

`describe(config)` builds the definition from the profile:

- Fix always has `decisions-recorded`, `reproduces`, `passes` and `in-scope`;
  `builds` when the profile has `builds` commands; `changelog-entry` when it
  names a changelog. Review has `code-review`.
- Statements name what is checked for this repository, built from the profile:
  the runner's evidence for `reproduces` ("go test -json reports it failed, and
  the package built", or "vitest reports it failed with an assertion error in
  its own body, its file loaded, and no hook, suite or file around it
  failed"), the `passes` commands' statements,
  the `builds` commands' labels, the protected paths, the changelog path and
  the reviewer's harness. Qualification derives its cases from these
  statements, so they stay meaningful per repository.

The banyandb profile gives exactly banyandb-fix's stages, requirements,
statements, validator bindings, result contracts and environment, and the
same prompts and commands; a test compares them with banyandb-fix's own
build. Only the graph id, version and private-state schema differ, and the
[issues file](#the-issues-file), which banyandb-fix does not have. The file
adds to the review and implementer prompts and to the pull request only
through arguments the comparison leaves out.

### Regression runners

The parts that cannot be data are built-in runners the profile selects by
name. A runner gives the argv that runs exactly one named test and writes its
report, the report parser, the planner's description of `test.package`,
`test.name` and `test.focus`, the rule for which tests it can run, and the
report's own error lines for corrections.

| Runner | `test` | Outcome |
|---|---|---|
| `go-test` | `package` a `./` Go package, `name` a `TestXxx`, optional Ginkgo `focus` | banyandb-fix's `go test -json` and Ginkgo report parser, unchanged |
| `vitest` | `package` the test file relative to the repository root, `name` the test's full name (describe titles and title joined by spaces); no `focus` | Runs `vitest run <file> --testNamePattern ^name$` from the file's package directory with the nearest installed vitest and a small reporter the command installs, which writes one line naming the requested file and test, its result, and any failed hook, suite or file around it. A failed `beforeEach`/`afterEach` of the test, or a failed hook or error of an enclosing suite or the file (such as `afterAll`), is `setup-failed` whatever the test's own state; otherwise an `AssertionError` is `failed`; a missing export or module (`is not a function`, `Cannot find module`, …) or a file that does not load is `build-failed`, which sends RED to the revert patch as a Go build failure does; any other error is `panicked`; a skipped test with a file error is `setup-failed` |

vitest's file argument is a substring filter, relative to its root even when
given absolute, so `src/a.test.ts` also selects `other/src/a.test.ts`. The
reporter keeps only the file whose real path is the requested one, and the
command exits with that test's own status, not vitest's: 0 only when it
passed with no hook, suite, file or unhandled error failing around it, 1
otherwise, and non-zero when it has no result. Another file's failure can
neither satisfy RED nor block GREEN, and a failed cleanup cannot pass GREEN.

The reporter replaces vitest's JSON reporter, which loses exactly what RED and
GREEN need: it reports a test whose `beforeEach` threw an assertion as an
assertion failure of the test, though its body never ran, and it drops an
`afterAll` failure entirely, so a passing test there looks clean. vitest
leaves a hook's state at `run` when the hook throws, so the reporter reads any
hook state other than `pass` as a failure. The go-test runner has no such gap
for GREEN, which also needs `go test` to exit 0, so a failing `TestMain` or
package cleanup fails it; a `TestMain` that fails before the tests leaves no
result, so RED is not satisfied either. A Go `t.Cleanup` that fails marks the
test itself failed, which `go test -json` does not tell apart from its body.

**A run counts only for the test it ran.** The regression command names its
test only in its argv, and the candidate digest does not change when a
decision record renames the test or moves it to another package. RED and
GREEN therefore count only runs whose recorded argv is exactly the one the
runner builds for the record's current test; for any other, the graph runs
the checks again. This closes the hole for both runners: a Go run's argv
names its package, test and focus. The vitest report also records the test
it was run for, and `vitestOutcome` reads a report for any other test as
`not-run`.

### Enhancement issues

GraphLoom's issues are mostly enhancements, not bug reports. The graph treats
both the same way: the regression test is a new test of the behaviour the
issue asks for, RED shows it fails without the change, and GREEN shows it
passes with it. The graphloom profile's `planning.notes` tell the planner and
the implementer that:

- the expected value comes from the issue's acceptance criteria;
- the public surface the issue itself specifies (a new export, option, field
  or flag) is what was asked for and is recorded as a behaviour decision; only
  points the issue leaves open stay product decisions, so the
  unclear-issue policy does not block every enhancement;
- a new test usually calls code the base lacks, so RED's base checkout fails
  to load it (`build-failed`). The graph then asks for a revert patch, and the
  implementer supplies one that keeps the new names and signatures but
  restores the old behaviour behind them, so RED fails by assertion on the
  candidate with that patch reversed;
- `cannot_reproduce` is only for an issue that does not say what the new
  behaviour must be.

The example task requests `Fix hanahmily/graphloom#119.`

## Review discovery rounds

The reviewer may raise new findings for at most three rounds
(`MAX_DISCOVERY_ROUNDS`). After that, it only verifies that the findings
already raised are fixed. banyandb-fix follows the same rule; its design
section on [discovery rounds](design-banyandb-fix-graph.md#discovery-rounds)
gives the full rules.

- A **round** is the review of one candidate digest. The sweep's passes on
  that candidate belong to the same round. The round of a pass is the number
  of reviewed candidates the run had reached by then, this one included. Each
  candidate counts from its first record, ordered by generation, so the graph
  and the validator agree on the round when the run returns to an earlier
  candidate. The round never goes back, and it needs no private state.
- **Discovery rounds** are rounds 1 to 3. They behave as before.
- **Verify-only rounds** are round 4 onward. The assignment says the round is
  a verification round: report a status for every open finding, check that
  fixed ones stay fixed, and raise nothing new. A new critical or high
  comment becomes a non-blocking follow-up: it is not verified, and the pull
  request lists it under "Follow-ups". A known finding still present blocks
  and returns to Fix with the reviewer's latest note. A fixed finding named
  again reopens as a regression. There is no sweep. The round passes once
  every finding from the discovery rounds is fixed or dismissed.

Medium and low comments are unchanged. The requirement statement, the
validator binding and the private state are unchanged, so a running run can
adopt the rule with `resume --update-plugin`.

## The issues file

Since 0.4.0 the run tracks its critical and high findings as issues in a
file: the reviewer reports new issues, the fixer marks them fixed, and the
reviewer verifies each one and either closes it or reopens it. Only issue-fix
knows the file. The controller, the SDK and the CLI read none of it, and
banyandb-fix does not have it.

### Where it lives and how it stays out of the change

The graph writes `.graphloom/issues.json` in the run's worktree, and a
readable copy, `.graphloom/issues.md`, beside it. In the same command it
writes `.graphloom/.gitignore` containing `*`, so Git ignores the directory
in any repository, whatever the repository's own `.gitignore` says. Every
controller view of the change follows Git's ignore rules:

- the candidate digest (`candidateChange`) hashes `git diff` against the base
  and `git ls-files --others --exclude-standard`;
- the per-job scope check (`worktreeChangeFingerprints`, used for read-only
  jobs and write scopes) reads `git status --porcelain -uall` without
  `--ignored`;
- checkouts for RED and GREEN, and the `in-scope` validator, use the same
  change list.

The file therefore never changes the candidate digest, never counts as a
change by a read-only job, and never reaches a checkout. The deliver command
also adds the change with `git add -A -- . ':(exclude).graphloom'`, so the
directory stays out of the delivered commit even if the fixer deletes its
`.gitignore`. The next read puts the `.gitignore` back.

### Entries

```json
{
  "schema": "graphloom-issues-v1",
  "protocol": ["…the rules below, for the agents…"],
  "round": 2,
  "phase": "discovery",
  "issues": [
    {
      "id": "I1",
      "severity": "P1",
      "location": { "path": "pkg/timestamp/scheduler.go", "startLine": 88, "endLine": 95 },
      "title": "Close now waits forever for an action that ignores cancellation.",
      "description": "…the reviewer's comment and failure scenario…",
      "status": "fixed",
      "round": 1,
      "history": [
        { "actor": "verifier", "from": null, "to": "open", "note": "…", "round": 1, "candidate": "<digest>", "evidence": "ev-41" },
        { "actor": "fixer", "from": "open", "to": "fixed", "note": "Bounded Close's wait (scheduler.go:5).", "round": 2, "candidate": "<digest>", "evidence": "ev-57" }
      ]
    }
  ]
}
```

- `id`: issue `In` tracks finding `Fn` of the findings ledger. The numbers are
  the same, so the mapping needs no state and every view of the evidence
  agrees on it. Findings that never reach a verdict (a disputed one, or one
  resolved before verification) have no issue, so the ids can have gaps. The
  reviewer is told the `I` ids and may answer with either form. A run
  recorded before 0.4.0 used `F` ids, and they still work.
- `severity`: `P0` critical, `P1` high or unlabelled (an unlabelled comment
  blocks), `P2` medium, `P3` low. Only critical and high findings are tracked,
  because only they are findings in the ledger. Medium and low comments stay
  as they were: counted in the pull request and left for the maintainers.
  Numbering them would shift the `F` numbers of runs already recorded.
- `round`: the review round the finding was raised in. The history's `round`
  is the round of the candidate each event applies to.
- `history`: every move, with the actor (`reviewer`, `fixer`, `verifier` or
  `graph`), the statuses, a note, the candidate digest and the evidence
  record it comes from.

### The flow

| From | To | Actor | When |
|---|---|---|---|
| (new) | `open` | verifier | the verifier confirms a finding the reviewer raised in a discovery round |
| (new) | `dismissed` | verifier | the verifier refutes it with quotes that match the change |
| `open`, `reopened` | `fixed` | fixer | the fixer's edit to the file, with a history entry saying what it changed |
| `fixed` | `done` | reviewer | the reviewer's `resolved` on a later candidate, which also makes the ledger's finding fixed |
| `fixed` | `reopened` | reviewer | the reviewer's `still_present`, with its reason as the note |
| `open`, `reopened` | `fixed`, then `done` | graph, then reviewer | the reviewer finds an issue resolved that the fixer did not mark; the graph records the missing `fixed` step so no state is skipped |
| `fixed`, `done`, `dismissed` | `reopened` | verifier | the verifier confirms the finding again: a regression the reviewer reported, a withdrawn confirmation, or a dismissal whose quotes no longer match |
| `open`, `reopened`, `fixed` | `dismissed` | verifier | the verifier refutes a finding the reviewer withdrew |

A refuted regression of a `done` issue leaves it `done`. Verify-only rounds
add no issues: a new comment there becomes a follow-up, and `issues.md` and
the pull request list it.

### Who writes what

**The reviewer reports in its result and never edits the file.** The review
job stays read-only for every file. The controller's read-only check
(`packages/controller/src/loop.ts`, `pathsOutsideWriteScope`) fails a
read-only job that modifies a file that existed before it ran. An ignored
file is exempt only because the fingerprint skips ignored paths. Letting the
reviewer edit the file would rest the review's integrity on that exemption
and on the `.gitignore` the reviewer could itself remove. The reviewer
already gives a status for every open finding in its `code-review-v2` result
(`resolved`, `still_present`, `withdrawn`) and reports new findings as
comments, so the graph applies those to the file. Its assignment points at
the file and explains the protocol, and it shows each issue's id and status,
with the fixer's note on a `fixed` one. The result contract does not change.

**The fixer edits the file.** It is a writer anyway. Its assignment explains
the protocol: set an `open` or `reopened` issue's `status` to `fixed` and
append one history entry `{"actor": "fixer", "from": …, "to": "fixed",
"note": …}`. Its feedback on reentry is driven by the file: the open and
reopened issues first, each with the reviewer's latest note, then the ones it
marked fixed that the reviewer has yet to verify. The decision record does
not change.

### How the graph validates and restores it

The table is rebuilt from evidence on every call, in the same pass as the
findings ledger. Verifications, review passes and fixer reads move it in
evidence order. It needs no private state.

- **Write.** Before every implementer job, every review pass and the
  delivery, the graph writes the file unless the newest issues command in
  this generation, after the last implementer run, already shows the table's
  exact JSON. The write is a read-only command job in the worktree,
  `issues-write`. Its argv carries the whole JSON and markdown, so the last
  accepted version is itself evidence.
- **Read.** After every implementer run, once the graph has written the file
  at least once, a read-only command job, `issues-read`, copies the file into
  the command's report. The graph does not use `observe`, because the
  controller's admission requires every observed file to still match its
  observation when a stage is validated. A file the graph rewrites without a
  change to the candidate would make every later validation fail with
  "workspace file changed since observe".
- **Diff.** The read is compared with what the graph last wrote, which is
  what the fixer started from. An `open` or `reopened` issue moved to
  `fixed` with a new fixer history entry is accepted. Everything else is
  rejected: any other status (done, dismissed, reopened, open), `fixed`
  without a note, a deleted issue, a new issue, a changed `severity`,
  `location`, `title`, `description` or `round`, a deleted file, a file that
  is not JSON, and a file larger than the 64 KiB a command report keeps. A
  legal move on an issue is kept even when another field of the same issue is
  rejected. A rejection goes on the issue's history as a `graph` event, and
  the next implementer assignment lists it. The next write restores the
  accepted file.
- **Resume, reentry and `--update-plugin`.** A resume or a reentry starts a
  new generation, so the next agent job is preceded by a write from evidence,
  whatever the worktree holds. The same evidence always gives the same file.
  A run moved onto 0.4.0 has no issues commands yet. Its first write builds
  the table from the findings it already has, and its first read comes after
  the next implementer run.
- **Size.** A table that would not fit in a read is written with shorter
  descriptions and notes, then with only each issue's latest events. The
  evidence and `issues.md` keep the full text.

### Acceptance

The code review requirement passes when no P0 or P1 issue is `open`,
`reopened` or `fixed` but not yet verified. This is the ledger's existing
rule: an issue is `done` exactly when the ledger counts its finding fixed, so
an issue the fixer marked fixed still blocks until the reviewer verifies it.
The validator also checks the issues explicitly and names any that are not
done. The stages, requirement ids and statements, validator bindings, result
contracts and private-state schema are unchanged, so a running run can move
onto 0.4.0 with `resume --update-plugin`.

The pull request body gets a "Review issues" section with the table: every
tracked issue, `done` or `dismissed`, with its latest note. Follow-ups stay
under "Follow-ups".

## How the config is pinned and passed

The task file names the profile:

```yaml
graph: issue-fix
repo: skywalking-banyandb
config: plugins/issue-fix/profiles/banyandb.json
request: "Fix apache/skywalking#14092."
```

`config` is a path relative to the task file, resolved like `repo` (no
traversal). It is generic: the controller, SDK and CLI read no field of it.

1. **Intake** reads the file, requires UTF-8 JSON of at most 256 KiB, and pins
   `IntakePin.config = { path, sha256, text }` in run state. A manifest that
   declares `taskConfig: "required"` makes intake refuse a task without one.
2. **Plugin host.** The controller opens every plugin host with the pinned
   value (`taskConfigValue(intake)`, which also refuses a pin whose text no
   longer matches its digest). The host attaches it to every call:
   `describe` (`GraphPlugin.describe(config?)`), `advance` (`RunView.config`),
   `evaluate` (`ValidationInput.config`) and `rehearsal` (a rehearsal entry may
   export `rehearsal(config)`). The in-process host passes it to describe and
   advance; in-process validators get it from the caller (issue-fix's
   `validatorsFor(config)`).
3. **Pinning the definition.** The run pins the definition
   `describe(config)` returns, as for any graph; resume, activation and
   repair qualification compare later describes with it. Every host the run
   opens, including on resume and for a repair candidate, gets the same
   pinned config, so they describe the same graph.
4. **Resume** uses the pinned copy, never the file: editing the file after
   intake does not change a running graph, and a state file whose config
   text was edited stops the resume as a pin mismatch.
5. **Rehearsal and replay.** `graphloom check`, `rehearse` and `probe` open
   their hosts with the task's pinned config, and the temporary task a
   rehearsal writes carries the same `config:` line. Replay uses the recorded
   run's pinned config. The rehearsal gate's fingerprint includes the
   config's digest.
6. **Inspect** shows the config's path and digest.

A plugin that ignores config works as before; a task without `config` gives
it none.

### Manifest

A bundle's manifest normally pins its requirements, which the controller
compares with `describe()` at intake. issue-fix's requirements depend on the
profile, so its manifest declares `taskConfig: "required"` and pins no
requirements or stages; the run's own requirements are pinned in run state
from `describe(config)` at intake. The manifest still pins the source,
profiles, tests and lock digests. A consequence: validator substitution on an
*opaque* bundle needs requirements pinned in the manifest, so a
config-dependent bundle can only use it if it is source-repairable, as
issue-fix is.

## Profiles shipped

- [`profiles/banyandb.json`](../examples/plugins/issue-fix/profiles/banyandb.json):
  banyandb-fix's behaviour exactly; its environment is banyandb-fix's
  declaration verbatim.
- [`profiles/graphloom.json`](../examples/plugins/issue-fix/profiles/graphloom.json):
  this repository. Preparation installs and builds, because the workspaces'
  tests import each other's `dist/`; `--include=dev` keeps a
  `NODE_ENV=production` shell from skipping tsc and vitest. It pins no file:
  `AGENTS.md` and `package.json` change often, and a pinned-file mismatch
  blocks every run until a qualified repair. There is no changelog, so no
  changelog requirement.

The example tasks are
[`examples/issue-fix-banyandb-task.yaml`](../examples/issue-fix-banyandb-task.yaml)
and
[`examples/issue-fix-graphloom-task.yaml`](../examples/issue-fix-graphloom-task.yaml),
with banyandb-fix's budgets. The GraphLoom task uses `repo: .`, the checkout
it lives in. Intake pins the top level of the repository `repo` names, so the
run's worktree and state sit under `graphloom/` and `graphloom-state/` at the
repository root, which Git ignores.

## Migration from banyandb-fix

`examples/plugins/banyandb-fix` is left unchanged: runs pinned to it resume on
it, and its recorded run stays its rehearsal and replay fixture. New BanyanDB
runs should use `issue-fix` with the banyandb profile; the two graphs have
different ids, so a run never switches between them. To move a task, change
`graph: banyandb-fix` to `graph: issue-fix` and add
`config: plugins/issue-fix/profiles/banyandb.json`. banyandb-fix can be
retired once no stopped run needs to resume on it.

To add a repository, copy a profile beside the task, adjust it, and name it
with `config:`. A repository whose tests need another runner needs a new
built-in runner in the bundle, a source change qualified like any other.

## Verification

- banyandb-fix's unit suite runs unchanged on issue-fix under the banyandb
  profile; another test compares the definition, prompts, commands and
  decision rules with banyandb-fix's build.
- The graphloom profile's requirement set (no changelog), protected paths,
  vitest test rules and its GREEN-then-RED commands are tested; the vitest
  runner runs real vitest on a scratch project and classifies passes,
  assertion failures, crashes, missing exports, unloadable files and missing
  tests, judges only the requested file when another file's path ends the
  same way, and reads a report as no result for any other test. Graph and
  qualification cases show that a renamed test, or the same name in another
  package, reruns the checks rather than reusing the old runs, and that an
  enhancement's unloadable RED leads to the revert-patch request.
- Qualification cases cover both shipped profiles.
- The CLI e2e test runs issue-fix with a fixture profile through the
  controller and a child plugin host, and the rehearsal tests rehearse it
  from a task config; controller and plugin-host tests cover pinning, the
  calls the config reaches, resume with a changed file, a tampered pin, a
  plugin without config, and config fields never becoming task settings.
- The issues file: graph tests run a finding through `open`, `fixed` (the
  fixer's edit) and `done`. They reopen a fixed issue with the reviewer's
  note and show that note to the fixer. They reject a fixer marking an issue
  `done` and restore the file, and they record the `fixed` step when the
  fixer did not mark it. A dismissed issue is listed, a verify-only round
  adds no issue, and a resume rewrites the file from evidence before the
  implementer. Unit tests reject each illegal edit. Tests with real Git, in a
  repository that does not ignore `.graphloom/`, show that the write leaves
  the digest's and the scope check's view of the change unchanged. They also
  show that the delivered commit leaves the file out even after its
  `.gitignore` is deleted. A replay of run 4c70ff66-dd9's evidence (#119,
  recorded on 0.2.0) builds 16 issues, 15 `done` and 1 `dismissed`, each
  history moving one state at a time. The test runs when that run's state is
  present; set `ISSUE_FIX_REPLAY_STATE` to point at it.

Not yet verified: a live run with either profile, a live run with the issues
file, and a full rehearsal (L1) of the graphloom profile, which would run its
real commands.
