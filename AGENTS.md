# Working on GraphLoom

Read [README.md](README.md) and the current
[TypeScript core design](docs/design-typescript-core.md) before architectural work.
Use [CONTEXT.md](CONTEXT.md) for terminology. The core design owns behavior, public
interfaces, package seams, verification, and migration. Native Go plugin documents
are superseded. Historical Go code lives under `legacy/go/` and is not built by CI.

## Packages

| Path | Package | Role |
|---|---|---|
| `packages/sdk` | `@graphloom/sdk` | Public value/wire contracts, operations, scripted GraphPlugin |
| `packages/controller` | `@graphloom/controller` | Durable state, admission, receipts (scaffold) |
| `packages/plugin-host` | `@graphloom/plugin-host` | Isolated child process adapter (scaffold) |
| `packages/supervisor` | `@graphloom/supervisor` | Recovery session protocol (scaffold) |
| `packages/runner` | `@graphloom/runner` | Jobs and scopes (scaffold) |
| `apps/graphloom` | `@graphloom/cli` | CLI composition root (stub) |

```sh
npm ci
npm test
npm run typecheck
npm run build
```

## Principles

- Graphs are executable TypeScript plugins. Task YAML selects a graph; plugin code
  owns normal task construction and routing. The controller owns accepted receipts.
- One logical supervisor session owns exceptional recovery. Its core job is to
  make the graph advance successfully: investigate, repair, and reenter until the
  run can finish or a hard blocker/budget remains. Do not stop early for a single
  failure. The controller can invoke it without a plugin repair branch and admits
  its decisions without veto.
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

Implement against the TypeScript packages above. Port still-valid behavioral ideas
from `legacy/go` when useful; do not extend that tree for new MVP features.
Implement the requested scope and verify affected behavior. Documentation-only
edits need consistency, link, and formatting checks; runtime changes need meaningful
behavior tests. Do not commit, push, publish, deploy, or alter external resources
unless the user authorizes those actions.

Historical research is context, not proof of implemented GraphLoom capability.
