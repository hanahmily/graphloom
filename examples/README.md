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
Pi coding agent. Both run unrestricted in the run's worktree, as you would. The
controller checks afterwards that each job changed only the paths it was allowed
to. Configure the agent in `~/.config/graphloom/agent.json`, or in the file
`GRAPHLOOM_AGENT_CONFIG` names:

```json
{ "harness": "claude-code" }
```

```json
{ "harness": "pi", "provider": "minimax-cn", "modelId": "MiniMax-M3", "agentDir": "~/.pi/agent" }
```

Without a file, `GRAPHLOOM_AGENT_HARNESS=claude-code` or `=pi` selects the
harness. Pi then reads `GRAPHLOOM_PI_PROVIDER` and `GRAPHLOOM_PI_MODEL`. Other
settings:

- Claude Code: `command` (default `claude` on `PATH`; a relative path resolves
  against the directory you run `graphloom` in), `model`, and `configDir`, its
  config dir, which picks the login or gateway. `startupTimeoutMs` and
  `responseTimeoutMs` stop a Claude Code session that shows no model output for
  that long (defaults five and ten minutes; 0 disables). Each must be shorter
  than `timeoutMs`; a default that is not falls to half of it.
- Pi: `agentDir`.
- Both: `timeoutMs` per job (default one hour) and `passEnv`, extra environment
  variable names the agent's commands may see.

Credentials never go in this file, and `graphloom` refuses one that holds them.
Claude Code uses the login in its config dir. Pi uses the keys in its agent dir
or the provider's environment variable, such as `MINIMAX_CN_API_KEY`. A missing
or incomplete agent configuration fails before the run starts.

Then build, prepare a disposable repository beside the task, and run:

```sh
npm ci && npm run build
cd examples
git init test-repo
git -C test-repo -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit --allow-empty -m "Initialize hello fixture"
node ../apps/graphloom/dist/main.js run task.yaml
node ../apps/graphloom/dist/main.js inspect <runId> --state-root test-repo/graphloom-state
```

`inspect` lists each stage's completion and the validation receipts behind it.
Write requires exact bytes `Hello, GraphLoom!\n` at `GREETING.txt` only. Review
is an independent read-only job, and its structured result is the verdict. See
[design §11](../docs/design-typescript-core.md#11-minimal-example-and-verification).

The same run as an opt-in test, using your agent config (or Claude Code when you
have none). It stays out of CI:

```sh
npm run build && GRAPHLOOM_HELLO_LIVE=1 npm exec -w @graphloom/cli -- vitest run test/hello-live.test.ts
```
