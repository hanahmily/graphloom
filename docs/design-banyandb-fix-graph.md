# BanyanDB fix graph

Status: implemented, 2026-09-28, as
[`examples/plugins/banyandb-fix`](../examples/plugins/banyandb-fix/). The
GraphLoom gaps listed at the end are closed except where the table says
otherwise; no live run on BanyanDB has been made yet. This applies the
[TypeScript core design](design-typescript-core.md) and the
[executor design](design-executors.md) to a real repository.

## Purpose and boundary

The graph fixes one bug issue from the `BanyanDB - 0.12.0` milestone. Issues live
in `apache/skywalking` under the `database` label; the code lives in
`apache/skywalking-banyandb`. A run delivers a verified, reviewed change on a
local branch in the run's worktree, with a short commit message, and a pull
request body.
Publishing stays with the operator: the graph does not push, open pull requests,
post comments, or change labels.

A run takes one leaf issue whose expected behaviour can be tested on Linux. It is
not suited to:

- tracking parents such as #13990, #14003, #14004, #14005 and #14007;
- features that still need design, such as #14074 and #14075;
- platform-specific work that cannot be proven on Linux, such as #14094 (macOS
  ARM64);
- issues someone else is already fixing, such as #14110 (open PR
  apache/skywalking-banyandb#1374) or #13999 (PR #1380).

The first target is #14111: the scheduler reports "action timed out" for backup
and lifecycle actions that are still running, because the five-minute timeout in
`pkg/timestamp/scheduler.go` is hard-coded.

## Task

```yaml
graph: banyandb-fix
repo: ../skywalking-banyandb
request: |
  Fix apache/skywalking#14111.
```

The request names exactly one issue. The operator answers a question from an
earlier stopped run either on the issue or by appending a `Decisions:` block to
the request of a new run. The issue stays the authority; the request only adds
answers.

## Shape

```yaml
happy_path: [fix, review]
```

```text
environment preflight           (controller, declared by the graph package)
  missing tool                  --> Stop: environment
  CONTRIBUTING.md changed       --> supervisor: qualified checklist repair
                                    --> activate --> rerun preflight
                                    no authorized remedy --> Stop: environment
  |
Fix
  issue snapshot                (GitHub executor, read-only)
  plan                          (Claude Code, read-only)
    blocked                     --> Stop: needs maintainer decision
  plan review                   (Pi, read-only, fresh session)
    request_changes             --> revise the plan in the planner's session, at most twice, then supervisor
    product decision            --> Stop: needs maintainer decision
  implement                     (Claude Code, continues the plan session)
  checks                        (command jobs run by the controller)
  validate  --failed check-->   reenter Fix with the failing evidence
  |
Review                          (Codex in open-code-review's delegation mode, read-only)
  no critical or high comment  --> Return: branch + PR body
  otherwise                    --> supervisor: reenter Fix (revisit the plan), or Stop
```

Two stages is the minimum that keeps writing and judging independent. The issue
snapshot, plan, plan review, checks and corrections are supporting work inside
Fix, not extra stages.

## Environment preflight

The preflight is the controller's piece, declared by the graph. It is not a
stage: it establishes the environment needed to execute the stages. Its results
are checked again after recovery. The checklist is repository-specific: it is
BanyanDB's and comes from its `CONTRIBUTING.md`.

The graph package declares:

| Kind | Content |
|---|---|
| Checks | `make check-req`; Go version equal to `go.mod` (1.25.13); Git >= 2.41 (open-code-review; BanyanDB needs 2.30); `ocr delegate preview --help`, printing the absolute `ocr` path; `codex --version` and `codex login status`; `claude --version` and `claude auth status`; GNU make; Node.js >= 24.6.0 only when the issue touches Canopy (`ui/`) |
| Prepare | `make generate` in the run's worktree |
| Pinned source | Digest of `CONTRIBUTING.md` at the version the checklist was written against |

The controller runs the checks and the preparation at the start of the run and
again on every resume, before it admits normal Fix or Review jobs, and records
each result as evidence. A missing or wrong tool stops the run before any agent
job and names the tool. The controller never installs tools.

A `CONTRIBUTING.md` digest mismatch blocks normal jobs and enters supervisor
recovery. With existing repair authority, available source and a working repair
environment, the controller may admit recovery-only jobs: the supervisor reads
the changed contribution guide and patches the checklist in an isolated graph
candidate; controller-run qualification checks and a separate read-only reviewer
verify the repair under the core design's qualified repair procedure. These jobs
cannot write BanyanDB product code or bypass the blocked preflight. Activation
records the qualified graph version, then reruns the complete preflight before
normal work resumes. Required outcomes and the repair admission policy stay
fixed. If qualification cannot proceed or no authorized remedy remains, the run
stops with the blocker; an operator can update the package out of band and start
a new run.

Generated files from `make generate` must be ignored by Git, so they never appear
in the change the controller checks against the write scope.

## Fix

### Requirements

| Requirement | Satisfied by |
|---|---|
| `plan-reviewed` | The latest plan in this generation was approved afterwards by a read-only review job other than the implementer; the controller checks the separate reviewer |
| `decisions-recorded` | The plan's decision record is valid, every unclear point has a tier, and no product decision is marked chosen |
| `reproduces` | RED check: the base commit plus only the test-file changes fails on the new test by assertion, not by build error |
| `passes` | GREEN check: the full change passes the new test and the affected packages |
| `builds` | `make build`, `make lint`, `make check` and `make license-check` pass |
| `in-scope` | The changed paths fall within the write scope |
| `changelog-entry` | `CHANGES.md` has an entry for the issue under the current release |

### Work in order

1. **Issue snapshot.** The GitHub executor's `get-issue` and
   `list-issue-comments` operations fetch the issue body and comments. The
   snapshot becomes evidence and is the authority for the whole run. Comments
   posted later need a new run. The planner and the plan reviewer receive the
   whole snapshot, never a prefix: later comments take precedence. When the comment
   listing is incomplete or the snapshot exceeds what one prompt carries
   (200,000 characters), the run stops as an incompatible task before any agent
   job.
2. **Plan.** A read-only Claude Code job reads the snapshot, the repository and
   its `AGENTS.md` and `CLAUDE.md`. It returns a `decision-record-v1` result:
   - the test to add, its package, and where the expected value comes from;
   - the production caller the fix changes;
   - each unclear point, with its tier, the options, the chosen option and its
     basis, following the policy below;
   - for each behaviour it changes, in that decision's basis, every caller and
     lifecycle path that depends on the old behaviour (shutdown and `Close`,
     cancellation, errors, panics, retries, concurrency, resource release) and
     the test that covers it, or the risk when none does;
   - `blocked`, plus a draft issue comment, when the fix cannot proceed without
     a maintainer's answer.

   When the plan is blocked, the graph stops before any code is written. The
   blocker is "needs maintainer decision", and the evidence is the decision
   record and the draft comment.
3. **Plan review.** A Pi agent in a fresh read-only session reads the issue,
   the plan and the code it names, and judges four axes: spec (the root cause,
   nothing outside the issue), decisions (tiers, bases, conservative choices,
   no product decision), test (an expected value from the issue that fails by
   assertion on the base), and reach (every changed caller and lifecycle path
   named, and covered by a planned test or stated as a risk; a removed
   guarantee that other code relies on is blocking). Findings go back to the
   planner's session; after two revisions the supervisor decides. A product
   decision the plan depends on stops the run; one raised with an approval
   goes into the pull request's open questions.

   On the #14111 plan from the first live run, Pi with MiniMax-M3 approved it
   when the reach axis only listed lifecycle paths. Told to start from the
   changed type's own `Close` path and ask what happens when awaited code never
   returns, it named the unbounded wait in `Close` but rated it minor, and it
   blocked the plan on a test that would not fail on the base. The plan review
   narrows what reaches the code; it is not the check that proves reach.

   Validators see only the current generation's evidence, so each generation
   plans and reviews again. After a re-entry, the planner revisits its plan in
   its continued session with the code review's comments, and a fresh
   reviewer checks the revision before any code changes.
4. **Implement.** A Claude Code job continues the plan's session. It writes the
   test, the fix and the `CHANGES.md` entry. Its write scope is the repository
   except `api/proto/**`, `go.mod`, `go.sum` and `.github/**`. A decision record
   that justifies one of those paths widens the scope for that run only.
5. **Checks.** The controller freezes the full proposed change, including new
   files, under a candidate digest. It runs command jobs against that snapshot
   and records their inputs, commands and results as evidence:
   - RED starts in a separate scratch checkout of the pinned base commit. It
     verifies the toolchain and runs `make generate` using that base's source,
     lockfiles and build inputs, then applies only the candidate's test-file
     changes. No production edits or generated output are copied from the fixed
     worktree. Preparation failure is environment evidence, never a RED pass.
     RED passes only when the new test fails by assertion, not by compilation,
     setup failure or panic.
     Test identity comes from `go test -json` for plain tests, or from a Ginkgo
     JSON report with a focus on the new spec for suites; GREEN must execute the
     same regression.
   - GREEN and build checks use a separate disposable checkout containing the
     full frozen candidate. The controller creates a local commit there before
     preparation or checks, with isolated Git metadata; it does not commit the
     delivery branch. It runs the pinned preparation, then
     `make test-ci PKG=<affected packages>`. The build checks follow the
     repository's CI order: license, build, lint, check.
   - The committed candidate gives `make check` a clean baseline: its
     `check-format` target stages renormalized files and fails on any nonempty
     `git status -s`. The controller also compares tracked and non-ignored new
     files to the frozen candidate after preparation and each check. Any such
     mutation fails validation, even if the command exits successfully; record
     the diff and return it to the implementer. Generated ignored files remain
     disposable preparation output.
   - Receipts bind the candidate digest, pinned graph/check versions and the
     recorded preparation inputs. A correction creates a new candidate and
     reruns RED, GREEN and build checks; earlier passes cannot approve it.
6. **Validate.** The validators judge the requirements above from the recorded
   evidence. A failed requirement reenters Fix with the failing evidence, and the
   implementer continues its session. The existing stall and correction limits
   hand the run to the supervisor after two corrections without new established
   facts.

End-to-end tests need Kind, so they are outside the graph. The PR body says
when an issue needs them.

## Review

Codex reviews the change in
[open-code-review](https://github.com/alibaba/open-code-review)'s delegation
mode. The job is a fresh read-only agent job with purpose `review` in the run's
worktree, on the coding-agent executor's Codex harness (`codex exec` in its
read-only sandbox, without graph tools). Its result is bound to the candidate
digest like every check. open-code-review only does the deterministic part:
`ocr delegate preview` selects the files of the uncommitted change against the
base commit, and `ocr delegate rule` resolves their review rules. Codex reads
the diffs and reviews. The assignment carries:

- the delegation workflow, naming `ocr` by the absolute path the environment
  check printed, because Codex runs commands in a login shell that may reset
  `PATH`;
- the change's `_test.go` files, which preview excludes by default;
- a Go rule that asks what the change breaks outside its diff: every changed
  caller and lifecycle path without a covering test, a removed guarantee that
  other code or comments rely on, a stale comment describing a removed
  guarantee, a test whose expected value comes from the new code, and an
  on-disk or wire format change are high severity; a goroutine outside
  `run.Go` is medium;
- a background of at most 2,000 characters: the issue, the plan's summary,
  test, decisions and open questions.

The result is strict JSON: comments with a path, lines, category and severity,
and a coverage summary listing any skipped file with its reason. The
requirement passes when the reviewer finished, every file on its list was
reviewed and none skipped, and no comment is critical or high; a comment
without a severity counts as blocking. Anything else goes to the supervisor
with the comments. If it re-enters Fix, the planner revisits its plan with
them, the plan is reviewed again, and the new change is checked and reviewed
from scratch. Lower-severity comments are listed as left for the human
reviewer.

The reviewer changed after a comparison on PR #94's graph code, which had four
known defects. open-code-review driving MiniMax-M3 itself, at high effort with
the rule, found one of them and reported high-severity false positives, using
7 to 8 million tokens. Codex in delegation mode found three, with no clear
false positives, using about 1.4 million input tokens, mostly cached. Before
that, on the #14111 change that made `Scheduler.Close` wait forever for an
action that ignores cancellation, MiniMax-M3 found the hang only with the rule
at high effort (3.5 million tokens in 16 minutes).

## Unclear issues

Issue descriptions are often incomplete, so the graph applies one fixed policy
instead of pinning choices per task or leaving them to the supervisor.

**Sources, highest first:** the issue's explicit acceptance criteria; its
expected-behaviour section; maintainer or assignee comments, later over earlier;
a linked design document; existing code patterns and tests; agent judgement.

**Detection:** a point is unclear when the RED test's expected value cannot be
written from those sources.

**Tiers:**

| Tier | Covers | Handling |
|---|---|---|
| Implementation | Internal, reversible, no visible behaviour change | The implementer decides and notes it in the PR description |
| Behaviour | Options the issue lists or implies | Take the most conservative option, record the decision and the alternatives, and let the reviewer check it |
| Product | Public API or flags, wire or file formats, changed defaults, removals, destructive or security-relevant behaviour | Never decided by an agent |

**Conservative, in order:** no destructive or data-losing change; unchanged
behaviour for everything the issue does not name; the smallest new public
surface; reversible; consistent with existing patterns.

**Product decisions** block only what depends on them. When the fix stands
without the answer, the graph implements the rest, leaves that behaviour
unchanged, and lists the point as an open question in the PR description. When
it does not, the plan is blocked. Missing information needed to reproduce the
bug is handled the same way.

**No scope growth:** adjacent problems become follow-ups in the PR description.

For #14111:

| Option in the issue | Tier | Outcome |
|---|---|---|
| Cancel the action when it times out | Destructive: kills a 65-minute backup mid-upload | Ruled out |
| Configurable timeout per registration | A new flag is a product decision | Not needed for the fix |
| Warn "still running" at five minutes, then log the real outcome | Behaviour; meets "should not be reported as an error" | Chosen |

The `backupInFlight` guard stays. Whether `TotalTasksTimeout` should keep
counting these actions is an open question in the PR description, because
changing what the metric means affects anyone alerting on it.

## Agents and supervisor

| Role | Harness | Session | Access |
|---|---|---|---|
| Plan and implement | Claude Code | One session, continued across plan, plan revisions, implement and corrections | Plan read-only; implement within the write scope |
| Plan review | Pi | Fresh for each review | Read-only |
| Code review | Codex, in open-code-review's delegation mode | Fresh for each review | Read-only sandbox in the run's worktree |
| Supervisor | Pi | The run's logical supervisor session | Recovery decisions and qualified graph/validator repairs in isolated candidate trees |

The supervisor handles recovery. It investigates, directs corrections and writes
qualified graph or validator repairs within existing authority and budgets. It
uses the core repair procedure, including independent review in a separate
read-only session and controller-admitted activation. It stops when no authorized
remedy remains or a hard blocker or budget prevents progress. It may switch the
implementer to Pi, or the reviewer to Claude Code, after repeated failures. It
never lets one session both write and review the same revision. It cannot
unblock a product decision, change a tier or waive a requirement.

Budgets use the controller defaults, including the four-hour active-time budget,
unless the task sets tighter ones.

## Delivery and outcomes

A returned run leaves the change on a local `fix/<issue>` branch in the run's
worktree. The commit message is short: the title, the summary and "Fixes
apache/skywalking#N". The pull request body is the delivery command's report,
kept with the run's evidence; the stop summary names that evidence. The body
follows BanyanDB's pull request template:

- the bug-fix checklist heading, "Fixes apache/skywalking#N" and the `CHANGES`
  log item;
- summary of the change;
- decisions taken, with their alternatives;
- open questions for maintainers, the behaviours the change leaves unchanged;
- test plan: RED on the base, GREEN and the build checks, and the code review's
  result. It carries no receipt or evidence identifiers; those stay in the run.

| Outcome | Meaning |
|---|---|
| Returned | Fixed, checked and approved |
| Stopped: needs maintainer decision | The plan or review found a blocking product decision; evidence includes a draft issue comment |
| Stopped: cannot reproduce | No RED test can be written from the issue; evidence includes a draft comment asking for details |
| Stopped: environment | A required tool is unavailable, preparation cannot run, or a preflight defect cannot be resolved through authorized recovery |
| Stopped: budget or stall | The controller's limits ran out |

## GraphLoom gaps

| Gap | Current state |
|---|---|
| Graph-declared preflight and prepare commands, run at start and on resume | Closed: `GraphDefinition.environment` declares checks, prepare commands and pinned files. The controller runs them before the first job, on every resume and after activation. A pinned-file mismatch enters supervisor recovery and refuses jobs until an activated repair updates the declaration |
| Per-job harness selection in the CLI runner | Closed: `input.harness` picks among the harnesses `runner.json` enables |
| Command jobs in the CLI runner | Closed: the `graphloom.command/run` executor runs argv lists with timeouts, output tails and a report file |
| GitHub executor in the CLI runner | Closed: reads are served when `runner.json` names `github.tokenEnv` |
| Structured test evidence from command jobs | Closed: the regression command writes `go test -json` to the report file, and the plugin tells an assertion failure from a build failure |
| Prepared scratch checkouts for RED and candidate checks | Closed: `JobSpec.checkout` runs a read-only command job in a disposable, prepared checkout of the base with chosen paths or of the committed candidate. Mutations are recorded, and receipts carry the candidate digest; a changed workspace invalidates the final stage |
| Write scope exclusions | Closed: `!path` entries exclude paths from a broader scope |
| Qualified repair from the CLI | Open: `graphloom run` does not wire repair dependencies, so a changed `CONTRIBUTING.md` stops the run instead of reaching a repair |
| Canopy's Node.js version | Open: covered only by `make check-req` |
| Live run on BanyanDB | Open: the first milestone below has been exercised on a Go fixture, not on BanyanDB. When the local Go is older than `go.mod` requires, the default `GOTOOLCHAIN=auto` downloads the required toolchain during the check; with `GOTOOLCHAIN=local` the preflight stops and names both versions |

## First milestone

The graph works when:

- a run on #14111 returns with a RED receipt showing the new test failing before
  the fix, all checks passing, a Pi approval of the plan, a code review with no
  critical or high comment, and a PR body that lists the metric as an open
  question;
- a run on #14075, which still waits on a maintainer decision, stops at the plan
  with a draft question and no code change;
- a run with Go removed from `PATH` stops at preflight, names Go, and admits no
  agent job;
- a contribution-guide digest mismatch blocks normal jobs but permits authorized
  isolated repair and independent review; only successful activation and a fresh
  passing preflight resume Fix, while unavailable repair authority stops the run;
- RED in a fresh checkout generates the base's dependencies and reaches the
  regression assertion; failed preparation cannot satisfy `reproduces`;
- an uncommitted valid fix passes `make check` in its committed disposable
  checkout, while a formatting change made by the check fails validation and
  requires fresh candidate checks and review.
