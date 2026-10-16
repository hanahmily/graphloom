# BanyanDB fix graph plugin

Source-repairable Fix → Review bundle for bug issues in the BanyanDB 0.12.0
milestone of apache/skywalking, written only against the public
`@graphloom/sdk`. Given a request that names an issue, such as
`Fix apache/skywalking#14111.`, it plans the fix with Claude Code, has a fresh
Pi session review the plan, implements it, proves it with a regression test
that fails on the base and passes on the change, has Codex review the change in
[open-code-review](https://github.com/alibaba/open-code-review)'s delegation
mode, and leaves a local `fix/<issue>` branch with a short commit message. The pull
request body is the delivery command's report in the run's evidence.
Publishing stays with you. The
[design](../../../docs/design-banyandb-fix-graph.md) explains the choices.

The generic [issue-fix](../issue-fix/README.md) graph runs this graph from a
repository profile; its `profiles/banyandb.json` reproduces this bundle, and
new BanyanDB runs should use it. This bundle stays as it is so runs pinned to
it can resume.

## Environment

The graph declares BanyanDB's contributor checklist, and the controller runs it
before any job, on every resume, and after a repair activation:

| Command | Checks |
|---|---|
| `go` | `go env GOVERSION` equals the `go` line of `go.mod` |
| `git` | Git 2.41 or later (open-code-review needs it; BanyanDB needs 2.30) |
| `ocr` | open-code-review is installed and has a delegation mode (`ocr delegate preview --help`); prints the absolute path the code reviewer is told to run |
| `codex` | `codex --version` and `codex login status`: Codex is installed and logged in, with the command and home the runner configures for the harness (`GRAPHLOOM_CODEX_BIN`, `GRAPHLOOM_CODEX_HOME`, then `CODEX_HOME`) |
| `claude` | `claude --version` and `claude auth status`: Claude Code is installed and logged in, with the command and config directory the runner configures for the harness (`GRAPHLOOM_CLAUDE_BIN`, `GRAPHLOOM_CLAUDE_CONFIG_DIR`, then `CLAUDE_CONFIG_DIR`) |
| `make` | GNU make |
| `check-req` | `make -C scripts/ci/check test`: BanyanDB's Go version and architecture test, not `make check-req` itself (which also runs `ui`/`mcp` `check-version`, redundant with the dedicated `node` check below, and slower: it runs `npm ci`) |
| `node` | Node.js >= 24.6.0, unconditionally: `make generate` and `make build` both need it for every task, since they loop over BanyanDB's `ui` and `mcp` projects regardless of what changed |
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
| Review | `code-review`: the latest read-only Codex pass on the current change, in this generation, reviewed every changed file, test files included, skipped none, and gave a status for every open finding; every critical or high finding it raised was refuted by a read-only verifier with quotes that match the change; and no finding of the run is confirmed and unfixed, disputed, or awaiting verification | `open-code-review` |

Validators see the current generation's evidence, so each generation plans
and reviews its plan again: after the supervisor re-enters Fix, or after a
resume during Fix, the planner revisits its plan in its continued session and a
fresh reviewer checks it before any code changes. The code review validator
also reads earlier generations' evidence, which the controller passes as
history, to rebuild the findings ledger; it still needs a pass on the current
change.

Checks run in disposable checkouts, never in the run's worktree. Each checkout
is prepared with `make generate`; a check that leaves a file changed (such as
`make check` reformatting Go code) fails its requirement. The code review is a
read-only agent job in the run's worktree, where Codex runs in its read-only
sandbox. Every receipt is bound to the change's digest, so a later edit
invalidates it.

## Behavior

| State | Action |
|---|---|
| Fix, no issue snapshot | Read the issue and its comments through the GitHub executor |
| Snapshot, no plan | Dispatch a read-only Claude Code plan returning `decision-record-v1` |
| Plan is `blocked` | Stop "needs maintainer decision" with the draft question |
| Plan is `cannot_reproduce` | Stop "cannot reproduce" |
| Plan is invalid | Supervise |
| Plan ready, not reviewed | Dispatch a fresh read-only Pi reviewer with the issue and the plan |
| Plan reviewer names a product decision without approving | Supervise; the graph itself cannot tell a genuine product question from a malformed one, so the supervisor judges it and stops "needs maintainer decision" only if it is real |
| Plan reviewer requests changes | Return the findings to the planner's session, at most twice, then Supervise |
| Plan approved | Implement, continuing the plan's session, with the protected paths excluded from write scope |
| Implemented | Observe `CHANGES.md`, run the candidate checks, then RED on the base |
| Every Fix requirement passes | Validate Fix |
| A requirement fails | Return the reasons and failing output to the implementer's session, at most twice, then Supervise |
| Review, no pass on the current change in this generation | Dispatch a fresh read-only Codex reviewer with open-code-review's delegation workflow, the `ocr` path from the environment check, the review rule, the issue and plan, and the known findings by name |
| Review, but no `ocr` path was recorded | Supervise |
| A pass raised critical or high findings | Dispatch one fresh read-only Claude Code verifier for every finding pending on the change, then observe the files its refutations quote |
| A finding the pass raised was confirmed or disputed | Another pass, told every known finding, looks for new ones; at most four passes per change |
| Code review passes | Validate Review, then deliver; the PR body lists dismissed findings |
| Code review fails, misses or skips a file, or leaves a finding confirmed or disputed | Supervise with the round's progress; if it re-enters Fix, the planner revisits its plan with the confirmed findings only |
| Delivered | Stop complete; the branch has a short commit message, and the delivery report holds the PR body |
| Request names no issue | Stop incompatible |

The plan reviewer judges four axes: spec, decisions, test, and reach. Reach
means every caller and lifecycle path whose behaviour the plan changes
(shutdown and `Close`, cancellation, errors, panics, retries, concurrency,
resource release) is named, and covered by a planned test or stated as a
risk. The planner is asked for the same in each behaviour decision's basis.

In delegation mode open-code-review only selects the files (`ocr delegate
preview`) and resolves their rules (`ocr delegate rule`); Codex reads the diffs
and does the review. The assignment adds a Go rule that asks the same reach
question of the diff, and the change's `_test.go` files, which preview excludes
by default. The result is strict JSON (`code-review-v2`): comments with a
path, lines, category, severity, the known finding they repeat and a concrete
failure; a status for each open finding; and a coverage summary. A pass counts
only when every file on the list was reviewed, none skipped, and every open
finding has a status. A comment without a severity counts as blocking. The
assignment names `ocr` by the absolute path the environment check printed,
because Codex runs commands in a login shell that may reset `PATH`.

Critical and high findings are named `F1`, `F2`, … and kept in a ledger rebuilt
from the evidence. A verifier confirms each with its own `file:line` witness,
refutes it with at most three quoted lines, or cannot decide. A refutation
dismisses the finding only once the controller has observed the quoted files
on the current change and every quote, whitespace collapsed, appears within
three lines of the line it cites; otherwise, and when the verifier gives no
verdict, the finding is disputed and blocks. A confirmed finding is fixed only
when a pass on a later change calls it resolved. A dismissed finding raised
again stays dismissed while its quotes still match. The design's [review
convergence](../../../docs/design-banyandb-fix-graph.md#review-convergence)
section gives the full rules.

Codex runs through the coding-agent executor's Codex harness (`codex exec` in
its read-only sandbox, no graph tools, no saved session). On PR #94's graph
code with four known defects, open-code-review with MiniMax-M3 at high effort
found one, with high-severity false positives, using 7 to 8 million tokens;
Codex in delegation mode found three, with no clear false positives, using
about 1.4 million input tokens, mostly cached.

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
  agentInvocations: 2000
  jobs: 1024
  decisions: 2048
  corrections: 16
  activeMs: 43200000
```

`budgets` replaces the controller's defaults. The default of 64 model requests
per run is too few for BanyanDB: every agent turn counts, a plan alone can
spend 64 while reading the code, and a failing review round can run four
passes and four verifications.

These numbers come from a real run (apache/skywalking#14092, run
`9bfa446d-4ea`): it used 1,924 agent invocations (fix 1,656, review 268)
across one failed review round and one fix reentry, so 2,000 covers a
comparable fix with modest headroom. `jobs`, `decisions`, and `corrections`
are scaled to the same run; `activeMs` allows 12 hours of execution time.

The runner config must enable all three harnesses and the GitHub reads, and
give command jobs room for BanyanDB's checks:

```json
{
  "harness": "claude-code",
  "harnesses": ["claude-code", "pi", "codex"],
  "allowUnrestricted": true,
  "pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3", "agentDir": "~/.pi/agent" },
  "codex": { "reasoningEffort": "high" },
  "github": { "tokenEnv": "GRAPHLOOM_GITHUB_LIVE_TOKEN" },
  "command": { "timeoutMs": 10800000 }
}
```

Install open-code-review 1.9 or later (`npm install -g
@alibaba-group/open-code-review`); delegation mode needs no model on its side.
Claude Code and Codex must be installed and logged in (`claude auth status`,
`codex login status`). The environment checks stop the run before any job
otherwise, naming the tool. They check the commands and login directories
`runner.json` gives the harnesses (`claude.command`, `claude.configDir`,
`codex.command`, `codex.codexHome`), which the CLI passes to command jobs.
To check by hand:

```sh
ocr delegate preview --help >/dev/null && codex login status && claude --version && claude auth status
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
change, has the scripted reviewer run the `ocr` path from the environment check
in the worktree and raise a false positive, has the scripted verifier refute it
with lines the controller observes in the worktree, and leaves `fix/14111`
with the dismissed finding in the PR body.
