# Working on GraphLoom

Read [README.md](README.md) and the current
[TypeScript core design](docs/design-typescript-core.md) before architectural work.
Use [CONTEXT.md](CONTEXT.md) for terminology. The core design owns behavior, public
interfaces, package seams, verification, and migration. Native Go plugin documents
are superseded.

## Packages

| Path | Package | Role |
|---|---|---|
| `packages/sdk` | `@graphloom/sdk` | Public value/wire contracts, operations, scripted GraphPlugin |
| `packages/controller` | `@graphloom/controller` | Durable state, admission, receipts |
| `packages/plugin-host` | `@graphloom/plugin-host` | Isolated child process adapter |
| `packages/supervisor` | `@graphloom/supervisor` | Recovery supervisor: harness-neutral host (`createSupervisorHost`) with the Pi harness (any Pi provider/model: Anthropic, OpenAI, Gemini, DeepSeek, Kimi, MiniMax, custom `models.json` endpoints), the Claude Code harness (your own `claude` login, under bwrap), and the Codex harness (your own `codex` login, under bwrap); the plugin's preference selects one per run ([supervisor harnesses](docs/design-supervisor-harnesses.md)) |
| `packages/runner` | `@graphloom/runner` | Jobs and scopes |
| `packages/agent-harness` | `@graphloom/agent-harness` | Agent session drivers (Claude Code, Codex, Pi): processes, stream protocols, session capture, failure classification; vendored into `executors/coding-agent` |
| `packages/testkit` | `@graphloom/testkit` | Unpublished test fixtures (repos, tasks, bundles, scripted agents, fake provider); tests only |
| `apps/graphloom` | `@graphloom/cli` | CLI: run, resume, check, doctor, setup, rehearse, task, session and more |

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm run typecheck` checks test files too, through each workspace's
`tsconfig.test.json`; builds use `tsconfig.json`, so `dist/` never contains tests.
`npm test` also runs `npm run check:headers`: hand-written `.ts`, `.js`, `.mjs`,
and `.sh` files start with the two-line SPDX header (after any shebang); run
`node scripts/check-headers.mjs --fix` to add it to new files. After editing an
example plugin's sources, regenerate its manifest with `npm run manifest -w <plugin>`.

Agent skills for driving GraphLoom from Claude Code, Codex or opencode live in top-level
`skills/<name>/SKILL.md` ([design](docs/design-agent-skills.md)); every
`graphloom` command and flag they name must be in `graphloom --help`
(`skills-drift.test.ts`), and `graphloom skills` installs them.

`graphloom task new <graph> <args...>` asks a bundle's optional `prepareTask`
hook for a task plan and runs it with Git hooks and user configuration off
([core design §16](docs/design-typescript-core.md#16-preparing-a-task-graphloom-task-new));
`graphloom session list|open` forks a recorded Claude Code or Codex session in
the operator's terminal and records the conversation
([§15](docs/design-typescript-core.md#15-opening-a-recorded-agent-session));
`graphloom resume <run> --approve <id> [--input name=value ...]|--decline <id>` records an operator decision on
an approval a graph declared as data. Tests of these use stub `claude`/`codex`
binaries and a temporary `HOME`, never the real login; the one live check of
Claude Code's fork is opt-in (`GRAPHLOOM_LIVE_CLAUDE_FORK=1`).

A pull request is reviewed by two graphs, each its own plugin and its own run, with
no human in a run and no run starting another. `pr-design-review`
(`examples/plugins/pr-design-review`, round 1) writes a neutral change report and
asks design-level questions with their answers, the first being whether the change
is necessary; it needs no Docker, posts its open items as one `COMMENT` review, posts
nothing when clean, and its clean result names the `graphloom task new pr-review …`
command, which the `graphloom-run` skill starts only when the user asks
([design review](docs/design-pr-design-review.md)). `pr-review` 1.x
(`examples/plugins/pr-review`, round 2) runs alone or after a design review: three
aspect reviewers with verified findings and deterministic leads, seeded with the
design review's report, a report-only prelude, or, with `task new pr-review …
--no-report`, the pull request alone; it always posts one `COMMENT` review whose
first line is the verdict ([PR-review design](docs/design-pr-review-graph.md)). Both
share one ledger per pull request, a section per graph. Their one write, the review,
needs the runner config's `github.writeTokenEnv`; the plugins never see the token.
Both plugins vendor the third-party diagram-design agent skill
(`examples/plugins/<plugin>/vendor/diagram-design`, MIT, unmodified, with its
`LICENSE` and a `VENDORED.md` naming source and commit; design
[§12.4](docs/design-pr-review-graph.md#124-the-vendored-diagram-design-skill)),
which their diagram jobs draw with; `vendor/` directories are exempt from the SPDX
header check and listed in `THIRD_PARTY_NOTICES`.
The review machinery the two graphs share (Fetch, the ledger, the change
report, measurements, groundwork, the profile parser, posting a review, the
`task new` plan) is the review kit, `examples/plugins/review-kit/src`, a plain
source tree copied byte for byte into each plugin's `src/kit/` (design
[§14](docs/design-pr-review-graph.md#14-the-review-kit)): edit the kit, never
a copy, then `npm run vendor -w @graphloom/plugin-pr-review` and
`npm run vendor -w @graphloom/plugin-pr-design-review` and regenerate both
manifests; each plugin's `kit-drift.test.ts` fails, naming the file, when they differ.

Installable releases (tarball, install layout, upgrade, local release
procedure) follow the [release design](docs/design-release.md).
`scripts/release.sh build <version>` builds the release assets locally into
`release-out/<version>/` (gate on the pinned Node, license and content checks,
smoke tests with no `node` on `PATH`); it publishes nothing.
`scripts/install.sh` (installer, `upgrade`, `self ...`) and `scripts/shim.sh`
(the user shim and the daily update trigger) are POSIX sh; their tests
(`apps/graphloom/test/install.test.ts`, `auto-update.test.ts`) use a temporary
`HOME` and a stub `gh`, never the real install home or the network.

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
  Each qualification forks an immutable snapshot of the base plugin version into
  its own candidate tree so concurrent repairs cannot clobber each other or the
  live pin; activation admits one candidate under the run lock.
- Source repair needs available source, build inputs, tests, and operator authority.
  Opaque dependencies retain explicit limits; TypeScript alone is not repairability.
- Run plugins outside the controller process. Process separation does not replace
  enforced filesystem, credential, network, and process scopes.
- The controller owns persistence, evidence, permissions, finite budgets, and
  version transitions. Reconcile ambiguous effects before retrying.
- Show concise decision reasons and evidence, not private model reasoning.

## Scope and verification

Implement against the TypeScript packages above.
Implement the requested scope and verify affected behavior. Documentation-only
edits need consistency, link, and formatting checks; runtime changes need meaningful
behavior tests. Do not commit, push, publish, deploy, or alter external resources
unless the user authorizes those actions.

Historical research is context, not proof of implemented GraphLoom capability.
