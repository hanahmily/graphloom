# Hello native graph plugin

> Superseded by the [TypeScript design](../../../docs/design-typescript-core.md). The content below
> records the earlier native Go direction and is retained for historical context.

Status: implementation contract, not a built plugin. The public SDK, main package,
Go implementation, and generated bundle will be added during the native-plugin
migration. The retained examples/graphs files describe the earlier design.

## Package shape

```text
examples/plugins/hello/
  main.go          # exports NewGraph() (loom.Graph, error)
  graph/           # HelloGraph with Describe and Advance; ordinary Go tests
examples/plugins/hello.so
examples/plugins/hello.manifest.json
```

The binary and sidecar are generated build outputs, not checked-in declarations.
The exact toolchain and shared sources must match the host release profile.

## Deterministic behavior

The definition declares Write and Review. Advance interprets controller-observed
state and returns one next action:

| State | Action |
|---|---|
| Compatible greeting task, no writer result | Dispatch writer with exact task and result schema |
| Writer completed | Observe GREETING.txt and the complete workspace change manifest |
| Bytes differ from `Hello, GraphLoom!\n` or unrelated paths changed | Dispatch bounded correction, or escalate after repeated failure |
| Content/scope predicate passes | Accept Write with references to controller observations |
| Write accepted | Dispatch separate read-only reviewer |
| Review approves the current revision | Accept Review |
| Review requests changes | Go selects Reenter Write with the report; controller admits and applies it |
| Unfamiliar failure | Yield to supervisor recovery; controller fallback also works without this branch |
| Missing authority or exhausted limits | Stop with a reason |

The plugin checks the actual bytes with Go code. It does not trust a writer's
claim that tests passed. The reviewer receives pinned task inputs and observed
validation evidence. Reports go outside the worktree. Acceptance is completed by
the controller after freshness, stage order, and required-evidence checks.

A reviewer or worker reports a conflict; it does not route the run. Known review
rejections route directly in Go. For ambiguous failures, the supervisor directs
repair and reentry through controller admission without plugin approval. The
controller reserves correction allowance and invalidates affected receipts. On
Return, Advance consumes fresh repair results and resumes unchanged content/scope
checks and independent Review. See
[reentry ownership and admission](../../../docs/core-design.md#execution-graph-and-reentry).

The recovery scenario must inject an unsupported writer launch configuration into
a plugin with no matching error branch. The controller enters recovery, the
supervisor retries with a supported configuration, and normal validation resumes
without a second normal writer dispatch. A second scenario must exercise a review
conflict requiring supervisor-directed reentry; neither scenario can skip Review
or obtain acceptance from the supervisor.

The task selects `graph: hello`; the proposed launcher resolves hello.so and its
manifest beside that task under plugins/. New graph authors implement the same
public interface without editing controller code.

See the [core design](../../../docs/core-design.md) for lifecycle and interface
rules, and the [example task](../../task.yaml) for invocation inputs.
