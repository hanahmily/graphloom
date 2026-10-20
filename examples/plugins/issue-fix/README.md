# issue-fix graph plugin

Source-repairable Fix → Review bundle that fixes one bug issue in any
repository, written only against the public `@graphloom/sdk`. Everything
repository-specific comes from a *profile*: a JSON file the task names with
`config:`. The graph is [banyandb-fix](../banyandb-fix/README.md)'s, with its
plan, implementation, RED/GREEN proof, scope check, optional changelog check,
open-code-review sweep with independent verification, and local `fix/<issue>`
delivery. The reviewer may raise new findings in the first three review
rounds only; after that it verifies the known findings, and new comments
become follow-ups in the pull request. Since 0.4.0 the run tracks its
critical and high findings as issues in `.graphloom/issues.json` in the run's
worktree, with a readable `.graphloom/issues.md`: the verifier opens or
dismisses them, the fixer marks them fixed, and the reviewer verifies each one
done or reopens it. The graph owns the file and rejects any other edit, Git
ignores it, and the pull request lists the table. The
[design](../../../docs/design-issue-fix-graph.md) gives the profile schema,
how the config reaches the plugin, the
[discovery rounds](../../../docs/design-issue-fix-graph.md#review-discovery-rounds)
and the [issues file](../../../docs/design-issue-fix-graph.md#the-issues-file).

## Profiles

| Profile | Repository | Regression runner | Build checks | Changelog |
|---|---|---|---|---|
| [`profiles/banyandb.json`](profiles/banyandb.json) | apache/skywalking-banyandb, issues in apache/skywalking | `go-test` | `make test-ci` for the changed packages, license-check, build, lint, check | `CHANGES.md` |
| [`profiles/graphloom.json`](profiles/graphloom.json) | hanahmily/graphloom (this repository) | `vitest` | `npm run typecheck`, `npm run build`, `npm test` | none |

The banyandb profile reproduces banyandb-fix's requirements, statements,
environment checks, prompts and commands, with two differences: the issues
file, which banyandb-fix does not have, and, since 0.5.0, a code review that
covers every changed file (ocr's exclusions put back, `.graphloom/` left out)
and then checks the change as a whole across files. See banyandb-fix's
README for its environment table and runner configuration; they apply as they
are.

## Run it

From `examples`:

```yaml
graph: issue-fix
repo: skywalking-banyandb
config: plugins/issue-fix/profiles/banyandb.json
request: "Fix apache/skywalking#14092."
```

The run's budgets come from the profile's `budgets`, which the graph declares
as its default budgets (since 0.6.0): about twice what the measured runs
used, per [docs/budgets.md](../../../docs/budgets.md). A `budgets:` block in
the task overrides them key by key; `graphloom stats <run>` shows what a run
used against them.

[`../../issue-fix-banyandb-task.yaml`](../../issue-fix-banyandb-task.yaml) and
[`../../issue-fix-graphloom-task.yaml`](../../issue-fix-graphloom-task.yaml)
are ready to use; the GraphLoom one runs on the checkout it lives in
(`repo: .`). Intake pins the profile's bytes and digest; editing the file
later does not change a running or resumed run.

A resume retries what failed (since 0.6.1): candidate checks that failed, and a
RED that could not build or run, before the operator's latest resume run again
once, instead of sending the implementer a correction for a fault that may
have been the environment. Checks that passed stay valid, and a failure
recorded after the resume is corrected as before.

The commit message and the pull request summary come from the decision
record's `change` (since 0.7.0, contract `decision-record-v2`): what the change
does against the base, kept current every round. The round's `summary` is the
implementer's report to the graph and is never delivered. Sentences naming
review issue ids, `.graphloom/` or the implementer in the first person are
dropped, the Test plan names only the pinned checks the evidence shows passed,
and follow-ups about the environment or a pinned check are left out. A record
without `change` falls back to the plan's text.

The runner config is banyandb-fix's: Claude Code, Codex and Pi enabled, the
GitHub reads, and command jobs long enough for the profile's checks. For the
graphloom profile the full suite takes about ten minutes; its commands allow
45.

```sh
GRAPHLOOM_GITHUB_LIVE_TOKEN="$(gh auth token)" node ../apps/graphloom/dist/main.js run issue-fix-graphloom-task.yaml
```

## Another repository

Copy a profile beside your task, adjust it, and name it with `config:`. A
profile selects one of the built-in regression runners (`go-test`, `vitest`);
another test framework needs a new runner in `src/runners/`.

## Build and repair

```sh
npm run build -w @graphloom/plugin-issue-fix
npm test -w @graphloom/plugin-issue-fix
npm run manifest -w @graphloom/plugin-issue-fix   # after build
node <installed>/scripts/qualify.mjs <candidateRoot>  # repair preflight
```

The manifest declares `taskConfig: "required"` and pins the source,
profile, test and lock digests, but no requirements: they depend on the
profile, and each run pins the ones `describe(config)` returns.
`src/qualification.ts` holds positive and negative cases for every validator
under both shipped profiles.
