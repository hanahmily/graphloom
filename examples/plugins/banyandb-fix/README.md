# BanyanDB fix graph plugin

Source-repairable Fix → Review bundle for bug issues in the BanyanDB 0.12.0
milestone of apache/skywalking, written only against the public
`@graphloom/sdk`. Given a request that names an issue, such as
`Fix apache/skywalking#14111.`, it plans the fix with Claude Code, has a fresh
Pi session review the plan, implements it, proves it with a regression test
that fails on the base and passes on the change, reviews the committed change
with [open-code-review](https://github.com/alibaba/open-code-review), and
leaves a local `fix/<issue>` branch with a short commit message. The pull
request body is the delivery command's report in the run's evidence.
Publishing stays with you. The
[design](../../../docs/design-banyandb-fix-graph.md) explains the choices.

## Environment

The graph declares BanyanDB's contributor checklist, and the controller runs it
before any job, on every resume, and after a repair activation:

| Command | Checks |
|---|---|
| `go` | `go env GOVERSION` equals the `go` line of `go.mod` |
| `git` | Git 2.41 or later (open-code-review needs it; BanyanDB needs 2.30) |
| `ocr` | `ocr version` and `ocr llm test`: open-code-review is installed and its model answers |
| `claude` | `claude --version` and `claude auth status`: Claude Code is installed and logged in, using `GRAPHLOOM_CLAUDE_BIN` and `GRAPHLOOM_CLAUDE_CONFIG_DIR` (then `CLAUDE_CONFIG_DIR`) as the harness does |
| `make` | GNU make |
| `check-req` | `make check-req` |
| `generate` (prepare) | `make generate` leaves no tracked or unignored file changed |

It also pins the SHA-256 of `CONTRIBUTING.md`. A missing tool stops the run and
names it. A changed guide blocks normal jobs until a qualified repair updates
the declaration; without a supervisor, the run stops.

## Stages and requirements

| Stage | Requirement | Validator |
|---|---|---|
| Fix | `plan-reviewed`: a fresh read-only Pi reviewer approved the plan the implementer followed, after it was written, on the spec, decisions, reach and test axes | `plan-reviewer` (controller-checked separate reviewer) |
| Fix | `decisions-recorded`: the implementer's `decision-record-v1` names the test, the expected value's source, the production caller, and every decision with its tier and basis | `decisions-recorded` |
| Fix | `reproduces`: in a prepared base checkout with only the change's test files, the regression test fails by assertion, not by a build error, setup failure or panic | `red-reproduces` |
| Fix | `passes`: in the committed candidate checkout, the regression test and `make test-ci` for the changed packages pass | `green-passes` |
| Fix | `builds`: in the same checkout, make license-check, build, lint and check pass | `build-checks` |
| Fix | `in-scope`: the change avoids `api/proto`, `go.mod`, `go.sum` and `.github` unless the record justifies it | `write-scope` |
| Fix | `changelog-entry`: the change adds a bullet to the current release section of `CHANGES.md` | `changes-entry` |
| Review | `code-review`: open-code-review, run read-only in a prepared checkout of the committed change, reviewed every file and reported no critical or high comment | `open-code-review` |

Validators see only the current generation's evidence, so each generation plans
and reviews its plan again: after the supervisor re-enters Fix, or after a
resume during Fix, the planner revisits its plan in its continued session and a
fresh reviewer checks it before any code changes.

Checks and the code review run in disposable checkouts, never in the run's worktree. Each checkout
is prepared with `make generate`; a check that leaves a file changed (such as
`make check` reformatting Go code) fails its requirement. Every receipt is bound
to the change's digest, so a later edit invalidates it.

## Behavior

| State | Action |
|---|---|
| Fix, no issue snapshot | Read the issue and its comments through the GitHub executor |
| Snapshot, no plan | Dispatch a read-only Claude Code plan returning `decision-record-v1` |
| Plan is `blocked` | Stop "needs maintainer decision" with the draft question |
| Plan is `cannot_reproduce` | Stop "cannot reproduce" |
| Plan is invalid | Supervise |
| Plan ready, not reviewed | Dispatch a fresh read-only Pi reviewer with the issue and the plan |
| Plan reviewer names a product decision without approving | Stop "needs maintainer decision" |
| Plan reviewer requests changes | Return the findings to the planner's session, at most twice, then Supervise |
| Plan approved | Implement, continuing the plan's session, with the protected paths excluded from write scope |
| Implemented | Observe `CHANGES.md`, run the candidate checks, then RED on the base |
| Every Fix requirement passes | Validate Fix |
| A requirement fails | Return the reasons and failing output to the implementer's session, at most twice, then Supervise |
| Review | Run open-code-review on the committed change in a candidate checkout, with the review rule and the issue and plan as background |
| Code review passes | Validate Review, then deliver |
| Code review fails or reports a critical or high comment | Supervise; if it re-enters Fix, the planner revisits its plan with the comments |
| Delivered | Stop complete; the branch has a short commit message, and the delivery report holds the PR body |
| Request names no issue | Stop incompatible |

The plan reviewer judges four axes: spec, decisions, test, and reach. Reach
means every caller and lifecycle path whose behaviour the plan changes
(shutdown and `Close`, cancellation, errors, panics, retries, concurrency,
resource release) is named, and covered by a planned test or stated as a
risk. The planner is asked for the same in each behaviour decision's basis.

The code review uses open-code-review's own rules plus a Go rule that asks the
same reach question of the diff, and it reviews `_test.go` files too. A comment
without a severity counts as blocking. The command reduces open-code-review's
JSON to status, model, warnings and at most 30 comments, most severe first,
without the model's reasoning. It runs at `--effort high` (three review rounds)
and caps the review at 8,000,000 tokens. On the #14111 change that hung
`Scheduler.Close` for actions ignoring cancellation, MiniMax-M3 missed the hang
at the default effort, with or without the rule, and reported it at high
severity with the rule at high effort, using 3.5 million tokens in 16 minutes.

Delivery builds the commit from a temporary index, so the run's worktree, index
and branch stay untouched. It refuses to overwrite an existing `fix/<issue>`
branch.

## Run it

From `examples`, with a BanyanDB checkout beside this repository, write a task:

```yaml
graph: banyandb-fix
repo: ../../skywalking-banyandb
request: "Fix apache/skywalking#14111."
budgets:
  agentInvocations: 600
  activeMs: 28800000
```

`budgets` replaces the controller's defaults. The default of 64 model requests
per run is too few for BanyanDB: every agent turn counts, and a plan alone can
spend 64 while reading the code.

The runner config must enable both harnesses and the GitHub reads, and give
command jobs room for BanyanDB's checks:

```json
{
  "harness": "claude-code",
  "harnesses": ["claude-code", "pi"],
  "allowUnrestricted": true,
  "pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3", "agentDir": "~/.pi/agent" },
  "github": { "tokenEnv": "GRAPHLOOM_GITHUB_LIVE_TOKEN" },
  "command": { "timeoutMs": 10800000 }
}
```

Install open-code-review (`npm install -g @alibaba-group/open-code-review`) and configure
its model in `~/.opencodereview/config.json`; `ocr llm test` must pass. Claude
Code must be installed and logged in (`claude auth status`). The environment
checks stop the run before any job otherwise, naming the tool. If `runner.json`
sets `claude.command` or `claude.configDir`, export `GRAPHLOOM_CLAUDE_BIN` or
`GRAPHLOOM_CLAUDE_CONFIG_DIR` to match, because the check reads only the
environment. To check by hand:

```sh
ocr version && ocr llm test && claude --version && claude auth status
```

```sh
GRAPHLOOM_GITHUB_LIVE_TOKEN="$(gh auth token)" node ../apps/graphloom/dist/main.js run banyandb-fix-task.yaml
```

## Build and repair

```sh
npm run build -w @graphloom/plugin-banyandb-fix
npm test -w @graphloom/plugin-banyandb-fix
npm run manifest -w @graphloom/plugin-banyandb-fix   # after build
node <installed>/scripts/qualify.mjs <candidateRoot>  # repair preflight
```

`src/qualification.ts` holds positive and negative cases for every validator. A
repair preflight runs them from the installed copy, so a patch cannot weaken
them; the candidate must pass every case and the installed validators must fail
at least one.

`apps/graphloom/test/banyandb-fix-e2e.test.ts` runs this bundle through the
controller on a small Go module shaped like BanyanDB, with the real command and
GitHub executors (against a fake GitHub), scripted agents and a stand-in `ocr`
on `PATH`. The run checks the environment, gets the plan approved, fails RED by
assertion on the base, passes GREEN and the build checks on the committed
change, runs the code review in a candidate checkout, and leaves `fix/14111`.
