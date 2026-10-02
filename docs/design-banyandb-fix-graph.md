# BanyanDB fix graph

Status: implemented, 2026-09-28, as
[`examples/plugins/banyandb-fix`](../examples/plugins/banyandb-fix/). The
GraphLoom gaps listed at the end are closed except where the table says
otherwise; no live run on BanyanDB has been made yet.
[Review convergence](#review-convergence) is implemented except its second
phase, executable confirmations. This applies the
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
    product decision            --> supervisor: judges it, Stop: needs maintainer decision only if it is real
  implement                     (Claude Code, continues the plan session)
  checks                        (command jobs run by the controller)
  validate  --failed check-->   reenter Fix with the failing evidence
  |
Review                          (Codex in open-code-review's delegation mode, read-only)
  critical or high comment     --> verify (Claude Code, read-only, fresh session)
    confirmed or disputed      --> another pass for new ones, at most four per change
  nothing new survives, nothing open --> Return: branch + PR body
  otherwise                    --> supervisor: reenter Fix with confirmed findings, or Stop
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
| Checks | `make -C scripts/ci/check test` (BanyanDB's Go version and architecture test, without `make check-req`'s `ui`/`mcp` steps, which need Node.js and run `npm ci`); Go version equal to `go.mod` (1.25.13); Git >= 2.41 (open-code-review; BanyanDB needs 2.30); `ocr delegate preview --help`, printing the absolute `ocr` path; `codex --version` and `codex login status`; `claude --version` and `claude auth status`; GNU make; Node.js >= 24.6.0 |
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
   decision the plan depends on goes to the supervisor, since the graph
   itself cannot tell a genuine product question from a reviewer artifact;
   the supervisor stops the run only if it is real. One raised with an
   approval goes into the pull request's open questions.

   On the #14111 plan from the first live run, Pi with MiniMax-M3 approved it
   when the reach axis only listed lifecycle paths. Told to start from the
   changed type's own `Close` path and ask what happens when awaited code never
   returns, it named the unbounded wait in `Close` but rated it minor, and it
   blocked the plan on a test that would not fail on the base. The plan review
   narrows what reaches the code; it is not the check that proves reach.

   Validators see the current generation's evidence, so each generation plans
   and reviews again. After a re-entry, the planner revisits its plan in its
   continued session with the confirmed findings, and a fresh reviewer checks
   the revision before any code changes. The code review validator also reads
   earlier generations' evidence, passed as history, to rebuild the findings
   ledger; it still needs a pass on the current change.
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

The result is strict JSON: comments with a path, lines, category, severity, the
known finding they repeat and a concrete failure; a status for each open
finding; and a coverage summary listing any skipped file with its reason.
Critical and high comments, and comments without a severity, are verified
independently, and the review passes only as [review
convergence](#review-convergence) describes. Anything else goes to the
supervisor with the confirmed findings. If it re-enters Fix, the planner
revisits its plan with them, the plan is reviewed again, and the new change is
checked and reviewed again. Lower-severity comments are listed as left for the
human reviewer.

The reviewer changed after a comparison on PR #94's graph code, which had four
known defects. open-code-review driving MiniMax-M3 itself, at high effort with
the rule, found one of them and reported high-severity false positives, using
7 to 8 million tokens. Codex in delegation mode found three, with no clear
false positives, using about 1.4 million input tokens, mostly cached. Before
that, on the #14111 change that made `Scheduler.Close` wait forever for an
action that ignores cancellation, MiniMax-M3 found the hang only with the rule
at high effort (3.5 million tokens in 16 minutes).

## Review convergence

Without this design, the loop between Fix and Review ends only through its
limits. Every review is fresh and has no memory, so a later review can raise new
findings, raise a finding again that earlier work settled, or block on a false
positive that sends the run back to Fix until the budget runs out. Every
blocking comment also went to the implementer, so a false positive could make
it change correct code. This design makes the loop monotone and settles false
positives with evidence.

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

### Acceptance

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
   "passes on this change: 2 (sweep saturated); 2 fixed, 1 dismissed, 1 new
   confirmed, 0 regressions, 0 disputed". A round that fixed nothing and ended
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
agent-written file to a checkout; see the gaps table.

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
that opts into executable confirmations (like this one) would use it.

### Cost and budgets

A clean round costs one pass. A failed round costs up to four passes and four
verification jobs, all read-only. The controller's `agentInvocations` budget
counts model requests, not jobs: harnesses reserve each request, Codex once at
the start and once after each command it runs, and supervisor calls draw from
the same budget. A small Codex review used 7 requests at low effort; a review of
this design used about 20 at high effort. The default 64 is therefore likely to
run out within one failing round with planning and implementation, so a
BanyanDB task should raise `budgets.agentInvocations`. The round summary shows
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
| Code review | Codex, in open-code-review's delegation mode | Fresh for each pass | Read-only sandbox in the run's worktree |
| Finding verification | Claude Code | Fresh for each verification, never the implementer's | Read-only, no shell |
| Supervisor | Pi | The run's logical supervisor session | Recovery decisions and qualified graph/validator repairs in isolated candidate trees |

The supervisor handles recovery. It investigates, directs corrections and writes
qualified graph or validator repairs within existing authority and budgets. It
uses the core repair procedure, including independent review in a separate
read-only session and controller-admitted activation. It stops when no authorized
remedy remains or a hard blocker or budget prevents progress. It may switch the
implementer to Pi, or the reviewer to Claude Code, after repeated failures. It
never lets one session both write and review the same revision. It cannot
unblock a product decision, change a tier or waive a requirement. It can judge
whether a reviewer's flagged product decision is a genuine one or a malformed
artifact from that pass; only a genuine one stops the run.

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
| Agent-written files in a checkout | Open, scoped: the second phase of [review convergence](#executable-confirmations-second-phase) needs a candidate checkout with a verifier's test file added, so a confirmation can be a failing test. Needs a new `CheckoutSpec` field in `packages/sdk`, applied in `packages/controller/src/checkout.ts` before the checkout commits, with the same path safety as observed quotes; see the scoping note above |
| Qualified repair from the CLI | Open: `graphloom run` does not wire repair dependencies, so a changed `CONTRIBUTING.md` stops the run instead of reaching a repair |
| Canopy's Node.js version | Closed: a dedicated `node` preflight check, cheaper than the full `ui check-version`/`mcp check-version`. Node.js is required unconditionally, not only when the change touches `ui/` or `mcp/`: `make generate` (preparation) and `make build` (the `builds` requirement) both loop over every BanyanDB project, `ui` and `mcp` included, and each runs `npm ci` regardless of what the task changes (confirmed with `make -n` in the target repository). Scoping either to a Node-free subset would mean overriding BanyanDB's own `PROJECTS` variable per target, coupled to its Makefile internals, so the requirement stays unconditional until those paths support Go-only execution |
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
