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
and `apps/graphloom`. The SDK, isolated plugin host, durable controller lifecycle,
Pi supervisor, executor packages, and qualified repair workflows are implemented
and covered by scripted integration tests. Live-provider qualification and the
complete local-release scenarios remain outstanding. [Agent-host mode](docs/design-agent-host.md) is newly designed and not implemented.
Earlier Go sources are frozen under
[`legacy/go`](legacy/go) for reference and are not part of CI.

```sh
npm ci
npm test
npm run build
```

The local runtime requires Linux, Node.js 22.19 or newer, Git, and util-linux
`flock`. Controller and repository locks use kernel locks held by a helper
process; a controller exit releases them without deleting or reclaiming leases.

## Select a graph

Run an installed graph with `graphloom run task.yaml`:

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

Configure the job runner in `~/.config/graphloom/runner.json`, or point
`GRAPHLOOM_RUNNER_CONFIG` at an operator-owned file. For Claude Code:

```json
{ "harness": "claude-code", "allowUnrestricted": true }
```

Claude Code must be installed and logged in. Optional `claude.command` and
`claude.model` select its executable and model. For Pi, use `"harness": "pi"`
with `"pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3" }` and the
existing Pi credential store. Keep credentials out of runner configuration.
The same configuration is used by `resume`. Without runner configuration, or
without the Claude Code command or Pi model it names, `run` and `resume` refuse
to start. The [example guide](examples/README.md) lists every setting.

`allowUnrestricted` is required because coding agents can run shell commands
with the operator's permissions. Claude's file-tool permission checks restrict
file mutations to the job scope and deny shell commands for read-only jobs;
writer shell commands still require trust. See the
[permission and cancellation design](docs/design-claude-live-mode.md).

## Agent-host mode (proposed)

An existing coding-agent session can be the primary worker and supervisor, using
GraphLoom tools for assignments, executors, evidence, and recovery. This mode needs
no separate Pi supervisor, and retains separate sessions for independent review.
The first adapter targets a Claude Code plugin; the existing headless Claude worker
is not that plugin. See the [agent-host design](docs/design-agent-host.md).

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
