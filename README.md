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
the supervisor on Pi, Claude Code, or Codex, executor packages, and qualified
repair workflows are implemented and covered by scripted integration tests. Live-provider qualification and the
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

`graphloom doctor` reports what this machine can run (Claude Code, Codex, Pi,
`gh`, bubblewrap) with the next command for each gap, and `graphloom setup`
writes the runner and supervisor configs from what it finds, asking for your
consent to `allowUnrestricted` (`graphloom setup --yes` in scripts). `run`
starts setup on a terminal when no runner config exists. To write it by hand,
configure the job runner in `~/.config/graphloom/runner.json`, or point
`GRAPHLOOM_RUNNER_CONFIG` at an operator-owned file. For Claude Code:

```json
{ "harness": "claude-code", "allowUnrestricted": true }
```

Claude Code must be installed and logged in. Optional `claude.command` and
`claude.model` select its executable and model. For Pi, use `"harness": "pi"`
with any provider and model Pi knows, for example
`"pi": { "provider": "deepseek", "modelId": "deepseek-v4-pro" }`, and that
provider's Pi credential (its environment variable, such as `DEEPSEEK_API_KEY`,
or Pi's auth store). Codex (`"codex"`, installed and logged in) serves
read-only jobs only, such as a plugin's code review; list it in `harnesses` next
to the default. Keep credentials out of runner configuration.
The same configuration is used by `resume`. Without runner configuration, or
without the Claude Code or Codex command or Pi model it names, `run` and
`resume` refuse to start. The [example guide](examples/README.md) lists every setting.

`allowUnrestricted` is required because coding agents can run shell commands
with the operator's permissions. Claude's file-tool permission checks restrict
file mutations to the job scope and deny shell commands for read-only jobs;
writer shell commands still require trust. See the
[permission and cancellation design](docs/design-claude-live-mode.md).

### The supervisor

The supervisor (`~/.config/graphloom/supervisor.json`, or the file
`GRAPHLOOM_SUPERVISOR_CONFIG` names; also written by `graphloom setup`) runs on
one of three **harnesses**:

- **Pi**, in-process, on any model Pi supports:
  `{ "provider": "<pi provider>", "modelId": "<model>" }` with that provider's
  Pi credential. For DeepSeek, `DEEPSEEK_API_KEY` and
  `{ "provider": "deepseek", "modelId": "deepseek-v4-pro" }` are all it takes.
- **Claude Code**, your own `claude` login (never an API key), under bwrap.
- **Codex**, your own `codex` login (a ChatGPT login; a Codex home signed in
  with an API key is refused), under bwrap.

So Claude and OpenAI models each have two routes: Claude through Claude Code
or through Pi with `ANTHROPIC_API_KEY`; OpenAI through Codex or through Pi with
`OPENAI_API_KEY`. Gemini, DeepSeek, Kimi, MiniMax, and every other vendor run
through Pi; a custom OpenAI-, Anthropic-, or Google-compatible endpoint is a
provider in Pi's `models.json`. A Claude Code subscription or a Codex login
alone is enough for automatic recovery.

The per-harness form enables several and lists each one's models:

```json
{
  "harnesses": ["pi", "claude-code", "codex"],
  "pi": { "provider": "deepseek", "modelId": "deepseek-v4-pro" },
  "claude": { "models": ["opus", "sonnet"] },
  "codex": { "models": [{ "modelId": "gpt-5-codex", "thinkingLevel": "high" }] }
}
```

A plugin may say which harness it prefers (`GraphDefinition.supervisor`); the
operator's `harnesses` is the allowlist and fallback order, and `"select"`
overrides the plugin. `graphloom run --supervisor <harness>` overrides both for
one run. The harness is pinned when the run starts, and the repair reviewer
uses the same one. `graphloom resume <run> --supervisor <harness> [--reason
<text>]` moves a run to another enabled harness, keeping its logical session,
budgets, and case file; `graphloom switch-model <run> <model> --reason
<text>` changes the model within the pinned harness (`provider/model` for Pi, the model name for
Claude Code and Codex). `graphloom check` and `graphloom doctor --task` report
the harness a run would get, `graphloom doctor` runs each enabled harness's own
probe and shows which vendor routes have a login or credential, and
`graphloom stats` shows the supervisor's use per harness. See
[supervisor harnesses](docs/design-supervisor-harnesses.md) and
[choosing a supervisor model](docs/design-pi-supervisor.md#choosing-a-supervisor-model)
for examples per vendor.

### Knowing when a run stops

`graphloom run` and `graphloom resume` take `--on-stop <command>` (or set
`"notify": { "onStop": "<command>", "timeoutMs": 60000 }` in the runner config;
the flag wins). The command runs through `sh -c` once, when the run leaves
`running` (`succeeded`, `stopped` or `failed`), or with status `crashed` when the
CLI itself dies with an error (a SIGKILL or power loss cannot fire it). It gets
`GRAPHLOOM_RUN_ID`, `GRAPHLOOM_STATUS`, `GRAPHLOOM_STOP_REASON`,
`GRAPHLOOM_STOP_RETRYABLE` (`true`, `false`, or empty) and `GRAPHLOOM_STATE_DIR`
in its environment and the report JSON on stdin, and is killed after 60 seconds.
Its failure is logged to stderr and never changes the run or the exit code.

```sh
graphloom run task.yaml --on-stop 'notify-send "graphloom $GRAPHLOOM_RUN_ID: $GRAPHLOOM_STATUS"'
```

From another shell, `graphloom wait <stateDir|runId> [--state-root <dir>]
[--timeout <dur>] [--json]` blocks until the run is no longer `running`, reading
its durable state and owner claim rather than the process table, then prints what
`graphloom stats` prints. Exit 0: the run left `running` (read its status line).
Exit 2: `--timeout` (`90s`, `10m`, `2h`) elapsed first. Exit 3: the state says
`running` but its controller died without recording a stop; `graphloom resume`
takes it over. `--until progress` also returns on each meaningful change (a stage
accepted, a supervisor episode, a quota pause, a budget at 80%) with a cursor for
the next `--since` ([agent skills](docs/design-agent-skills.md)).

## Agent-host mode (proposed)

An existing coding-agent session can be the primary worker and supervisor, using
GraphLoom tools for assignments, executors, evidence, and recovery. This mode needs
no separate supervisor session, and retains separate sessions for independent review.
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
- [Supervisor harnesses](docs/design-supervisor-harnesses.md) (implemented, S1
  to S6): the supervisor runs on Pi, Claude Code, or Codex behind one
  contract, so a Claude Code subscription or a Codex login alone gets
  automatic recovery; the plugin declares its preferred harness, the run pins
  one, and `resume --supervisor` moves it.
- [Pi supervisor](docs/design-pi-supervisor.md): the Pi harness, and
  choosing a supervisor model on any Pi provider.
- [Run convergence design](docs/design-run-convergence.md): candidate-anchored
  freshness, correction escalation with an exit, supervisor repetition detection,
  and adjudicated plan review.
- [Agent–harness contract robustness](docs/design-agent-contract-robustness.md):
  plugin-declared result contracts applied generically by the controller,
  boundary validation with in-turn correction, reference integrity, and
  controller-owned acceptance accounting, from the first live BanyanDB run.
- [Graph rehearsal](docs/design-graph-rehearsal.md): a verification ladder —
  static check, zero-token rehearsal on stand-in models through the real
  harnesses, replay of recorded runs, a bounded real-model probe — and the
  gate `run` climbs before spending a live run's budget. A rehearsal that is
  kept (`--keep`, or any verdict other than `ready`) leaves
  `$TMPDIR/graphloom-rehearsal-*`; `graphloom rehearse --help` says how to
  remove it.
- [Issue-fix graph](docs/design-issue-fix-graph.md): one bug-fix graph for any
  repository, driven by a JSON profile the task names with `config:`; ships
  profiles for BanyanDB and for GraphLoom itself. It replaced the earlier
  BanyanDB-only fix graph.
- [Installable releases](docs/design-release.md) (proposed): a self-contained
  release tarball with a bundled Node runtime and the SDK tarball on GitHub
  Releases, versioned install directories with `install.sh`, `graphloom
  upgrade`, `graphloom self`, and automatic updates, `graphloom doctor` and guided `graphloom setup`, runs that stay on
  the version they started with until `resume --upgrade` migrates them, and the
  local release procedure.
- [Agent skills](docs/design-agent-skills.md): [`skills/`](skills) for driving
  GraphLoom from Claude Code, Codex or opencode (setup, issue, run, watch,
  triage, deliver), installed with `graphloom skills install` (`--agent
  opencode` writes `~/.config/opencode/skills`), and `graphloom wait --until
  progress`.
- [Run budgets](docs/budgets.md): what recorded runs used (`graphloom stats`),
  the profile defaults derived from them, budget layers, and what a raised
  budget means.
- [Example task](examples/task.yaml) and [example guide](examples/README.md).
- [Loopx gate-repair study](docs/research/loopx-gate-defect-handling.md) and
  [issue-fix study](docs/research/loopx-issue-fix-example.md).

Earlier native-plugin and file-described designs are historical references, not
authority for the TypeScript implementation.

## License

GraphLoom is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).
