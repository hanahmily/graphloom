# Issue-fix graph

Status: implemented, 2026-10-15, as
[`examples/plugins/issue-fix`](../examples/plugins/issue-fix/). No live run has
been made with it yet; its banyandb profile replaced the BanyanDB-only
banyandb-fix graph, since removed, whose live runs it inherits.
Version 0.4.0, 2026-10-17, adds the [issues file](#the-issues-file).
Version 0.5.0, 2026-10-19, has the code reviewer review [every changed
file and the change as a whole](#every-changed-file-and-the-change-as-a-whole).
Version 0.6.0, 2026-10-19, declares the profile's measured `budgets` as the
graph's default budgets ([budgets](budgets.md)).
Version 0.7.0, 2026-10-20, delivers the decision record's `change`, not the
implementer's last-round `summary`, as the commit message and pull request
summary ([#161](https://github.com/hanahmily/graphloom/issues/161)).
Version 0.8.1 splits the BanyanDB profile's `make generate` into separately
cached steps (proto, mcp npm install, mocks) with declared inputs and outputs,
so checkouts of a run reuse each output while its own inputs are unchanged
([#174](https://github.com/hanahmily/graphloom/issues/174)).
Version 0.9.0 adds the [`canopy` profile](../examples/plugins/issue-fix/README.md#the-canopy-profile)
for Node/TypeScript changes under `canopy/` in skywalking-banyandb, and makes the
`vitest` runner force `NODE_ENV=test` and work with vitest 5
([#179](https://github.com/hanahmily/graphloom/issues/179)).
Version 0.10.0 lets a profile command declare `writes`, the files it regenerates,
which the implementer may then write even under a protected path
([#181](https://github.com/hanahmily/graphloom/issues/181)); records one review
finding per problem across passes ([#182](https://github.com/hanahmily/graphloom/issues/182));
and checks, before code review, that the implementer's `coverage` covers each of the
planner's `acceptance` items ([#183](https://github.com/hanahmily/graphloom/issues/183)).
Version 0.10.3 reads the latest valid decision record in review and delivery, so a
supervisor-dispatched work run without one no longer crashes the graph
([#191](https://github.com/hanahmily/graphloom/issues/191)).
Version 0.10.4 declares a 6 h `waitMs` in every profile, so a coding-agent harness's usage-limit reset can be waited out instead of stopping the run ([#189](https://github.com/hanahmily/graphloom/issues/189)).
Version 0.11.0 reenters Fix itself when code review fails only on confirmed findings and the loop is converging, instead of handing every such failure to the supervisor ([#193](https://github.com/hanahmily/graphloom/issues/193); see [review failures](#review-failures-the-graph-reenters-fix-or-the-supervisor-decides)).
Version 0.12.0 reads the profile's [context documents](#context-documents) once and gives them to the planner, the implementer and the code reviewers ([#195](https://github.com/hanahmily/graphloom/issues/195)), runs a profile's [`final` tier commands](#the-final-command-tier) once after review converged ([#196](https://github.com/hanahmily/graphloom/issues/196)), and ships the [banyandb-ql profile](#the-measure-ql-profile-and-benchmark-gates) with its `bench-gates` requirement and a delivery option that keeps a private tracker out of the commit and the pull request ([#197](https://github.com/hanahmily/graphloom/issues/197)).
Proposed for 0.17.0: [code quality gates](#code-quality-gates) on the functions a change adds or modifies (complexity, nesting, CRAP, mutation), with the metrics defined in [code quality metrics](design-code-quality-metrics.md).

## Purpose

`issue-fix` resolves one issue, a bug or an
[enhancement](#enhancement-issues), in any repository, given a repository
*profile*. It began as the BanyanDB-only banyandb-fix graph with everything
BanyanDB-specific moved into the profile, so the same graph runs on BanyanDB
and on GraphLoom itself. The stages, requirements, RED and GREEN checks
(including the revert patch), scope checks, delivery and outcomes came from
that graph, and its review rules are kept below as
[review convergence](#review-convergence). banyandb-fix has since been
removed.

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
| `issues` | Where issues live; the request names `owner/repo#N`. Optional `context`: [documents](#context-documents) the issue defers to | `apache/skywalking` | `hanahmily/graphloom` |
| `environment` | The SDK `EnvironmentDeclaration`: checks, preparation, pinned files. Must include an `ocr` check that prints open-code-review's path; the shipped profiles run the plugin's `scripts/ocr-path.sh`, which finds the [bundled copy](#bundled-open-code-review) first | BanyanDB's checklist, `make generate`, `CONTRIBUTING.md` pinned | Node.js 22+, npm, flock, git, ocr, codex, claude; `npm ci --include=dev`, `npm run build`; nothing pinned |
| `regression` | `runner` (a built-in, below) and `timeoutMs` | `go-test`, 30 min | `vitest`, 20 min |
| `commands` | GREEN's further checks and the build checks, run in order in the committed candidate checkout. Each has `id`, `argv`, `timeoutMs`, `requirement` (`passes`, `builds`, or `final-checks`/`bench-gates` for a `final` tier command), and optional `tier` (`cheap`, `full` or `final`, default `full`; a `final` command runs once, after review, see [the final tier](#the-final-command-tier), and has optional `section`; once any command is `cheap`, GREEN and the cheap commands run first in one checkout job and the full commands run in a second job only after those passed on the same candidate digest, and Fix needs both) and optional `label`, `statement` and `summary` wording, and optional `writes` (repository-relative files or directories, a trailing `/**` allowed, that the command regenerates and a failure tells the author to commit, such as license artifacts: the implementer's write scope covers them even under a protected path) | `test-ci` (passes); `build`, `lint`, `check` (builds; `make check` already runs license-check); `test-ci` and `lint` are cheap | `npm run typecheck`, `npm run build`, `npm test` (builds; the full suite takes about ten minutes, so 45 min) |
| `testPaths` | `suffixes`, and `directories` whose contents count as test files; RED applies only these | `_test.go`, `testdata/` | `.test.ts`, `test/`, `fixtures/` |
| `protectedPaths` | Excluded from the write scope unless the record justifies one, or a command's `writes` declares it regenerated (since 0.10.0) | `api/proto`, `go.mod`, `go.sum`, `.github` | `package-lock.json`, `.github`, `legacy` |
| `changelog` | Optional `{ path, rule }`; absent means no `changelog-entry` requirement. The one rule, `first-release-section-entry`, needs a new list entry inside the first `## ` section | `CHANGES.md` | none: the repository keeps no changelog |
| `planning` | `reach` (the reach question for the plan), optional `e2e` (what `needsE2E` means) and optional `notes` (guidance the planner and implementer both get) | Go lifecycle wording, Kind tests, no notes | TypeScript lifecycle wording, live-provider tests, [enhancement issues](#enhancement-issues) |
| `implementation` | `conventions`, optional `selfCheck` (cheap commands the implementer runs and reports in `selfChecks` before returning ready; the graph still runs its own checks), optional `checks` (what the implementer is told is checked; generated from the commands when absent) and `cleanCheckHint` | `run.Go`, `make format` | AGENTS.md rules; generated checks text |
| `review` | `language`, `testFiles` and `rules`: the extra "what does the change break" rule | the Go rule | the same questions for TypeScript: resume, AbortSignal, rejected promises, locks, persisted state and wire formats, plugin notions in the controller |
| `pullRequest` | `checklist` after the title, `footer` (`{issue}` becomes the reference), optional `e2eNote`, and optional `reference` (`{ "style": "implements", "subject": "..." }`: the commit and the pull request say "Implements <subject> <issue title>" and carry no reference to the issues repository; the footer may not use `{issue}`) | BanyanDB's template | a short checklist and `Fixes {issue}.` |
| `harnesses` | Optional `implementer`, `reviewer`, `verifier`; the verifier must differ from the reviewer | Claude Code, Codex, Claude Code | same |
| `supervisor` | Optional supervisor preference: `harnesses` (an order of `pi`, `claude-code`, `codex`), optional `models` hints per harness, optional `required`. `describe` declares it as `GraphDefinition.supervisor`; the CLI resolves it against the operator's enabled harnesses and pins one at intake ([supervisor harnesses §7](design-supervisor-harnesses.md#7-selection-and-pinning); since 0.16.0). Independent of `harnesses` | `pi`, `claude-code`, `codex` | same |
| `agent` | Optional `timeoutMs`: the wall clock every coding-agent job asks for instead of the operator's default (one hour), clamped to the operator's `maxTimeoutMs` (default four hours); optional `timeoutContinuations` (default 1, at most 3, 0 off): how many times per implement attempt (each implement dispatch and the continuations chained from it) the controller continues the implementer's own session after a timeout that changed the worktree, before a supervisor episode (since 0.13.0; see [timeout continuation](design-typescript-core.md#job-wall-clock-and-timeout-continuation)) | operator default (`banyandb-ql`: 3 h), 1 continuation | operator default, 1 continuation |
| `budgets` | Optional run budgets (`agentInvocations`, `jobs`, `decisions`, `corrections`, `waitMs`, `activeMs`, `recoveryReserve`, `probes`), positive integers. `describe` declares them as `defaultBudgets`; intake applies them over the controller's defaults and under the task's own `budgets` ([budgets](budgets.md)) | 6,000 agent calls, 250 jobs, 500 decisions, 100 corrections, 20 h active | 1,800, 250, 350, 30, 10 h |

`parseProfile` checks every field and names the first problem; `describe`
refuses a missing or unusable profile, so a run cannot start on one.

### Requirements from the profile

`describe(config)` builds the definition from the profile:

- Fix always has `decisions-recorded`, `reproduces`, `passes` and `in-scope`;
  `builds` when the profile has `builds` commands; `changelog-entry` when it
  names a changelog. Review has `code-review`, and `final-checks` or `bench-gates` when the profile has `final` tier commands that count toward them.
- Statements name what is checked for this repository, built from the profile:
  the runner's evidence for `reproduces` ("go test -json reports it failed, and
  the package built", or "vitest reports it failed with an assertion error in
  its own body, its file loaded, and no hook, suite or file around it
  failed"), the `passes` commands' statements,
  the `builds` commands' labels, the protected paths, the changelog path and
  the reviewer's harness. Qualification derives its cases from these
  statements, so they stay meaningful per repository.

The banyandb profile was written to give exactly banyandb-fix's stages,
requirements, statements, validator bindings, result contracts and
environment, and the same prompts and commands; while banyandb-fix was in the
repository, a test compared them with its build. Beyond the graph id, version
and private-state schema, the differences were deliberate: the
[issues file](#the-issues-file); since 0.5.0 a code review that [reviews every
changed file](#every-changed-file-and-the-change-as-a-whole) and then the
change as a whole; and since 0.8.0 no separate `license-check` command, which
`make check` already runs.

### Regression runners

The parts that cannot be data are built-in runners the profile selects by
name. A runner gives the argv that runs exactly one named test and writes its
report, the report parser, the planner's description of `test.package`,
`test.name` and `test.focus`, the rule for which tests it can run, and the
report's own error lines for corrections.

| Runner | `test` | Outcome |
|---|---|---|
| `go-test` | `package` a `./` Go package, `name` a `TestXxx`, optional Ginkgo `focus` | a `go test -json` and Ginkgo report parser, carried over from banyandb-fix |
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

## The final command tier

Some checks are too slow for the cheap and full tiers, which run again for every
candidate: a benchmark that takes an hour is paid once per round. A profile
command may declare `tier: "final"`, and then its `requirement` is
`final-checks` (a final command cannot count toward Fix's `passes` or `builds`,
which Fix needs before review, and only a final command may count toward
`final-checks`). Review gains the requirement `final-checks` only when the
profile has such commands; a profile without them has the definition and the
behaviour it had before.

Final commands run in one job, in a prepared checkout of the candidate, once
per candidate digest, at the moment code review has converged on that digest
(the review's own acceptance rule passed) and before the Review stage is
validated, so before delivery. The `final-checks` validator passes when every
final command ran in a prepared checkout of this candidate, succeeded and
changed no file; a command that did not run is not a pass.

- **Failure.** A final failure is a defect, not a flake. The graph reenters Fix
  itself with the failing requirement and the command's output, drawing on the
  same cap (`review.maxReentries`, default 4) and corrections budget as a
  [review reentry](#review-failures-the-graph-reenters-fix-or-the-supervisor-decides),
  since both count the implementer runs after the first review pass. If the
  last implementer pass left the candidate unchanged, the same candidate would
  fail the same way, so the supervisor gets it instead, as it does at the cap.
  The implementer is told that review passed and the final checks failed. The
  corrected candidate is a new digest, so the cheap tier, RED, the full tier,
  code review and the final tier all run again.
- **Resume.** As for every check ([#154](https://github.com/hanahmily/graphloom/issues/154)),
  a final failure recorded before the operator's latest resume is run once
  more; a failure recorded since then is acted on, so a failing command cannot
  loop. A final run that passed before the resume stands.
- **Pull request.** A final command's optional `section` names a pull request
  heading. The graph puts the `summary` of the command's JSON report there (a
  line, or a list of markdown lines), under a line saying it is reported and the
  run gated only on the exit status. The command's summary also joins the test
  plan's list of checks that passed.

## Context documents

An issue sometimes defers to a design or a plan kept elsewhere, in a repository
the agents cannot be relied on to read. A profile declares them as
`issues.context`: a list of `{ repo?, path, ref? }`. Without `repo` the path is a
file of the target repository, observed in the run's worktree at the base
commit; with `repo` (`owner/name`) it is read from GitHub at `ref` (default: the
repository's default branch) by the read-only `graphloom.github/get-file`
executor, under the same read scope and token handling as the other GitHub
reads. The executor returns the text whole with git's blob sha and its size; a
path that is missing, a directory, too large for the contents API or not UTF-8
text is an `ok` result with `found: false` and a reason, so the graph can name
the problem instead of entering a recovery episode.

Fix reads the documents in the same step that reads the issue snapshot and its
comments, once, before the first agent job: one observation for the target
repository's files, one `get-file` job per file of another repository. The
evidence is the pin: it records each document's path, blob sha (or SHA-256 for
an observed file) and bytes, and every later step, a resume and a reentry
included, reads the documents back from it, so an edit to a document never
changes a running run. The planner, the implementer and the code reviewer get
each document under a heading that names its source, and the planner is told an
acceptance item may cite a document by that name.

How a document reaches an agent depends on its length. Documents of at most
12,000 characters together go into the prompt under those headings. Longer ones
cannot: an executor declares what its input may be (the coding agent's
`assignment` is at most 64,000 characters, the issue and the instructions
included), and a design document is read, not recited. They are handed over as
files instead. A read-only command job writes each pinned document, from the
evidence and never fetched again, to `.graphloom/context/NN-<name>` in the run's
worktree and makes it read-only. `.graphloom/` is ignored by Git, so the
candidate and the delivered commit leave the files out, and a confined job
(supervisor-originated jobs run in a bubblewrap sandbox over the worktree) reads
them like any file of its worktree. The prompt then lists the files, with each
document's source name, blob sha and size, and says to read them in full before
starting. The planner, implementer, code reviewer and verifier all get the same
list. The files are written again after an implementer run, which may have
touched them, and after a resume or reentry, as the issues file is; a write that
fails goes to the supervisor, and a document too long for one command to write
(the argument count and the 256,000 byte serialized input, escapes included)
stops the run, naming it.

Three bounds apply, each a stop with reason "incompatible task" before the job
runs: the documents together may be at most 200,000 bytes; every agent job's
input is checked against the input shape its executor declares (the runner hands
the declared shapes to the graph in `RunView.executors`), so an assignment over
the executor's limit stops naming the field and the limit instead of being
refused at admission; and the input, serialized, must fit the 256,000 byte bound
on any executor input. A document that cannot be read is the same kind of stop,
naming it and why.

## Review convergence

These rules come from the banyandb-fix graph's design, which issue-fix
replaced; they apply to every profile. Without them, the loop between Fix and Review ends only through its
limits. Every review is fresh and has no memory, so a later review can raise new
findings, raise a finding again that earlier work settled, or block on a false
positive that sends the run back to Fix until the budget runs out. Every
blocking comment also went to the implementer, so a false positive could make
it change correct code. This design makes the loop monotone and settles false
positives with evidence. The ledger keeps its own `F1`, `F2`, … names; the
[issues file](#the-issues-file) shows the same findings as `I1`, `I2`, ….

Terms: a *P0* is a critical comment and a *P1* a high one; a comment without a
severity counts as P1. A *round* reviews one candidate digest. A *pass* is one
Codex review job on a candidate.

### Evidence from earlier generations

A reentry and a resume both start a new generation, and the controller shows
validators only the current generation's evidence. The graph sees all of it,
but acceptance would not. `ValidationInput.history` therefore carries the
evidence of earlier generations, oldest first. It is context: a receipt still
rests on current evidence, and a validator must not pass a requirement from
history alone. The code review validator rebuilds the findings ledger from
history and current evidence together, and still requires a pass on the
current candidate in the current generation.

### The findings ledger

The ledger is a pure function of the run's review passes, verification jobs and
file observations, in evidence order. It holds no private state, so a resume
or a supervisor decision cannot lose it.

**Identity.** The plugin names findings `F1`, `F2`, … in the order they first
appear, so the names are the same every time the ledger is rebuilt. A pass sees
the known findings with their names. A comment matches a known finding only
when its `finding` field names one; anything else is a new finding and is
verified. Nothing is matched by path, line or text, so an ambiguous comment
never inherits a closed state. The cost is that a reviewer who repeats a known
finding without its name creates a duplicate, which verification judges again.

**States.**

| State | Meaning |
|---|---|
| pending | Awaits verification on a named candidate |
| confirmed | Verified as a defect; open until fixed |
| disputed | The verifier could not decide, gave no verdict, or refuted it with quotes that do not match the candidate |
| fixed | A pass marked it resolved on a candidate other than the one it was last confirmed on |
| dismissed | Refuted with quotes that match the candidate |

**How a pass on candidate D changes it.** The pass reports a status for each
open finding it was shown: `resolved`, `still_present` or `withdrawn` (never a
defect), with a reason. A comment that names an open finding counts as
`still_present` for it. A pass that leaves an open finding without a status is
incomplete. Only critical and high comments, and comments without a severity,
become findings.

| Finding | Pass says | Result |
|---|---|---|
| confirmed | resolved, on a candidate other than the one it was last confirmed on | fixed |
| confirmed | resolved, on that same candidate | unchanged: a read-only pass cannot fix code |
| confirmed | still_present | confirmed, last seen on D |
| confirmed | withdrawn | pending on D: verification decides whether it was a defect |
| pending or disputed | resolved, on another candidate | fixed |
| pending or disputed | still_present or withdrawn | pending on D |
| fixed | raised again with its name | pending on D, as a regression |
| dismissed | raised again with its name | still dismissed while every line its refutation quoted matches D; otherwise pending on D |

A dismissal rests on the refutation's quoted lines, the code that made the
claim false, not on the line the comment pointed at. When a later change removes
the lock a refutation quoted, the quote no longer matches, and the finding is
verified again.

### Searching until no new P0 or P1

On each candidate, passes run until one raises nothing that survives
verification:

1. A pass reviews the whole change with open-code-review's delegation
   workflow. Its assignment lists the open findings, which need a status, and
   the settled ones (fixed and dismissed), which it must not report again
   unless the defect is back, and then with its name.
2. Every finding the pass raised, whether new, a regression, or a dismissal
   whose quotes broke, is verified (below).
3. When any of them was confirmed or disputed, another pass runs, in a fresh
   Codex session. It gets every known finding as already reported, must still
   review every changed file, and looks for P0 and P1 issues outside the list.
4. The sweep ends at the first pass whose raised findings were all dismissed,
   or when none were raised. It is capped at four passes per candidate. A sweep
   that reaches the cap ends unsaturated and fails the round.

The sweep collects every defect it can find before the run returns to Fix,
which saves round trips. A passing round needs only one pass, since its first
pass raises nothing that survives verification. A resume starts a new
generation, so the first pass after it runs again with the ledger intact.

### When the code review passes

The code review requirement passes when all of these hold:

1. The latest pass on the current candidate ran in the current generation,
   read-only, finished, returned a readable result, reviewed every file on its
   list, skipped none, and gave a status for every open finding it was shown.
2. No finding awaits verification or a file observation.
3. Every finding that pass raised is dismissed.
4. No finding is confirmed or disputed: every confirmed finding became fixed
   on a later candidate.

These four conditions are the only acceptance rule; the graph calls the same
validator before it asks the controller to validate. Because fixing needs a
different candidate, a sweep that confirmed a new finding on a candidate cannot
pass on that candidate.

### Monotone rules

1. The ledger only grows. Every finding keeps its name and history.
2. A closed finding stays closed. A dismissal holds while its quoted lines
   match; a fix holds until a regression is confirmed.
3. Only confirmed and disputed findings block. A dismissed finding never blocks,
   and it never reaches the implementer.
4. Delivery needs saturation: the last pass on the delivered candidate raised
   nothing that survived verification, and nothing confirmed is still open.
5. Each failed round reports its progress to the supervisor, for example:
   "review round 2 (discovery round, 3 at most); passes on this change: 2
   (sweep saturated); 2 fixed, 1 dismissed, 1 new confirmed, 0 regressions,
   0 disputed". A verify-only round also counts its follow-ups. A round that fixed nothing and ended
   without saturating is reported as not converging.

The supervisor still decides whether to reenter Fix or stop, and the
controller's correction budget is still the hard limit. The rules guarantee
that settled work stays settled, and that every block was confirmed or honestly
disputed by an independent verifier. They cannot bound how many real defects a
change has: a run that finds a new confirmed defect every round is working, and
its budget decides how far it goes.

### Verifying findings

After each pass that raised findings, the graph dispatches one read-only
verification job for every finding pending on the candidate. That covers new
findings, regressions, withdrawn confirmations, dismissals whose quotes broke,
findings a resume left unverified, and disputed findings on a new candidate.
The job runs on another model family from the reviewer (Claude Code), in a
fresh read-only session that has never written the change, uses a strict
`finding-verification-v1` result, and is bound to the candidate digest. For
each finding it returns:

| Verdict | Must include | Effect |
|---|---|---|
| `confirmed` | Its own call path or reproduction with `file:line`, not the reviewer's restated | The finding blocks and goes to Fix |
| `refuted` | Quotes of candidate lines, each copied from one line, that disprove the claim, such as the lock that is held or the caller that does not exist | Dismissed once the quotes match the candidate; listed in the pull request body |
| `uncertain` | Both arguments | Disputed; goes to the supervisor |

Nothing is downgraded. A P0 or P1 with thin evidence still goes to the
verifier, and one it cannot decide is disputed, so a real defect cannot slip
through on a malformed comment. A finding the verification job gives no verdict
for is disputed too, so one verification per pass is enough and the graph never
loops on it.

A refutation pins at most three quotes, and a confirmation without a `file:line`
witness is disputed. The graph observes the files a refutation quotes; a quote
matches when its text, with whitespace collapsed and at least eight characters
long, appears within three lines of the cited line. Only a relative path
without `.` or `..` segments, outside `.git`, that names a file by its
extension is observed, since observing a directory or an escaping path stops
the run; any other quoted path never matches. A refutation whose quotes do not
match is disputed.

For a disputed finding the supervisor can reenter Fix, where the next pass
gives the finding a status and a new candidate verifies it again, or stop for a
maintainer with the finding in the pull request body. It cannot dismiss a
finding by itself: a dismissal is always verification evidence.

Only confirmed findings return to Fix, each with the verifier's witness.
Dismissed findings never reach the planner or the implementer. The pull request
body lists each dismissed P0 or P1 with its refutation, so a human can overrule
a wrong dismissal.

### Executable confirmations (second phase)

For a behaviour defect, the verifier can write a Go test that the controller
runs in a candidate checkout with the test file added. Such a test confirms the
finding only under the RED contract: go test reports the named test failed by
assertion, the package built, no panic, no timeout, and the check changed no
file. The expected value must come from the issue or the code's documented
contract, never from the candidate's output, and the verifier states its
source. A confirmed reproduction becomes part of the finding: after Fix, GREEN
runs it by name with the file's bytes pinned, so it cannot be dropped or
weakened to close the finding. This needs the controller to add an
agent-written file to a checkout, which it cannot do yet.

**Scope of the missing controller capability.** `CheckoutSpec` (`packages/sdk/src/types.ts`)
is `{ from: "candidate" }` or `{ from: "base"; paths: string[] }`; `selectPaths`
and `commitPaths` (`packages/controller/src/checkout.ts`) both source bytes
only from the *live worktree's* current change (`candidateChange`), keyed by a
path already in `change.fingerprints`. A verifier's proposed test never
reaches the worktree — it is read-only and returns the file as `{path, bytes}`
in its structured result — so no existing `CheckoutSpec` variant can place it.
Closing this needs, at minimum:

- A new `CheckoutSpec` field, for example `write?: Array<{ path: string; bytes: string }>`,
  applied in `runInCheckout` before `commitPaths` commits the checkout, for
  both `from: "candidate"` and `from: "base"` (RED needs `base` plus the
  verifier's test file and nothing else; a later GREEN pin needs `candidate`
  plus that same file, unmodified).
- The same path safety already enforced for observed quotes in [review
  convergence](#review-convergence) (relative, no `.` or `..` segment, outside
  `.git`, a real file extension — see `observablePath` in the plugin's
  `findings.ts`) — worth promoting to a shared SDK guard so the controller can
  enforce it once, not trust each plugin to. A written path must not collide
  with a path the candidate's own change already touches, so a verifier cannot
  overwrite production code or existing tests under the guise of adding one.
- A stable way to "pin" the written bytes across two checkouts (RED, then
  GREEN after Fix): the finding already carries the verifier's file as
  evidence, so GREEN's `write` would replay that same evidence rather than
  re-deriving it, keeping the earlier "cannot be dropped or weakened" property
  from evidence alone, not from re-running the verifier.
- Evidence and receipts already bind to `candidateDigest` and record
  `checkout.paths`; a written file should appear there the same way, so a
  refutation or a later pass can still observe it like any other checkout
  path.

This is a `packages/sdk` and `packages/controller` change, not a plugin change:
every graph that uses checkouts would gain the capability, but only a graph
that opts into executable confirmations (like issue-fix) would use it.

### Cost and budgets

A clean round costs one pass. A failed round costs up to four passes and four
verification jobs, all read-only. The controller's `agentInvocations` budget
counts model requests, not jobs: harnesses reserve each request, Codex once at
the start and once after each command it runs, and supervisor calls draw from
the same budget. A small Codex review used 7 requests at low effort; a review of
the banyandb-fix design used about 20 at high effort. The controller's default
64 is therefore likely to run out within one failing round with planning and
implementation, so every profile declares its own measured `budgets`
([budgets](budgets.md)). The round summary shows
the remaining budget so the supervisor can stop before it runs out.

### Where it lives

- Controller and SDK: `ValidationInput.history`, checked on the wire like
  `evidence`.
- `ocr.ts`: the `code-review-v2` result (comments add `finding` and
  `evidence`; the report adds `prior`) and the pass assignment.
- `findings.ts`: the ledger, quote matching, the verification job's result and
  assignment, and the round summary.
- `validators.ts`: `code-review` evaluates the acceptance rule above.
- `graph.ts`: passes, observations, verification and the sweep; reentry
  feedback sends confirmed findings only; the pull request body lists
  dismissed findings.

## Review failures: the graph reenters Fix, or the supervisor decides

A failing code review is usually the normal Fix and Review loop, a known
correction, and the design assigns that to the graph (the core design's
[operations table](design-typescript-core.md#4-public-interface-and-process-protocol):
"Reenter: graph for known correction"). Since 0.11.0, when review fails the
graph returns `reenter` for Fix, with a reason naming the confirmed findings
and the review pass as evidence. The controller invalidates the receipts,
charges one `corrections` and bumps the generation. Fix's assignment is built
from the same confirmed findings as after a supervisor reentry, so the
implementer sees no difference. The graph reenters only when all of these hold:

- the failure is **only** confirmed findings: the last pass is usable, every
  open finding is confirmed (none disputed or awaiting verification), and the
  issues file has no unsettled issue beyond those findings;
- the loop is **converging**: it is the first failing round, or this round's
  open confirmed findings are fewer than the previous round's;
- the **reentry cap** is not reached: `review.maxReentries` in the profile
  (default 4) against the review reentries so far;
- the run still has at least two `corrections`, so the supervisor keeps one.

Otherwise the graph hands the run to the supervisor as before: any disputed
finding, a round with as many or more confirmed findings, the cap reached or
the corrections budget low, and any other reason review did not pass (missing
or incomplete passes, missing statuses, issues-file problems, contract
problems). Reentering is a graph decision inside the existing stages; no
step, stage or requirement changes.

The reentry count is not private state. It is the number of implementer work
runs after the first review pass (graph or supervisor reentries alike), read
from evidence, so a resume cannot reset it and a pass that leaves the candidate
unchanged still counts. The previous count is the confirmed findings in the
findings ledger rebuilt on the evidence before the last correction, so a
correction that changed nothing, with the same findings open, is not converging
and goes to the supervisor.

## Review discovery rounds

The reviewer may raise new findings for at most three rounds
(`MAX_DISCOVERY_ROUNDS`). After that, it only verifies that the findings
already raised are fixed. The rule extends [review
convergence](#review-convergence).

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

A candidate counts from its first record of any kind, such as the implementer
run that produced it, not from its first review pass, because the controller
shows a validator only the current candidate's latest pass, after the other
candidates' history. A candidate that Fix reached but did not hand to review
counts from its first record once a later return gets it reviewed.

The rule comes from the #119 dogfood run (`4c70ff66-dd9`). It had 24 high
findings over 11 review attempts on nine candidates. Each was fixed in the
next Fix round, but each review round raised new P1s in code the previous fix
had just written (F13 to F16, F17 to F19, F20 to F22, F23, F24). The run
needed 11 Fix-to-Review round trips to converge. Under this rule, F17 to F24,
all raised from round 4 on, would have been follow-ups. A run that adopts the
rule after round 3 rebuilds its ledger under it: high comments it first
raised in round 4 or later become follow-ups, even ones already confirmed.

Medium and low comments are unchanged. The requirement statement, the
validator binding and the private state are unchanged, so a running run can
adopt the rule with `resume --update-plugin`.

### Every changed file, and the change as a whole

Since 0.5.0 the code reviewer reviews every changed file, under every
profile. After `ocr delegate preview`, it adds back every file preview
excluded, whatever the reason: tests, docs, fixtures, generated files. It
leaves out only `.graphloom/`, the run's own bookkeeping. It then runs
`ocr delegate rule` on the whole list. Before 0.5.0 only the profile's test
files went back on the list. In #143, ocr's default selection reviewed 8 of
16 changed files; the tests, a doc and the fixtures were left out.

In a discovery round the same pass, after the per-file review, checks the
change as a whole, across files:

- data passed between modules;
- promises one file makes that another breaks;
- budget and limit invariants on every path, resume, retry and replay
  included;
- changed paths that no test in the change covers.

That is where the bugs were that a review of the delivered pull request still
found after the graph's own review had passed (#134, #143). Verify-only
rounds still cover every file and raise nothing new, and the profile's extra
rule is kept. The stages, requirements and statements, validator bindings,
result contracts and private-state schema are unchanged, so a running run can
adopt this with `resume --update-plugin`.

### One entry per problem

Since 0.10.0 a problem the code reviewer raises twice is one finding. Run
c44b4ae7-5d1 recorded about 8 problems as 14 entries: the whole-change check and
the sweep pass raised again, in other words, what the first pass had, and the
twins were verified, fixed and re-verified separately. Now:

- The reviewer is told to report each problem once: the cross-file check adds
  only problems that no per-file comment of the pass and no issue listed (the
  round's earlier passes included) describes, or reports one again with
  `finding` set to that issue's id, a duplicate of I<n>.
- The ledger merges deterministically. A new critical or high comment on the
  same path with an overlapping line range as a finding of the same round (not
  already fixed) joins that finding, and its text is kept in the finding's
  `merged` list, in the issue's description and in the verifier's assignment.
  The default is to merge; a comment the reviewer marks `distinct` (a field of
  the result, since 0.10.0) is a different problem and stays its own finding.
  Comments in later rounds are not merged: they name the finding or are new.
- One finding is one verdict, one issue and one row in `issues.json` and the
  pull request's table. A pair that sits in different files (run
  c44b4ae7-5d1's I4/I10, a source file and its test, and I6/I12) is not merged by
  location; the reviewer names the earlier issue instead.

## Acceptance coverage

Since 0.10.0 the planner's decision record may carry `acceptance`, `[{id,
text}]`, one item per acceptance-criteria checkbox and oracle line of the issue
(a planner may group); the implementer's record carries `coverage`, `[{id,
files, tests: [{file, name}]}]`, where `name` is the test's own title as written
in its file. Both are additive to `decision-record-v2`: a record without them
(from before 0.10.0, or for an issue that states no criteria) is judged as
before.

When every Fix requirement passes and the plan lists acceptance items, the
graph checks, without a model, before it accepts Fix and so before code review:
each item has a coverage entry naming a file or a test; every named file exists
in the candidate (observed from the worktree; a file the controller cannot
observe must be among the change's paths); every named test file exists and
contains the test's title. A gap sends the implementer a correction naming the
items, counted as a normal correction (`MAX_FIX_CORRECTIONS`, then the
supervisor), and code review does not run. The code reviewer then receives the
acceptance list and the coverage map, so it verifies what the items demand
rather than rediscovering them (run c44b4ae7-5d1: about 9 of round 1's 14
findings were requirements the implementer had skipped).

## The issues file

Since 0.4.0 the run tracks its critical and high findings as issues in a
file: the reviewer reports new issues, the fixer marks them fixed, and the
reviewer verifies each one and either closes it or reopens it. Only issue-fix
knows the file. The controller, the SDK and the CLI read none of it.

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
  "workspace file changed since observe". Only a read that succeeded
  consumes the fixer's run. A read that fails or times out is retried once.
  After two failed reads the graph hands the run to the supervisor. Until a
  read succeeds the graph never writes the file, because a write would
  replace the fixer's unread edits with the previously accepted table.
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
  evidence keeps the full text. The write command must also fit the SDK's
  256,000-byte executor input bound. The graph measures the serialized
  command input in bytes, so multi-byte text counts in full. It splits the
  text into argv chunks that never break a UTF-16 surrogate pair. When the
  command would not fit, it cuts `issues.md` short and never the JSON. A JSON
  that cannot fit on its own goes to the supervisor instead of being
  dispatched.

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
  BanyanDB, with the behaviour and environment of the former banyandb-fix
  graph, except that the `ocr` check finds the
  [bundled open-code-review](#bundled-open-code-review) first.
- [`profiles/graphloom.json`](../examples/plugins/issue-fix/profiles/graphloom.json):
  this repository. Preparation installs and builds, because the workspaces'
  tests import each other's `dist/`; `--include=dev` keeps a
  `NODE_ENV=production` shell from skipping tsc and vitest. It pins no file:
  `AGENTS.md` and `package.json` change often, and a pinned-file mismatch
  blocks every run until a qualified repair. There is no changelog, so no
  changelog requirement.
- [`profiles/banyandb-ql.json`](../examples/plugins/issue-fix/profiles/banyandb-ql.json):
  the Measure QL relational tickets R01 to R06, [below](#the-measure-ql-profile-and-benchmark-gates).

The example tasks are
[`examples/issue-fix-banyandb-task.yaml`](../examples/issue-fix-banyandb-task.yaml)
and
[`examples/issue-fix-graphloom-task.yaml`](../examples/issue-fix-graphloom-task.yaml),
with no budgets of their own: the profile's apply. The GraphLoom task uses `repo: .`, the checkout
it lives in. Intake pins the top level of the repository `repo` names, so the
run's worktree and state sit under `graphloom/` and `graphloom-state/` at the
repository root, which Git ignores.

## Bundled open-code-review

Since 0.14.0 the plugin depends on `@alibaba-group/open-code-review` at an
exact version (1.13.3), so operators never install `ocr` themselves. npm
installs the package's native binary from its platform package
(`@alibaba-group/ocr-linux-x64` and so on, optional dependencies with `os` and
`cpu`), so no install step downloads anything. The package's postinstall only
downloads a binary when no platform package is installed, and then skips; an
`npm ci --ignore-scripts` install works the same. The release tree ships the
dependency in its top-level `node_modules`, the platform prune keeps only the
linux-x64 package, and both packages are Apache-2.0 in `THIRD_PARTY_NOTICES`.

Every shipped profile's `ocr` check runs
[`scripts/ocr-path.sh`](../examples/plugins/issue-fix/scripts/ocr-path.sh) from
`$GRAPHLOOM_PLUGIN_ROOT`, which the controller sets to the bundle's root for
every environment check (the SDK's `PLUGIN_ROOT_ENV`). The script prints the
absolute path of the first of these that runs `delegate preview --help`:

1. A path given as its argument: a profile can name its own ocr with
   `exec sh "$r/scripts/ocr-path.sh" /path/to/ocr`.
2. `$GRAPHLOOM_OCR_BIN`, an operator override.
3. The bundled native binary. The script resolves the package from the
   plugin's real directory upward, as Node does. It then resolves the
   platform package from the package's real directory upward. A repair
   candidate links only the declared dependencies, so this is how its check
   still finds the installed tree's platform package. A binary for another host
   does not run, so the next candidate is tried. The binary that the
   postinstall would download is the last candidate.
4. `ocr` on `PATH`.

An explicit path never falls back. When nothing is found, the check fails
with exit code 127 and says that both the bundled copy and `ocr` on `PATH` are
missing. The script uses only shell builtins, so a `PATH` with just `sh` is
enough. The reviewer runs the native binary directly, not open-code-review's
Node launcher. That needs no `node` on `PATH`, which a release does not have,
and the launcher's background update check never runs. The binary sits in the
installed tree, which is read-only, and the reviewer only executes it.
A confined job sees the whole filesystem read-only, so it sees the binary too.
The one exception is a private `/tmp`, which applies only when nothing the job
reads is there. The executors ship in the same tree as the plugin, so a tree
under `/tmp` keeps `/tmp` visible.

## The Measure QL profile and benchmark gates

The Measure QL relational tickets R01 to R06 are tracked in the private
`hanahmily/banyandb-ql-design` and implemented in apache/skywalking-banyandb;
their design documents are the contract the tickets defer to, and their
benchmark rules ("Benchmark rules for every ticket" in `docs/relational-tickets.md`)
are part of every ticket's acceptance. `profiles/banyandb-ql.json` is
`banyandb.json` (same project, runner, build checks, budgets and harnesses; the
environment adds a `docker` check) plus three things that use the
[context documents](#context-documents), the `reference` delivery option and the
[final tier](#the-final-command-tier):

- `issues` names the private repository and its context is the three documents.
- `pullRequest.reference` makes the commit and the pull request say "Implements
  the Measure QL <title>" with no `Fixes` line, no reference to the private
  repository and no `{issue}` in the footer. Because an agent may still write
  the repository's name into a comment or a decision, every reference to the
  issues repository or a context document's repository (`owner/repo#N`,
  `owner/repo:path@ref`, a github.com link) is removed from the commit message
  and the body, and a line that lost one is tidied.
- One `final` command, `bench-gates` (requirement `bench-gates`), runs the
  ticket's benchmark once after review.
- One more prepare output, `bin/buf`: at the base these tickets build on, `make
  check` formats `api/` with `bin/buf`, which only `make generate` installs
  (`api/Makefile` defines `BUF` after `lint-api.mk` reads it, so `format` has no
  rule for it), so a checkout restored from the prepare cache would fail `make
  check` without the binary cached too.

`bench-gates` runs `make bench-ql-report`, a target the ticket's own
implementation adds, in `docker run --rm --cpus=4 --memory=8g --memory-swap=8g`:
a `golang` image matching `go.mod`'s `go` line (or `GRAPHLOOM_BENCH_IMAGE`),
the checkout mounted read-write, the operator's module cache mounted read-only
(`GRAPHLOOM_BENCH_GOMODCACHE`, else the cache a confined job's `file://` proxy
names, else `go env GOMODCACHE`), module downloads and toolchain switching off,
and only the container's `/tmp` for user-level state, so it runs the same under
a graph job and under the confinement of a supervisor job. It expects
`build/bench/ql-report.json` and hands the controller `{ harness, report }` as
its report file. A checkout without the make target fails with a message that
names the target, the report path and the schema, so the implementer can act on it.

The report is `ql-bench-report/v1` (the README gives the full shape): the
environment (toolchain, commit, base commit, seed, CPUs, memory), the effective
budgets, a preflight entry per size, the hard gates, and per case the raw
samples and the paired effects with intervals. The `bench-gates` validator is
the benchmark rules' hard gates and nothing else:

- exact results (`checked` > 0, `mismatches` = 0);
- zero failed timed calls;
- accounted peak memory within its budget;
- zero outstanding owned resources;
- a preflight entry for both 1,024/64 and 16,384/1,024 that fits the budget.

Each is read from counts and bytes, not from a boolean in the report. The report
must also be complete: the frozen environment, the budgets, a case at each size,
exactly five alternated pairs per case, each holding every variant once, and an interval on each effect. The
validator never reads a latency, so no timing can pass or fail it, and the pull
request's `Benchmark` section shows the medians, the effects and the RPC figures
as reported only. A gate or completeness failure is a defect in the change, so
Fix is reentered with the failing gate and its numbers, under the final tier's
rules. The planner's and implementer's guidance carries the schema and the rules
(`BENCH_GUIDANCE` in `src/bench.ts`, the profile's `planning.notes`), citing the
context document.

## Code quality gates

Status: proposed, 2026-10-28, for 0.17.0. Not implemented.

The operator's two "ub-mode" rules become hard gates on the code issue-fix's
agents write:

- **Complexity.** Every function the change adds or modifies has cyclomatic
  complexity below 10 and nesting depth at most 3. CRAP is measured too, with
  threshold 30.
- **Mutation.** Mutants of the changed functions that the tests do not kill
  fail the gate.

The metrics, the scope (changed functions only), the counting rules, the
mutation operators and outcomes, the tools and the `graphloom-metrics-v1`
record are defined once in [code quality metrics](design-code-quality-metrics.md),
shared with the pr-review graph. That document lands with PR #227, which
merges before this one. This section covers only what issue-fix does with the
measurements: requirements, jobs, corrections, evidence, delivery and profile
data. The [pr-review graph](design-pr-review-graph.md) reports the same
measurements as facts and never rejects on them.

### Requirements and where they run

All three gates are Fix requirements. They hold before code review, so the
reviewer reads tests that already kill their mutants and functions that are
already small. A gate failing after review would reopen a review round, and
review rounds are what discovery rounds bound.

| Requirement | Validator | Job | Statement (defaults filled in) |
|---|---|---|---|
| `function-complexity` | `function-complexity` v1 | The first candidate job: the cheap job, or the only job of an untiered profile | In the candidate checkout, `gometrics` (Go) or `tsmetrics` (TypeScript) measured every function the change adds or modifies, test files included and generated files excluded. Each has cyclomatic complexity below 10 and nesting depth at most 3, except a [legacy function](#legacy-functions-no-worse) over a limit at the base, whose complexity and nesting are each at most its base value. The measurements recompute from the decision and nesting evidence against the observed files and the base lines. |
| `crap-score` | `crap-score` v1 | The quality job (below) | In the quality job's Docker sandbox, the touched packages' tests ran with coverage (`go test -coverprofile`, or the repository's own `vitest run --coverage` in each touched workspace). Every changed non-test function has CRAP(m) = comp(m)² × (1 − cov(m))³ + comp(m) of at most 30, or, for a legacy function, at most its CRAP measured at the base, recomputed from the coverage reports. |
| `mutants-killed` | `mutants-killed` v1 | The quality job | In the quality job's Docker sandbox, `gomutate` or `tsmutate` applied the shared mutation operators to every changed non-test function within the profile's mutant caps and ran the touched packages' tests against each mutant. No mutant survived, except a legacy function's mutant whose id also survived at the base, or a mutant the decision record claims equivalent and an independent verifier confirmed with quotes that match the change. |

A requirement exists only when its gate is enabled in the profile (below), as
`final-checks` exists only with `final` commands. Adding one changes the
definition, which is pinned at intake. A running run therefore cannot adopt the
gates with `resume --update-plugin`; new runs get them
([core design §5](design-typescript-core.md#5-requirements-validators-and-acceptance-gates):
a new requirement needs a new run).

The commands are the graph's own, like `changes-diff`, not profile `commands`
entries. The plugin builds their argv from the profile's `quality` field and
the regression runner's language: `go-test` means Go and `vitest` means
TypeScript. The order of a candidate's checks becomes:

1. **The cheap job**, or the only job of an untiered profile. GREEN, the cheap
   commands, then `quality-diff` (`git diff -w --ignore-blank-lines
   --unified=0 HEAD~1 HEAD`, reduced to `+++` and `@@` lines),
   `quality-metrics` and `quality-base-lines`. `quality-metrics` measures
   complexity and nesting on the head and the base trees; it only parses, so
   it takes seconds. `quality-base-lines` is described under
   [legacy functions](#legacy-functions-no-worse). A complexity failure is a
   cheap-tier failure. RED, the full tier and the quality job are not paid
   for, as for any cheap failure today.
2. **RED, then the full job**, unchanged.
3. **The base quality job**, only when the change modifies a legacy function
   whose base CRAP and mutation results the run does not have yet
   ([below](#legacy-functions-no-worse)). It runs once per run in practice,
   since the base never changes.
4. **The quality job.** One read-only `command` job in a prepared checkout of
   the candidate, running `quality-tested` in the
   [Docker sandbox](#tools-per-profile-and-confinement). It runs coverage
   first, which also gives the baseline test duration, then mutation. The
   graph dispatches it only when every other Fix requirement passed on the
   same digest. Mutation never runs against failing tests, and it never runs
   twice on one digest except after a resume, as for every check.
5. **The equivalence verification**, when the decision record claims
   equivalent mutants ([below](#equivalent-mutants)).
6. The [acceptance coverage](#acceptance-coverage) check, then Fix is
   validated.

Before the quality job, the graph observes the changed source files on the
digest, so validators can check cited lines against real bytes. It uses the
same `observe` the changelog and acceptance checks use; the files do not change
until the next candidate. More than 60 files or 4 MiB is a stop with reason
"incompatible task", naming the limit. A change that big is not one issue.

### Changed functions

The rules are the shared document's
[§1](design-code-quality-metrics.md#1-scope-changed-functions-only): added or
modified functions; closures as their own functions; generated files never
measured; test files measured for complexity and nesting only. `-w
--ignore-blank-lines` keeps a reformatted legacy function out of scope. A
function is modified only when a non-whitespace line of it changed. A
modified function that was already over a limit at the base must not get
worse ([legacy functions](#legacy-functions-no-worse)).

Each tool reads the hunks and the head files and writes one record per changed
function. It also writes a `functions` index, `[name, startLine, endLine]` for
every function in every changed file, so the validator can check that the
scope is complete: every changed line inside an indexed range belongs to a
record, and every indexed range starts on a line that declares a function in
the observed bytes. Profile `quality.generated` globs are added to the shared
`// Code generated … DO NOT EDIT.` rule; for BanyanDB, `**/*.pb.go`,
`**/*.pb.*.go` and `**/mocks/**`.

### Legacy functions: no worse

A **legacy function** is a modified function that exists at the base, matched
by its qualified name, and is over the complexity or nesting limit there. It
must not get worse. Every other changed function gets the strict limits: new
functions, and modified functions that were within both limits at the base.
For a legacy function:

- complexity at most its base complexity, and nesting at most its base
  nesting;
- CRAP at most its base CRAP;
- no new survivor: every mutant that survives at the head has an id that also
  survived at the base. Ids leave lines out ([below](#mutation-time-budget)),
  so an unchanged expression keeps its id. A head survivor whose id was
  `not-run` or absent at the base counts as new.

Its base and head values are reported side by side, in the correction and in
the pull request.

**Base complexity and nesting** come from the cheap job. `quality-metrics`
also parses each changed file's base version (`git show HEAD~1:<path>` inside
the checkout, whose parent commit is the base) and writes base records for the
changed functions that exist there. It only parses, so it costs nothing worth
capping. `quality-base-lines` is a graph-owned `git show` with fixed argv. It
writes the base lines of every legacy function, each function's line range
from its base record, to `GRAPHLOOM_REPORT_FILE`, at most 60,000 bytes. The
validator recomputes base complexity and nesting against these bytes, as it
does the head's against the observed files. A tool's base numbers are never
taken on trust.

**Base CRAP and mutation** are measured only for legacy functions.

- *Why only those.* A function within complexity 10 and nesting 3 can be
  covered and have its mutants killed at bounded cost, so it gets the strict
  CRAP and mutation rules even when its base was untested. The functions
  where a strict rule could force a large refactor are the complex ones.
- *How.* They need the base's own tests run against the base code, so the
  base quality job runs `quality-tested` in a prepared checkout of the base,
  `{ from: "base", paths: [] }`. It uses the same Docker sandbox, tools, seed
  and caps as the quality job, scoped to the legacy functions by their base
  line ranges. Today a base checkout needs at least one path; the generic
  change in Phase 2 lets an empty list mean the prepared base itself.
- *Reuse.* The base never changes within a run, so a function's base result is
  measured once and read back from evidence, history included, for every later
  candidate. A later candidate that modifies another legacy function dispatches
  the job again for that function only.
- *Cost cap.* At most `quality.legacy.maxFunctions` legacy functions (default
  5) are measured at the base per run, within one `mutation.timeBudgetMs`. A
  change that modifies more is a stop with reason "incompatible task", naming
  the functions and the cap; touching that much legacy code is not one issue.
  `not-run` base mutants are not survivors, so they can only make the head
  stricter.

### Tools, per profile, and confinement

| Profile | Complexity, nesting (cheap job) | Coverage (quality jobs) | Mutation (quality jobs) | Sandbox image |
|---|---|---|---|---|
| `banyandb` | `gometrics` | `go test -coverprofile -covermode=set -coverpkg=<touched> <touched>` | `gomutate` (`go test -overlay`) | `golang@sha256:…` matching `go.mod` |
| `banyandb-ql` | same | same | same | same |
| `canopy` | `tsmetrics` | `vitest run --coverage` with `@vitest/coverage-v8` in each touched workspace (`web`, `server`); **off** until canopy declares the provider upstream (below) | `tsmutate` with the workspace's vitest; **off** with coverage | `node@sha256:…` matching `canopy/package.json` `engines.node` |
| `graphloom` | `tsmetrics` | `vitest run --coverage` with `@vitest/coverage-v8` in each touched workspace; **on** from the GraphLoom release that adds the provider (below) | `tsmutate` with the workspace's vitest; **on** with coverage | `node@sha256:…`, Node 22 |

**Static measurement** (`quality-metrics`) only parses and runs no repository
code. It stays in the cheap job, under that job's confinement, on every
profile.

**The quality job and the base quality job run in Docker on every profile.**
They use the generic `docker` confinement kind
(`JobSpec.confinement: { kind: "docker", … }`) that the pr-review design adds
to the runner
([pr-review §12.2](design-pr-review-graph.md#122-confinement),
[§15](design-pr-review-graph.md#15-generic-platform-changes)). That design
defines the sandbox and this one does not repeat it: no network, CPU, memory
and process limits, a read-only root, a tmpfs `/tmp`, the operator's
uid/gid, all capabilities dropped, `no-new-privileges`, an image pinned by
digest and run with `--pull never`. Only the checkout and a per-run build
cache are writable. The module and npm caches are read-only, with
`GOFLAGS=-mod=readonly`. The plugin's tools are mounted read-only from the
installed tree: `gometrics` and `gomutate` are stdlib-only, so `go run` builds
them offline into the build cache, and `tsmetrics` and `tsmutate` run on the
container's `node` with the `typescript` package GraphLoom ships as a CLI
dependency, mounted read-only with them. Vitest and its coverage provider are
the repository's own, installed offline from the read-only npm cache like its
other dependencies.

- **Limits are profile data:** `quality.sandbox`
  `{ image, cpus, memory, pids, tmp }`. The image is pinned by digest. The
  defaults are banyandb-ql's `bench-gates` limits: 4 CPUs, 8 GiB memory and
  8 GiB memory-swap (no extra swap), plus pr-review's 512 processes and 1 GiB
  `/tmp`. The wall clock is the job's own (below).
- **banyandb-ql's `bench-gates` wrapper** moves onto the same confinement kind
  in Phase 2, with its image and limits as data, so the profile keeps one
  Docker setup.
- **Readiness.** When a quality gate is enabled, the profile gets a
  `quality-sandbox` environment check. It needs the `docker` CLI, a daemon
  reachable by the operator's user, and the profile's image present locally by
  digest. A missing image is pulled there, by digest, before any job runs,
  and never during the run. `graphloom check` and `graphloom doctor --task`
  report each of the three, as for pr-review.
- **No unconfined fallback.** When Docker is missing, the daemon is
  unreachable, the image is absent, or the container cannot start, the quality
  job's report says `not run` with the reason. `crap-score` and
  `mutants-killed` are then **inconclusive**, and the supervisor gets the
  reason; a resume after the operator fixes Docker runs the job again.
  Coverage and mutation never run outside the sandbox. `function-complexity`
  is unaffected.

Go uses the plugin's own `gometrics` and `gomutate` rather than gocyclo with
gremlins or go-mutesting, as the shared
[§3](design-code-quality-metrics.md#3-tools) decides. For issue-fix two more
reasons settle it:

- gremlins has no boolean literal flip, which the rule names, and it brings
  operators the rule does not name;
- go-mutesting rewrites the source file in place, which an interrupted run
  leaves dirty, so the clean-run rule fails. Its MD5 blacklist also changes
  with any edit to the file, so no equivalent-mutant claim could outlive the
  next correction.

`gomutate` gives each mutant a stable id (below) and never writes the
checkout.

TypeScript uses `tsmetrics` and `tsmutate`, the plugin's own tools on the
TypeScript compiler API, and the repository's own vitest coverage, as the
shared [§3](design-code-quality-metrics.md#3-tools) decides. No mutation
framework or coverage wrapper is bundled, and adding one needs the operator's
approval. `tsmutate` never writes the checkout: each mutant is served to the
workspace's vitest by a Vite `load` hook from a generated config under the
job's temporary directory
([§3.1](design-code-quality-metrics.md#31-tsmutate)), and coverage reports and
vitest's cache are written there too.

**The coverage provider is the repository's, never installed by GraphLoom.**
Coverage uses `@vitest/coverage-v8`, the one approved third-party metrics
tool ([metrics §3](design-code-quality-metrics.md#3-tools)), from the
repository's own dependencies at the repository's vitest major version.
GraphLoom never installs it into a target repository, at run time or
otherwise. Where it is missing, coverage is `not run (no vitest coverage
provider in the repository)`, and the two gates cannot pass, so a profile
whose repository lacks it ships them off:

- **`graphloom`.** GraphLoom's implementation adds `@vitest/coverage-v8` as a
  root `devDependency` at the version matching its vitest (^3) (Phase 1). The
  `graphloom` profile turns `crap` and `mutation` on in the same release, so
  they are on from the release that adds the provider.
- **`canopy`.** Canopy's `web` and `server` workspaces use vitest ^5.0.0 and
  declare no provider. Adding one is an upstream change to
  apache/skywalking-banyandb that GraphLoom does not make on its own:
  `@vitest/coverage-v8` at the version matching vitest 5 as a
  `devDependency` in `canopy/web/package.json` and
  `canopy/server/package.json`, with the updated lockfile. The operator may
  file it as a follow-up. Until it lands, the `canopy` profile ships with
  `crap.enabled: false` and `mutation.enabled: false`, the reason `no vitest
  coverage provider in the repository`, and `function-complexity` on; the
  pull request's Quality section states both gates as "not gated" with that
  reason. Enabling them after it lands is a profile change, and new runs get
  them.

When a `vitest` profile enables `crap`, the `quality-tools` check (below)
fails unless `@vitest/coverage-v8` resolves from every workspace the profile
tests at that workspace's vitest major version, so `graphloom check` reports
a missing or mismatched provider before the run rather than as an
inconclusive gate during it.

A run that changes a checkout file fails the clean-run rule like any check. A
second environment check, `quality-tools`, resolves the plugin's tools and
the shipped `typescript` the way `scripts/ocr-path.sh` resolves ocr, and, for
a `vitest` profile with `crap` enabled, the repository's
`@vitest/coverage-v8`.
It exists only when a gate is enabled.

Every tool's version is recorded in the report: the plugin's tools carry the
plugin version, and the report adds `go`, `node`, `typescript`, and the
repository's vitest and `@vitest/coverage-v8`. The validators fail a report whose
plugin tool or `typescript` version differs from the installed plugin's, so a
host tool cannot silently change a gate. The repository's vitest and provider
are recorded, not pinned by the plugin, since the repository pins them; a
provider whose major differs from vitest's fails the report.

### Mutation time budget

Mutants are capped and sampled deterministically, so the same candidate gets
the same mutants on every run, and a correction is checked against the
mutants it was asked to kill:

- **Identity.** A mutant's id is `M` plus the first 8 hex characters of
  SHA-256 over `path`, `function`, `operator`, `original`, `mutated` and the
  occurrence index of that `original` within the function. Lines are not part
  of it, so an edit elsewhere keeps the id.
- **Size.** The shared operators
  ([§2.5](design-code-quality-metrics.md#25-mutation-testing)) are only
  relational inversions and boolean literal flips. Each relational operator or boolean literal
  in a changed function yields exactly one mutant. A function below
  complexity 10 rarely has more than a dozen.
- **Per function.** At most `mutation.maxPerFunction` mutants (default 20).
- **Per change.** At most `mutation.maxMutants` (default 120). That fits the
  default time budget at the shared document's estimate of 10 to 40 seconds a
  mutant. When the changed functions generate more, each function gets an
  equal share, at least 5.
- **Sampling.** Within a function's cap, mutants are taken round-robin over
  the operator families, so every family is tried. Within a family they are
  taken in order of SHA-256(`seed` + id), with `mutation.seed` defaulting to
  `issue-fix`. The report states `generated`, `selected` and `sampled: true`
  per function.
- **Clock.** Each mutant gets three times the baseline test duration, at
  least 30 s; a timeout counts as killed (shared §2.5). The whole job has
  `mutation.timeBudgetMs` (default 30 min). The tool stops
  starting mutants at 90% of it and records the rest as `not-run`.

`not-run` mutants make `mutants-killed` **inconclusive**, not failed. Slow
tests or a large change are not a defect the implementer can be told to fix
the way a survivor is. The supervisor gets the counts and decides: stop with
the blocker, or reenter with guidance to narrow the change. The command's job
wall clock is the time budget plus 10 minutes. A job that times out is
inconclusive the same way.

### Evidence and recomputation

`quality-metrics` and `quality-tested` write `graphloom-metrics-v1` (shared
[§5](design-code-quality-metrics.md#5-records-and-recomputation)) plus the
`functions` index and the tool versions to `GRAPHLOOM_REPORT_FILE`. The
report is at most 60,000 bytes, since the run keeps 64 KiB. A mutant that was
killed is counted, not listed; survivors, timeouts and not-run mutants are
listed by id. A report too large fails the command with a message naming the
size.

Validators judge the report only after recomputing it, and never correct it:

- **`function-complexity`.**
  - The shared §5 checks for complexity and nesting: the head records against
    the observed bytes, the base records against `quality-base-lines`.
  - The scope check against `quality-diff`'s hunks and the `functions` index.
  - The thresholds: a function whose recomputed base complexity is 10 or more,
    or whose base nesting is over 3, is legacy and is held to its base values.
    Every other function gets the strict limits.
- **`crap-score`.**
  - Coverage follows from the covered and total counts. The validator computes
    CRAP itself, and a report's `crap` field that differs beyond rounding
    fails it.
  - A legacy function is compared with its base CRAP, recomputed the same way
    from the base quality job's report. A legacy function with no base
    measurement in evidence is inconclusive, not strict: the graph dispatches
    the base job first, so that means a job is missing.
  - A coverage of `unknown`, or a report that says `not run`, is not a pass.
    Issue-fix always executes the change's tests, so either means the run went
    wrong.
- **`mutants-killed`.**
  - Survivors and `not-run` are counted from the listed mutants.
  - Each survivor's `original` must sit on its line in the observed bytes, and
    its `mutated` must differ by one operator of its family.
  - A changed non-test function with no selected mutant needs `generated: 0`,
    and the validator checks that the function's observed lines hold no
    operator of any family.
  - A legacy function's head survivors are allowed only when their ids are
    listed as survivors in its base report.

No validator reads the implementer's decision record for a number. The
implementer may run the same tools as `implementation.selfCheck` (the shipped
profiles add them when a gate is enabled), but its reported `selfChecks` are
advice to itself, as today.

### Failures go back as corrections

A gate failure is a normal Fix correction, built by `correctionFeedback` like
any other failing requirement. It needs no special tool or job. The assignment
names every offending function with its measurements and the rule. For
complexity it also names the decision and nesting lines, and asks for a
refactor into small, intention-revealing, cohesive functions, pure where
possible, that keeps behaviour and the tests green:

```text
function-complexity: 2 changed functions exceed the limits.
- pkg/query/plan.go schema.newPlanStep (lines 140-188, new): complexity 11 (limit: below 10),
  nesting 4 (limit: 3; for at 152 > if at 157 > switch at 160 > if at 163).
  Split it into small, intention-revealing functions (pure where possible) so
  each is below 10 and nests at most 3; keep the behaviour.
- pkg/query/plan.go schema.(*Planner).Build (lines 40-131, legacy: over the limits at the base):
  complexity 16, base 14 (limit: no worse than the base, 14); nesting 4, base 4 (limit: 4).
  The change added the decisions at 77 (if) and 77 (&&). Keep it at or below its base values,
  for example by moving the new logic into a small function of its own.
mutants-killed: 1 mutant survived.
- M3fa29c01 pkg/query/plan.go:88 schema.clampLimit, relational: `n > max` -> `n <= max`.
  The tests do not fail when it is mutated. Strengthen the assertions
  (for example a case above max and one at or below it), or claim it
  equivalent with a reason.
```

The loop has three bounds:

- **Graph corrections.** The graph sends a gate failure back itself only
  within the existing `MAX_FIX_CORRECTIONS` per Fix attempt, and only while the
  run's corrections budget allows. After that the supervisor decides, as it
  does for every Fix failure.
- **Convergence.** A second or later quality correction is sent only when the
  failure shrank. The previous quality failure on an earlier digest, read from
  evidence, must have more of one of these, with none of them grown: offending
  functions, total excess over the limits, survivors. A refactor that moves the
  complexity around without reducing it goes to the supervisor with both
  measurements, not to another round.
- **Run cap.** `quality.maxCorrections` (default 3) caps quality corrections
  across the run: implementer runs whose feedback carried a quality failure,
  counted from evidence, so a resume or a supervisor reentry cannot reset it.
  At the cap, the supervisor gets a summary such as "quality round 3 of 3:
  schema.newPlanStep complexity 10 (was 12, then 11)". It may reenter,
  charged to corrections as always, or stop with that blocker.

Cost per candidate that reaches it: one quality job and one observation, plus
one verifier job when equivalence is claimed. A run that modifies a legacy
function adds one base quality job, usually once per run. Agent invocations are
unchanged, apart from the corrections themselves. Active time grows by up to
the mutation time budget per candidate. The profiles' `budgets` stay as they
are until a rehearsal and a live run measure them (Phase 4).

### Equivalent mutants

A survivor is never dropped automatically (shared §2.5). The implementer may
claim one equivalent in its decision record, an additive field of
`decision-record-v2` like `coverage`:

```json
"equivalentMutants": [
  { "id": "M7c41e0b2", "reason": "presize only sets the map's initial capacity; lookups return the same values either way.",
    "quotes": [{ "path": "pkg/query/index.go", "line": 31, "text": "if presize { m = make(map[string]int, len(entries)) }" }] }
]
```

- **Bounded.** At most `mutation.maxEquivalent` claims per change (default 3),
  and at most one per function. A record over either bound fails
  `decisions-recorded`, naming the bound.
- **Verified.** For each claim on a survivor of the current digest, the graph
  dispatches one read-only verification job on the verifier harness, the
  family that confirms review findings. The job has a strict
  `mutant-equivalence-v1` result: `equivalent` with at most three quotes of
  candidate lines that make the mutation unobservable; `distinguishable` with
  an input or call that would kill it; or `uncertain`. The quotes are matched
  against the change like a [refutation's](#verifying-findings).
- **Effect.** Only `equivalent` with matching quotes exempts the mutant. A
  `distinguishable` verdict goes back to the implementer with the verifier's
  input, as a normal quality correction. `uncertain`, no verdict, or quotes
  that do not match leave the mutant surviving, and the convergence rule and
  run cap above apply. The claim binds to the mutant id and the digest: a new
  candidate whose survivor keeps its id needs a new verification only when a
  quoted line no longer matches.
- **Visible.** The code reviewer gets the exempted mutants with their reasons
  and may raise one as a finding. The pull request lists them.

### Review, the final tier and bench gates

- **Code review** gets the quality summary of its candidate in its assignment:
  the measured functions with their values, and the exempted mutants. It is
  told the gates already hold, so it does not re-raise complexity or test
  strength the gates measure. Any other defect is a finding as before. A
  review reentry produces a new candidate, which runs every gate again.
- **The final tier and `bench-gates`** are unchanged. A final failure reenters
  Fix, and the corrected candidate passes the quality gates before review and
  the benchmark run again. A performance fix that makes a function too complex
  is therefore caught before the hour-long benchmark is paid for again. Quality
  corrections do not count toward `review.maxReentries`, which counts
  implementer runs after the first review pass. A quality correction inside
  such a reentry is one of those runs, and the review cap still bounds the
  whole loop.

### The pull request's Quality section

The pull request body gets a short `## Quality` section after the test plan,
built from the reports of the delivered digest only:

```markdown
## Quality

7 changed functions measured (gometrics, gomutate; complexity below 10, nesting at most 3, CRAP at most 30;
legacy functions no worse than the base).
- New and within-limit functions: max complexity 6 (`schema.newPlanStep`), max nesting 2, max CRAP 7.4.
- Inherited, no worse: `schema.(*Planner).Build` complexity 14 → 13, nesting 4 → 4, CRAP 41.2 → 33.0,
  surviving mutants 3 at the base, 2 now, none new.
- Mutation: 58 mutants, 53 killed, 2 timed out, 2 inherited survivors, 1 equivalent (verified), 0 new survivors.
- Equivalent: M7c41e0b2 `newIndex(entries, true)` -> `newIndex(entries, false)` in `schema.buildIndex`: the flag only presizes the map.
```

Inherited functions are marked as such, with their base and head values. A
gate disabled in the profile is stated as "not gated", with the reason when
the profile gives one (the canopy profile's CRAP and mutation gates: no
vitest coverage provider in the repository). The
section never shows a number the validators did not recompute.

### Profile switches

An optional `quality` field; absent means no gates and the definition of
0.16.0:

```json
"quality": {
  "generated": ["**/*.pb.go", "**/*.pb.*.go", "**/mocks/**"],
  "complexity": { "enabled": true, "below": 10, "maxNesting": 3 },
  "crap": { "enabled": true, "max": 30 },
  "mutation": { "enabled": true, "maxPerFunction": 20, "maxMutants": 120, "timeBudgetMs": 1800000,
                "maxEquivalent": 3, "seed": "issue-fix" },
  "legacy": { "maxFunctions": 5 },
  "sandbox": { "image": "golang:1.25@sha256:…", "cpus": 4, "memory": "8g", "memorySwap": "8g",
               "pids": 512, "tmp": "1g" },
  "maxCorrections": 3
}
```

`parseProfile` accepts thresholds only at or below the shared rules
(`below` ≤ 10, `maxNesting` ≤ 3, `max` ≤ 30); a profile may tighten them,
never loosen them. A gate may be disabled; its requirement then does not
exist. `mutation.enabled` needs `crap.enabled`, because mutation needs the
coverage run. `sandbox.image` must carry a digest; `parseProfile` refuses a
tag alone. All four shipped profiles enable `complexity` with the defaults
and their own image. `banyandb`, `banyandb-ql` and `graphloom` also enable
`crap` and `mutation` (`graphloom` from the release that adds
`@vitest/coverage-v8`); `canopy` disables them until canopy declares the
provider upstream ([tools](#tools-per-profile-and-confinement)).

### Rehearsal scenarios

These are added to each profile's rehearsal, hand-written like
`bench-gate-fails`, with real tool runs under `--commands run`. A profile
gets only the scenarios its enabled gates exercise: while canopy's CRAP and
mutation gates are off, the `canopy` rehearsal gets
`complex-function-refactored`, the complexity half of `legacy-no-worse`,
and one scenario whose Quality section states the two gates as "not gated"
with the reason.

- **`complex-function-refactored`.** The first implementer pass writes a
  function of complexity 12 and nesting 4. The cheap job fails
  `function-complexity`; RED and the full tier do not run. The correction
  names the function, its decision lines and its nesting path. The second pass
  splits it, and the run reaches delivery with a Quality section. There is no
  supervisor episode.
- **`surviving-mutant-fixed`.** The first pass's test calls a function with
  an `n > max` guard but asserts only a result that does not depend on the
  guard. The quality job reports the `n > max` → `n <= max` survivor by id,
  and the correction quotes it. The second pass adds assertions on both sides
  of the guard, and the same id is now killed.
- **`equivalent-mutant-justified`.** The first pass leaves a `true` → `false`
  survivor on a flag that only presizes a map, and claims it equivalent with
  a quote.
  The scripted verifier returns `equivalent` with matching quotes, the mutant
  is exempt, and the pull request lists it. A variant whose verifier returns
  `distinguishable` sends one correction and then passes.
- **`legacy-no-worse`.** The fixture's base has a function of complexity 12,
  with one surviving mutant at the base. The first pass adds a branch to it
  (complexity 13). The cheap job fails `function-complexity` with "no worse
  than the base, 12", and the base quality job does not run yet. The second
  pass moves the new branch into a small new function, which gets the strict
  limits. The base quality job then runs once, and the quality job finds the
  legacy function's one survivor among its base survivors. The run reaches
  delivery with the function marked inherited (complexity 12 → 12) in the
  Quality section, and the base job is not run again for the review round
  that follows.

### Phases and verification

1. **Tools.**
   - `gometrics` and `gomutate`: stdlib Go, under `tools/` in the plugin.
   - `tsmetrics` and `tsmutate`: Node scripts on the shipped `typescript`,
     under `tools/` in the plugin.
   - The vitest coverage step: `@vitest/coverage-v8` resolution and its
     major-version match, the reporter, include and cache flags, and
     statement attribution from `coverage-final.json`.
   - `@vitest/coverage-v8` added to GraphLoom's root `devDependencies` at the
     version matching its vitest (^3), with the lockfile, and the `graphloom`
     profile's `crap` and `mutation` gates turned on in the same release.

   The shared document's fixtures apply to both mutators: gocyclo agreement
   on a corpus, recomputation, the overlay leaving the checkout unchanged
   (a clean worktree status and no file under the checkout modified,
   `node_modules` included), stable ids across unrelated edits (including
   between a base and a head), and the deterministic sample. `tsmutate` has
   one fixture per inversion (`<`/`>=`, `>`/`<=`, `==`/`!=`, `===`/`!==`,
   `true`/`false`, each direction), and every fixture fails if any mutant
   outside that set appears; literal types are never mutated; a module
   imported through two different specifiers is mutated for both. Coverage
   fixtures: statements attributed by line range from a checked-in
   `coverage-final.json` from `@vitest/coverage-v8`, with a nested
   literal's statements excluded; an unloaded changed file reported at zero;
   a workspace without the provider reported `not run (no vitest coverage
   provider in the repository)` and one with a mismatched major reported
   `not run` with both versions, in both cases with no vitest started.

   Two real-repository verifications:
   - one GraphLoom workspace (vitest ^3, with the provider added above):
     coverage attributed from `coverage-final.json`, then `tsmutate` at the
     covered sites kills one mutant and reports one survivor, and the
     checkout is unchanged;
   - one real canopy test (`web` or `server`, vitest ^5), with nothing added
     to canopy: coverage reports `not run (no vitest coverage provider in the
     repository)`, and `tsmutate` given that test's sites as covered (a
     test-only input in place of a coverage report) kills one mutant and
     reports one survivor with the checkout unchanged, so the vitest 5 path
     is proven before the upstream provider lands.
2. **Sandbox and gates.**
   - The generic `docker` confinement kind
     ([pr-review §15](design-pr-review-graph.md#15-generic-platform-changes)),
     shared with pr-review; whichever design lands first builds it.
   - An empty `paths` list for a `{ from: "base" }` checkout, meaning the
     prepared base. This is generic, in `packages/controller/src/inadmissible.ts`
     and the checkout code.
   - The `quality-sandbox` and `quality-tools` environment checks, with the
     `check` and `doctor --task` reports, and banyandb-ql's `bench-gates` moved
     onto the confinement kind.
   - The profile `quality` field, the three requirements and validators, the
     graph-owned commands, the observation step, the base quality job and its
     reuse and cap, the quality job's ordering, feedback, convergence and the
     run cap.

   Qualification cases for each validator:
   - passes;
   - over a limit, by one;
   - a legacy function no worse (passes) and one worse by one (fails);
   - a legacy function without its base measurement (inconclusive);
   - a head survivor whose id is not among the base survivors;
   - a report that does not recompute (complexity not 1 + decisions, a
     decision line without its keyword in the head or base lines, a survivor's
     text absent);
   - an incomplete function set;
   - foreign tool versions;
   - `not-run`, and a `not run` sandbox (both inconclusive);
   - an exempted mutant with stale quotes.

   Graph tests:
   - complexity fails in the cheap job and skips RED and the full tier;
   - the base job runs once and is reused across candidates and a resume;
   - more legacy functions than the cap stop the run;
   - the quality job waits for the other requirements;
   - Docker unavailable goes to the supervisor and never runs unconfined;
   - a non-shrinking correction goes to the supervisor;
   - the run cap counts across a resume.
3. **Equivalence and delivery.** `equivalentMutants`, its bounds, the
   `mutant-equivalence-v1` job, the reviewer's summary and the Quality
   section with inherited functions marked.
4. **Rehearse and measure.** The four scenarios on banyandb-ql and graphloom
   (L1), then one live run per language. Record the quality jobs' time and
   the correction count, and set each profile's `budgets` and `timeBudgetMs`
   from them, in [budgets](budgets.md).

## Migration from banyandb-fix

`examples/plugins/banyandb-fix` has been removed: BanyanDB runs use
`issue-fix` with the banyandb profile. The two graphs have different ids, so a
run never switched between them, and a stopped run pinned to banyandb-fix can
no longer resume from this repository. To move a task, change
`graph: banyandb-fix` to `graph: issue-fix` and add
`config: plugins/issue-fix/profiles/banyandb.json`. Its recorded run under
`examples/skywalking-banyandb/graphloom-state/` stays as replay input.

To add a repository, copy a profile beside the task, adjust it, and name it
with `config:`. A repository whose tests need another runner needs a new
built-in runner in the bundle, a source change qualified like any other.

## Verification

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
- The code review assignment, under both profiles, puts every file ocr's
  preview excluded back on the list, never `.graphloom/`, runs the rules on
  the whole list, and asks for the whole-change check in discovery rounds
  only.
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
