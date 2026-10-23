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
| [`profiles/banyandb.json`](profiles/banyandb.json) | apache/skywalking-banyandb, issues in apache/skywalking | `go-test` | `make test-ci` for the changed packages, lint (cheap tier); build, check (full tier; `make check` includes license-check) | `CHANGES.md` |
| [`profiles/graphloom.json`](profiles/graphloom.json) | hanahmily/graphloom (this repository) | `vitest` | `npm run typecheck`, `npm run build`, `npm test` | none |
| [`profiles/canopy.json`](profiles/canopy.json) | apache/skywalking-banyandb, issues in apache/skywalking; Node/TypeScript changes under `canopy/` | `vitest` | the changed workspaces' tests, typecheck, lint (cheap tier); build, `npm test`, `make license-dep` (full tier) | `CHANGES.md` |

The banyandb profile reproduces banyandb-fix's requirements, statements,
environment checks, prompts and commands, with two differences: the issues
file, which banyandb-fix does not have, and, since 0.5.0, a code review that
covers every changed file (ocr's exclusions put back, `.graphloom/` left out)
and then checks the change as a whole across files. See banyandb-fix's
README for its environment table and runner configuration; they apply as they
are.

Since 0.8.0 the banyandb profile differs in two more ways. It no longer runs
`license-check` as a command of its own, because `make check` already runs it
and `check-format`. And it checks in two tiers: a command's `tier` is `cheap`
or `full` (default `full`). When a profile declares any `cheap` command, one
checkout job runs GREEN and the cheap commands (banyandb: `make test-ci`,
`make lint`); the full commands (`make build`, `make check`) run in a second
job only when the cheap tier passed on the same candidate digest and no other
requirement already fails. A cheap failure goes back to the implementer with
its evidence and skips RED and the full tier. A command that did not run never
counts as passed, and Fix is accepted only when both tiers passed on the same
digest. A profile with no `cheap` command runs every check in one job, as
before. The profile's `implementation.selfCheck` lists the commands the
implementer runs before returning `ready` (banyandb: `go vet` and
`golangci-lint run` on the changed packages) and lists in the record's
`selfChecks`; the graph does not trust that report.

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

## Generated files, duplicate findings and acceptance coverage (0.10.0)

- A profile command may declare `writes`: the files it regenerates, such as
  canopy's `canopy/LICENSE` and `canopy/licenses/**` for `make license-dep`.
  The implementer's write scope covers them even when `protectedPaths` lists
  them, so a correction for a failed license check is not refused for scope.
  A `writes` path below a protected directory is a `+path` exception in the
  scope (the rest of the directory stays excluded).
- A problem the code reviewer raises twice (per file and in the whole-change
  check or a sweep pass) is one finding when the lines overlap on the same
  path in the same round; a comment marked `distinct` stays separate. Only
  passes whose result carries `contract: "dedupe-1"` merge, so evidence from
  before 0.10.0 replays with its original finding ids.
- The planner lists the issue's acceptance items (`acceptance`) and the
  implementer maps each to files and tests (`coverage`); the graph checks the
  map before code review and sends the change back for anything uncovered. A
  plan without `acceptance` runs as before. The contract is
  `decision-record-v2` with these two optional fields.

### Refreshing the pinned CONTRIBUTING.md

The banyandb profile pins `CONTRIBUTING.md` by sha256 (`environment.pinnedFiles`),
and a different file in the repository stops a run with `environment_changed`.
When BanyanDB changes it, refresh the pin and the fixture the tests use:
`git -C <skywalking-banyandb> show origin/main:CONTRIBUTING.md | sha256sum` gives
the digest; put it in `profiles/banyandb.json` and in
`examples/plugins/banyandb-fix/src/constants.ts`, copy the file to
`examples/skywalking-banyandb/CONTRIBUTING.md`, rebuild, and regenerate both
manifests (`npm run manifest` in each plugin). The pin was refreshed in 0.10.0.

## The canopy profile

[`profiles/canopy.json`](profiles/canopy.json) (since 0.9.0) checks changes
under `canopy/` in apache/skywalking-banyandb, an npm workspace (`web`,
`server`, `shared`) tested with Vitest. Select it with
`config: plugins/issue-fix/profiles/canopy.json` and a request such as
`Fix apache/skywalking#14001.`; [`../../issue-fix-canopy-task.yaml`](../../issue-fix-canopy-task.yaml)
is a ready task. The banyandb profile cannot check such a change: its
`make test-ci` command fails when the change touches no Go package.

- **Environment.** `node` must equal `canopy/package.json`'s `engines.node` (an
  exact pin, as the repository's `make check-node-version` requires), plus
  `git`, `license-tools` (`make`, and `go` or `bin/license-eye`, for
  `make license-dep`), `ocr`, `codex` and `claude`. Prepare runs
  `npm ci --include=dev` in `canopy/` (dev dependencies matter: an agent shell
  often has `NODE_ENV=production`), cached on the lock file and the
  workspaces' `package.json` files, with the `node_modules` directories as its
  outputs.
- **Cheap tier**, run beside GREEN: `test-changed` runs `npm run -w <ws> test`
  for each workspace the change touches (`shared/` and canopy's root files run
  both; a change touching no workspace fails), then `npm run typecheck` and
  `npm run lint`, each in `canopy/`.
- **Full tier**, only once the cheap tier and GREEN passed: `npm run build`,
  `npm test` for all workspaces, and `make license-dep` with
  `make check-license-outputs` from the repository root. `license-dep`
  reinstalls the canopy dependencies it prunes, and runs last. The Playwright
  tests (`canopy/e2e`, `npm run e2e`) are not run; the planner marks a change
  that needs them `needsE2E`.
- **Self check.** The implementer runs `npm run -w <ws> typecheck` and `lint`
  for the workspaces it changed (all three when `shared/` changed).
- **Regression test.** A Vitest test, named by its path from the repository
  root (`canopy/server/test/config.test.ts`,
  `canopy/web/src/components/Pager.test.tsx`) and its full name. The `vitest`
  runner runs it from the nearest `package.json` (the workspace) with the
  hoisted `canopy/node_modules/.bin/vitest`, so nothing in the profile selects
  a directory. Two changes to the runner came with the profile and apply to
  every `vitest` profile. It forces `NODE_ENV=test`: under `production`, React
  loads its production build and every component test fails in setup (the
  profile's test commands set it too). And its reporter and name pattern work
  with vitest 5, which canopy uses: vitest 5 no longer calls `onFinished`, and
  joins a test's titles with ` > ` where vitest 3 uses a space.
- **Budgets** are banyandb's scaled down for a single-workspace UI change
  (3,000 agent invocations, 150 jobs, 250 decisions, 50 corrections, 10 hours of
  active time). They are unmeasured: no live run has used this profile yet.
  Measure one with `graphloom stats` and revise them ([budgets](../../../docs/budgets.md)).
- Not run: `license-check` (the license-header scan, slow on the whole
  repository). A new source file still needs the Apache header.

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
