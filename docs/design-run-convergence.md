# Run convergence: acceptance that survives retries

Proposed, 2026-10-02; not implemented. Extends the
[core design](design-typescript-core.md) §5, §6 and §10 and the BanyanDB graph's
[review convergence](design-banyandb-fix-graph.md#review-convergence). It changes
how freshness, correction escalation, repetition and plan review work so that a
run whose candidate is already correct can reach acceptance instead of re-earning
it until a budget runs out. The pinned invariants stay: the step set is fixed,
receipts rest on evidence for the current candidate under admitted bindings, the
implementer cannot satisfy its own review, budgets never reset, and only the
controller issues receipts.

## 1. What the live run showed

The first live run of the BanyanDB fix graph against apache/skywalking#14075
(run `a23b53b8-5df`, 2026-09-30 to 2026-10-01) produced the fix that shipped as
apache/skywalking-banyandb#1383, yet the run itself never accepted its Fix
stage. The record, read from the run's durable state:

| Fact | Value |
|---|---|
| Generations | 45 (18 resumes, 27 reentries) |
| Receipts issued | 0; `current.stageId` stayed `fix` throughout |
| Working-tree diff | unchanged from about generation 12: 7 files, 77 insertions, 15 deletions |
| Plan-review verdicts | 29 passes; `request_changes` at generations 1, 2, 3 and 19; `approved` at every other pass, including all 19 from generation 22 on |
| `correctionTrials.fix` | 2 (the cap) from before generation 14 to the end |
| Supervisor decisions on `correction_limit` episodes | `reenter` then `return`, repeated across roughly 20 generations, never detected as repetition |
| Agent-invocation budget | reset by the operator three times; each reset was consumed by re-planning and re-reviewing the same unchanged candidate |

Two mechanisms, acting together, made this inevitable; two more made it hard to
see. None of them is a defect in the candidate code, which independent `go
build`, `go test -race`, `make lint` and `make license-check` confirmed.

## 2. Root causes

### 2.1 Freshness is defined by generation, not by candidate change

The core design says acceptance needs evidence for the current candidate and
that "missing or stale evidence does not count" (§5), but never defines
*stale*. The implementation defines it by generation number:

- `bumpGeneration` runs on every reentry and every resume
  (`packages/controller/src/generation.ts`, `loop.ts` `case "reenter"`,
  `controller.ts` resume path).
- `invalidateFromStage` marks every receipt of the reentered stage and all
  downstream stages `valid: false` unconditionally
  (`packages/controller/src/admit.ts`), whether or not the candidate changed.
- The BanyanDB graph filters its own evidence with `inGeneration` and runs
  `evaluateFix(current, digest)` over that window only; its comment says so:
  "Validators see only this generation's evidence, so every generation plans
  and reviews its plan" (`examples/plugins/banyandb-fix/src/graph.ts`).
- `ValidationInput.history` carries earlier generations, but by the BanyanDB
  design's own rule "a validator must not pass a requirement from history
  alone" ([evidence from earlier generations](design-banyandb-fix-graph.md#evidence-from-earlier-generations)).

So an operator resume after a budget reset, or a reentry after an unrelated
executor failure, costs the full set: a new plan, a new plan review, a new
implementer pass, new RED and GREEN checks, new build/lint/license runs, a new
changelog observation. Nothing carries over, even though the candidate digest is
identical. In CI terms: "retry" behaves like "a new commit was pushed" every
time, and one of the re-run checks is an AI reviewer that can fail for reasons
unrelated to the code (one pass failed at its own output limit).

### 2.2 Correction escalation has no exit except stage acceptance

The core design (§6) intends: "After two failed correction trials at the same
unresolved stage, transfer to the supervisor before a further trial." The
implementation (`packages/controller/src/escalation.ts`, `loop.ts`
`prepareDispatch`) makes that transfer permanent:

- `correctionTrials[stage]` increments on each normal-mode `work` dispatch that
  counts as a correction, and is cleared only by `clearResolvedTrials`, which
  requires the stage's requirements to be met.
- Once it reaches `MAX_CORRECTION_TRIALS` (2), `correctionHandoff` refuses every
  later graph `work` dispatch for that stage and enters recovery with trigger
  `correction_limit`.
- `reenter` on the same stage increments `current.attempt` rather than
  resetting it, so `isCorrection` (`attempt > 1`) stays true, and `reenter`
  never touches `correctionTrials`.

The only path out is a supervisor-dispatched `work` job that leads to full
acceptance. A supervisor that answers the handoff with `reenter` then `return`
hands the stage back to a graph whose next dispatch is refused again. The loop
has no terminating condition other than budgets.

### 2.3 The repetition detector watches the graph, not the supervisor

`noteGraphDecision` counts a normal-mode graph decision repeated with no change
in `progressMark` and escalates after two (`escalation.ts`; core design §6 "Two
repeated no-progress decisions also trigger recovery"). Supervisor proposals
never feed it. A supervisor already in recovery can propose the same action for
the same episode kind indefinitely, and nothing in the controller or in the
supervisor's own prompt tells it that it has done so before. `RunView` does not
expose `correctionTrials`, the handoff state, or any repetition count, so the
supervisor cannot infer the situation either.

### 2.4 Plan review is a one-way gate

The Review stage already treats a reviewer's finding as a claim to be checked:
an independent verifier confirms or dismisses it and a dismissed finding cannot
block ([the findings ledger](design-banyandb-fix-graph.md#the-findings-ledger)).
Plan review has no such step. A `request_changes` verdict sends the planner
back to revise; the planner may answer a finding it disagrees with in the
decision record's `basis`, but nothing requires the reviewer to engage with
that answer, and after `MAX_PLAN_REVISIONS` (2) the dispute goes to the
supervisor rather than to a verifier. In the live run this was not the binding
constraint (the reviewer approved from generation 22 on), but the one
substantive disagreement at generation 19 — whether Boundary item 4 requires an
in-process rollback or a restart-triggered flip — was never adjudicated; later
passes simply approved without resolving it, and it reached the pull request as
an open question.

### What the supervisor fixes in hanahmily/graphloom#97 do and do not cover

That pull request tells the supervisor, for a `correction_limit` trigger, that
`reenter` then `return` cannot help and that it must dispatch the stage's work
itself; it also validates text-only replies the same way as tool calls and
shares the continuation checks. Those are prompt- and admission-layer
mitigations: they stop the observed loop when the model follows the prose. The
design below moves the guarantees into the controller so convergence does not
depend on a model reading a sentence correctly.

## 3. Goals and non-goals

Goals:

1. A retry with an unchanged candidate reuses what that candidate already
   earned. A changed candidate re-earns everything the change can affect.
2. Correction escalation has a defined exit that a supervisor trial can reach
   without full acceptance.
3. The controller detects a repeating supervisor as it detects a repeating
   graph, reports it to the supervisor, and refuses the repetition in a way the
   supervisor can correct.
4. Plan review disputes are adjudicated with evidence, like code review
   findings, instead of being settled by who speaks last.

Non-goals: passing a requirement from history for a different candidate;
letting a plugin, worker or supervisor synthesize a receipt; relaxing reviewer
independence; resetting any budget; changing the step set or any requirement
statement.

## 4. Design

### 4.1 Candidate-anchored freshness

Evidence and receipts are fresh when they were produced for the current
candidate under the currently admitted binding. Generation becomes producer
metadata and a fence for version transitions and crash recovery (its purpose in
core design §8), not a freshness boundary.

Controller:

- A receipt is `valid` while `receipt.candidateDigest === state.candidateDigest`
  and its validator binding is unchanged. Receipts already carry the candidate
  digest ([GraphLoom gaps](design-banyandb-fix-graph.md#graphloom-gaps)).
- `invalidateFromStage` on reentry invalidates a receipt only if the candidate
  changed since it was issued, or the receipt's stage depends on a stage being
  reentered *and* that reentry produces a new candidate. A reentry that edits
  nothing invalidates nothing; the graph still gets a new attempt.
- A workspace change (already detected by fingerprint) invalidates every receipt
  whose digest no longer matches, in any stage. This replaces the current
  "changed workspace invalidates the final stage" rule with the general one.
- `ValidationInput.evidence` is the evidence for the current candidate digest,
  oldest first, across generations; `ValidationInput.history` is the evidence
  for other candidates. Validators that order evidence (`planReviewed` checks
  that the review follows the plan) keep working, because order within one
  candidate's evidence is preserved.
- Resume never invalidates; it already does not, but the plugin-side generation
  window made it behave as if it did.

Plugin (BanyanDB graph): replace `inGeneration` with `forCandidate(evidence,
digest)` in `fix()`, `review()` and `evaluateFix`; delete the "every generation
plans and reviews its plan" behaviour. The plan reviewer is re-dispatched when
the plan record or the candidate changed, not when the generation did.

What this buys: in the live run, generations 13 through 45 would have shared one
candidate digest. The deterministic receipts (RED, GREEN, builds, scope,
changelog, decision record) earned once would have stayed valid; the plan-review
approval at generation 13 would have stayed valid; Fix would have been accepted
when the seventh receipt landed, and the run would have moved to Review.

Illustrative controller rule, not the current code:

```ts
function receiptStillValid(r: Receipt, state: DurableRunState): boolean {
  return r.candidateDigest === state.candidateDigest
    && bindingFor(state, r.requirementId)?.version === r.validatorBinding.version;
}
```

### 4.2 Correction escalation with an exit

Keep the rule "after two failed trials at one unresolved stage, the supervisor
authorizes the next." Change what the counter counts and how it clears:

- A correction trial is a `work` dispatch that follows a *failed* `work`
  dispatch on the *same* candidate. The first `work` dispatch after a candidate
  change, or after upstream acceptance, is not a correction. `isCorrection`
  derives from this, not from `attempt > 1`, which is permanent once set.
- `correctionTrials[stage]` counts consecutive failed trials since the last
  supervisor-authorized trial on that stage. A supervisor-dispatched `work` job
  that settles — succeed or fail — resets the counter to 0 and clears the
  handoff. The graph then owns the next trials again, up to the cap.
- The handoff is explicit durable state: `handoff[stage] = { since, reason,
  trials }`. While it is set, a graph `work` dispatch is refused with the
  existing `correction_limit` trigger; a supervisor `work` dispatch is admitted
  and clears it; `reenter` leaves it set.
- `attempt` keeps incrementing so history stays acyclic (§6 "Retries append
  attempts"); it no longer carries escalation meaning.

### 4.3 Repetition detection for the supervisor

Extend the no-progress rule to recovery:

- Every admitted supervisor proposal is keyed by `(episode trigger code,
  stage, action type, stable hash of the action spec without reason text)` and
  counted against the current `progressMark`, exactly as graph decisions are.
- The count is reported back as a settlement fact on the next turn: "proposal
  reenter(fix) is the 2nd with no progress since <mark>; the prior one led to
  the same correction_limit episode."
- On the third identical proposal with no progress the controller rejects it as
  the admission tools reject a malformed job: an in-turn rejection the
  supervisor can answer with a different action, not a stop. A stop still
  happens when budgets are exhausted or the supervisor chooses it.
- `RunView` gains `escalation: { correctionTrials, handoff, repeatedProposals
  }` so the supervisor sees the situation it is asked to resolve. The
  supervisor prompt renders each trigger code with its consequence for the
  available actions (what #97 did for `correction_limit`, generalized).

Counters keep crossing mode changes until progress or acceptance clears them,
as §6 already requires; a resume restarts the graph's repeat counts (current
behaviour) but not the supervisor's.

### 4.4 Plan review as an adjudicated dialogue

Apply the Review stage's ledger to plan review:

- A plan-review finding is a claim with an id, axis and severity. The planner
  answers it in `decisions[].basis` (existing) or changes the plan.
- A finding the reviewer repeats after the planner answered it is *disputed*.
  A disputed finding goes to an independent read-only verifier session, as code
  review findings do, with the issue, the plan record and the repository; the
  verifier returns `confirmed` or `dismissed` with quotes.
- A dismissed finding cannot block approval and is not raised again for the same
  plan record. A confirmed finding must be addressed before approval. A finding
  the verifier cannot settle stays disputed and goes to the supervisor; a
  product-tier point goes to the operator as today.
- The review verdict schema (`review-verdict-v1`) gains per-finding state
  (`raised`, `answered`, `confirmed`, `dismissed`, `disputed`). `planReviewed`
  passes when the latest pass on the current plan record and candidate approves
  or raises only dismissed findings. The round cap counts rounds per unresolved
  finding, not revisions of the whole plan.
- Reviewer independence is unchanged: the verifier is a third session, distinct
  from both the planner's and the reviewer's.

This is a validator and evidence-schema change for an existing requirement, not
a new requirement, so it is within plugin repair scope under §5.

### 4.5 Supervisor guidance is defense in depth

The prompt changes in #97 stay. With 4.2 and 4.3 in place they become
explanatory rather than load-bearing: a supervisor that still proposes a futile
`reenter` gets one settlement fact, then a correctable rejection, and the
handoff can be cleared by any authorized trial it dispatches.

## 5. Interfaces and seams

| Surface | Change | Package |
|---|---|---|
| `Receipt.valid` semantics | candidate- and binding-anchored; generation not consulted | controller `admit.ts` |
| `invalidateFromStage` | invalidates only receipts whose candidate changed or depend on a changed upstream candidate | controller `admit.ts` |
| `ValidationInput.evidence` / `history` | current-candidate evidence across generations; other candidates in history | sdk `types.ts`, controller `admit.ts` |
| `DurableRunState.handoff`, `repeatedProposals` | new durable fields with defaults | controller `state.ts` |
| `correctionTrials` counting and clearing | consecutive failed trials since last authorized trial; reset on any settled supervisor `work` dispatch | controller `escalation.ts`, `loop.ts` |
| `isCorrection` | derived from candidate and prior failed trial, not `attempt > 1` | controller `loop.ts` |
| Supervisor proposal repetition | counted against `progressMark`; third repeat rejected in-turn | controller `loop.ts`, `escalation.ts` |
| `RunView.escalation` | exposes trials, handoff, repeated proposals | sdk `types.ts`, controller `toRunView` |
| `review-verdict-v1` findings state; plan-review verifier job | per-finding state; dispute verification | banyandb-fix `validators.ts`, `graph.ts`, `prompts.ts` |
| `inGeneration` → `forCandidate` | candidate-scoped evidence selection | banyandb-fix `evidence.ts`, `graph.ts` |

The supervisor package still depends only on `@graphloom/sdk`; everything it
needs arrives through `RunView` and settlement facts.

## 6. Verification

Controller tests (`packages/controller`):

1. Resume with an unchanged candidate keeps every valid receipt and dispatches
   no job for a requirement that already has one.
2. A worktree edit invalidates exactly the receipts whose digest changed, in
   every stage, and nothing else.
3. Reentry without an edit creates a new attempt and invalidates no receipt.
4. Two failed graph trials hand off; a supervisor `work` dispatch that settles
   clears the handoff and the graph's next `work` dispatch is admitted.
5. The same supervisor proposal with no progress is reported once and rejected
   in-turn on the third repeat; the run does not stop.
6. Replay the live run's durable state as a fixture: under the new rules the Fix
   stage accepts at the first generation where all seven requirements hold
   receipts for one candidate digest, and the run proceeds to Review.

Plugin tests (`examples/plugins/banyandb-fix`):

7. A plan-review finding answered in `basis` and repeated by the reviewer is
   dispatched to a verifier; a dismissed finding does not block approval; a
   confirmed one does.
8. The plan reviewer is not re-dispatched when neither the plan record nor the
   candidate changed.

The e2e scenarios in §11 of the core design stay green; the hello and release
example plugins, which have no correction loops, are unaffected beyond type
changes.

## 7. Migration

- New durable fields default to empty; existing run state loads unchanged.
- A receipt without `candidateDigest` (pre-checkout-era runs) is treated as
  stale once, then re-issued anchored.
- Plugins that filter by `generation` keep working — generation remains on
  `EvidenceRecord` — but lose the reuse benefit until they switch to candidate
  scoping. The BanyanDB graph switches in the same change.
- `MAX_CORRECTION_TRIALS` and `MAX_PLAN_REVISIONS` keep their values; their
  meaning narrows as described.

## 8. Open questions

1. Should a settled supervisor trial reset `correctionTrials` to 0 or decrement
   by one? Reset is proposed: the supervisor authored that trial with the full
   failure history in view, so the graph's next trials start from a reviewed
   position.
2. Should `generation` stay visible to plugins at all, or be replaced in
   `RunView` by `candidateDigest` plus a version-transition counter? Keeping it
   as metadata is proposed to avoid a protocol version bump.
3. Whether the plan-review verifier should reuse the Review stage's verification
   prompts or get its own; the claims differ (plan reach versus code defects),
   so separate prompts are expected.
