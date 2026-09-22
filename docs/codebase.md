# GraphLoom Go codebase design

Status: accepted, 2026-09-22. Implements the [minimal core design](core-design.md)
package shape. Behaviour contracts stay in the core design; this document owns
module layout, seams, and import rules.

Vocabulary: **module**, **interface**, **seam**, **adapter**, **depth**,
**leverage**, **locality** (see the codebase-design skill). Prefer these terms
over “component,” “service,” “API,” or “boundary” when discussing package shape.

## Goal

Three deep modules matching the three core concerns, with only the seams that
already have two justified adapters for the MVP.

## Package tree

```text
module github.com/hanahmily/graphloom

cmd/graphloom/                    # argv → harness only

internal/
  graph/                          # deep, pure: Apply / Ready / Complete
  supervisor/                     # deep, pure: BuildView / ParseDecision
  controller/                     # deep: loop, budgets, intake, artifacts
    harness.go                    # Run / Inspect / Stop / Resume
    runner.go                     # seam: Runner
    store.go                      # seam: Store (FS adapter only in MVP)
    worktree.go                   # seam: Worktree
    clock.go                      # seam: Clock

  adapter/
    runner/{process,scripted}
    store/fs                      # durability is the behaviour; no mem yet
    worktree/{git,fake}
    clock/{system,fake}

examples/                         # fixtures (already present)
test/scenarios/                   # full-run scripted adapters
```

## Deep modules

### `internal/graph` (in-process, pure)

Owns readiness, receipt validity, reentry invalidation, and completion.
No subprocess, provider, YAML, or filesystem imports.

| Entry | Role |
|---|---|
| `Apply(state, transition)` | Admit append / accept / reenter / observe, or reject |
| `Ready(state)` | Earliest ready node, blocked, or complete |
| `Complete(state)` | Every happy-path stage has a currently valid receipt |

Tests build `State` fixtures and call these entries directly.

### `internal/supervisor` (in-process, pure)

Owns prompt/view assembly and typed decision decoding. Session I/O uses the
controller `Runner` with a supervisor role; this package does not launch
processes.

| Entry | Role |
|---|---|
| `BuildView(input)` | Pack pinned sources, graph summary, observations, limits |
| `ParseDecision(raw)` | Decode `plan` / `append` / `accept` / `reenter` / `stop` |

### `internal/controller` (deep orchestration)

Sole state writer and job launcher. Hides intake, artifact hashing, budgets,
ownership fencing, stop inbox, and the main loop. Operator and scenario callers
use the harness entries:

```go
func Run(ctx context.Context, taskPath string, opts ...Option) (*Outcome, error)
func Inspect(ctx context.Context, runID string, opts ...Option) (*Report, error)
func Stop(ctx context.Context, runID string, opts ...Option) error
func Resume(ctx context.Context, runID string, opts ...Option) (*Outcome, error)
```

Defaults wire production adapters. Tests inject scripted runner, fake worktree,
and fake clock via options.

## Seams and adapters

A seam exists only when two adapters are justified.

| Seam | Production adapter | Test / alternate adapter | Notes |
|---|---|---|---|
| `Runner` | `adapter/runner/process` | `adapter/runner/scripted` | One contract for supervisor turns, agents, and command nodes (core design §6) |
| `Worktree` | `adapter/worktree/git` | `adapter/worktree/fake` | Create, reconcile, fingerprint; never silently recreate on resume |
| `Clock` | `adapter/clock/system` | `adapter/clock/fake` | Active-time accumulation and per-job deadlines |

**Store:** implement `adapter/store/fs` only for the MVP. Durability rules (atomic
`state.json`, lock, inbox, crash reconcile) *are* the store’s meaning. Scenario
and unit paths use `t.TempDir()`. Add a second store adapter only when a real
alternate (fault injection or another medium) appears.

**Not seams:** YAML intake, artifact hashing, budget arithmetic, decision shape.
Those stay in-process inside `graph`, `supervisor`, or `controller`.

## Import rules

```text
cmd/graphloom
  → controller (harness)

controller
  → graph, supervisor
  → Runner, Store, Worktree, Clock interfaces (defined beside controller)

adapter/* → controller contracts + host libraries
graph → stdlib only
supervisor → graph types + stdlib only
```

- Adapters never contain admission, reentry, or acceptance policy.
- `graph` and `supervisor` must not import `controller` or `adapter`.
- `cmd` must not import adapters directly; harness defaults own wiring.

## Dependency categories

| Category | Treatment in GraphLoom |
|---|---|
| In-process | `graph`, `supervisor` protocol, budget math |
| Local-substitutable | `Clock`; filesystem store tested via temp dirs |
| True external | Agent/LLM backend and `git` behind `Runner` / `Worktree` |

## Implementation sequence

Aligns with core design §8:

1. **Graph + scripted execution** — `graph` package, harness loop with scripted
   `Runner`, FS store under temp roots, fake worktree where Git is irrelevant.
2. **Real runner + scopes** — process adapter, plan review, limits, write roots.
3. **Runnable CLI** — task intake, real git worktree, stop/resume, hello demo.

Release gate unchanged: `graphloom run task.yaml` succeeds on the hello fixture,
and a failing-first fixture recovers without editing the graph declaration.

## Rejected alternatives

- **Many shallow packages** (`evidence`, `decision`, `runstate` as top-level
  peers): useful later if depth appears; premature before the hello gate.
- **Unified store memory adapter now**: forks durability behaviour from
  production; prefer temp-dir FS tests.
- **Separate Decider seam beside Runner**: core design specifies one narrow
  runner interface for supervisor and child jobs; keep that single seam.
- **Public `pkg/`**: no second binary yet; keep contracts under `internal/`.
