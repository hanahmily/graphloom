# BanyanDB fix graph plugin

Source-repairable Fix → Review bundle for bug issues in the BanyanDB 0.12.0
milestone of apache/skywalking, written only against the public
`@graphloom/sdk`. Given a request that names an issue, such as
`Fix apache/skywalking#14111.`, it plans and implements the fix with Claude
Code, proves it with a regression test that fails on the base and passes on the
change, has a fresh Pi session review it, and leaves a local `fix/<issue>`
branch with a draft PR description. Publishing stays with you. The
[design](../../../docs/design-banyandb-fix-graph.md) explains the choices.

## Environment

The graph declares BanyanDB's contributor checklist, and the controller runs it
before any job, on every resume, and after a repair activation:

| Command | Checks |
|---|---|
| `go` | `go env GOVERSION` equals the `go` line of `go.mod` |
| `git` | Git 2.30 or later |
| `make` | GNU make |
| `check-req` | `make check-req` |
| `generate` (prepare) | `make generate` leaves no tracked or unignored file changed |

It also pins the SHA-256 of `CONTRIBUTING.md`. A missing tool stops the run and
names it. A changed guide blocks normal jobs until a qualified repair updates
the declaration; without a supervisor, the run stops.

## Stages and requirements

| Stage | Requirement | Validator |
|---|---|---|
| Fix | `decisions-recorded`: the implementer's `decision-record-v1` names the test, the expected value's source, the production caller, and every decision with its tier and basis | `decisions-recorded` |
| Fix | `reproduces`: in a prepared base checkout with only the change's test files, the regression test fails by assertion | `red-reproduces` |
| Fix | `passes`: in the committed candidate checkout, the regression test and `make test-ci` for the changed packages pass | `green-passes` |
| Fix | `builds`: in the same checkout, make license-check, build, lint and check pass | `build-checks` |
| Fix | `in-scope`: the change avoids `api/proto`, `go.mod`, `go.sum` and `.github` unless the record justifies it | `write-scope` |
| Fix | `changelog-entry`: the change adds a bullet to the current release section of `CHANGES.md` | `changes-entry` |
| Review | `spec-and-standards-review`: a fresh read-only reviewer approves the change on the Spec and Standards axes | `independent-reviewer` |

Checks run in disposable checkouts, never in the run's worktree. Each checkout
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
| Plan ready | Implement, continuing the plan's session, with the protected paths excluded from write scope |
| Implemented | Observe `CHANGES.md`, run the candidate checks, then RED on the base |
| Every Fix requirement passes | Validate Fix |
| A requirement fails | Return the reasons and failing output to the implementer's session, at most twice, then Supervise |
| Review | Dispatch a fresh Pi reviewer with the issue, the record and the check evidence |
| Reviewer names a product decision | Stop "needs maintainer decision" |
| Reviewer requests changes | Supervise |
| Reviewer approves | Validate Review, then deliver |
| Delivered | Stop complete; the branch commit's message is the PR description |
| Request names no issue | Stop incompatible |

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
GitHub executors (against a fake GitHub) and scripted agents. The run checks
the environment, fails RED by assertion on the base, passes GREEN and the build
checks on the committed change, gets an approval, and leaves `fix/14111`.
