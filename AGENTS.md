# Working on GraphLoom

GraphLoom is a graph-native harness for multi-agent execution. Read README.md and
docs/core-design.md before making architectural changes. The core design controls
the first runnable release; docs/codebase.md owns Go package layout and seams;
docs/architecture.md provides broader context.

## Principles

- Keep graph authoring minimal: required happy-path stages only.
- One logical supervisor session owns a run's planning, agent selection,
  validation strategy, and recovery decisions.
- The controller owns admission, permissions, durability, evidence receipts,
  ownership, cancellation, and finite budgets.
- Domain-specific failure routing belongs to supervisor reasoning and pinned
  semantic context, not a growing engine classification table.
- Preserve required outcomes when adding graph nodes, reentry, or repair work.
- Distinguish proposals, executed observations, and accepted progress.
- Reconcile ambiguous external effects before retrying them.
- Keep private model reasoning out of user-facing activity; show concise decision
  summaries and evidence references.

## Scope and verification

The repository currently contains design documentation and an example only.
Choose the implementation language and build tooling explicitly when starting
implementation; no runtime stack is established by this scaffold.

Implement the requested scope and verify affected behavior. Preserve unrelated
work. Do not commit, push, publish, deploy, or create remote resources unless the
user authorizes those actions. Documentation-only edits need reference and
formatting checks; runtime changes need meaningful behavior tests.

Treat docs/research as historical input, not evidence that GraphLoom already
implements the referenced Vajra or Loopx capabilities.
