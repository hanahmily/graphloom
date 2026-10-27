# Minimal hello graph example

[task.yaml](task.yaml) selects `hello`, the repository, and the request. The
source-repairable bundle under [`plugins/hello`](plugins/hello/) includes
TypeScript graph/validators, tests, manifest, and build outputs
(`@graphloom/plugin-hello`).

```sh
npm test -w @graphloom/plugin-hello
```

## Run it on a real coding agent

`graphloom run` sends each job hello dispatches to the coding agent the operator
configures: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or a
Pi coding agent. Both run with your user permissions in the run's worktree, so
the runner config must say `"allowUnrestricted": true`. `graphloom setup`
writes it from what `graphloom doctor` finds on this machine. Or configure it
in `~/.config/graphloom/runner.json`, or in the file `GRAPHLOOM_RUNNER_CONFIG`
names:

```json
{ "harness": "claude-code", "allowUnrestricted": true }
```

```json
{
  "harness": "pi",
  "allowUnrestricted": true,
  "pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3", "agentDir": "~/.pi/agent" }
}
```

Pi falls back to `GRAPHLOOM_PI_PROVIDER` and `GRAPHLOOM_PI_MODEL` when the file
omits them. Other settings:

- `claude`: `command` (default `claude` on `PATH`; a relative path resolves
  against the directory you run `graphloom` in), `model`, and `configDir`, its
  config dir, which picks the login or gateway. `startupTimeoutMs` and
  `responseTimeoutMs` stop a Claude Code session that shows no model output for
  that long (defaults five and ten minutes; 0 disables). Each must be shorter
  than `timeoutMs`; a default that is not falls to half of it.
- `pi`: `agentDir`.
- `codex`, for the read-only Codex harness (`"harness": "codex"`, or listed in
  `harnesses` so a job can choose it with `input.harness`): `command` (default
  `codex` on `PATH`), `model`, `reasoningEffort` (`minimal` to `xhigh`),
  `codexHome` (its login and config), and `responseTimeoutMs` (default ten
  minutes; 0 disables). Codex uses its own login and runs only read-only jobs.
- `claude`, `pi` and `codex` take `passEnv`, extra environment variable names
  the agent's commands may see. `timeoutMs` at the top level limits each job
  (default one hour).
- `notify.onStop` (a shell command) and `notify.timeoutMs` (default 60 seconds):
  run once when a run leaves `running`, like `run --on-stop <command>`, which
  overrides it. See "Knowing when a run stops" in the main README.

Credentials never go in this file, and `graphloom` refuses one that holds them.
Claude Code uses the login in its config dir. Pi uses the keys in its agent dir
or the provider's environment variable, such as `MINIMAX_CN_API_KEY`. A missing
runner config, Claude Code or Codex command, or Pi model fails before the run
starts.

Then build, prepare a disposable repository beside the task, and run:

```sh
npm ci && npm run build
cd examples
git init test-repo
git -C test-repo -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit --allow-empty -m "Initialize hello fixture"
node ../apps/graphloom/dist/main.js run task.yaml
node ../apps/graphloom/dist/main.js inspect <runId> --state-root test-repo/graphloom-state
node ../apps/graphloom/dist/main.js stats <runId> --state-root test-repo/graphloom-state
```

`inspect` lists each stage's completion and the validation receipts behind it;
`stats` shows what the run used against its budgets ([budgets](../docs/budgets.md)).
Write requires exact bytes `Hello, GraphLoom!\n` at `GREETING.txt` only. Review
is an independent read-only job, and its structured result is the verdict. See
[design §11](../docs/design-typescript-core.md#11-minimal-example-and-verification).

The same run as an opt-in test, using your runner config (or Claude Code when
you have none). It stays out of CI:

```sh
npm run build && GRAPHLOOM_HELLO_LIVE=1 npm exec -w @graphloom/cli -- vitest run test/hello-live.test.ts
```

## A second graph: release

[`plugins/release`](plugins/release/) is a second plugin written only against
the public SDK (`@graphloom/plugin-release`). It is shaped differently from
hello: its three stages are Bump version, Changelog, and Review. Changelog
carries two requirements, and one of its validators reads two files. The
[plugin README](plugins/release/README.md) describes its routing and how a copy
of it rebuilds for repair. Run it the same way, from `examples`:

```sh
node ../apps/graphloom/dist/main.js run release-task.yaml
```

`apps/graphloom/test/release-e2e.test.ts` runs it through the controller with
scripted jobs. One of those runs repairs a faulty validator with a qualified
source patch and completes after activation.

## A real repository: issue-fix

[`plugins/issue-fix`](plugins/issue-fix/) fixes bug issues in any repository
(`@graphloom/plugin-issue-fix`). Its two stages are Fix and Review. The graph
declares the repository's contributor checklist, which the controller runs
before any job, and proves each fix in disposable checkouts: the regression
test fails on the base and passes, with the build checks, on the committed
change. A task names a repository profile with `config:`, a JSON file relative
to the task file that intake pins with its digest and hands to the plugin; the
controller reads none of its fields.
[`issue-fix-banyandb-task.yaml`](issue-fix-banyandb-task.yaml) runs it on
[Apache SkyWalking BanyanDB](https://github.com/apache/skywalking-banyandb)
with the banyandb profile, and
[`issue-fix-graphloom-task.yaml`](issue-fix-graphloom-task.yaml) on GraphLoom
itself. See the [plugin README](plugins/issue-fix/README.md) and the
[design](../docs/design-issue-fix-graph.md).
