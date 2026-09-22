# GraphLoom implementation roadmap

Status: proposed. These milestones have not been implemented.

Begin with the implementation sequence in the [minimal core design](core-design.md).
The milestones below remain broader follow-on planning; portal work and parallel
execution are not prerequisites for the first runnable release.

## M1 — Graph and contract foundation

Define the intent graph, execution DAG, operation identity, graph patches,
source contracts, evidence receipts, and budget records. Add strict minimal
graph parsing and pinned semantic-context resolution.

Verify that cycles, unknown stages, missing authority, stale patches, and changes
to protected required outcomes are rejected. Demonstrate repeated milestone
attempts without overwriting execution history.

## M2 — Durable multi-agent execution

Implement one run-wide supervisor session, typed proposals, controller admission,
bounded workers and checks, durable settlement, ownership fencing, cancellation,
and external-effect reconciliation.

Complete the two-stage hello graph with stub agents using `task.yaml` and a
controller-created isolated worktree. Verify typed handoffs and real content/scope
checks. Inject crashes between worktree creation, reservation,
dispatch, observation, and settlement. Duplicate requests and late workers must
not duplicate side effects or replenish budgets.

## M3 — Adaptive routing and recovery

Support supervisor-directed agent selection, dynamic supporting nodes, reentry,
run-local prompt/model/check repairs, independent verifier qualification, and
all recovery limits.

Start with a missing newline and an unrelated file edit in the hello fixture.
Both must recover through new Write and Review attempts without static failure
routes. Larger task conflicts and defective checks extend that coverage later.
Reject weakened validators, forged success, stale review, and attempts to evade
recovery limits.

## M4 — Operator experience and pilot

Expose milestone progress, current execution nodes, dependencies, concise
supervisor decisions, evidence, and remaining budgets. Support inspect, stop,
and resume with stable state across refresh and restart.

Verify an end-to-end run against a private test repository, including ambiguous
external-write recovery. Also exercise a scheduled graph without TDD-specific
artifacts. Public delivery and merge permissions come from explicit project policy.
