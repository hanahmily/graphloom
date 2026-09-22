# GraphLoom architecture

Status: initial proposal. No runtime implementation exists yet.

The [minimal core design](core-design.md) now defines the first runnable release
and takes precedence over this broader proposal. In particular, the first release
serializes agent jobs, uses `task.yaml` with an isolated worktree per run, and
starts with the two-stage `write → review` graph. Local pinned context, typed
artifact handoffs, and explicit validation nodes are defined in the core design.

## Purpose

Use a graph to harness multiple agents while keeping graph configuration
limited to the required happy path. The supervisor plans execution and adapts it
to evidence. The controller makes those plans durable, bounded, and enforceable.

## Two related graphs

### Intent graph

The author-facing ordered happy path becomes an immutable graph of required
milestones. The minimal example is a linear sequence:

```text
write → review
```

Each milestone references versioned semantic definitions, required outcomes,
and an evidence strategy derived from authoritative task sources. The graph
file contains only the stage list. Shared runtime policy and semantic bindings
live at project level.

The supervisor cannot remove a required milestone, weaken the task's original
requirements, or expand delivery permission. An authorized requirement change is
an explicit versioned revision, not an implicit repair.

### Execution graph

The supervisor incrementally proposes concrete nodes and dependency edges:

- Agent jobs: bounded implementation, investigation, or independent review.
- Checks: commands or provider reads producing observed evidence.
- Supporting operations: environment setup or run-local recipe repair.
- Waits: external evidence or an unresolved authority requirement.

Each node has a stable ID, run generation, input references, effect scope,
resource reservation, and execution state. Nodes reference the milestone and
obligations they support. Dependency edges determine readiness; typed lineage
links identify retries, repairs, and superseded attempts without masquerading as
execution dependencies.

The execution dependency graph is acyclic. Reentry creates a new attempt node
for an earlier milestone; it does not reset an executed node or create a cycle.
For example:

```text
write#1 → check#1 → diagnose#1 → write#2 → check#2 → review#1
```

The required milestone order still governs accepted completion. A corrected
file invalidates affected checks and review receipts. Historical attempts remain
visible.

Jobs are serialized in the minimal release. Future parallel children would need
compatible dependencies and write scopes. Joining results always requires accepted
evidence, not just process exit.

## Control loop

```text
Observe graph and evidence
  → supervisor proposes a bounded graph change or operation
  → controller validates authority, dependencies, revisions, and budget
  → persist intent and dispatch ready work
  → collect observations and verify evidence
  → settle durable state
  → supervisor continues
```

Normal successful advancement follows the happy path. The supervisor owns
semantic choices outside it, including choosing another agent, repairing checks,
and returning to an earlier milestone. Unknown failures remain available for
investigation without adding a new domain-specific branch to controller code.

## Semantic context

Resolve stage definitions and repository policy from versioned project context.
The control repository is the default source; a separate semantic repository is
optional. Pin its revision separately from the target code revision.

Task requirements and authorized operator constraints are authoritative. Current
repository observations establish facts. Recalled lessons are advisory. Missing
required sources or unresolved authoritative conflicts prevent dependent work.

## Evidence and authority

Supervisor proposals are not execution receipts. Worker claims are not accepted
milestone completion. The controller runs admitted checks and binds observations
to code, context, verifier, and state revisions. Semantic review is recorded as
review judgment rather than mathematical proof.

New or changed verifiers need independent qualification against the unchanged
obligation. Controller-owned state must be outside worker write access. All graph
changes use expected-state revisions and current run-generation fencing.

## One logical supervisor session

The same logical session covers planning, execution, recovery, and finalization.
Worker and reviewer sessions return bounded results to it. Durable decisions and
receipts preserve continuity if the provider session is compacted or replaced.
A provider conversation is not the authoritative run database.

## Recovery and durability

Persist operation intent before side effects. Reconcile interrupted effects before
replaying them, using provider readback when an outcome is ambiguous. Cancellation
fences late results and prevents further dispatch; it cannot undo an external
write that already completed.

Recovery attempts, model calls, time, and infrastructure retries have finite
project-level limits. A retry, model change, or session replacement cannot reset
usage. Exhaustion leaves a resumable stopped run. Overall execution also has a
finite budget, including planning before the first failure.

## Initial scope

The initial implementation targets serial required milestones and serial bounded
jobs inside them. Arbitrary business milestone DAG authoring, automatic
cross-host failover, and unbounded autonomous recovery are outside the first
release. Language, storage implementation, CLI, and adapter APIs will be selected
when implementation starts.

The [graph design research](research/graph-design.md) contains the detailed
Loopx comparison, proposed recovery defaults, and migration context.
