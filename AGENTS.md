# Working on GraphLoom

Read [README.md](README.md) and the current
[TypeScript core design](docs/design-typescript-core.md) before architectural work.
Use [CONTEXT.md](CONTEXT.md) for terminology. The core design owns behavior, public
interfaces, package seams, verification, and migration. Native Go plugin documents
are superseded; existing Go code remains a partial earlier implementation.

## Principles

- Graphs are executable TypeScript plugins. Task YAML selects a graph; plugin code
  owns normal task construction and routing. The controller owns accepted receipts.
- One logical supervisor session owns exceptional recovery. The controller can
  invoke it without a plugin repair branch and admits its decisions without veto.
- The supervisor may repair any failing plugin implementation, but the complete
  step set, identities, names, order, and required outcomes are fixed for a run.
  Repair jobs and retries are executions within existing steps, not new steps.
  Code and validator changes use the qualified repair procedure in the core design.
- Source repair needs available source, build inputs, tests, and operator authority.
  Opaque dependencies retain explicit limits; TypeScript alone is not repairability.
- Run plugins outside the controller process. Process separation does not replace
  enforced filesystem, credential, network, and process scopes.
- The controller owns persistence, evidence, permissions, finite budgets, and
  version transitions. Reconcile ambiguous effects before retrying.
- Show concise decision reasons and evidence, not private model reasoning.

## Scope and verification

This design is not evidence that the TypeScript runtime already exists. Preserve
existing source and user work during migration; port still-valid behavioral tests.
Implement the requested scope and verify affected behavior. Documentation-only
edits need consistency, link, and formatting checks; runtime changes need meaningful
behavior tests. Do not commit, push, publish, deploy, or alter external resources
unless the user authorizes those actions.

Historical research is context, not proof of implemented GraphLoom capability.
