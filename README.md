# GraphLoom

**A graph-native harness for multi-agent execution.**

Declare the happy path. Let the supervisor build the execution graph.

GraphLoom is a new project for coordinating multiple agents through a durable
execution graph. Authors declare required stages; one run-wide supervisor plans
workers, validation, supporting work, and recovery. A controller enforces
permissions, evidence, ordering, ownership, and resource limits.

## Status

Design and Go package scaffold. The CLI entry and seams compile; runtime
behaviour is not implemented yet. See [codebase design](docs/codebase.md).

## Graph authoring

```yaml
happy_path: [write, review]
```

Stage meanings come from versioned semantic context bound to the graph and
repository. The supervisor expands that intent into bounded executable operations.
Failed validation can introduce repair work or another attempt at an earlier stage
without removing the required outcomes.

## Task input

The proposed minimal interface is `graphloom run task.yaml`:

```yaml
graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
```

The controller creates an isolated Git worktree from the repository's current
`HEAD`. It preserves the source checkout and retains the run worktree for inspection
or resume. Agents exchange typed results and artifact references through the
controller; validation runs as explicit graph nodes.

These are proposed interfaces, not runnable commands yet. See the
[hello example](examples/README.md) for definitions and the fixture setup.

## Graph model

- The **intent graph** records required milestones and their ordering.
- The **execution graph** records concrete agent jobs, checks, dependencies, and repairs.
- Evidence and durable events explain why operations were admitted and milestones accepted.

The supervisor proposes graph changes. The controller validates and records them
before dispatch. Agents cannot mark their own work accepted or rewrite required
outcomes.

## Documentation

- [Minimal core design](docs/core-design.md): graph advancer, supervisor, and controller; the first runnable release.
- [Codebase design](docs/codebase.md): Go module layout, seams, and import rules.
- [Architecture](docs/architecture.md): broader graph model and background.
- [Roadmap](docs/roadmap.md): implementation sequence and acceptance scenarios.
- [Hello graph](examples/graphs/hello.yaml) and [stage definitions](examples/graphs/hello.md): the two-step minimal example.
- [Task example](examples/task.yaml): graph selection, repository, and request.
- [Graph design research](docs/research/graph-design.md): original Loopx study and detailed proposal.
- [Earlier supervisor design](docs/research/design-supervisor-run-repair.md): historical context.

The research documents adapt earlier Vajra proposals to GraphLoom terminology.
References to Vajra describe the predecessor project, not existing GraphLoom code.
