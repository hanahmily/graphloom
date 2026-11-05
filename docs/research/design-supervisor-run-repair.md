# Run-wide supervisor repair

Terminology adapted for GraphLoom; implementation references below describe an earlier orchestrator.

Status: proposed, 2026-09-21. This document defines the next recovery design; it
is not a description of capabilities already deployed. It supersedes the
restricted repair menu for run-local recovery in the older RSI supervisor design.
Revised after Claude Code review and verification against the actual control-repo
`tdd-bydb` graph, including its PR-ready (not auto-merge) delivery policy.

## Objective

One durable supervisor session owns diagnosis, remediation, verification, and
recovery across the entire run. Every failure is eligible for investigation,
including previously unseen failures. Repairs may change the execution machinery
without changing what successful delivery means.

Every graph declares its own happy-path contract. It describes required outcomes
and milestone dependencies independently of the executable step/entry graph.
For the graph currently named `tdd-bydb`, the required happy path remains:

`assign -> implement -> review -> land`

Selection, context gathering, verification hooks, repair entries, and review
preparation remain supporting machinery. Repair may revisit earlier milestones;
it may not delete, reorder, merge away, or claim completion of a required milestone.
Success means completing all four with valid evidence for the delivered revision.
For `tdd-bydb`, land means verifying the deliverable and marking its PR ready for
maintainers; it does not authorize the graph to merge its own PR. Recovery does
not change that outcome. Success also does not mean making every attempted hook
invocation exit zero.

No finite remediation policy can guarantee success for contradictory requirements,
unavailable credentials, permanent provider outages, or an unsolved implementation.
The objective is autonomous recovery wherever verifiable within the bound, followed
by a resumable stop with a precise explanation when it is not.

## Why the existing implementation missed the validation failure

The real `assign@validate_revision` failure exposed three separate gaps:

1. The supervisor preferred changing output digests over the repeated hook error
   and recommended Retry without resolving the evidence-format mismatch.
2. The available graph patch fields are only `max_visits`, `max_total_visits`,
   `timeout`, and narrow `when` substitutions. Hook scripts, prompts, and runtime
   input declarations cannot be repaired through this interface.
3. A resume verdict without verified recovery evidence falls into a fence that
   reports "no remedy could be parsed" and closes the recovery episode. A rejected
   operation does not reliably return actionable feedback to the same reasoning
   loop with another opportunity to repair.

The run-wide session already exists. Extend it rather than introduce a separate
classifier, fixer conversation, or per-step supervisor identity.

## Immutable success contract and editable execution snapshot

At intake, pin two separately hashed objects:

- **Success contract:** required milestones and their order, authoritative source
  revisions, required acceptance outcomes, protected policy, review independence,
  delivery target, and the permitted terminal outcomes for that graph. This is outside the repair
  workspace's write authority.
- **Execution snapshot:** graph, roster/model selections, adapters, prompts,
  hooks, supporting scripts, and verification fixtures. This is versioned and
  repairable per run.

The success contract is distinct from assign's editable implementation contract
(`requirements.md`, design choices, and protected test implementation). Assign may
correct its interpretation, decomposition, or tests while preserving the immutable
source obligations. A normal review-to-assign correction route remains ordinary
graph execution, not a supervisor repair attempt. Only an admitted supervisor
recovery episode spends the remediation budget; its dispatched assign/implement
trial remains part of that attempt until observation completes.

Intake freezes the graph's milestone and delivery policy plus available source
revisions. If select/discover stages additional authoritative sources, the controller
records those additions before accepting assign; it cannot replace or discard prior
obligations silently. The manifest of approved verifiers is separately versioned:
repairs may replace a verifier only through the independent approval process below,
without changing its immutable obligation. Missing authoritative context parks the
run. A human-requested requirements change creates an explicit audited contract
revision, invalidates dependent receipts, and does not reset recovery budgets.

The success contract references a requirement-to-verifier manifest. It distinguishes
required behavior from its current test/hook implementation. Repairing a defective
verifier is permitted; dropping its obligation or lowering its acceptance threshold
is not. Machine-checkable invariants are enforced by the engine. Behavioral
preservation additionally needs independent review and negative tests; graph
validation alone cannot prove it.

For existing runs, an explicit migration pins the success contract from the
original graph and authoritative sources, before enabling broad repair. The
supervisor must not invent its own relaxed contract after encountering a failure.
Other graphs declare their own milestones; no shared engine rule assumes they
produce a requirements document or use TDD.

The published control default branch is never a repair target. Each accepted repair
creates a revision on `task/<run-id>` and updates that run's execution copy. A
proposal to promote the repair to the reusable graph is a separate, optional
operation and never a prerequisite for resuming this run.

## General graph happy-path contract

A happy path is a graph-owned success specification, not a hard-coded TDD sequence
and not a list of entry names. It defines stable milestone identities, dependency
order, completion obligations, evidence dependencies, and permitted terminal outcomes.
Kanban versus scheduled describes how a run starts; either running type can use any
happy-path shape. Neither scheduling nor supervisor remediation changes this contract.

### Proposed declaration

Add a strictly decoded, versioned top-level `happy_path` section to graph YAML.
The following is a proposed authoring format, not currently accepted functionality.
Its obligation references resolve to a pinned `success_obligations` manifest; labels
and explanations alone are not executable proof. The manifest records each obligation's
meaning and evidence schema. A separately versioned verifier manifest binds each
obligation to controller-executed checks and, where needed, independent review.
Unknown fields, unresolved obligations, and unenforceable completion criteria fail
validation. These examples abbreviate the manifests but not the dependency rules.

```yaml
happy_path:
  version: 1
  milestones:
    - id: assign
      label: Assign
      after: []
      requires: [assignment_consistent]
      evidence_inputs: [authoritative_sources, assignment, protected_tests]
    - id: implement
      label: Implement
      after: [assign]
      requires: [implementation_verified]
      evidence_inputs: [assignment, code, implementation_checks]
    - id: review
      label: Review
      after: [implement]
      requires: [independent_review_approved]
      evidence_inputs: [assignment, code, review_result]
    - id: land
      label: Land
      after: [review]
      requires: [remote_revision_verified, pr_ready]
      evidence_inputs: [code, base_revision, remote_head, pull_request]
  outcomes:
    - id: delivered
      kind: delivered
      requires_milestones: [assign, implement, review, land]
      requires: [remote_revision_verified, pr_ready]
    - id: no_work
      kind: no_work
      requires_milestones: []
      requires: [eligible_work_absent]
```

For `tdd-bydb`, these obligation IDs preserve its existing assignment/gates/review
semantics and PR-ready delivery. `eligible_work_absent` requires fresh, scoped
selection evidence that no candidate was eligible. It is applicable to the existing
unselected selection outcome, not to a failed or inconvenient selected issue. If the
run pins a selected issue, that evidence cannot satisfy no-work. The supervisor may
not use this outcome to escape an implementation or validation failure.

An illustrative scheduled analysis graph has different outcomes and no code or
PR requirements. This is an example, not a claim that daily RSI currently uses this
graph YAML:

```yaml
happy_path:
  version: 1
  milestones:
    - id: collect
      label: Collect
      after: []
      requires: [input_window_complete]
      evidence_inputs: [window, input_snapshot]
    - id: analyze
      label: Analyze
      after: [collect]
      requires: [analysis_verified]
      evidence_inputs: [input_snapshot, analysis]
    - id: report
      label: Report
      after: [analyze]
      requires: [report_persisted]
      evidence_inputs: [analysis, report_artifact]
  outcomes:
    - id: reported
      kind: delivered
      requires_milestones: [collect, analyze, report]
      requires: [report_persisted]
    - id: empty_window
      kind: no_work
      requires_milestones: [collect]
      requires: [input_window_verified_empty]
```

A milestone's `after` list is an AND dependency, not an array of alternatives. It
forms an acyclic graph: a release graph can declare independent `build` and
`security_check` milestones followed by `release` with
`after: [build, security_check]`. Both must have valid receipts before release.
Multiple milestones with no dependency may execute in parallel, but this declaration
does not itself add engine parallel-execution capability. Serial execution that
respects the same dependencies is valid.

The milestone set is the union of all declared outcome paths. Milestones are required
for outcomes that name them and for their transitive predecessors. Do not introduce
an unrestricted `optional` flag or let the supervisor decide which obligations apply.
Alternative delivery paths must be separately named outcomes with their own immutable
eligibility obligations. Ordered stages are simply a dependency chain.

### Binding the contract to execution

Keep `happy_path`, the obligation meanings, and outcome eligibility pinned outside
repair write authority. Add repairable `milestone_bindings` that associate a stable
milestone with graph steps/entries and verifier implementations. Every binding
must name existing execution nodes, valid obligation verifiers, and the artifact
inputs they consume. One milestone can span several entries or steps; helpers such
as selection, repair, and review preparation need no separate business milestone.
Renaming an entry or replacing a helper cannot rename or remove the milestone.

An entry/action can request verification of a milestone, but cannot mint its receipt.
The controller checks predecessor receipts, executes the admitted verifiers, captures
evidence hashes, and issues the receipt. The graph requests finalization with an
explicit declared outcome ID, through a typed terminal action. That request is a
claim to verify, not a worker-supplied authorization to choose an easier outcome.
Existing `$success` routes must be migrated to an explicit outcome binding; bare
`$success` is rejected for contract-enabled graphs. The controller checks the
outcome's eligibility, required milestone closure, and delivery obligations before
accepting completion. Failure and cancellation never become successful outcomes.

The validator checks unique IDs, schema version, all references, acyclic milestone
dependencies, outcome reachability, verifier availability, and each terminal binding.
Supporting execution routes may contain bounded correction loops. A review-to-assign
loop is legal: it invalidates dependent receipts and produces a new assignment
revision, without changing the milestone dependency graph. Execution-graph checks
reject structurally provable bypasses; runtime receipt and evidence checks enforce
dynamic conditions that static validation cannot prove.

Before activation of a repair, compare the immutable contract hash, validate the
new bindings and graph, run affected real verifiers, and simulate every declared
terminal outcome, including negative attempts to select an ineligible outcome.
Changing a binding or verifier cannot silently shrink its obligation set.

### Evidence invalidation and terminal outcomes

Each milestone receipt records input hashes and predecessor receipt IDs. A changed
`evidence_inputs` value invalidates its dependent milestone and all transitive
successors. Bindings must include the actual verifier inputs, including pinned
sources and versions; omitted dependencies are a validation failure. If a verifier
cannot enumerate a changed dependency precisely, invalidate conservatively.
Parallel siblings retain evidence only if their own inputs and predecessor receipts
are unchanged. Revalidation never implies repeating an already-completed external
effect: inspect and reconcile its actual state before requesting another effect.

Supported outcome kinds are `delivered`, `no_work`, and `skipped`. Each named outcome
has immutable eligibility and completion obligations. `skipped` requires a graph-
authorized reason with controller-verifiable evidence; a model-written reason alone
is insufficient. Unsupported work, missing context, failed checks, or exhausted
recovery allowance are blocked/failure states, never no-work or skipped success.
An operator cancel is cancellation, not a supervisor-selected skip.

Record the outcome ID and kind durably. The portal and metrics distinguish delivery,
no work, skipped, failed, and canceled; a no-work run does not paint every unexecuted
milestone green. Show non-required milestones as not applicable for the verified
outcome. A normal completion with no work does not initiate remediation.

### Adoption and compatibility

Graph authors declare the contract and migrate existing success exits explicitly.
Do not infer required milestones from arbitrary step names or have the supervisor
generate its own success contract after failure. Validation checks every declared
outcome and its negative eligibility cases before enabling broad repair. The author
may use a single milestone for a simple graph; no TDD artifacts are required.

New contract-enabled runs pin a supported schema and the resolved manifests at intake.
Legacy graphs can retain existing execution/recovery while awaiting migration,
but broad automatic graph/verifier repair stays disabled for them. Existing runs
need an explicit contract migration with budget/history preservation. Verify deployed
engine support before publishing the new YAML fields: an older parser ignoring an
unknown key is not compatibility. No migration silently changes delivery behavior.

## Repair authority

| Failure surface | Run-local repair | Required proof |
| --- | --- | --- |
| Model/provider | Select another configured model, provider, or roster agent; adjust reasoning and context settings | Provider readiness, adapter compatibility, preserved worker role and review independence |
| Prompt/context | Rewrite instructions, repair input bindings, stage missing available context, adjust summarization | Reproduce the context problem; verify required source and diagnostic delivery |
| Handoff/schema | Repair producer instructions, consumer parsing, and format adapters together | Actual failing payload passes; empty, malformed, and semantically invalid payloads still fail |
| Hook/tool | Repair shell or program logic, dependencies, paths, environment, and timeouts | Real hook regression tests, including forbidden outcomes, under the runner/container boundary |
| Route/entry | Edit conditions, add or repair helper entries, repair loops and reentry behavior | Route validation and coverage, milestone reachability/order, bounded loops, replay checks |
| Budgets/resources | Adjust local visit/time/context limits or allocation within the run's outer caps | Evidence explaining why the change can make progress; no increase to the outer recovery bound |
| Assignment/test design | During admitted recovery, dispatch assign to correct its owned assignment or tests; ordinary contract-gap routes remain normal execution | Immutable source obligations preserved; independent consistency review before implementation |
| Production implementation | Dispatch the implement worker with a precise defect and refreshed context | Normal implementation checks and a new independent review of the resulting code |
| Infrastructure | Repair isolated worktree/container/cache state; select available provider; wait for transient dependencies | Fresh liveness/readiness probes and preservation of uncommitted work |
| Engine/adapter defect | Build and test a candidate in an isolated code checkout; use a run-specific runner/adapter when supported | Integration tests, version/state compatibility, approved capabilities, unchanged success contract |

"Everything" means no diagnostic category is excluded just because no knowledge
entry or hard-coded fixer matches. It does not grant credentials, waive upstream
policy, authorize new publication destinations, or let an agent rewrite its own
success checks. Model switches use configured identities; they do not create paid
accounts or obtain new credentials.

Diagnosis is allowed even when the failure is `action_policy` or `hook_policy`.
The controller continues enforcing immutable restrictions on secrets, protected
paths, publication destinations, role ownership, and allowed external effects.
The supervisor cannot repair a refusal by disabling those restrictions, changing
its authority, or declaring a forbidden effect harmless. It may repair the offending
work through the authorized role, or propose a correction to a defective verifier
whose unchanged obligation is independently checked. A defect in the installed
policy controller itself follows the tested-change-and-deployment path below.

This deliberately replaces the blanket consult refusal in
`internal/watch/rsi_classify.go:isHardFenced` with a distinction between permission
to investigate and permission to act. Operator vetoes still prohibit automatic
effects. Unknown external outcomes require reconciliation before any replay;
diagnosis is not permission to retry a potentially completed effect.

A run-specific engine binary may implement missing execution behavior but does not
control authoritative milestone receipts, recovery limits, or final completion.
Those are verified by the installed recovery controller. If the defect requires
changing that controller, host-wide services, or an unavailable capability, prepare
a tested engine change and park for deployment. Do not self-replace the trust anchor
or deploy fleet-wide software as an incidental task repair.

The installed controller owns a receipt store that worker/candidate-engine processes
cannot write. It launches the approved deterministic verifiers using its own runner
against the exact candidate code/artifact snapshot, captures exit status and evidence,
and checks external delivery state through its own adapters. It accepts neither a
candidate engine's self-issued receipt nor a success flag as proof. Independent
semantic review comes from a separate verifier invocation that did not author the
candidate; its response and supporting tests are bound to the same hashes.

A changed verifier is admitted only after the installed controller checks the
unchanged obligation, original failure reproduction, required negative controls,
and independent semantic review. Existing unaffected policy checks always run from
the trusted manifest. Arbitrary behavioral equivalence is not mechanically provable:
if the evidence is insufficient, refuse the candidate with a specific explanation
and permit another bounded attempt. The controller never claims that a schema check
or an LLM approval alone proves preservation of all semantics.

## Recovery protocol

The graph remains parked while the supervisor repairs it. The recovery ledger
has explicit phases; these are distinct from the graph's milestone cursor:

`observed -> diagnosing -> proposed -> testing -> accepted -> activating -> resuming -> observing -> resolved`

A refused candidate ends its attempt; another diagnosis reserves a new attempt within the bound. Exhaustion or an
unresolvable external decision transitions to `needs_attention`, preserving the run.

1. **Capture.** Observe all engine, hook, action, provider, adapter, owner, and
   terminal failures. Detect repeated failures before the entry budget expires.
   An active worker is interrupted only at a safe checkpoint under ownership control;
   otherwise the supervisor waits for its boundary. Explicit operator cancellation
   always wins and disables automatic recovery/resume.
2. **Diagnose.** Atomically reserve an attempt before the first model call. Build
   an evidence packet from the actual pinned execution snapshot,
   local authoritative state, failed handoff payload, normalized hook errors,
   transcripts, code and artifact revisions, previous repair attempts, and remaining
   limits. Never substitute the published default branch for the failing snapshot.
   Knowledge entries are hints. Distinct prose/output digests alone are not proof
   of progress when the blocking check remains unchanged.
3. **Propose.** In the same logical session, identify the root cause, intended change,
   affected obligations, allowed file set, expected observation, negative checks,
   rollback point, and earliest milestone invalidated by the change. No mandatory
   selection from a finite list of diagnoses or fixers.
4. **Stage.** Within the reserved attempt, create an isolated workspace from exact
   execution, code, state, and artifact
   revisions. A repair worker may edit only the declared execution files. Code or
   contract changes go to their owning graph workers. The supervisor can use
   bounded specialist workers, but their results and actions return to its single
   session; they have no independent publication or resume authority.
5. **Test.** Reproduce the original defect, apply the candidate, and prove the
   triggering case passes. Run affected negative tests and ordinary graph gates.
   For hook changes, execute the real script rather than only mocked routing tests.
   For prompt/model changes, run a bounded behavioral trial in an isolated sandbox.
   Side effects are stubbed during candidate testing. An independent verifier checks
   preservation of obligations, especially changes to tests, gates, and routes.
6. **Decide.** The controller validates scope, unchanged success contract, test
   results, review receipt, graph policy, limits, and expected revisions. A refusal
   becomes a typed result with exact reasons in the existing supervisor session.
   A rejected candidate closes the current attempt with that result. The supervisor
   may reserve another attempt for a revised candidate within all remaining limits;
   revision cycles are not exempt. No silent conversion into a generic human
   classification, and no unsupported operation is reported as a parsing error.
7. **Activate.** Acquire ownership and compare revisions again. Persist a repair
   manifest and an accepted revision on the task branch, then atomically switch
   the local execution snapshot. Publish only authorized task-branch changes.
   Activation is journaled and idempotent: after a crash, finish the same operation
   or leave the previous snapshot active; never start from a half-updated copy.
   A publication failure leaves the run parked in activation, with a visible error.
8. **Resume.** Invalidate stale verification evidence and resume the earliest
   affected milestone at a replay-safe entry. Use an engine-issued receipt bound
   to the accepted snapshot, code/artifact hashes, cursor, contract hash, and
   attempt ID. Changed evidence invalidates the receipt. A no-edit Retry still
   requires a verified transient recovery or explicit readiness evidence.
9. **Observe.** Re-execute the original failing check and watch the affected
   milestone. A repair is not successful merely because it committed or spawned a
   worker. Return the actual result to the same session. New failure: diagnose again
   within the remaining run-wide budget. Same failure: record no progress and do
   not repeat the identical candidate automatically.

Transport restarts may create a new provider-native session, but restore the same
logical session, accepted revisions, attempt history, decisions, and remaining
budget. No second supervisor owns an overlapping effect.

### Ownership, dispatch, and cancellation

Use the existing session-owner lock for model turns, the supervisor-effects lock
for effect serialization, and the run-control owner lock for worker exclusion.
All effect paths use the same lock order: supervisor effects, then run owner.
Never hold these locks while waiting for a model or remote test. Publication uses
the existing ref-store lock inside the effect transaction; no shared checkout switch.

Watcher orphan recovery, portal Retry, and supervisor resume must use one dispatch
admission path. Under the run lock, reserve a durable dispatch intent containing
attempt ID, ownership epoch, expected revisions, cancellation generation, and receipt.
The child acquires the run lock and atomically claims that intent before any work.
A competing child or stale intent cannot execute. A reserved dispatch remains visible
to orphan detection during the parent-to-child handoff; recovery reconciles a dead
spawner/child through that intent instead of dispatching a duplicate. Manual Retry
cannot bypass an active recovery owner or the remaining recovery allowance.

Cancellation first increments the cancellation generation and invalidates outstanding
activation/dispatch authority. Check it before activation, dispatch admission, child
claim, and each external effect. During resuming/observing, send cancellation through
the existing run-control path to the actual worker and its owned subprocesses and
containers; stop them with the configured shutdown grace period and record the
acknowledgment. Invalidating the model session alone is not process cancellation.
Until worker exit is confirmed, show stopping and do not admit another owner.
Already-issued remote requests may finish: query their actual outcome, record it,
and prevent replay. Do not promise rollback of pushes or other external effects.
A canceled attempt stays charged and cannot restart automatically.

## Preserving the happy path

The engine maintains milestone receipts outside the repairable graph files.
Each receipt binds milestone identity, success-contract revision, code/artifact
revisions, required gate results, and the execution revision used to establish it.
A route to `$success` is insufficient: completion requires the declared outcome
and all valid receipts and obligations required by that outcome.

For `tdd-bydb`:

- **Assign:** coherent, source-backed assignment with required contract/tests and
  consistency checks. This includes the initial RED requirement where applicable;
  later contract revisions use their defined revision checks.
- **Implement:** implementation satisfies the current assignment and required gates.
- **Review:** an independent reviewer evaluates the actual current implementation;
  required findings are resolved and review checks pass.
- **Land:** the fork branch is pushed and contains the required base, applicable
  post-rebase gates pass, and the actual PR is marked ready according to the pinned
  delivery policy. The current `tdd-bydb` graph explicitly stops at
  `mark_pr_ready`; merging is a maintainer action and is neither a recovery goal
  nor a new prerequisite for run completion. A handoff claiming ready is insufficient:
  verify the remote head and PR state through the installed controller.

Changing assign artifacts invalidates dependent implement/review/land evidence.
Changing implementation invalidates review and land evidence. Changing a review
check requires review again. An execution-only repair retains earlier receipts
only when its declared dependencies are unchanged and the verifier confirms this.
Uncertain impact rewinds to the earliest plausibly affected milestone.

Static graph checks reject paths that bypass required milestones. Runtime receipts
reject renamed nodes or fabricated handoffs without the required verified evidence.
Preventing a weakened hook from granting success additionally depends on verifier
admission and independent obligation checks, not on receipt formatting alone. Independent review remains a
separate worker even when supervisor and workers use the same model provider.

Recovery respects side effects: inspect whether a PR, push, or merge already
happened before replay. Never roll back a real merge by resetting local state.
After a completed external effect, reconcile or perform separately authorized
compensating work instead of repeating the action.

## Hard remediation limit

Proposed defaults, pinned by the controller at intake:

```yaml
supervisor:
  recovery:
    max_attempts_per_run: 8
    max_attempts_per_failure: 3
    max_consecutive_no_progress: 2
    max_model_calls_per_attempt: 8
    max_active_time: 4h
    max_elapsed_time: 24h
    max_infra_retries_per_operation: 2
```

These keys are proposed and require schema, config validation, and implementation;
putting them in that orchestrator's current configuration file would not enable this design.

**Eight remediation attempts total per run is the main limit**, shared by every
milestone, model, worker, failure family, and resumed process. It is not eight per
entry. Within that, allow at most three attempts at the same failure and stop after
two consecutive attempts in the same failure episode show no progress. A different
failure has its own streak but shares the same eight-attempt run allowance. A verified
advance resets only that episode's no-progress streak, never spent attempt counts.
First applicable limit wins.

An attempt starts when a diagnosis is admitted, before spending its first model
turn, and covers diagnosis, one candidate (or one verified no-edit recovery), tests,
activation, and observation of one resumed affected milestone. Failed verification,
rejected proposals, abandoned attempts, and an unsuccessful resumed trial consume
an attempt. One attempt admits one submitted candidate; a refused candidate or
failed candidate test ends the attempt. A revised candidate starts a new attempt
and counts against both the run and failure limits. Drafting within the isolated
workspace is allowed before submission within the call/time budget. An observation
failure closes the attempt even if some verified progress occurred; its remaining
blocker is diagnosed in the next attempt. A resolved attempt ends at verified
completion of the affected milestone, after which ordinary graph execution resumes.

Crash recovery continues the reserved attempt by idempotency key; it cannot allocate
a fresh budget. Allow at most eight model calls per attempt, across supervisor,
specialist, independent verifier, and observed graph-worker calls. A call means
one provider request, including a tool-result continuation, not an unbounded CLI
session. Reserve before sending; the adapter must report and enforce this bound.
Do not enable unattended repair on an adapter that cannot enforce it. Ambiguous
provider acceptance consumes the reservation; retry cannot make spending invisible.
Transport retries also obey the per-operation cap. Reserve enough remaining calls
for independent verification and result interpretation before starting a candidate;
otherwise end the attempt explicitly rather than perform an unreviewable effect.
Deterministic tool invocations consume time and operation limits, not model calls.
Eight is an initial default, adjustable at intake for larger worker trials while
retaining the hard run attempt/time limits.

### Budget migration and precedence

The new recovery policy is authoritative for migrated runs; old counters remain
historical data and must not act as hidden additional recovery ceilings.

| Existing limit | Treatment for migrated recovery |
| --- | --- |
| `supervisor.max_turns` / session `MaxTurns` | Retain for non-recovery automatic turns. Recovery requests and their follow-ups use reserved attempt call capacity, not this second counter. One logical session still records both. |
| `supervisor.max_operator_turns` | Retain for operator conversation; it grants no repair/effect allowance and cannot launch an uncharged recovery. |
| `supervisor.max_infra_attempts` and RSI consult `max_infra_attempts` | Replace for recovery calls with `max_infra_retries_per_operation` plus the attempt call/time caps. Retain old behavior outside migrated recovery. |
| RSI consult `max_per_remediation` | Replace with failure-attempt and attempt-model-call limits. |
| RSI local/resume `max_attempts` | Replace recovery counters with attempt reservations and idempotent operation records. A rejected dispatch does not create free repeated model trials. |
| RSI local/resume timeouts | Keep as per-operation deadlines clipped to remaining recovery time; do not reinterpret timeout as a fresh attempt allowance. |
| RSI patch `max_per_run` and once-per-field rule | Replace numeric patch allowance with the run attempt cap and duplicate-candidate detection; retain immutable authority and outer resource constraints. |
| `supervisor.max_llm_invocations_per_step` | For migrated runs, repeated-failure consultation admits the same recovery episode and spends its budget, rather than an independent per-step repair loop. |
| Graph entry/step and normal execution budgets | Remain graph controls. Repairs may change editable inner limits, but not the controller-pinned outer run limits. |

Migration records the resolved effective policy once and disables legacy recovery
admission for that run. Existing usage is retained; migration never silently grants
a fresh eight attempts. If legacy records cannot be mapped reliably, require an
explicit operator-approved remaining allowance before enabling automatic recovery.
Config validation rejects ambiguous simultaneous legacy/new recovery overrides for
migrated runs. The portal shows the effective limits, consumption, and exact stopping
limit. Granting additional attempts must explicitly name any other exhausted limit
being extended; unrelated exhausted time/call limits are not reset implicitly.

Active time includes recovery model calls, workers, tests, and the resumed affected
milestone under observation. Time waiting for quota or an external dependency
consumes elapsed time but not active time. A recovery worker enforces the remaining
time deadline even if the provider returns no events. The normal run also retains
its separately pinned execution/resource limits; visit-limit repairs cannot bypass
those limits. Four hours is an initial operating default, configurable at intake
for graphs whose verification requires more time.

The controller fingerprints a failure using the blocking obligation, normalized
error, and causal input revisions; changing wording, model, entry name, or failure
code cannot reset the total budget. All unresolved attempts for the same blocker
remain one failure episode until its verification succeeds. Progress requires a
blocking check passing, a reproduced defect eliminated, or a required milestone
advancing with valid evidence; changing output hashes is insufficient.

An ordinary portal Retry, graph refresh, model switch, watcher restart, or
session reconstruction never resets these limits. A human may explicitly grant an
additional bounded allowance with an audit reason. Cancellation cannot be overridden
by unused budget. On exhaustion, preserve code, artifacts, PR, snapshots, and
session; display the last blocker and remaining choices. Do not archive the run.

## Data and integration

Extend the existing run-wide session and remediation ledger; avoid a parallel
recovery subsystem with conflicting ownership.

- **Recovery policy:** immutable per-run limits and success-contract hash.
- **Attempt record:** monotonically increasing ID, failure episode, exact evidence
  revisions, hypothesis, allowed scope, before/after snapshot hashes, tests,
  independent review, invalidated milestones, deadlines, and result.
- **Execution manifest:** content-addressed graph, prompts, roster, adapters,
  helper scripts, fixtures, and optional run-specific runner revision. Runtime
  reads one active manifest; cached copies cannot disagree with that pointer.
- **Milestone receipts:** controller-owned, version-bound evidence and invalidation
  records. Worker output is evidence to check, not an authority to mint receipts.
- **Operation journal:** request ID, ownership epoch, expected revisions, effect
  receipts, and durable activation phase for replay safety.

The recovery controller is the evolved existing recovery path, not a second service:

| Component | Ownership after migration |
| --- | --- |
| `internal/supervisor/session` | One durable conversation, provider-session restoration, turn history, and model ownership. Recovery calls carry attempt reservations. |
| `internal/remedy` | Durable run recovery policy, attempts, operation journal, and the phase machine. Extend `Ledger`/`Advance`; do not run the old and new phase machines for the same task. |
| `internal/watch` | Observe/admit failures, drive the recovery phase machine, and dispatch through the shared run-control path. Existing `superviseRecovery` is evolved; the old `classifyFailure` plus bounded-patch dispatch is disabled for migrated runs. |
| `internal/rsi` | Knowledge supplies evidence aids. Retire the finite patch-field menu for migrated recovery; immutable authority checks move into explicit controller admission, not knowledge matching. |
| `internal/intake` | Snapshot staging, materialization, boundary publication, and receipt-bound resume. Replace independent cached-file overwrite with execution-manifest activation. |
| Engine / installed controller | Trusted verifier execution, milestone receipt issuance and invalidation, completion checks, and replay enforcement. |

Map old ledger records explicitly: `Phases` remain append-only history; new phases
carry attempt IDs. `Attempts` become historical counters plus the authoritative
reservation journal. `Consults` link to the same session turns and attempt IDs.
`Patches` link to candidate manifests and accepted execution revisions. Existing
terminal records and failed-operation fingerprints remain evidence, not permission
to replay. A migration version selects exactly one admission/advance implementation.
`router` and `prloop` retain their current import boundaries. The portal reads these
records rather than reconstructing recovery state from log phrases.

### Shared infrastructure coordination

The existing ledger can represent multiple `AffectedTasks`, but the current
`superviseRecovery` sends such ledgers to human handling. Do not claim or depend on
an already-working automatic shared-fix path. Migrate those ledgers explicitly.

Run reasoning and budgets stay per-run. A separate resource-operation record deduplicates
shared effects by resource identity, observed fault generation, and operation kind
(for example the host Docker daemon, not just matching error text). One elected
executor holds the resource lease; other affected runs subscribe to its result and
do not launch competing repairs. This is effect coordination, not another LLM
supervisor. Host-wide mutations still require their declared authority; waiting and
readiness probes do not authorize a service restart.

Each affected run charges at most one admitted attempt while diagnosing/joining that
operation. An already-classified passive dependency wait opens no additional attempt
on each watcher tick. A shared operation failure closes joined attempts with the
same evidence; another actual proposal must spend a new attempt. Successful repair
does not bulk-resume tasks: each supervisor rechecks its own prerequisites and gets
its own resume receipt under its own owner and limits. Cancellation removes that
run's subscription and resume authority; it does not cancel an operation still
needed by another authorized subscriber. Resource executor crashes use the same
journal/reconciliation rules before a replacement may repeat the effect.

## Portal

Render the milestone labels and dependencies from the run's pinned happy-path
contract. Show a strip for a dependency chain and a dependency view for parallel
milestones. Never hard-code TDD stages in the shared portal: `tdd-bydb` renders
**Assign / Implement / Review / Land**, while the illustrative analysis graph
renders **Collect / Analyze / Report**. Attach recovery to the affected milestone;
it is not another business milestone. Always show the verified terminal outcome
separately, including no-work or skipped with its evidence-backed reason and
not-applicable milestones.

Show: `Repairing validation — attempt 2 of 8`, current phase, elapsed/active time,
root-cause summary, proposed changes, verification results, and the next resume
point. Provide a diff of original and current run snapshots and their revision IDs.
The activity feed includes concise decision rationales and observable evidence,
not private model reasoning. Rejected operations and remaining limits stay visible.

Controls: stop recovery, inspect evidence/diff, retry within remaining allowance,
restore a prior execution revision with receipt invalidation, and explicitly grant
an additional bounded allowance. Restoration does not undo external side effects.
Promotion to the published graph is separate and optional.

## End-to-end acceptance

Use a sandbox control repo, code repo, deterministic provider stubs, and the real
engine/container/hook boundary. Assert durable state and external sandbox effects,
not only a simulated final status.

1. Reproduce the structured-evidence rejection plus omitted retry diagnostic. The
   supervisor identifies the mismatch, patches hook/prompt/input declarations only
   in the task snapshot, proves valid structured evidence passes and invalid evidence
   fails, resumes validation, and completes assign -> implement -> review -> land.
   Published default-branch bytes must remain unchanged.
2. Inject model unavailability, bad prompt/context, malformed handoff, broken hook,
   invalid route, missing repair entry, and isolated tool dependency failures. Verify
   the appropriate repair and real progression without bypassing a milestone.
3. Propose deleting review, routing directly to land, replacing a test with `true`,
   lowering an acceptance threshold, changing authoritative requirements, or marking
   success through agent output. Each candidate is refused with actionable feedback.
4. Change the contract after implementation and change code after review. Verify
   dependent evidence is invalidated and the required work runs again.
5. Repeat the same failure with changing text, model, and entry names. Verify no
   progress is recorded and per-failure, no-progress, and total limits hold. Trigger
   eight unrelated failures and verify a ninth attempt cannot start.
6. Restart at reservation, test completion, commit, publication, local activation,
   and resume dispatch. Verify one activation/effect per operation ID, no reset
   budgets, and no mixed execution snapshot. Race portal Retry with the supervisor.
7. Cancel during diagnosis, testing, activation, resuming, and observing. Race
   cancellation with dispatch intent reservation and child claim. Verify no stale
   worker can start, already-running workers/subprocesses/containers stop and
   acknowledge, and already-issued external effects are reconciled without replay.
8. Reject a resume without a valid receipt. Return the exact reason to the same
   session and permit a bounded revised proposal; do not misreport a parser error.
9. Run final replay tests around push and marking the PR ready. For `tdd-bydb`,
   require the verified remote revision and an actual ready PR, with zero merge
   requests from the graph or supervisor. Test reconciliation of a maintainer's
   concurrent merge separately; it must not trigger a duplicate delivery effect.
10. Test provider outages, silent hangs, time exhaustion, and controller restart.
    Time and call bounds survive restart, and exhausted runs remain inspectable and
    manually resumable. Verify engine-candidate repairs cannot rewrite policy or
    mint their own success receipts. Forge a valid-looking candidate-engine receipt
    and verify the installed controller rejects it without independent check results.
11. Migrate runs with legacy consult/patch/resume history and near-exhausted budgets.
    Verify one recovery owner, no double charging, no fresh budget from migration,
    and no hidden legacy cap. Exercise rejected candidates, provider continuations,
    and insufficient capacity for verification/result interpretation.
12. Fail one shared dependency across five runs. Verify a single authorized resource
    operation, per-run accounting, independent resume receipts, cancellation of one
    subscriber, and crash-safe resource ownership transfer.
13. Exercise both an ordinary review-to-assign correction and a supervisor-dispatched
    assignment repair. Only the latter spends remediation allowance; neither changes
    immutable requirements. Verify an explicit operator requirements revision
    invalidates dependent evidence without resetting budgets.
14. Diagnose action/hook-policy refusals. Accept a scoped correction to offending
    work or a proven defective verifier; reject disabling the immutable restriction.
    Unknown side-effect outcomes remain unreplayable until reconciled.
15. Run the same controller against TDD, scheduled analysis, a single-milestone
    graph, and a graph with parallel prerequisite milestones. Verify their
    own declared order, evidence invalidation, and delivery outcomes; require no
    TDD artifact from the non-TDD graphs. Portal labels/dependencies come from
    the pinned contract, including after an execution-node rename.
16. Exercise declared delivered, no-work, and skipped outcomes. Verify scoped
    empty-selection and empty-window evidence, required prefix receipts, and
    not-applicable portal states. Reject a no-work/skip claim for a selected task
    with failing checks, unknown outcome IDs, bare `$success`, missing predecessor
    receipts, cycles, unknown schema fields, and unsupported verifier references.
17. Repair a supporting loop and rename execution entries while preserving stable
    milestone IDs. Change one branch's input in a dependency graph: invalidate that
    branch and its successors, retain an unaffected sibling, and reconcile existing
    external effects. Verify a legacy graph cannot opt into broad repair through
    silently ignored fields or a supervisor-generated contract.

Stub tests establish wiring and bounds, not model diagnosis quality. A separately
budgeted live-model evaluation uses the same failure corpus to measure diagnosis,
repair success, false-progress claims, and verifier refusal accuracy before rollout.

## Delivery milestones

1. **Contract and bounds:** general happy-path schema, milestone bindings and
   terminal-outcome validation preserving each graph's actual delivery semantics,
   trusted milestone receipts, durable run-wide limits, legacy ledger/
   budget migration, single recovery ownership, and portal recovery status.
2. **Repair workspace:** unrestricted diagnosis plus scoped graph/prompt/hook/
   route/entry edits, real regression execution, independent verification, and typed
   operation feedback. Start in proposal-only mode while validating refusal cases.
3. **Activation and recovery:** task-only publication, atomic execution manifests,
   crash-safe activation, evidence invalidation, shared dispatch admission,
   cancellation of resumed workers, safe resume, and observation loop.
   Enable automatic run-local repairs after the validation incident passes end to end.
4. **Broader repairs:** configured model/provider changes, role-aware worker dispatch,
   adapter/tool/environment repairs, shared resource-operation coordination, and
   isolated run-specific runner support with controller-issued evidence.
5. **Rollout:** full failure corpus, live-model evaluation, portal controls, and
   optional promotion of proven repairs through a separate publication graph.

Implementation should prove the actual validation incident at milestone 3 before
claiming the supervisor can recover arbitrary graph defects. The complete design
is delivered only when the broader failure corpus and unchanged happy path pass.
