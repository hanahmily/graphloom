# GraphLoom

**A graph-native harness for multi-agent execution.**

Write a graph in TypeScript. Let the loom run its agents.

Graph plugins define required outcomes and normal execution. A run-wide supervisor
handles exceptional recovery, including tested repairs to readable plugin source.
The controller executes admitted actions, owns accepted evidence, and preserves
permissions, history, and finite budgets. Required outcomes remain unchanged when
a validator implementation is repaired.

## Status

The [TypeScript core design](docs/design-typescript-core.md) is the current target.
The repository contains a partial Go implementation of an earlier design; the
TypeScript runtime and plugin repair protocol are not implemented yet. Existing
source is retained during migration. The native Go plugin design is superseded.

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
