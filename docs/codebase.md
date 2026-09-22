# GraphLoom Go codebase design

> Superseded by the [TypeScript design](design-typescript-core.md). The content below
> records the earlier native Go direction and is retained for historical context.

Status: revised target, 2026-09-22. Native graph plugins supersede the previous
internal-only, file-described graph authoring model. The Go source currently
implements parts of that earlier model; this document does not claim that the
new packages or interfaces already exist.

The [core design](core-design.md) owns behavior. This document owns package layout,
interfaces, import rules, and migration. Vocabulary: module, interface, seam,
adapter, depth, leverage, and locality.

## Target package layout

```text
module github.com/hanahmily/graphloom

loom/                             # public plugin SDK and value contracts
cmd/graphloom/                    # CLI → controller harness

internal/
  graph/                          # pure generic advancement and receipt rules
  supervisor/                     # recovery views and typed recovery decisions
  controller/                     # loop, intake, artifacts, budgets, persistence
  adapter/
    graphplugin/{native,scripted}  # load a .so or a scripted Graph implementation
    runner/{process,scripted}
    store/fs
    worktree/{git,fake}
    clock/{system,fake}

examples/plugins/hello/
  main.go                         # NewGraph export; proposed source location
  graph/                          # ordinary importable implementation and tests
examples/task.yaml
test/scenarios/
```

This is a migration target, not a directory inventory. Example implementation
files and the public SDK still need to be added.

## Public extension seam

`loom.Graph` exposes `Describe` and `Advance`. Its value types carry a graph
manifest, detached run view, typed decision, job specification, observed result,
and evidence references. The package imports only small standard-library value
dependencies. It has no dependency on controller internals, providers, filesystem
stores, or process launchers.

Graph plugins import this public package at the exact host build revision. Their
implementation owns domain logic and can compose ordinary Go functions and
libraries. It returns operation descriptions rather than executing effects inside
`Advance`. Plugin-specific state is a bounded versioned serialized blob carried
by the view and decision, never a separate authoritative store.

The SDK should provide constructors for valid typed actions and shared bounded
known-correction helpers only where real graph implementations need them.
Supervisor recovery capabilities belong to the host and require no plugin helper.
Avoid a second configuration language inside the SDK. Deterministic plugin code
is the normal harness.

## Deep host modules

| Module | Owns | Must not own |
|---|---|---|
| `internal/graph` | Dependency readiness, stage order, generic evidence/reference validity, reentry, completion | Greeting predicates, issue triage, provider execution |
| `internal/supervisor` | Recovery context, one logical run session protocol, typed recovery decisions | Normal stage routing, direct acceptance, process launch |
| `internal/controller` | Lifecycle, decision-source modes, fallback triggers, plugin calls, admission/execution, artifacts, transactions, limits | Domain-specific interpretation of agent payloads |

The controller harness retains `Run`, `Inspect`, `Stop`, and `Resume`. Operator
and scenario callers use that same interface. Native plugin loading is an injected
seam with real and scripted adapters. The existing runner, worktree, clock, and
filesystem-store responsibilities remain useful.

The native adapter imports Go's `plugin` package and handles export resolution and
compatibility diagnostics. The controller pins bundles and journals activation;
loading is not itself task authority. `Inspect` and `Stop` need no plugin load.

## Import rules

```text
user graph implementation → loom + graph-specific Go dependencies
native export main         → loom + user graph implementation
loom                       → standard-library value types
internal/graph             → loom + stdlib
internal/supervisor        → loom + stdlib
internal/controller        → loom + graph + supervisor + injected host interfaces
adapter/*                  → host interfaces + loom + host/provider libraries
cmd/graphloom               → controller harness
```

Keep concrete default wiring at the composition root without controller/adapter
import cycles. An external plugin must compile from its own module without importing
`internal/` packages or adding itself to a hard-coded host registry.

## Migration from current code

1. Publish the small `loom` contract and update internal imports deliberately.
   Preserve existing behavior tests where their invariant remains valid.
2. Replace graph YAML/Markdown resolution in `controller/intake.go` with native
   plugin bundle selection and pinning. Keep task YAML and repository resolution.
3. Adapt the current graph types to generic required evidence declarations.
   Existing universal `PlanReviewNodeID`, `CheckNodeID`, and `ReviewNodeID`
   acceptance fields must not prescribe every user graph's validation strategy.
4. Use `Graph.Advance` for normal execution and direct supervisor decisions for
   recovery. Persist the active mode, episode, overrides, and reservations; host
   fallback works without plugin escalation branches. On Return, pass canonical
   stage/attempt and repair evidence to Advance for private-state reconciliation
   and ordinary validation. See core-design section 6 for admission semantics.
5. Add observed file/content manifests so hello's Go predicate consumes real
   controller evidence. Continue recording command checks through the runner.
6. Build hello as a `.so`, then qualify an independently built second graph against
   an unchanged host. Existing file examples stay legacy fixtures until their
   tests and runtime path are explicitly migrated.

## Verification

Test plugin logic through the public interface as ordinary Go code. Test actual
native loading in fresh subprocesses, including missing symbols, wrong exported
function type, incompatible SDK/builds, corrupted bundles, panics, and resume
with a different installed version. Package tests alone do not prove `.so`
compatibility, and race-detector success alone is not sufficient for native plugins.

End-to-end scenarios load the real sample plugin and use scripted agent runners,
then a real backend. Verify independent review, content/scope failures, correction
budgets, stale evidence, process recovery, and source-checkout preservation. Include
an unfamiliar launch failure in a plugin with no repair handler, direct supervisor
reentry, mode/override recovery after restart, and return to required validation.

The exact runnable milestones are in the [core design](core-design.md). This
change establishes the design; it does not retrofit the current source silently.
