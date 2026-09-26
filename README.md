# GraphLoom

**A graph-native harness for multi-agent execution.**

Write a graph in TypeScript. Let the loom run its agents.

Graph plugins define required outcomes and normal execution. A run-wide supervisor
drives exceptional recovery so the graph can still finish—including tested repairs
to readable plugin source—rather than giving up on the first failure. The
controller manages execution lifecycle, owns accepted evidence, and preserves
permissions, history, and finite budgets. Required outcomes remain unchanged when
a validator implementation is repaired.

## Status

The [TypeScript core design](docs/design-typescript-core.md) is authoritative.
Active code lives under `packages/` (`sdk`, `controller`, `plugin-host`,
`supervisor`, `runner`), built-in executor packages under `executors/` (`github`, `coding-agent`),
and `apps/graphloom`. The public SDK and scripted
`GraphPlugin` adapter are in place; durable run/inspect/stop/resume and plugin
repair are not implemented yet. Earlier Go sources are frozen under
[`legacy/go`](legacy/go) for reference and are not part of CI.

```sh
npm ci
npm test
npm run build
```

## Select a graph

The proposed operator interface is `graphloom run task.yaml`:

```yaml
graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
```

`hello` selects the operator-installed `plugins/hello/` bundle beside the task.
It implements Write → Review in code. The controller creates an isolated Git
worktree and preserves the source checkout. Successful runs deliver a local diff
without automatic commit, push, or publication.

## Extend and repair

Plugins implement the public TypeScript SDK and run in separate processes.
The [executor interface](docs/design-executors.md) lets plugins reuse
built-in executors such as GitHub or supply their own execution code without a
controller release. The controller admits and tracks execution; executor code
performs the actual operation. When an executor fails, the supervisor can retry
it, switch to another pinned executor, or, with the `executorRepair` task grant,
repair a run-local copy of its package.
Repairable bundles include source, readable acceptance requirements, locked build
dependencies, and tests. The supervisor coordinates isolated patches, regression
checks, independent review, and recorded version transitions within the same run.
Opaque dependencies retain explicit repair limits. Process separation contains
crashes; filesystem and execution scopes require host enforcement.

## Documentation

- [Current core design](docs/design-typescript-core.md): all decisions, contracts,
  repair lifecycle, minimal example, verification, and implementation milestones.
- [Architecture](docs/architecture.md): runtime interaction overview.
- [Domain glossary](CONTEXT.md): project vocabulary.
- [Roadmap](docs/roadmap.md): entry point to the implementation sequence.
- [TypeScript decision](docs/adr/0002-typescript-repairable-plugins.md).
- [Example task](examples/task.yaml) and [example guide](examples/README.md).
- [Loopx gate-repair study](docs/research/loopx-gate-defect-handling.md) and
  [issue-fix study](docs/research/loopx-issue-fix-example.md).

Earlier native-plugin and file-described designs are historical references, not
authority for the TypeScript implementation.
