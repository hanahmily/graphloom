# PR-review graph (`pr-review`) and the review kit

Status: implemented, `pr-review` 1.1.0 (`examples/plugins/pr-review`). A pull
request is reviewed by two graphs, each its own plugin and its own run:

- **`pr-design-review`**, round 1, the design review: is the change necessary,
  what is each high-level change for, does the codebase already have it. It has
  [its own document](design-pr-design-review.md).
- **`pr-review`** 1.x, round 2, the detail review: three aspect reviewers
  (correctness, maintainability, security) with verified findings. This document.

The machinery both graphs run (Fetch, the change report, the measurements, the
groundwork, the ledger, the post of one review) is the **review kit**
([§14](#14-the-review-kit)), and this document describes it once, in
[§3](#3-inputs) to [§6](#6-the-change-report), [§8.5](#85-publish),
[§9](#9-incremental-re-review) and [§12](#12-safety). Until pr-review 0.27 one
`pr-review` run did both rounds; [§18](#18-version-history) says how that changed.

## 1. Purpose and fixed decisions

The review graphs help the maintainer of a repository understand an
**incoming** pull request, for example a contributor's pull request to
apache/skywalking-banyandb, and decide what to do with it. The maintainer always
decides. Neither graph merges or pushes, and neither ever approves.

The product has three layers:

1. **The change report** is primary. The *reporter* writes a neutral, cited
   account of exactly what the pull request changes. It carries no findings,
   severities or verdict, and its result contract has no field for them. Its
   **Measurements** section gives, for every function the pull request adds or
   modifies, the cyclomatic complexity and nesting depth and, in `pr-review`,
   coverage and CRAP, as defined in
   [code quality metrics](design-code-quality-metrics.md). Both graphs write it
   ([§6](#6-the-change-report)).
2. **Questions and answers**, `pr-design-review` only: N1 (is the change
   necessary), the purpose of each high-level change, whether the codebase already
   has it, and design-level questions the questioner adds, each answered from the
   whole codebase by a separate agent and checked by another
   ([design review §5](design-pr-design-review.md#5-questions-and-answers)).
3. **The review layer**, `pr-review` only: three reviewers, each reviewing the
   pull request (in large mode, the areas the report cites) for one aspect. The
   graph's deterministic **leads** (untested features, missing tests, splits,
   CRAP, reuse) point the maintainability reviewer at what the measurements and
   the test map show. A reviewer who claims a bug writes a test that shows it, and
   the graph runs that test against the head in the Docker sandbox. The layer
   produces verified findings, inline comments and a verdict ([§8](#8-the-review-layer)).

| Decision | Consequence |
|---|---|
| Two independent graphs | `pr-design-review`: Fetch → Report → Questions → Answers → Round 1 → Publish. `pr-review`: Fetch → Report → Review → Draft → Publish. No run starts another, and the controller learns nothing of rounds ([§2](#2-the-run-two-graphs-and-no-human)) |
| Understanding comes before judgement | The reviewers are seeded with a report: the design review's, when the ledger holds a usable one, else a report-only prelude of this run; only `--no-report` seeds them with the pull request alone ([§7.1](#71-the-context-source)) |
| `pr-review` runs alone | It does not gate on round 1. It lists and counts round 1's open items when a design review ran, and says round 1 was not run when none did ([§8.4](#84-draft)) |
| The detail questions are leads | Computed by plugin code, given to the maintainability reviewer, each with a status from it; a raised lead is an ordinary finding, verified, and drafted at a priority its kind fixes or caps: P0 for `weak-test`, `split-function`, `crap` and `reuse` ([§7.3](#73-leads)) |
| The report and the answers are grounded | Deterministic detectors, symbol extraction, whole-repository search, the dependency inventory and test mapping feed them; every item cites the diff or the base tree; independent checkers verify every claim ([§6](#6-the-change-report)) |
| Judgement words are allowed | No word list is enforced. The report and the Q&A stay structurally neutral, and the checkers judge claims for support ([§6.5](#65-deterministic-validation)) |
| Exactly one write per run: a `COMMENT` review | Posted through `graphloom.github/create-pull-review` with the credential the runner binds, which the plugin never sees; never `APPROVE` or `REQUEST_CHANGES`; found by its marker before any post, so a retry never posts twice ([§8.5](#85-publish), [§12.5](#125-never-auto-approve)). A clean design review posts nothing |
| Three aspect reviewers, each on its own rules | A pass whose rule groups are not all `custom` fails, so no aspect is reviewed with a generic rule; each finding is verified in a fresh session on a different harness ([§8.1](#81-review), [§13.1](#131-roles)) |
| Reviewers prove bugs with tests | A behavioral finding is `proven` only when its test, rerun by the graph in the Docker sandbox, fails on the head and the verifier judges that it shows the bug; an unproven one is never P0 or P1, even when raised from a lead ([§8.2](#82-reproducing-tests)) |
| One ledger per pull request, a section per graph | A Git ref in the operator's review clone; each graph advances only its own section by compare-and-swap ([§9.1](#91-where-the-ledger-lives)) |
| One run reviews one head | A later head continues from the ledger: ids continue, each earlier open item is re-checked, and the posted review says what became of it ([§9](#9-incremental-re-review)) |

## 2. The run: two graphs and no human

Each run reviews one head and ends by itself; nothing waits for a person. The
usual sequence for a head is

```sh
graphloom task new pr-design-review apache/skywalking-banyandb#1234 --repo ../skywalking-banyandb --profile banyandb
graphloom run reviews/skywalking-banyandb-1234-design/task.yaml --on-stop '…'
# "design review clean at 9ab2c41; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#1234 --profile banyandb"
graphloom task new pr-review apache/skywalking-banyandb#1234 --repo ../skywalking-banyandb --profile banyandb
graphloom check reviews/skywalking-banyandb-1234/task.yaml
graphloom run reviews/skywalking-banyandb-1234/task.yaml --on-stop '…'
# ends complete: "changes requested: 2 open on apache/skywalking-banyandb#1234 at 9ab2c41; the review is posted (<url>)"
# <worktree>/.graphloom/review/review.html is the visual report; graphloom inspect prints the path
```

but the `pr-review` pair can run first, alone, or on a head the design review
never saw. A `pr-review` run:

1. **Fetch** reads the pull request, materializes the head, reads the ledger's
   `review` and `design` sections and, when the design section holds a report,
   the delta from its head, and probes the sandbox images.
2. **Report** decides the reviewers' context source ([§7.1](#71-the-context-source)),
   writes the report-only prelude when the source is `prelude`, and always
   measures (static, then coverage in the Docker sandbox).
3. **Review** computes the leads ([§7.3](#73-leads)) and runs the three aspect
   reviewers with their verifiers and reproducing tests ([§8](#8-the-review-layer)).
4. **Draft** composes the draft and advances the ledger's `review` section.
5. **Publish** posts one `COMMENT` review whose first line is the verdict, and
   the run ends `complete` with the verdict and the review's link.

**Chaining is outside the graphs.** A clean `pr-design-review` run names the
`pr-review` command in its result
([design review §9](design-pr-design-review.md#9-publish-and-the-runs-result));
the `graphloom-run` skill relays it and starts the task only when the user asks.
`pr-review` reads what the design review left in the ledger and nothing else.

`graphloom session open` is not part of the flow
([§17](#17-discussing-a-run-graphloom-session-open)). Starting and watching a
run use the `graphloom-run` and `graphloom-watch` skills; the task is prepared by
the generic `graphloom task new`
([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)).

## 3. Inputs

### 3.1 Task

`graphloom task new pr-review <owner/repo#N or URL> --profile <name or path> [--base <branch>] [--no-report] [--repo <clone>]`
writes `reviews/<repo>-<N>/task.yaml`
([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)):

```yaml
graph: pr-review
repo: repo                            # a link beside the task to the operator's review clone (--repo)
config: profile.json                  # a link beside the task to the profile found in the bundle (intake refuses `..`)
base: 3f1c…e9                         # the merge base, pinned instead of HEAD (§15)
request: "Review on apache/skywalking-banyandb#1234 at 9ab2…41."
```

- `request` names one pull request (`owner/repo#N` or its URL) of the profile's
  `project` and its head `at <40-hex>`, optionally followed by `, without a
  report` (`--no-report`, [§7.1](#71-the-context-source)). A `Report on …` request
  (the two-round form of 0.x) and `, asking every question` are refused as an
  incompatible task, naming `pr-design-review`. The design review's request is
  `Design review on … at <sha>[, asking every question].`
  ([design review §3.1](design-pr-design-review.md#31-task)).
- `--all-questions` is refused, naming `pr-design-review`; `--review` is accepted
  and ignored, so earlier invocations still work.
- `base` is the merge base of the head and the base branch. Intake pins it
  instead of `HEAD`, so the candidate digest, `git diff HEAD`, open-code-review's
  workspace mode and `{ from: "candidate" }` checkouts all mean "this pull request
  at this head".

**Preparing the task.** Both plugins implement the optional `prepareTask` hook
with the kit's plan (`kit/taskplan.ts`). It is pure over its input and only
returns a plan; the generic CLI validates and executes it, and knows nothing of
pull requests.

- **Arguments:** one pull request; optional `--base <branch>` (default the
  profile's `baseBranch`, itself default `main`); the graph's own flags above.
  Anything else, a missing profile, or an `owner/repo` other than the profile's
  `project` is a `{ refused }` reply naming the problem.
- **Remote:** the repository's remote whose fetch URL is
  `https://github.com/<owner>/<repo>(.git)`, else that URL itself.
- **Two phases for the head.** The head's sha is unknown until it is fetched,
  so the plan fetches into a moving ref, resolves it, and only then pins
  `heads/<sha>`. With `R = refs/graphloom/<graph>/<owner>/<repo>/<N>` (each graph
  its own namespace, as `validateTaskPlan` requires), the plan for
  `apache/skywalking-banyandb#1234` is:

  | # | Step |
  |---|---|
  | 1 | `fetch { remote: "https://github.com/apache/skywalking-banyandb.git", refspec: "refs/pull/1234/head", intoRef: "R/head" }` |
  | 2 | `fetch { remote: (same), refspec: "refs/heads/main", intoRef: "R/base" }` |
  | 3 | `resolve { name: "headSha", revParse: "R/head" }` |
  | 4 | `updateRef { from: "${headSha}", to: "R/heads/${headSha}" }` |
  | 5 | `resolve { name: "mergeBase", mergeBase: ["R/head", "R/base"] }` |
  | 6 | `writeTask { path: "reviews/skywalking-banyandb-1234/task.yaml", fields: { base: "${mergeBase}", request: "Review on apache/skywalking-banyandb#1234 at ${headSha}." } }` |

  The design review's task path is `reviews/<repo>-<N>-design/task.yaml`, because
  a task directory holds one `task.yaml` and one `profile.json` link.
- `R/head` and `R/base` move with every `task new`; `R/heads/<sha>` is created
  once per head and never moved, so earlier heads stay alive for the deltas of
  later runs ([§9.2](#92-mapping-a-new-head-to-the-last-reviewed-one)); the design
  review's pinned heads are what keep its report's head readable for `pr-review`.
  The ledger is `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger` for both
  graphs ([§9.1](#91-where-the-ledger-lives)), written by command jobs, which the
  task-plan namespace rule does not bind.
- Only `git fetch`, `git rev-parse`, `git merge-base`, `git update-ref` and
  the task write run, with hooks and the user's Git config disabled; no
  repository code runs, and nothing is checked out.
- Fetch checks the task against GitHub: the pull request's head sha must equal
  the request's, and `base` must be an ancestor of the head and of the base
  commit the metadata names. A mismatch stops the run with reason "incompatible
  task", naming the command to rerun.

### 3.2 Profile

The profile is a JSON file named by `config:` and pinned as issue-fix pins its
own ([config pinning](design-issue-fix-graph.md#how-the-config-is-pinned-and-passed)).
Each manifest declares `taskConfig: "required"`. The kit's `parseProfile(config,
graph)` parses it for one graph; each bundle ships `profiles/banyandb.json` with
its own keys only.

| Field | Meaning |
|---|---|
| `name`, `description`, `project` | Names for messages (the design review's result names `--profile <name>`), and the repository whose pull requests are read |
| `baseBranch` | The branch pull requests usually target (default `main`), fetched by `task new` unless `--base` names another ([§3.1](#31-task)) |
| `environment` | Only `checks` (`git`, the bundled `ocr`, the harness CLIs). **`prepare` and `pinnedFiles` are refused**: preparation would run contributor code in the unconfined worktree. Code generation a coverage run needs is `metrics.sandbox.<language>.setup`, which runs inside the Docker sandbox ([§12.2](#122-confinement)) |
| `report` | The section template, each section's meaning in this repository, and its detectors ([§6.2](#62-profile-mapping), [§6.3](#63-detectors)) |
| `symbols` | Language packs: file globs, definition patterns, test-file and test-name patterns ([§7.2](#72-deterministic-groundwork)). Go and TypeScript packs ship as data; a profile may add or override them |
| `questions` | `excludeRoots` (generated code only); `similarity` (default 0.5) and `maxCandidates` per query (5) for the searches behind `reuse` leads ([§7.2](#72-deterministic-groundwork)); `designDocs`, the design documents N1 reads first; `principles`, `{ path, ref? }`, the project's design principles file ([design review §5.6.1](design-pr-design-review.md#561-project-design-principles)), which `pr-review`'s reviewers also get; `incremental` (default `true`), whether the design review may carry N1 |
| `metrics` | Per language: `files`, and `generated` globs. `coverage` (run the pull request's tests for coverage in the Docker sandbox, **default true**); `mutation` (accepted; mutation is not measured yet); and `sandbox`, the Docker sandbox per language: the image by digest, `cpus`, `memory`, `pids`, `tmp`, `wallClockMs`, `readOnly` mounts and, for Go, `setup` (sandboxed code generation run in the checkout before the tests), `buildTags` and `ginkgoLabelFilter` ([§12.2](#122-confinement)) |
| `context` | issue-fix's [context documents](design-issue-fix-graph.md#context-documents) |
| `issues` | Where linked issues live. `Fixes`/`Closes` references are read with `get-issue` |
| `review` | `aspects.<aspect>.rules`, `[{ path, rule }]` entries that replace the shipped rule of the same `path` or add one ([§8.1](#81-review)); `repro`: `enabled` (**default true**), `perFindingMs` (3 min), `timeBudgetMs` (30 min per head), `maxTestBytes` (16 KiB) ([§8.2](#82-reproducing-tests)); `fork.maxParentTokens`, accepted and vestigial since reviewers start seeded |
| `comments` | `footer`, appended to every posted review; `designPassedNote` (default `false`), the design review's note on a clean round 1 |
| `privateRepos` | Never named in posted text |
| `harnesses` | Each role takes a harness id or `{ harness, model?, effort? }` ([§13.1](#131-roles), [design review §10](design-pr-design-review.md#10-roles-budgets-and-sessions)) |
| `supervisor`, `budgets`, `agent.timeoutMs` | As in issue-fix ([§13](#13-agent-roles-supervisor-budgets)) |
| `limits` | `maxFiles` (150), `maxPatchBytes` (1 MiB), `maxNewSymbols` (200): past `maxFiles` or `maxPatchBytes` the pull request is reviewed in large mode ([§6.9](#69-large-pull-requests)), past `maxNewSymbols` `pr-review` computes no `reuse` leads. `hardMaxFiles` (1000), `hardMaxPatchBytes` (8 MiB), `hardMaxNewSymbols` (2000): past one, the run stops "incompatible task". `areaMaxBytes` (256 KiB) and `areaMinBytes` (16 KiB) shape the areas |

#### 3.2.1 Refused keys

- `rounds` is refused by both graphs: a run of `pr-design-review` is round 1 and
  a run of `pr-review` is round 2 (the message says `review-only` meant: run
  `pr-review`).
- `comments.questions` is refused by both: there is no Q&A item in `pr-review`'s
  draft, and the design review always posts its open items.
- In `pr-review`, `checks` (the Checks stage) and `rules` (the deterministic rule
  checks) are refused as a later version's fields, and so are
  `comments.minSeverity`, `nits`, `maxComments` and `suggestions`.
- `harnesses.answerer` and `harnesses.batch-answerer` may not be `pi`.
- Any other unknown key is refused, naming the fields.

#### 3.2.2 Keys per graph

One operator profile may hold the union of both graphs' keys: each graph's parser
accepts the keys only the other graph reads, without reading or checking them, and
refuses any key neither reads.

| Key | `pr-design-review` | `pr-review` 1.x |
|---|---|---|
| `name`, `description`, `project`, `baseBranch`, `environment`, `report`, `symbols`, `context`, `issues`, `privateRepos`, `supervisor`, `budgets`, `agent`, `limits` | reads | reads |
| `questions.excludeRoots`, `questions.principles` | reads | reads |
| `questions.designDocs`, `questions.incremental` | reads | accepts unread |
| `questions.similarity`, `questions.maxCandidates` | accepts unread | reads (`reuse` leads) |
| `metrics.generated`, the languages' `files` | reads | reads |
| `metrics.coverage`, `metrics.mutation`, `metrics.sandbox` | accepts unread | reads |
| `review` | accepts unread | reads |
| `rules`, `checks` | accepts unread | refused (a later version's) |
| `comments.footer` | reads | reads |
| `comments.designPassedNote` | reads | accepts unread |
| `comments.minSeverity`, `nits`, `maxComments`, `suggestions` | accepts unread | refused (a later version's) |
| `harnesses.reporter`, `diagrammer`, `report-checker` | reads | reads (the prelude only) |
| `harnesses.questioner`, `answerer`, `batch-answerer`, `answer-checker` | reads | accepts unread |
| `harnesses.reviewer-<aspect>`, `verifier-<aspect>` | accepts unread | reads |
| `limits.maxNewSymbols` | accepts unread | reads |
| `rounds`, `comments.questions` | refused | refused |

The validators of each graph see its pinned config only.

### 3.3 Credentials

- **Read:** the existing `github.tokenEnv` (`apps/graphloom/src/runner-config.ts:49`).
- **Write:** `github.writeTokenEnv` in the runner config
  (`apps/graphloom/src/runner-config.ts`). When the variable it names is set,
  the CLI runner binds that token as the one `github` credential and allows
  the write executors (`allowedEffects: ["read", "write"]`); without it the
  binding stays read-only and the Publish stage stops with `posting not enabled`
  ([§8.5](#85-publish)). The plugin names the executor
  (`graphloom.github/create-pull-review`) and never sees the token: it travels
  over stdin to the executor process, never argv or the environment, and is
  redacted from job results. A fine-grained token with "Pull requests: read and
  write" on the one repository suffices. Without contents permission it cannot
  push or merge. `graphloom doctor` warns when the named variable is unset.
- Agent, search and check jobs never receive either token
  ([executors](design-executors.md#built-in-executor-packages)).

## 4. Workspace

| Thing | Where | Why |
|---|---|---|
| Pull request head tree | The run worktree, materialized by Fetch over the pinned merge base | The existing checkout, digest and quote machinery applies |
| Base tree | The pinned base commit, read with `git show <base>:<path>` and `git grep <base>`, and exported read-only into `.graphloom/review/base/` ([design review §5.4](design-pr-design-review.md#54-answers)) | Searches see the repository as it is without the pull request |
| `review.md`, `report.json`, `context.json`, the draft | `.graphloom/review/`, ignored by its own `.gitignore` (`*`) | Kept out of the digest and every checkout, as issue-fix's [issues file](design-issue-fix-graph.md#where-it-lives-and-how-it-stays-out-of-the-change) is |
| Per-PR ledger | Ref `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`, a section per graph | Durable, versioned, CAS-updated ([§9.1](#91-where-the-ledger-lives)) |
| Earlier heads | `refs/graphloom/<graph>/<owner>/<repo>/<N>/heads/<sha>` | Needed for the deltas ([§9.2](#92-mapping-a-new-head-to-the-last-reviewed-one)) |
| Sandbox images | The local Docker image store, by digest | `pr-review` only: checked, and pulled if missing, in Fetch, never during a sandboxed job ([§12.2](#122-confinement)) |
| Aspect rule files | Shipped as plugin data. The effective file, with the profile's entries applied, is written to `.graphloom/review/rules/<aspect>.json` | The rules each pass used are evidence ([§8.1](#81-review)) |
| Reproducing tests | Their text is evidence. They are written only inside the sandbox job's own `/tmp`, never into the worktree, a checkout or the review clone | They are never committed or pushed ([§8.2](#82-reproducing-tests)) |

**Materialization** is one writer command job with a fixed argv,
`git -c core.hooksPath=/dev/null checkout --no-overlay <head> -- .`, run with
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so no user filter,
hook or textconv runs. A pull request touching `.graphloom/` is refused. Agents
run with the home directory hidden ([§12.2](#122-confinement)).

## 5. Stages and requirements

The stages of `pr-review` 1.0 are fixed per plugin version, whatever the profile
or the request says. The design review's are in
[its §4](design-pr-design-review.md#4-stages-and-requirements); its Fetch, Report
and Publish requirements are the kit's, as below, except where that table says.

| Stage | Requirement | Statement (abridged; full text names the profile's values) | Validator |
|---|---|---|---|
| Fetch | `pr-snapshot` | The pull request's metadata, every changed file with its patch, every commit, review, review comment and thread (with resolution), and the head's check runs were read completely for the one head the request names; within the hard limits; large mode and its areas recorded | `pr-snapshot` |
| Fetch | `head-checked-out` | The worktree holds exactly the head's tree on the pinned merge base, and no repository code ran to produce it | `head-tree` |
| Fetch | `prior-ledger` | The ledger was read, or recorded absent (a v1 ledger migrated in memory); its `review` and `design` sections read or recorded absent; when the design section holds a head D, D's `report.json`, `qa.json` and `necessity.json`, and, when D is not this head, the delta from D and whether D's base is in the review clone, or the reason they are not usable; the sandbox images checked by digest | `review-scope` |
| Report | `review-context` | The context source decided by plugin code and recorded in `context.json` ([§7.1](#71-the-context-source)) | `review-context` (recomputes it from the ledger reads, the delta and the pinned request) |
| Report | `change-report` | When the source is `prelude`: every template section present, every citation inside the diff, every changed file and detector fact cited, no severity, finding or verdict; `report.json`, `review.md`, `review.html` and `review-appendix.html` hold that report, the briefing saying there is no design review in this run. When the source is `design-review` or `none`: no report of this run's; `review.md` is the reviewers' seed, rendered by plugin code ([§7.1](#71-the-context-source)) | `change-report` |
| Report | `measurements` | Whatever the source: complexity and nesting at the head and, for a modified function, the base, by the pinned static tools; coverage in the Docker sandbox, or its not-run reason, and CRAP recomputed or shown as its upper bound. Mutation arrives with a later version | `measurements` |
| Report | `claims-checked` | When the source is `prelude`: an independent report checker, on another harness, in a read-only review job, judged every item and briefing claim; otherwise passes on the recorded source | `claims-checked` (not bound as a separate reviewer: the validator itself requires a prelude's checks to be read-only review jobs) |
| Review | `code-review` | For each aspect, a read-only reviewer swept the scope with the aspect's rule file, and every finding has a verdict from the aspect's verifier on another harness; the scope recorded once, naming the context source, which equals `context.json`'s; every reviewer starts a fresh session seeded with `review.md` only | `code-review` (`independence: separate-reviewer`) |
| Review | `leads-judged` | The leads computed before the first pass; at most 60 given to the maintainability reviewer; each given one exactly one status ([§7.3](#73-leads)) | `leads-judged` |
| Review | `findings-proven` | Every `proven` behavioral finding recomputes from the graph's own test run and the verifier's judgment; a finding raised from an `untested-feature`, `weak-test`, `split-function`, `crap` or `reuse` lead is proven by its lead, which recomputes and is recorded as raised by it ([§8.2](#82-reproducing-tests), [§7.3](#73-leads)) | `findings-proven` |
| Draft | `draft-composed` | The draft composed by plugin code; no Q&A item; round 1's open items listed, or round 1 said to be clean or not run ([§8.4](#84-draft)) | `draft-composed` |
| Draft | `ledger-recorded` | The ledger's `review` section advanced by compare-and-swap from the value Fetch read, with this head, its context source, the round-1 head and open count it counts, and its lead counts; the design section carried unchanged ([§9.4](#94-section-writes-markers-and-migration)) | `ledger-cas` |
| Publish | `review-published` | One `COMMENT` review at the head with the idempotency key `review-<head12>` and the `graphloom-review` head marker, or one already there found before any post; the verdict as the first line; the comments read back and recorded in the `review` section ([§8.5](#85-publish)) | `review-published` |

The validators get the task's pinned request (`ValidationInput.request`,
[§15](#15-generic-platform-changes)): `review-context` needs it to tell the
operator's `--no-report` from a report the graph failed to write.

Verification and the reproducing tests stay inside Review: issue-fix's sweep
interleaves passes and verdicts, and a separate stage would split that loop.
`findings-proven` and `leads-judged` are requirements of their own, so their
recomputation has its own validator and receipt.

### 5.1 Convergence after a reentry

A supervisor reenters a stage when it has repaired what blocked it. The graph must
then run that stage's own jobs again, not read the failure back from the evidence of the
attempt that failed (the [convergence design](design-run-convergence.md) §4.1 gives
issue-fix the same rule). Every call of the graph reasons from the same view of the
evidence, made before any flow reads it:

- **The live candidate.** A record made against a workspace other than the live one is
  not seen, as a validator does not see it (`candidateEvidence`). A flow therefore never
  finds a requirement done on evidence its validator would not accept. Environment
  checks describe the machine and stay. A repair that writes into the worktree changes
  the candidate, so after it every receipt is stale and the stages are earned again from
  Fetch, with the checkout first.
- **The stage's attempt.** The graph keeps, in its private state, each stage's attempt
  number and the generation at which the graph first saw it. An agent result a stage's
  job recorded in an earlier generation than the stage's current attempt began is not
  seen. A reentered stage therefore dispatches its agents again, and the corrections it
  has spent count from none, so each attempt has its own two corrections before the
  supervisor is asked again. A resume keeps the attempt and its start.
- **Commands stand** while the candidate does: a search, a read or a write is the same
  function of the candidate however often it runs, and is looked up by its exact
  arguments. A reentry that left the candidate unchanged reuses them and the agent
  results of every stage it did not reenter.
- **The claim checks are recorded** (`kit/claimrecord.ts`, `report/claim-checks`,
  `claim-checks-v1`). A validator sees only a candidate's latest review evidence, so a
  later read-only review job (the answer checker, a verifier) hides the report's claim
  checks. Each graph records them once the report is checked, and the report flow puts
  a superseded check back from that record, only when it is missing and belongs to the
  same candidate. Without it, a reentry to Fetch with the candidate unchanged would wait
  at the report checker forever.
- **A flow that reads a job's runs by position reads the latest attempt's.** The
  validators have no private state, so they still see an earlier attempt's agent
  results. A flow that replays its runs, where the latest result clears an earlier
  one, ends where the graph's does. A flow that takes a job's runs by their place
  (the diagram job's drawing and its one correction, [§6.10](#610-features-and-their-data-flow))
  takes only the runs of the latest attempt of the job's stage, by the attempt the
  controller records on each job's evidence (`producer.attempt`, `latestAttemptRuns`
  in `kit/attempt.ts`): the graph and a validator then pick the same runs, whatever
  else either one sees. Runs an older controller recorded without an attempt count
  as one attempt of their own. Before `pr-review` 1.1.7 and `pr-design-review`
  0.1.7 the diagram flow took the stage's first two runs, which a validator found in
  the first attempt while the graph, which no longer saw them, drew again; the
  written `report.json` then never recomputed, and the Report stage could not be
  accepted after a reentry or a resume that sent the run back to it
  (apache/skywalking-banyandb#1487). A replay's own state is that of the latest
  result too: an answer that is not a revision clears what an earlier attempt's
  revision left, so a validator does not take that revision for the new answer's.

The validators are unchanged. They see the candidate's evidence and replay a stage's
flow over it, where a later passing result clears an earlier failure, so a fresh
compliant result passes them although the failed attempt's results are still recorded.
Nothing is deleted: the record keeps every result, and the supervisor reads all of it.

## 6. The change report

The change report is the kit's, and both graphs write it the same way. The design
review writes it whole, with N1 and the Q&A in the appendix and the briefing's
verdict and open questions filled in once the answers are checked. `pr-review`
writes it only for the `prelude` context source ([§7.1](#71-the-context-source)):
no Necessity, no Q&A and no open questions, the briefing's verdict line saying
there is no design review in this run, and a Review section and the leads once the
draft is composed. Its Measurements add coverage and CRAP; the design review's are
static only ([design review §6](design-pr-design-review.md#6-measurements-in-round-1)).
The examples below are the design review's.

### 6.1 Template

The default template is the maintainer's list, in this order, plus two
minimal extras:

| Section id | Title |
|---|---|
| `schema` | Database / storage schema changes (tables, columns, indexes, migrations) |
| `background` | Scheduled jobs, cron, background workers |
| `features` | Every feature added or modified |
| `external` | New external services, APIs, or third-party libraries |
| `config` | New environment variables or config flags |
| `interfaces` | New public endpoints or interfaces |
| `removed` | Anything deleted or deprecated |
| `other` | Other changes (**extra**) |
| `claims` | What the PR says vs what it changes (**extra**) |
| `measurements` | Measurements (**extra**, the operator's code-quality rules, [§6.8](#68-measurements)) |

- **`other`** makes the coverage check possible. Tests, docs, build files and
  refactors that fit no section are still accounted for.
- **`claims`** lists only factual mismatches between the PR's own text and
  the diff, for example "the body says `X` is removed; `x.go:40` still
  defines it". Each entry quotes and cites, and judges neither side.
- Every section appears. An empty one says **None**, explicitly.
- A **Notes** line records, as a fact, text in the PR addressed to automated
  tools ([§12.1](#121-pull-request-content-is-data)).

Each item gets a stable id (`R<n>`). The Q&A refers to items by it.

**The report opens with a briefing, and is analysis, not narration.** A
maintainer must grasp the change, and know what to check in it, in about two
minutes. The first fields of the reporter's result are therefore a briefing, and
the HTML report ([§6.11](#611-the-html-report)) shows only that on its one page;
everything below it is the appendix.

- **`whatsNew`:** 3 to 5 entries, one for each new capability (not for each file
  or refactor): the **high-level changes**, `W1`…, in this order in both modes. An
  entry has its bullet `text` (at most 240 characters, with 1 to 4 cites) and the
  fields of its card on `review.html` ([§6.11](#611-the-html-report)): a `title`
  (at most 80 characters, in the shape "area, what was done, how the mechanism
  changed", for example "stream writes: report the first error when a batch stores
  nothing"), an `overview` (one sentence of at most 240 characters: what the
  situation was before and how it works now, or for a purely new capability what it
  adds and where it hooks in), `coreFiles` (1 to 4 files that carry the change's
  logic) and `feature` (the id `F1`… of the feature whose data-flow diagram belongs
  to this change, or an empty string).
- **`features`:** at most 3, each the path the data takes through a new feature,
  end to end, drawn as a data-flow diagram ([§6.10](#610-features-and-their-data-flow)).
- **`check`:** five lists of at most 8 one-line entries, each with cites and each
  a claim the checker verifies: `surfaces` (new public APIs, RPCs, proto
  messages, CLI commands and flags, config), `behavior` (changes to the behavior
  of existing code paths, not new code), `compatibility` (wire format,
  on-disk or schema format, mixed versions), `risks` (concurrency, retries, rate
  limiting, unbounded memory or resources, error handling that drops data) and
  `tests` (the tests and end-to-end tests added, and what they cover).
- **`areas`:** a short label for each area id of a large report
  ([§6.9](#69-large-pull-requests)); empty otherwise.

The scope split, the hotspots and the open questions of the briefing are not the
reporter's: plugin code computes them from the file list, the measurement records
and the answers ([§6.11](#611-the-html-report)). So are each change's **synced-along
files** (the files its cites and its report items touch beyond its core files) and
the **code excerpts** under its card, cut from the patches the plugin already holds
([§6.11](#611-the-html-report)); both are written to `report.json` as `cards`.

After the briefing, the report is analysis, not narration. It has three layers,
and the sections above hold only the second:

1. **Summary**, first in the report. The **purpose** is `{ text, source,
   quote }`: `source` is `stated` when the pull request's own title, body or
   a commit message says why, with `quote` an excerpt that matches that text
   (whitespace collapsed, at least 12 characters, as the Q&A's stated
   purposes do), and `inferred` otherwise, with an empty quote, marked as
   inferred wherever it is shown. The **overview** is two to four sentences
   on the mechanism of the whole change.
2. **Conceptual change items.** An item is one behavioral change, however
   many places in however many files implement it: its `cites` list every
   diff location involved. One mechanism is never split across items. A new
   variable, the three places that set it, the place that increments it and
   the branch that reads it are one item. The reporter analyses the change
   and does not describe hunks one by one.
3. **Lifecycle and behavior inside the item.** For every new or changed piece
   of state (a field, counter, flag, cached value or accumulator) the item
   has a `state` entry, and where behavior changes it has `behavior` rows
   ([§6.4](#64-writing-and-checking)).

Example of the difference. For a pull request that makes a write callback
reply with an error when a batch stores nothing, narrating the diff gives
four items: "declares `stored` and `firstErr`", "records `firstErr` on three
failure paths", "increments `stored`" and "returns an error when
`stored == 0`". The analysis is one item with the lifecycle of `stored` and of
`firstErr` and a before/after table ([§6.6](#66-output)).

### 6.2 Profile mapping

`report.sections` may retitle a section, give its repository meaning (text
handed to the agents), route files by glob and attach detectors. It may add
sections but not remove `other` or `claims`. Meaning is data; the plugin has
no repository branches. The BanyanDB mapping below gives example routing,
with globs to be confirmed when the profile is written:

| Section | BanyanDB meaning (profile text) | Example routing |
|---|---|---|
| `schema` | Proto and API definitions, the schema catalog, storage and on-disk format | `api/proto/**`, `banyand/metadata/schema/**`, storage and encoding packages |
| `background` | Schedulers, flushers, compaction and merge, retention | scheduler, flusher, merger and retention files |
| `config` | CLI flags (cobra/pflag), environment variables, config files | `Flags()` registrations, `os.Getenv` |
| `interfaces` | gRPC services and messages, the HTTP gateway, BydbQL syntax | `api/proto/**/rpc.proto`, the BydbQL grammar package |
| `external` | Go modules, the UI's npm packages, Docker images | `go.mod`, `ui/package.json`, Dockerfiles |

### 6.3 Detectors

Detectors are deterministic, profile-configured matchers over the pinned
patches. Each yields a **fact** `{ id, section, path, side, line, symbol?,
text }`:

| Kind | Finds | Generic default |
|---|---|---|
| `manifest` | Dependency added, removed or re-versioned | `go.mod`, `package.json` (all four maps), `pom.xml`, `requirements*.txt`, `Cargo.toml` |
| `paths` | A file added, changed or deleted under schema or migration globs | `**/migrations/**`, `*.sql`, `*.proto` |
| `added-line` | An added line matching a regex, with one capture group as the symbol | `os.Getenv("…")`, `process.env.X`, `flag.*("…")`, cron expressions, route registrations |
| `removed` | Deleted files and removed exported declarations | always on |
| `deprecated` | Added deprecation markers | `// Deprecated:`, `@deprecated`, `deprecated = true` |

Detectors aid recall and ground the report; they do not parse code. A
detector cannot miss without leaving a trace, and a false match costs one item
the checker rejects.

**State candidates** are the deterministic trigger for the lifecycle analysis
([§6.4](#64-writing-and-checking)). A scan of the added lines of non-test Go
and TypeScript sources yields a candidate for:

- an **accumulator**: a local declared in an added line (`x := …`,
  `var x …`, `let x …`) that a later added line of the same file changes
  (`x++`, `x += …`, `x = …`, `append(x, …)`, `x[k] = …`), leaving out `err`,
  `ok`, `ctx`, one-letter names and declarations in a `for`/`if`/`switch`
  header;
- a **field**: an added Go struct field or TypeScript class property.

Candidates are not facts: they route to no section and are not listed in an
item's `facts`. They are handed to the reporter, and validation requires a
`state` entry named for each in an item that cites the candidate's file. A
candidate that is not real state still gets its entry, saying so in `initial`.
A pull request in a language the scan does not know, or state it does not
see, relies on the reporter's prompt and on the checker.

### 6.4 Writing and checking

1. The **reporter** runs one read-only job (`change-report-v1`), confined
   `untrusted-read`. It gets the template and meanings, the facts, the state
   candidates ([§6.3](#63-detectors)), the file list with diffstat, and the PR
   text in untrusted blocks. It returns:

   ```text
   purpose:  { text, source: "stated" | "inferred", quote }   quote "" when inferred
   overview: text                                              2 to 4 sentences
   whatsNew: [{ text, cites: [cite],                           3 to 5 high-level changes (W1…)
                title, overview,                             card title; one sentence, before and now
                coreFiles: [path],                           1 to 4 files with the logic
                feature }]                                   "F1"… or ""
   features: [{ name, summary, stages: [...], flows: [...] }]  at most 3 (§6.10)
   check:    { surfaces, behavior, compatibility, risks, tests }   each [{ text, cites: [cite] }], at most 8
   areas:    [{ id, label }]                                   large mode only; [] otherwise
   sections: [{ id, none, items: [{
       text,                                    one conceptual change
       cites: [{ path, side, start, end, symbol }],            every location
       facts: [fact id],
       state: [{ name,
                 scope,            "per call" | "per request/batch" | "per instance" | "global" | other text
                 initial,
                 transitions: [{ when, effect, cite }],
                 reads:       [{ where, decision, cite }] }],
       behavior: [{ case, before, after }] }] }]
   notes:    [text]
   ```

   Every property is required (empty arrays where an item has no state or no
   behavior change), and the contract has no other. Its prompt leads with the
   briefing fields, says what each is for (the maintainer must grasp the change
   and what to check in two minutes) and gives each field's bounds (in large
   mode the features' and the check entries' cites may name lines the reporter
   read in the tree, which the claim check verifies there); then it says:
   analyse, do not narrate the diff; one item per conceptual change; do not
   split one mechanism across items; give every new or changed piece of state
   its lifecycle (each transition and each read the diff shows, in the order
   they happen, none left out and none invented); give a before/after row for
   each case whose behavior differs, and for a case that deliberately stays as
   it was when a reader would expect it to change; describe what the code does,
   in the present tense, with no evaluation.
2. **Deterministic validation** ([§6.5](#65-deterministic-validation)).
   Failures go back as a correction listing every problem: at most two
   corrections, then the supervisor.
3. The **report checker** runs on a harness different from the reporter's
   (`claim-check-v1`). It returns `supported` (with 1 to 3 quotes matched by
   issue-fix's `quoteMatches`), `partial` or `unsupported` per **claim**. It
   checks claims only, never judges. The claims are:

   | Claim id | What the checker judges | Quotes |
   |---|---|---|
   | `purpose` | when stated, that the text says what the quote says (the quote itself is matched against the PR text by code); when inferred, that the diff supports it | none when stated, else required |
   | `overview` | consistent with the diff and with the items: no mechanism no item has, none an item contradicts | required |
   | `R3` | the item's text against its cited diff | required, from the cited files |
   | `R3.s1` | the entry's name, scope and initial value | required, from the files its steps cite |
   | `R3.s1.t2` | the transition's condition (`when`) is the one the code has at the cited line, and its effect is what the line does | required, from the cited file |
   | `R3.s1.r1` | the code at the cited line decides what `decision` says, from this state | required, from the cited file |
   | `R3.b1` | `before` is what the base code does in that case, `after` what the head code does | required, any changed file |
   | `W1` | the cited code provides the capability the what's-new entry names, and its title and overview (the situation before, how it works now) are what the cited code and the diff show | required, from the cited files |
   | `F1` | the feature's summary is what the data path through its stages shows | required, from the stages' files |
   | `F1.s2` | the cited code is that stage of the data's path, of that kind | required, from the cited file |
   | `F1.f3` | the cited code moves the data from the one stage to the other, in that direction, as the label says | required, from the cited file |
   | `C.risks.1` | what the check entry says (a surface, a behavior change, a compatibility fact, a risk, a test) is what the cited code shows | required, from the cited file |

   The checker also says, in the note of an entry's verdict, when the diff
   shows a transition or a read the entry leaves out.
4. `partial` and `unsupported` claims go back to the reporter once. A claim
   still unsupported is handled by what it is, and recorded in `report.json`
   (`removed`, `removedParts`) and in `review.md` ("Removed by the claim
   check"):
   - an **item** is removed whole, and its parts with it;
   - a **lifecycle entry** is dropped whole, with the item kept: if its
     name, scope or initial value, or any one of its transitions or reads, is
     unsupported, half a lifecycle would mislead more than none;
   - a **behavior row** is dropped, with the item and its other rows kept;
   - the **purpose** or the **overview** is not shown; the briefing (the purpose)
     or the appendix (the overview) says the claim check could not support it,
     with the reason;
   - a **what's-new entry** (with its card) or a **check entry** is dropped; a
     feature dropped below leaves the `feature` of the entry that named it empty; a feature's
     **stage** is dropped with the flows that touch it, a **flow** alone, and a
     **feature** left with fewer than two stages or no flow, or whose own claim
     is unsupported, whole ([§6.10](#610-features-and-their-data-flow)).

   Plugin code then lists any file that became uncited in `other` as "changed
   (+a −d lines); not summarised", so coverage holds without trusting a model.
   Removing a lifecycle entry does not re-trigger the state check below: the
   removal is the recorded outcome.

### 6.5 Deterministic validation

- **Sections:** every template section is present, `none` or with items. A
  section that is `none` while a detector fact routes to it fails.
- **Summary:** the purpose and the overview are present and bounded (400 and
  900 characters). A `stated` purpose's quote matches the PR's title, body or
  a commit message, whitespace collapsed; an `inferred` one has no quote.
- **Briefing:** `whatsNew` has 1 to 5 entries (the prompt asks for 3 to 5) whose
  text is at most 240 characters, each with 1 to 4 cites. Each entry's `title` is
  1 to 80 characters on one line; its `overview` is one sentence of at most 240
  characters (no line break, and no second sentence: a sentence end followed by a
  capital letter is refused); `coreFiles` has 1 to 4 distinct paths, each a file of
  the pull request (a rename by either name) that one of the entry's own cites
  names, in large mode too (a cite may then lie outside the hunks, but its path
  must still be a core file); `feature` is empty or `F<n>` for a feature of the
  reporter's list, and no two entries name the same feature (an entry whose
  feature the claim check dropped is left empty, and the final check does not
  look the feature up); `features` at most 3, each with
  2 to 8 stages and 1 to 12 flows, unique stage ids, flows between two stages of
  their feature, and bounded labels ([§6.10](#610-features-and-their-data-flow));
  each `check` list at most 8 entries of at most 240 characters with 1 to 4 cites;
  `areas` only ids of the report's areas, each once (none in a standard report).
  Every briefing cite follows the rule below (inside the diff on the side it
  names), except that in large mode it may name a file the pull request does not
  change, by path and a range of lines. The claim check can only drop entries,
  so a report left with no bullet or a smaller feature is not a failure.
- **Citations:** paths are PR files, line ranges lie in the file's hunks on
  the given side, and symbols appear in the file's patch. A file with patch
  text is cited by lines: `0`/`0` and a symbol alone are refused, so that
  every citation renders as `path:line` or `path:start-end`. Only a file with
  no patch text (binary, pure rename) is cited as a whole, and renders as
  `path`. The rendering resolves what plugin-written items leave without lines
  (a fallback for an uncited file, a whole-file fact) from the patch: a file as
  a whole to its changed lines, never to a bare `path:`.
- **State:** every state candidate ([§6.3](#63-detectors)) has an entry named
  for it in an item that cites its file. Each entry has a name, a scope, an
  initial value and at least one transition or read; at most 6 entries per
  item and 8 transitions and 8 reads per entry; each text at most 240
  characters. Every transition and read cites lines inside a hunk of the
  diff, context lines included. The head file's unchanged lines outside the
  hunks are not citable, because the validators see the patches, not the
  files: a read site the diff does not show is described in the item's text.
- **Behavior:** at most 8 rows per item, each with a case, a before and an
  after.
- **Coverage:** every changed file (renames under both names, deletions
  included) is cited by at least one item.
- **Facts:** every detector fact is cited by an item of its section.
- **No severities, findings or verdict:** this is structural. The result
  contracts (`change-report-v1`, `questions-v1`, `answers-v1`) have no
  severity, finding or verdict field and refuse unknown properties.
  **Decision: judgement words are allowed.** No word list is enforced in the
  report, the questions or the answers. The reporter's and the answerer's
  prompts still say to describe what the code does, factually, and the
  checkers judge each claim for support, not for tone.
- **Bounds:** at most 40 items per section and 600 characters per item, all
  within the 256 KiB evidence bound, in every mode: large mode has no larger item.
- **Large mode** ([§6.9](#69-large-pull-requests)) is high level, so two rules
  are relaxed (and the briefing's cites may leave the hunks, above): a changed file no item cites, and a detector fact no item lists,
  are not problems (the plugin accounts for them in `other` and with its own
  fact items), and no state candidate needs a lifecycle entry. Every other rule
  is the standard one, including citations inside the file's hunks.

### 6.6 Output

A `report-write` command writes `.graphloom/review/report.json`
(`pr-change-report-v1`). It uses a chunked argv, as issue-fix's
`writeIssuesCommand` (`src/issues.ts:312`) does, so the written text is
evidence. The human-readable report is the first part of the one file
`review.md`, which `qa-write` writes once the answers are checked
([design review §5.5](design-pr-design-review.md#55-output-one-file)):

````markdown
# apache/skywalking-banyandb#1234 at 9ab2…41 (base 3f1c…e9)
Contents: Briefing · Appendix (Necessity · Report · Measurements · Q&A)

# Briefing
14 files, +612 −88. Commits: 5. GitHub checks at head: 9 passed, 1 pending.

**Purpose** (stated: "replies with the first error when nothing was stored"): A write batch whose events all fail was acknowledged as a success; the callback now replies with the first error in that case.

## What's new
- **W1** Stream writes: reply with the first error when a batch stores nothing. A batch whose events all failed was answered with a success; the callback now replies with an INTERNAL_ERROR carrying the first error. — banyand/stream/write_standalone.go:12-47 (core: banyand/stream/write_standalone.go; also changed: CHANGES.md, banyand/stream/write_standalone_test.go)

## Scope that matters
- Production code: 4 files, +52 −9
- Tests: 2 files, +31 −0
- Docs: 1 file, +3 −0
- Generated / other: 0 files, +0 −0

## Necessity and principles
- N1, is it necessary: necessary — The failure is possible on the base, the change keeps the design, and nothing existing does it.
- Principles touched: offline-idempotent preserves
- Questions that need the author: 1

## Data flow per new feature
None: the report names no new feature with a data path.

## What you need to check
### New surfaces (public APIs, RPCs, proto messages, CLI commands and flags, config)
- None.
### Changed behavior of existing code paths
- The write callback replies with an INTERNAL_ERROR when every event of a batch fails — banyand/stream/write_standalone.go:45-47
…

## Hotspots
1. stream.(*writeCallback).Rev — CRAP 156 (upper bound, coverage unknown), complexity 7 → 12, nesting 3 → 4 (modified) — banyand/stream/write_standalone.go:6

## Areas
- Every feature added or modified: 1 item
- Other changes: 1 item
…

## Open questions
- **Q3 [missing-test] needs author** Which test covers Rev (banyand/stream/write_standalone.go:6)? … — …
2 answered — see the appendix.

# Appendix
Every change item with its lifecycles and tables, the full measurements, the claim check's removals and the whole Q&A.

## Necessity
**N1 — Is this change necessary?** Conclusion: **necessary**. …
…

## Report
14 files, +612 −88. Commits: 5. GitHub checks at head: 9 passed, 1 pending.

### Summary
**Overview:** Rev counts the events it stores and remembers the first failure among its three failure paths. After the batch is flushed, a batch that stored nothing and failed at least once is answered with an INTERNAL_ERROR carrying that error and the original message ID. A batch that stored anything keeps the success reply.

### Database / storage schema changes
- None

### Every feature added or modified
- R1. A write batch that stores nothing is now answered with the first failure instead of a success: Rev counts the events it stores and keeps the first error of its three failure paths, and the reply is decided from the two after the groups are flushed. — banyand/stream/write_standalone.go:12-13, banyand/stream/write_standalone.go:23-25, banyand/stream/write_standalone.go:30-32, banyand/stream/write_standalone.go:37-39, banyand/stream/write_standalone.go:42, banyand/stream/write_standalone.go:45-47
  - State `stored` (per call); starts: 0, set at the start of the Rev call before the event loop
    - when w.handle returns no error for an event → increments by one; every failure path continues before it (banyand/stream/write_standalone.go:42)
    - read once, after the groups are flushed: stored == 0 && firstErr != nil switches the reply from success to an INTERNAL_ERROR carrying firstErr (banyand/stream/write_standalone.go:45)
  - State `firstErr` (per call); starts: nil, declared at the start of the Rev call
    - when proto.Unmarshal of a []byte event fails → firstErr = the error, only while firstErr is still nil (banyand/stream/write_standalone.go:24)
    - when an event has an unsupported type → firstErr = errUnsupportedEvent, only while firstErr is still nil (banyand/stream/write_standalone.go:31)
    - when w.handle returns an error → firstErr = the error, only while firstErr is still nil (banyand/stream/write_standalone.go:38)
    - read once, after the groups are flushed: stored == 0 && firstErr != nil switches the reply from success to an INTERNAL_ERROR carrying firstErr (banyand/stream/write_standalone.go:45)
  - Behavior:

    | Case | Before | After |
    |---|---|---|
    | every event of the batch fails | the empty success reply | an INTERNAL_ERROR reply with the original message ID and the first error |
    | some events are stored and some fail | the empty success reply | the empty success reply (unchanged) |
    | flushing the groups fails after events were stored | logged; the empty success reply | logged; the empty success reply (unchanged) |

### Other changes
- R2. Adds a changelog entry for the fix. — CHANGES.md:14
…
## Measurements
…
## Q&A
…
````

(The briefing is what the maintainer reads; the Appendix holds, in this order,
the Necessity part, written with the Q&A ([design review §5.6](design-pr-design-review.md#56-the-necessity-question-n1)),
the Report's change items, the Measurements and the Q&A, each one heading level
down so that the file reads as one document; the Verdict and the Open questions
of the briefing say "pending" until the Answers stage rewrites the file.
`review.md` stays complete, because agents and `graphloom session open` read it.
The example is the
`state-lifecycle` rehearsal scenario, a change modelled on
the first live report, [apache/skywalking-banyandb#1443](https://github.com/apache/skywalking-banyandb/pull/1443),
whose first report narrated it hunk by hunk as six items.) The report shows
the lifecycle as a compact block under its item and the before/after as a
small table, and a claim check removal as a "Removed by the claim check" line
under the item. `report.json` carries `summary` (`purpose`, `overview`, each
null when removed), `scope` (the lines by kind of file, counted by plugin code),
`briefing` (`whatsNew`, `features`, `check` and `areas` as the claim check left
them), the items' `state` and `behavior`, and `removedParts`.

**Multi-part writes.** One command carries at most 55 chunks of 4,000
characters in the argv, and at most 247,808 bytes once serialized as a job's
input with every chunk JSON-escaped (the executor's 256,000-byte input bound
less the 8,192 bytes the dispatch guard reserves for the rest of the job,
[§6.8](#68-measurements)); a large pull request's `report.json`, `qa.json`,
`review.md` or `review.html` can pass that. An artifact that fits one command is
written by its single command (`report-write`, `qa-write`, `necessity-write`,
`ledger-write`), as before; whether it fits is the guard's own check
(`commandFits`), never a looser bound. One that does not is written as a **part
set**: the text is cut into parts that each fit a command, in order, and each
part is one command, so one job. A part is sized by the same rule the guard and
the executor apply to the job that carries it: the part command's fixed argv
(the script, its id, the path, and k, n and the chunk count at their widest)
serialized, plus each chunk's own JSON-escaped bytes and its comma, stays within
247,808 bytes, so text that grows under escaping (quotes, backslashes,
newlines, control characters) is cut into more, smaller parts and no part is
planned over a bound (before `pr-review` 1.1.6 and `pr-design-review` 0.1.6 a
looser bound planned `report-json-p1` of apache/skywalking-banyandb#1487 at
250,050 bytes, and the guard refused it). Each part is recorded as evidence like
any write
(`report-json-p1`, `report-json-p2`, …; `review-md-p<k>`, `qa-json-p<k>`,
`review-md-qa-p<k>`, `review-html-p<k>`, `review-html-qa-p<k>`,
`review-appendix-html-p<k>`, `review-appendix-html-qa-p<k>`,
`necessity-json-p<k>`, and `<record id>-p<k>` for a record of a large run). Every
part carries the path, its position, the number of parts and the SHA-256 of the
whole artifact. Part 1 starts `<path>.parts`; each later part appends to it and
refuses to run before part 1; the last part checks the file against the digest
and renames it into place, so the final file is never half written and an older
one is replaced only whole. A ledger too large for its one command writes
`ledger.json` and `ledger.md` as part sets first and the compare-and-swap
reads those files. The validators reconstruct each artifact from the evidence:
they concatenate the recorded parts in order and check the digest, and a part
that is missing, failed, out of order, of another file or artifact, or altered
makes the artifact unread and the requirement failed. `review.html` and
`review-appendix.html` are always written as part sets (one part when small; the
briefing stays small however large the pull request is, and the appendix is the
file that grows). The `.gitignore` of `*` in
`.graphloom/review/` is written by each command, as before.

`review.html` and `review-appendix.html` ([§6.11](#611-the-html-report)) are
written beside `review.md` at the same two points: after the Report stage's measurements, with the Necessity
and the Q&A marked pending, and whole after the answers are checked.

`review.md` is local. From the publish phase on, its Report and Measurements
parts could be posted as a PR comment by a later version, using the existing
`create-issue-comment` (not in 0.21: the graph's one write is the review,
[§8.5](#85-publish)). The Q&A part is never posted as a whole.

### 6.7 Delta report

On a later head, Fetch reads the delta since the last reviewed head
([§9.2](#92-mapping-a-new-head-to-the-last-reviewed-one)). What the report does
with it, since 0.26:

- **The report is still written in full for the head.** The reporter, the claim
  check and the diagrams run as on a first head, and `report.json`, `review.md`,
  `review.html` and `review-appendix.html` hold the whole current report. The
  `change-report` requirement is about the head (every changed file and detector
  fact cited, a briefing of the head); an earlier report cannot satisfy it, and
  a reporter that wrote only the delta needs a merge contract the report does not
  have. A delta-only reporter job is deferred ([§19](#19-deferred-items)).
- **In the design review the delta decides only N1's carry**
  ([design review §7](design-pr-design-review.md#7-a-later-head)); every other
  question is asked again, and a carried N1 is marked `carried from <head7>`. In
  `pr-review` a design report of an earlier head is used with a "Since this
  report" part ([§7.1](#71-the-context-source)).
- **Not implemented:** the commits added, dropped or rewritten since L, and the
  detector facts present at H and not at L, as a section of the report. They need
  the commit mapping of [§9.2](#92-mapping-a-new-head-to-the-last-reviewed-one).

### 6.8 Measurements

The Measurements section is facts only. It is built by plugin code from the
measurement records, with no model involved. It holds one row per function
the PR adds or modifies, never untouched code, using the definitions in
[code quality metrics](design-code-quality-metrics.md):

````markdown
## Measurements
Coverage: `go test -coverprofile` of 2 touched packages, confined (no network), 6 min; 1 test failed (pkg/schema TestGroupDefaults). Mutation: not run: mutation not available in this version.

| Function | Change | Complexity (limit < 10) | Nesting (limit ≤ 3) | Coverage | CRAP (threshold 30) | Mutation |
|---|---|---|---|---|---|---|
| `schema.ParseTTL` pkg/schema/ttl.go:14 | added | 12 (over the limit of 10) | 4 (over the limit of 3) | 70% (measured) | 15.9 | not run: mutation not available in this version |
| `measure.(*writer).flush` banyand/measure/write.go:110 | modified | 4 → 6 | 1 → 2 | 50% (measured) | 10.5 | not run: mutation not available in this version |
| `stream.(*writeCallback).Rev` banyand/stream/write_standalone.go:6 | modified | 21 → 25 (over the limit of 10 at the base; made worse) | 4 → 4 (over the limit of 3 at the base; not raised) | unknown: package did not build offline | 650 (upper bound) | not run: no coverage |
| `liaison.(*grpc).route` banyand/liaison/grpc/route.go:88 | modified | 7 → 12 (over the limit of 10: introduced by the pull request) | 2 → 2 | unknown: package did not build offline | 56 (upper bound) | not run: no coverage |
````

When the profile turns coverage off, every row shows coverage `unknown`
with that reason, CRAP as the upper bound, and mutation `not run`.

The section follows a few rules:

- **A modified function shows `base → head`** ([metrics §1.1](design-code-quality-metrics.md#11-the-base-side-of-a-modified-function)),
  so a legacy value is not read as the pull request's: `21 → 25` is a
  function that was already over the limit and got worse, `7 → 12` one the
  change pushed over. The row says **over the limit at the base** (and
  whether it was **made worse** or **not raised**) or **introduced by the
  pull request**. A new function shows its head value alone. When the base
  value cannot be measured (the file is over a command report's 60 KB, cannot
  be read at the base, or has no function of that name), the row shows the
  head value with the reason. Only complexity and nesting are measured at the
  base; coverage and CRAP are the head's. A `split-function` lead says the same,
  so a reviewer sees whether the excess is inherited or introduced
  ([§7.3](#73-leads)).
- **How the base is measured.** A read-only command job reads each modified
  function's file at the pinned base (`git show <base>:<path>`, one command
  per file, recorded whole), then the same static tool, confined with no
  network, measures that file with every line treated as changed, so every
  function of it is recorded. The validator recomputes the base values from
  the recorded file text as it does the head's. A base measurement that does
  not recompute, or fails, never fails the report: it leaves that row's base
  unknown, with the reason.
- **The changed lines fit the report.** The tools' hunks come from
  `git diff -U0 -w` of the head against the pinned base, reduced to its file and
  hunk headers (the bodies are never read), recorded as the report of one command,
  `metrics-diff`, over the measured languages' files. A report is never read
  short: when it is cut, or over 60,000 bytes, the files are listed again in two
  groups, the first and second half of the measured files in the pull request's
  order (`metrics-diff-a`, `metrics-diff-b`), each a command that names its files
  as literal pathspecs (a renamed file with its base path, so Git pairs the two as
  in the whole diff); a group whose report still does not fit is halved again
  (`metrics-diff-aa`, `metrics-diff-ab`, …), down to one file. (The root lists
  every file of a measured language, measured or not, so a root of one measured
  file that does not fit is listed again by name, `metrics-diff-a`.) The groups' hunks
  are merged. A group's run counts only when it is the graph's own command (the
  same argv) recorded after its parent's run, so the plan is a function of the
  evidence and the validators recompute it; a small pull request still uses the one
  command. A single file whose own headers do not fit is not a failure of the run:
  its functions are not measured, and the section says `Not measured: <path> (its
  changed lines' hunk headers (git diff -U0) are over 60000 bytes, more than one
  command report holds whole)` (since `pr-review` 1.1.3 and `pr-design-review`
  0.1.3; before, the whole Report stage failed, as apache/skywalking-banyandb#1487's
  181 files, 71,735 bytes of headers, did).
- **Every command fits the command executor.** The command executor rejects,
  before it runs, a job of more than 16 commands, a command whose argv holds more
  than 64 strings or a string over 4,096 characters, and an input over 256,000
  bytes; a rejected job leaves no run, so a graph that plans from its evidence
  would plan it again. The review kit plans against these bounds (`bounds.ts`; a
  test holds them equal to the executor's own validator). A diff group's argv is
  `sh`, `-c`, the script, its id and one string per path, two for a renamed file;
  a group over 64 is halved, as a group whose report does not fit is, before it is
  ever dispatched, so a group's size never depends on a rejected run (181 files
  made halves of 91 and 90 files, over the bound, and the plan stalled; since
  `pr-review` 1.1.4 and `pr-design-review` 0.1.4). A static batch whose hunks
  would put its command over the bounds is halved before it runs the same way;
  a single file whose hunks alone do not fit is not measured, with the reason
  `its changed lines are too many to pass to the static tool in one command`. A
  path longer than 1,024 characters (a renamed file's base path too) is not
  observable, so one file always fits a group. A job carries as many of its
  commands as fit 16 and the input's bytes; the rest run in the next job. A
  coverage plan whose commands do not fit one job is not run, with the reason
  that the changed functions are too many. As a last guard, a graph that would
  dispatch a command job over one of these bounds hands it to the supervisor
  instead. The guard checks the kit's bounds, not the input shape the executor
  declares. Before `executor-command` 0.1.4 that shape published the id pattern
  without the validator's case-insensitive flag (a JSON Schema `pattern` carries
  none), so it refused an id such as `search-S1` that the executor takes; the
  executor now spells both cases out (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), the
  shape publishes exactly the pattern it applies, and a test holds the two to the
  same verdict on every id.
- **The static tools' Go environment is their own.** The Go tool runs the `go` of
  the root the environment check resolved in the worktree (`go-root`: `go env
  GOROOT`, which follows `go.mod`'s toolchain line into the module cache's
  `golang.org/toolchain@…`), bound read-only into the sandbox. The job inherits
  the hub's or the operator's environment, which may export a `GOROOT` of another
  toolchain that the sandbox does not bind (apache/skywalking-banyandb#1487:
  `GOROOT=/home/…/go1.26.9`, while the resolved toolchain was go1.26.11 from the
  module cache), and `go` stops on a GOROOT it cannot find (`go: cannot find GOROOT
  directory`) even though the binary has its own: every `static-go-*` batch exited
  2. So the static command and the base-side one set `GOROOT` to the root of the
  `go` they run (`<root>` of `<root>/bin/go`), or unset it for a bare `go`, which
  then finds its own; set `GOTOOLCHAIN=local`, `GOENV=off`, `GOWORK=off`,
  `GOFLAGS=-mod=readonly` and `CGO_ENABLED=0`; and drop `GOPATH`, `GOMODCACHE`,
  `GOOS`, `GOARCH`, `GOEXPERIMENT` and `GOBIN` (the tool has no dependencies and
  runs where it is built). `GOCACHE` and `GOTMPDIR` stay: a confined job's point
  into its scratch. The `go-root` check itself asks `go` again with `GOROOT` unset
  when an inherited one stops it, and the `go env GOMODCACHE` that coverage and
  dependency sources read always asks with it unset (the module cache does not
  depend on it) (since `pr-review` 1.1.5 and `pr-design-review` 0.1.5).
  Coverage runs in Docker with its environment named in full, so it inherits none
  of these.
- **Batches fit the report.** The static tools run over the changed files in
  batches of at most 8 (`static-go-1`, `static-typescript-2`, …), and each
  prints one **compact** JSON document (no indentation), because a command
  report keeps about 64 KiB. When a batch's run succeeded but its report was
  cut, the batch is replaced by two: the first half and the second half of its
  files in path order, with ids derived from the parent's (`static-go-2` gives
  `static-go-2a` and `static-go-2b`, those `static-go-2aa`, and so on). The plan
  is a function of the recorded evidence alone, so the validators recompute the
  same batches. Only a run of the graph's own command stands for a batch (same
  script, id, hunks, language, and the current plugin root); a command another
  actor ran under the same id, or one built with an older plugin root, is ignored
  and the batch runs again (since 0.23.3).
  A single file whose own report still does not fit is not a
  failure of the run: its functions are not measured, and the section says
  `Not measured: <path> (the static tool's output for <path> did not fit one
  command report)`, as it does for a file whose path cannot be observed. Each
  split is one more tools job per level (the large-mode floor of [§6.9](#69-large-pull-requests)
  counts a fixed number of such jobs and does not grow with splits, like
  other retries).
- Exceeding a limit is stated as a number beside its limit.
- The static metrics always run. In `pr-review` coverage runs **by default**,
  BanyanDB included, always in the Docker sandbox; mutation is not measured yet
  and every row says `not run: mutation not available in this version`
  (`metrics.mutation` is accepted for a later version). The design review runs
  neither
  ([metrics §4](design-code-quality-metrics.md#4-execution-and-confinement)).
  A profile can switch either off (`metrics.coverage: false`,
  `metrics.mutation.enabled: false`). Missing Docker, a missing image or an
  uncached dependency shows as `not run`, with its reason, per package. So
  does a sandboxed `setup` command that fails (`not run (setup failed: <id>
  exited <n> (<output>))`): the sentence under the heading then names the
  setup commands that ran (`after the profile's sandboxed setup (proto, mocks)`).
  The setup's outcome is kept in the run's scratch, and the reproducing tests of the
  head copy it instead of running the setup again ([§8.2](#82-reproducing-tests)).
  When the test command exits non-zero, the sentence names the failing tests
  (`the test command exited 1; failing: <list>`), read from the recorded output
  (Go `--- FAIL:` lines, Ginkgo's `[FAIL]` summary lines with colour codes
  stripped, and `FAIL <pkg>` lines; at most 20, each cut to 300 characters); a
  failure with none named (a build failure) keeps the generic sentence and adds
  the first compiler error line. A test binary that hit `go test`'s timeout
  (`panic: test timed out after 10m0s`) is named with the running tests Go printed
  (`failing: package <pkg> (timed out after 10m0s; running tests: TestA, TestB)`,
  at most 5 packages and 5 tests). The sentence on how the tests ran states the
  `-timeout` and, when the profile sets one, the Ginkgo label filter.
- The `measurements` validator recomputes every value from its evidence
  ([metrics §5](design-code-quality-metrics.md#5-records-and-recomputation))
  before the section is written.
- The section takes no part in the coverage check, since it is per function,
  not per file.

The delta section lists functions whose measurements changed since the last
report.

### 6.9 Large pull requests

A pull request over one of the profile's limits is reviewed in **large mode**
instead of being refused. Only the hard caps still refuse it.

| Limit (profile `limits`) | Default | Over it |
|---|---|---|
| `maxFiles` | 150 | large report |
| `maxPatchBytes` | 1 MiB | large report |
| `maxNewSymbols` | 200 | no `reuse` leads in `pr-review` past it ([§7.3](#73-leads)); unread by the design review |
| `hardMaxFiles` | 1000 | refused, as today ("incompatible") |
| `hardMaxPatchBytes` | 8 MiB | refused |
| `hardMaxNewSymbols` | 2000 | refused |

The mode is decided by code, recorded in `report.json` (`mode: "standard" |
"large"`, with the reason: which limit, the value and the limit) and shown in
the report's header.

**Areas.** Fetch partitions the changed files into areas, deterministically:

1. Group the files by their first path segment.
2. A group whose patch bytes exceed `areaMaxBytes` (default 256 KiB) splits by
   its next path segment, recursively; a single directory over it splits into
   files sorted by path, in runs under the size.
3. Sibling groups under `areaMinBytes` (default 16 KiB) merge into
   `<parent>/(rest)`.
4. Files under the profile's `questions.excludeRoots` (generated code) form one
   area, `generated`, which no agent reads as patches: it is listed with its
   diffstat in `other`.
5. A test file stays in its directory's area, so a package and its tests are
   read together.

Each area has an id (`A1`, `A2`, ... in path order), its paths and its sizes,
recorded in the snapshot.

**Report.** The report of a large pull request is **high level**: the maintainer
decided that large mode does not read the detail of each area, and that diving
into an area is something they ask for (see "Dive into an area" below).

1. **One reporter job** (`change-report-v1`, the `reporter` role, a fresh
   session, confined read-only with the head and base trees available as for the
   standard reporter: the working tree is the head, the pinned base commit is
   `HEAD`). It is given a bounded **digest**, not the diff:
   - the PR title, body and commit messages, as untrusted blocks ([§12.1](#121-pull-request-content-is-data));
   - the areas: id, name, files, lines added and deleted, patch bytes, and the
     names (only) of the exported symbols each adds, computed from the patches
     (Go: an added `func Name` or `type Name` with an upper-case first letter;
     TypeScript: an added `export ...`; test files add none; a generated area
     lists none);
   - the file list with its diffstat, grouped by area;
   - the detector facts the Report stage computes;
   - the patches of the **interface files** only: the files the profile's
     `schema`, `config` and `interfaces` routing globs match, `**/*.proto`,
     `CHANGES.md` and `docs/**`, at most 200,000 bytes of patch in all. Over the cap, the
     largest patch is left out first, then the next largest, and the note
     lists the files left out. The whole input also has to fit an executor's
     input bound (256,000 bytes once serialized), so the cap shrinks when the file
     list is long; the file list and the facts are cut at fixed sizes with
     their counts.

   The instruction says: describe the PR at a high level: the purpose, an
   overview, one item per conceptual change (usually one per area or per
   subsystem), the template sections and the briefing fields
   ([§6.1](#61-template), [§6.10](#610-features-and-their-data-flow)). State lifecycles and before/after rows are not
   required (empty arrays are allowed). In this mode the briefing's cites (what is
   new, the stages and flows of the features, the check entries) may also name a file of
   the head or the base that the pull request does not change, and lines the
   reporter read in the tree: the claim check verifies their quotes against that
   tree, and the deterministic rule that a cite lies in a hunk does not apply to
   them. Each what's-new entry also has its card fields ([§6.1](#61-template)): a
   title, one sentence, 1 to 4 core files (each a changed file, and cited by that
   entry) and the feature it draws; the excerpts and the synced-along files are
   plugin-computed from the snapshot's patches, whether or not the reporter was
   given them. `areas` gives a short label for each area id. The reporter may open any file of the
   head or the base read-only to confirm a claim, and every item cites the files
   and lines it rests on; those lines still lie in the file's hunks of the PR's
   diff, whether or not the patch was given to the reporter. An item is at most
   600 characters, as everywhere. The reporter need not cite every changed file or
   list every detector fact: a file no item cites is listed in `other` with its
   diffstat, a fact no item lists gets a plugin-written item, and the generated
   area and a file GitHub gave no patch for are listed in `other` with the reason.
2. **One claim check** (the `report-checker` role, [§6.4](#64-writing-and-checking))
   over that report. Because an item may cite lines that no patch given to the
   reporter holds, a claim's quotes are **verified against the cited tree**, not
   against the patch: each quote must be on a line of the file its cite names, in
   the tree that cite names (the head's working tree, or the base commit's file;
   a claim with no cite quotes the head), within three lines of the line given
   (whitespace collapsed), by read-only `tree-quote` commands (one job for up to
   14 quotes), so a quote the tree does not show makes its claim unsupported,
   with the revision and removal rules of §6.4. A quote from a file the claim
   does not cite is refused. A claim that cites a file the pull request does
   not change is never supported on the checker's word: it needs a quote.
3. The **diagrams** ([§6.10](#610-features-and-their-data-flow), [§6.11](#611-the-html-report))
   are drawn from the checked report as in standard mode.
4. Items are numbered `R1`... in section order. `report.json` records the mode,
   the limit passed, the areas with the number of items that cite each, and the
   files without a patch; there are no merges and no area records.

**Dive into an area.** The Areas section of the briefing ([§6.11](#611-the-html-report))
lists the areas, one line each (id, what it is, files, lines added and
deleted), where "what it is" is the reporter's label for the area id (the
area's path when it gave none), and gives the command

```sh
graphloom session open <run> --stage report
```

which opens a fork of the reporter's recorded session ([§17](#17-discussing-a-run-graphloom-session-open)),
saying that the reporter's session already has the PR's digest and can read any
file. The run id is not in what the validators see, so the file says `<run>`.
There is no new command. A Pi reporter has no interactive restore, so the
maintainer who wants this uses `claude-code` or `codex` for the `reporter`.

**Budgets.** Before the reporter job, the graph computes the jobs and agent
invocations large mode needs (the reporter and its check with the commands that
verify its quotes, the diagram job, plus, in the design review, the Questions and
Answers estimate, and in `pr-review` the review layer's) and stops
with the numbers if the run's remaining budget cannot cover them, so the
maintainer can raise the profile's `budgets` instead of losing a run halfway.
It is a floor: corrections and retries come on top.

**Every assignment fits the executor's bound.** The coding-agent executor accepts an
assignment of at most 64,000 characters, and a job past it stops the run
"incompatible task". No agent job of the plugin can pass it, at any size of pull
request. Each job builder fits its assignment in this order: (1) bulk input is a
**file in the worktree's `.graphloom/review/`** the agent reads, written, as a
bounded multi-part write ([§6.6](#66-output)), before the job that names it (the
assignment gives the absolute path and says what the file holds), while a compact
index stays inline (each item's or claim's id with the start of its text); (2) what
must stay inline is cut with a note of what was left out and where to read it; (3) one
guard in the job builder measures every assignment against the bound less a margin
of 2,000 characters before dispatch, and a job that still does not fit stops with the
job's name and what to shrink, never with the executor's message. A part that fits is
inlined whole, as it always was; the file appears only past its inline budget.

| Job | Inlined when it fits | Otherwise |
|---|---|---|
| Reporter (standard) | changed files, detector facts, state candidates | `reporter-input-<digest>.md` with all three, and an index of the facts |
| Reporter (large) | the digest, already fitted | its file list, facts and interface patches cut, with counts |
| Claim checker | every claim, with its text and cites | `claims-<digest>.md` with every claim; an index of the ids |
| Diagram job | the data of every feature and lifecycle entry | the diagrams past 12, or past 36,000 characters of data, are drawn by the plugin |
| N1 answerer | the report's change items | an index, and the `review.md` and `report.json` the Report stage wrote |
| Questioner | change items, required questions, groundwork | the same index of items; `required-questions-<digest>.md`; `groundwork-<digest>.md` and an index of the symbols |
| Answerer (each batch) | its questions, the groundwork | `groundwork-<digest>.md` and, inline, the groundwork of the batch's own symbols and functions |
| Answer checker (each batch), N1 checker | the questions with their answers | `answers-<digest>.md` or `necessity-answer-<digest>.md` with the whole text, cites and searches |

The N1, questioner and answer rows are the design review's.

Every job also shows the pull request's text bounded: the title at 500 characters,
the body at 8,000 and the first 20 commit messages (the plugin matches a stated
purpose against the whole text). Feedback of a correction is listed to 8,000
characters, with a count of the rest. The files are named by their content's digest,
so a revised report or a corrected answer writes a new file and never reads an old one.

### 6.10 Features and their data flow

The maintainer reads the briefing ([§6.1](#61-template)) to learn what the
pull request adds. For each new feature the reporter returns the path the data
takes through it, end to end: where it enters, each hop, where it is stored. The
report draws one **data-flow diagram** for each, not a map of the modules the
change touches (a diagram of the architecture was tried in 0.12 and dropped in
0.16: it was long, and it did not say what the new code does).

```text
features: [{ name, summary,
             stages: [{ id, label,
                        kind: "source" | "process" | "transport" | "store" | "external" | "sink",
                        cite: { path, side, start, end, symbol } }],      a place that shows the stage
             flows:  [{ from, to, label,                                  stage ids, what moves
                        cite: { path, side, start, end, symbol } }] }]    where the code moves it
```

At most 3 features (the most important new capabilities; none for a fix or a
refactor), 2 to 8 stages and 1 to 12 flows each. A feature's place in the list
names it (`F1`, `F2`, `F3`). `source` is where the data enters, `process` code
that transforms or routes it, `transport` a hop over a wire or a queue, `store`
where it is kept, `external` a system outside the repository, `sink` where it
leaves or is consumed.

**Deterministic validation:** stage ids unique inside a feature and of the form
letters, digits, `_` and `-`; every flow names two stages of its feature and
joins no stage to itself; every label non-empty and bounded; every cite a range
of lines inside the diff's hunks on the side it names (the rule of an item's
cites, [§6.5](#65-deterministic-validation)); in large mode a cite may also name a file
the pull request does not change, by a repository-relative path and a range of
lines, which the claim check's tree verification covers
([§6.9](#69-large-pull-requests)).

**Claim check:** claims `F1` (the summary is what the data path through its
stages shows), `F1.s2` (the cited code is that stage, of that kind) and `F1.f3`
(the cited code moves the data from the one stage to the other, in that
direction, as the label says), each needing quotes like an item's. An
unsupported stage is dropped with the flows that touch it, an unsupported flow
alone, and a feature left with fewer than two stages or no flow, or whose own
claim is unsupported, is dropped whole; each drop is recorded under "Removed by
the claim check". The other briefing fields are claims of the same check
(`W1` a what's-new bullet, `C.surfaces.1`, `C.behavior.1`,
`C.compatibility.1`, `C.risks.1`, `C.tests.1` the entries of the check lists),
dropped and recorded the same way.

**Drawing.** What the claim check leaves is drawn for the HTML report
([§6.11](#611-the-html-report)) by the **diagram job**, with the vendored
diagram-design skill ([§12.4](#124-the-vendored-diagram-design-skill)), and the
plugin's own SVG is only the fallback:

- **The job.** After the claim check, one read-only agent job (`diagrams-v1`,
  fresh session `diagrammer`, on the optional `diagrammer` role's harness, model
  and effort, the `reporter`'s when the profile names none;
  [§13.1](#131-roles)) receives only the checked data: for each feature that
  survived its stages (id, label, kind) and flows (from, to, label), and every
  lifecycle entry that survived ([§6.4](#64-writing-and-checking)): its name,
  scope, initial value, transitions (condition and effect) and reads. It gets no
  path, citation or diff. The skill is mounted read-only in the job like the
  other read-only binds, and the instruction names `<mount>/SKILL.md` and the
  references to read: `type-data-flow.md`, `type-state.md`, `style-guide.md`
  (Font source: offline/system fonts), `primitives-core.md`, `output-spec.md`
  and `layout-budget.md`.
- **What it draws.** One **Data flow** (the skill's type, `type-data-flow.md`)
  for each feature (id `feature:<feature id>`): the skill's type has roles in
  lanes and steps in columns, and here the lanes are the kinds of the stages
  (only those that occur) and the columns the stages in the order the data
  reaches them; every stage is a node titled with its label, every flow an arrow
  from its from stage to its to stage, labelled with its label (the skill's
  one-labelled-arrow rule gives way, since every checked flow is drawn); the
  first `store` stage (the last stage when there is none) is the focal node and
  the flow into it the focal arrow. No step-header strip, step number or role
  chip is drawn, since they would print text that is no label of the data. And
  one **State machine** for each lifecycle entry (id
  `state:<item id>:<entry name>`): the start dot, the initial state, one
  transition for each recorded transition, labelled with its condition, and the
  reads noted. At most 12 diagrams (the features first, then the entries in
  report order); the rest are drawn by the plugin. The choices are fixed in the
  instruction, and nobody is asked: the skill's default style (its style-guide
  gate is answered "keep default"), system fonts (no Google Fonts link), static
  (no motion), the light minimal template. The skill's complexity budgets do
  not apply: every checked stage, flow and entry is drawn. The result is, for
  each diagram, its id and the complete self-contained HTML document the skill
  produces, at most 160,000 characters.
- **Checks, for each diagram, deterministic and recorded as evidence.** (1) The
  skill's own `self_check.py --offline` and `verify-geometry.py`, run by one
  command in a confined read-only job (bwrap, no network, `python3`, the
  plugin's directory read-only) on the document written to a scratch file in the
  run's temporary directory (`diagram-check-<attempt>-<n>`; no `python3` is a
  failed check, with its reason). (2) The inertness check of
  [§6.11](#611-the-html-report) on the document (no script, no external
  stylesheet, font, image or link, no `url(` that leaves it) and on the `<svg>` the
  report embeds. (3) The **label rule**: every visible text of the SVG (each
  `<text>` and `<tspan>`) is built from the labels of the data the job was
  given: feature names, stage ids, labels and kinds, flow labels, state names,
  scopes, initial values, transition conditions and effects, read descriptions,
  and the skill's fixed words (Before, After, Changes, ADDED, REMOVED, CHANGED,
  MODIFIED, UNCHANGED, MOVED, REWIRED, STATE, START, END, INITIAL, READS, and a
  legend's words). Text is compared with whitespace, case and decorating
  punctuation normalized; a text passes when each part of it between standalone
  separators (`·`, `→`, `+`, `−`, `|`, `/`, `:`) is a fixed word or a run of
  whole words of one label, so a label may be wrapped over lines and the two
  sides of a pair may stand beside an arrow. Any other text is a claim the
  checker never saw, and the drawing fails. The title and description of the
  SVG are the plugin's own.
- **One correction.** The problems of the diagrams that failed go back to the
  same session once, which returns the whole set again; a diagram that still
  fails after it is drawn by the plugin instead. The latest attempt that passed
  stands. The drawing and its correction are the diagram job's runs of the Report
  stage's latest attempt ([§5.1](#51-convergence-after-a-reentry)): after a
  reentry or a resume that sends the run back to Report, the graph draws again,
  and the validators judge those runs, never the drawings of an earlier attempt
  they still see. A check is looked up by its id and its exact argv, which carries
  the document and the skill's mount, so a check of another document or of an
  older plugin directory never stands for it. The run never stops for a diagram: the appendix says "drawn by the
  plugin: the diagram-design drawing failed its checks (<reason>)" beside it, and
  `review.html` puts it in the tooltip of the diagram's caption.
- **What is embedded.** The plugin never copies the model's markup. It reads the
  `<svg>` into a tree, keeps only an allow-list of elements and attributes
  (`g`, `rect`, `line`, `path`, `polygon`, `polyline`, `circle`, `ellipse`, `text`,
  `tspan`, `defs`, `marker`, `pattern`; `data-*` and `aria-*`; no `style`, `href`,
  `use`, `image`, `foreignObject` or handler), prefixes every id so that several
  drawings share one document, resolves the document's `<style>` into presentation
  attributes (simple `.class` rules and `var(--x)` from `:root`; anything else
  that styles the drawing is a problem, handled by the correction or the
  fallback), drops every `class`, sets the title, description and `role="img"`,
  scales the viewBox to the container (`width: 100%`; the job is asked for a
  viewBox at most 1200 wide, the output spec's `doc-inline` preset, or `doc-wide`
  when a wide diagram needs it), and writes it back out. The reader allows
  at most 64 levels of nesting and 6,000 elements and stops there, so a hostile
  drawing is a problem, never a crash. The drawing
  is recorded in `report.json` (`diagrams`) so that `review.html` at the Answers
  stage embeds the same bytes.

**Fallback rendering**, by plugin code, with no third-party tool: an SVG for the
HTML report ([§6.11](#611-the-html-report)), used when the skill's drawing fails
its checks: a layered layout (layers by longest path from the stages with no
incoming flows, cycles broken at back flows found by depth-first search, order
within a layer by barycentre over a few sweeps), boxes coloured by the stage's
kind, flow labels, a legend of the kinds that occur; and a lifecycle diagram of
its own for each state entry. `review.md` has the features as text lists (the
stages, then the flows, each with its cite), whoever drew the SVG; it has no
Mermaid block.

### 6.11 The HTML report

Beside `review.md`, the plugin writes two self-contained files in
`.graphloom/review/`, for every pull request: **`review.html`**, the report as
**diagrams and visual elements only**, which a maintainer reads in about two
minutes, and **`review-appendix.html`**, everything else, in text. Plugin code
renders both from `report.json`, `qa.json`, `necessity.json` and the measurement
records, at the same two points `review.md` is written (in the design review:
Report, with the Q&A pending, and Answers, whole; in `pr-review`: Report, then
Draft, with the Review section). `pr-review`'s files have no N1 tile, principle
grid or question grid; with the `none` context source it writes no HTML. `review.md` beside them is their plain-text copy, for
agents and `graphloom session open`, and it stays complete: the briefing, then
the appendix's content. No model writes HTML: the one piece of a model's markup
they hold is the `<svg>` of a diagram the skill drew
([§6.10](#610-features-and-their-data-flow)), which plugin code re-serializes
from an allow-list.

**Self-contained and inert:** inline CSS and inline SVG; no `<script>`, no
external stylesheet, image or font; the only links are `href`s to the pull
request, its commits and files on GitHub at the pinned head and base, and the
two files' links to each other (`review.html` and `review-appendix.html`, with
an optional `#fragment` of letters, digits and `_.:-`). Every text that came
from a model or the pull request is HTML-escaped. A deterministic check on the
written bytes of both files enforces this, for the embedded diagram SVGs too (an
allow-list of elements and attributes, `data-*` and `aria-*` by prefix, no `href`
outside `<a>`, no `url(` that leaves the document). The excerpts of the change cards
are text in `<pre>`, escaped, in `<details>`; no element or attribute is added to the
allow-list for them. `review-appendix.html` uses
`<details>`, so its sections collapse without JavaScript. A diagram sits inline in
an `overflow-x: auto` wrapper and scales to the container width. Light theme,
readable on a laptop.

**`review.html`, in this order, and nothing else.** It holds no prose paragraph and
no list of text items, with one exception: **one sentence for each change card**
(item 3). Everything else is short labels, numbers and badges; anything longer is a
tooltip (an SVG `<title>`, an HTML `title` attribute; no script) and is in the
appendix.

1. **Header strip:** the pull request's number and title on one line, the head and
   base short SHAs (links to the commits) and a link to the appendix.
2. **Verdict and scope tiles.** N1's conclusion as a large coloured tile
   (necessary green, questionable amber, unnecessary red, needs author grey), a
   **principle grid** (one small tile for each principle id the change touches,
   coloured preserves green, breaks red, not applicable grey, pending grey; the
   tooltip is the one-line explanation, [design review §5.6.1](design-pr-design-review.md#561-project-design-principles)); the
   **scope bar**, one horizontal stacked bar of the lines added split into
   production code, tests, docs and generated or other files, with the counts as
   labels (the lines deleted are a thin second bar), counted by plugin code from
   the file list (a generated file is one the profile's `questions.excludeRoots` or
   its generated globs name; docs are `docs/**` and `*.md`; tests are the files the
   plugin's own rule classifies as tests, `_test.go`, `*.test.ts`, `*.spec.ts`,
   and any file in a `test`, `tests` or `__tests__` directory; production code is
   the rest); and counts tiles for files, commits and checks.
3. **Changes:** one card for each high-level change the claim check left (`W1`…, the
   `whatsNew` entries, in both modes; the report's `R` items are not cards). A card
   has, in this order:
   - its id and **title** (the reporter's, "area, what was done, how the mechanism
     changed"), and **one sentence**, its `overview`: the situation before and how it
     works now, or for a purely new capability what it adds and where it hooks in.
     Title and sentence are the only prose of the page, escaped like any text, and
     each is also checked as part of the change's claim (`W1`);
   - the change's **data-flow diagram** ([§6.10](#610-features-and-their-data-flow))
     when a feature names it (`feature`), the skill's drawing or the plugin's
     fallback, with the feature's name as its caption (the summary, and the note when
     the plugin drew it, are the caption's tooltip);
   - its **core files** as chips (`coreFiles`, the must-read files: each a link to
     the change's first cite in it on GitHub, or to the file at the head, or at the
     base for a file the change deletes, when no cite of the change has lines in it), and under them a collapsed
     `<details>` "also changed (N)" listing the **synced-along** files as small
     links. Plugin code computes them: the files of the pull request that the change's
     cites name, and the files cited by the report items that cite a core file, minus
     the core files, in the file list's order, at most 30 listed with a count of the
     rest;
   - a row of **links to every cite of the change** (`path:line`, at the pinned head or
     base on GitHub), whether or not an excerpt of it is shown below;
   - a collapsed `<details>` "cited code (N lines)" holding the **excerpts** of the
     change's cites: for each cite inside a hunk of its file, the patch lines from the
     first to the last line the cite's range covers on its side, in patch order, so
     that the removed lines between them (base side) show beside the added and
     context lines (head side), each with its line number and a `+`, `-` or space
     mark, in a `<pre>`, under the cite's GitHub link. Bounds: at most 12 lines for
     a cite, 36 for a card, 160 characters for a line; what is left out is said ("…
     k more lines") and the link leads to it. A cite outside the hunks (large mode),
     on a file with no patch text or on a file the pull request does not change has
     no excerpt, only its link. The excerpts are cut by plugin code from the patches
     of the snapshot when `report.json` is written, and stored there (`cards`), so
     the renderer needs no patch and the page has no script.

   A feature no change names keeps its own diagram after the cards, captioned with
   its name, as before. A report whose claim check left no change has no card, and
   shows the diagrams alone.
4. **Risk map:** an SVG treemap of the areas (the areas of a large report; the
   report's sections otherwise), laid out by a squarified treemap implemented in
   plugin code (deterministic, no dependency). Each rectangle is sized by the lines
   changed in the area and coloured by what the briefing's `check` lists cite in its
   files, the most serious kind winning: **risk** (the `risks` list), then
   **compatibility**, then **changed behavior**, then **new surface**, then
   **none** (the `tests` list says nothing of risk); a legend names the colours with
   their counts. The label is the area id and its short label where it fits. The
   tooltip is the area's label and the one-line `check` entries that cite it. The
   hotspot functions (the top 5 by CRAP, then complexity, [§6.8](#68-measurements);
   a test file's functions are not ranked) are small dots in their area, each with
   a tooltip. Under the map, one compact reason card for each coloured area (none for
   a grey one) lists the `check` entries that cite it, each with its category tag,
   its text and its cites as GitHub links, and the live review findings in its
   files as chips that link to the appendix; the area's rectangle links to its card
   (`#area-<id>`, highlighted with `:target`, no script).
5. **Question status grid:** one tile for each question, N1 first, then grouped by
   the high-level change the questions are about (`W1`…, or the report items that stand
   in when the claim check kept no capability), coloured answered green, partially answered amber, needs author
   red, unanswered grey, labelled with the question id and a type abbreviation
   (NEC, WHY, HAS, ETC for `necessity`, `purpose`, `existing-feature` and `other`). The tooltip is the question in one line,
   and each tile links to its answer in the appendix (`#q-<id>`). A legend gives
   the counts. Pending (the Questions and Answers stages follow) at the Report
   stage.
6. **Review**, when the review layer ran ([§8](#8-the-review-layer)): the findings as
   a grid of tiles by aspect and final priority ([§8.4](#84-draft)) with counts, coloured by state
   (disputed when its verifier did not settle it, unproven when it is a
   behavioral finding no test proves, confirmed otherwise; a cell takes its most
   serious state, and dismissed findings are not shown), each linking to its
   finding in the appendix (`#f-<id>`).

It holds no change item, no table, no list and no Q&A text, and no prose beyond the
change cards' title and sentence. The text that used to
be the briefing (the purpose, what is new with its `W` ids, titles, sentences, core and synced-along files, the scope table, the
verdict panel, the data flow with its stages and cites, the five check lists, the
hotspots, the areas with the dive-in command, the open questions) is the first part
of the appendix, in the same words.

**`review-appendix.html`, in this order:** the briefing in text (see above);
the **Summary** (the reporter's
overview of the mechanism); the **Necessity** part (the base trace as numbered
steps with their citations, the design statements, the principles block with
one badge per verdict and the checker's judgment, and the simpler-way answer);
the **Change map** (a horizontal bar chart of added and deleted lines per area
in large mode, per report section otherwise); the **Change items**, as cards
grouped by section (the text, the citations as links, a state diagram, the
skill's State machine or the plugin's SVG with its note, for each lifecycle
entry with its reads listed under it, and the before/after table; standard mode
keeps producing the lifecycles); the **Measurements** (the full metrics table
with cells coloured against the limits, over the limit red, inherited from the
base, made worse or introduced said in the cell, coverage as a bar, CRAP as a
bar with the threshold marked, and the coverage run's note, with the files not
measured); the whole **Q&A** (per item, each question with a status badge, the
answer, its evidence and the checker's judgment, collapsed by default except
"needs author", each with an `id` (`q-<id>`) that `review.html`'s tiles link to; N1's answer is the Necessity part, `q-N1`); and **Removed by the
claim check**, with the notes. It links back to the briefing at the top and the
bottom.

The stop message names the visual report first: "the report is
`.graphloom/review/review.html`, with the appendix
`.graphloom/review/review-appendix.html`; `review.md` beside them is the
plain-text copy of both for agents and `graphloom session open`".

## 7. The review's context and leads

`pr-review` asks no question. What round 1 of 0.26 asked about details became
deterministic leads for its reviewers, and its reviewers are seeded with a
report from one of three sources.

### 7.1 The context source

Plugin code decides the source from what Fetch recorded, the first that applies,
and records it in `.graphloom/review/context.json` (`pr-review-context-v1`: the
source, D and its base for `design-review`, the delta's files and hunks, the reason
each earlier source was not used, and whether the request asked for no report).
The `review-context` validator recomputes it from the ledger reads, the delta and
the pinned request; the `review-scope` record names the same source.

1. **`design-review`: the ledger's round-1 report.** The `design` section holds a
   report of a head D, the latest design head, whose `report.json`, `qa.json` and
   `necessity.json` the section's tree carries ([§9.1](#91-where-the-ledger-lives)).
   - D is this head: the report is used as it is.
   - D is another head: the report is used when the delta from D to this head is
     usable by the rules of [§9.2](#92-mapping-a-new-head-to-the-last-reviewed-one)
     (the records are there, of D and of one mode with this head; D's commit and
     base are in the review clone; the diff is complete and fits). D's commit is
     kept alive by the design review's pinned `heads/<sha>` ref.
   - The seed, `review.md`, is rendered by plugin code from those three records
     (Context · Briefing, the design review's, as of its head · Measurements, this
     run's · Necessity · Q&A · Report). When D is not this head, a "Since this
     report" part says the report and the Q&A describe D and lists the files and
     hunks the delta changed. In large mode the review scope is D's briefing cites,
     each mapped to this head by the delta; a cite whose file left the pull request
     is dropped.
   - A round-1 report with open items is used all the same: round 2 does not gate
     on round 1.
   - With no design head, or a delta that is not usable, the source is the next
     one, and the reason is recorded.
2. **`prelude`: a report-only prelude.** The Report stage writes and checks the
   change report as [§6](#6-the-change-report) describes, with no N1, no questions
   and no answers: the briefing's verdict line says there is no design review in
   this run, and there is no open questions or Q&A part. The reporter, diagrammer
   and report checker run.
3. **`none`: `--no-report`.** Only when the operator asked (`graphloom task new
   pr-review … --no-report`, the request suffix `, without a report`), and in place
   of the prelude: a usable design report is still used, since it costs no job. The
   seed is the pull request's metadata (title, body and commit messages as untrusted
   blocks), its file list with the diffstat, and the patches of the files in the
   review's scope, within the assignment bounds. In large mode there is no briefing
   to narrow the scope, so every readable area is reviewed. It is weaker, since the
   reviewers have no map, and never the default.

The measurements run whatever the source: the leads need them, and a design report's
Measurements are static only, so the seed carries this run's.

**Round 1 in the review.** When the `design` section has a head, the posted review
lists round 1's open items and counts them, whatever the context source; when it
has none, the review says round 1 was not run ([§8.4](#84-draft)).

### 7.2 Deterministic groundwork

Plugin code, and read-only command jobs over the pinned trees, prepare the
material the leads, the report and the design review's answers rest on:

1. **Symbol extraction.** Each language pack has definition patterns. Go has
   `func`, methods with receivers, `type`, and exported `const`/`var`.
   TypeScript has `export function|class|interface|type|const` and class
   methods. The patterns run over the patch's added lines, and plugin code
   cuts each body from the head file by brace matching. A symbol is new when the
   same patterns do not find its qualified name (package or path, receiver, name)
   in the base file, and modified when it is defined in both and has changed lines
   inside its body.
2. **Whole-repository search** (`pr-review`, for `reuse` leads, up to
   `limits.maxNewSymbols` new symbols). Read-only command jobs run
   `git grep -n -E … <base>` over the **whole base commit**. Only the profile's
   `excludeRoots` (generated code) are left out, and vendored directories are
   included. The queries per new symbol are its name and its camelCase and
   snake_case token variants, its normalized signature, and the three rarest
   identifiers or literals in its body. Each query keeps at most `maxCandidates`
   hits and fits a 64 KiB command report. Plugin code scores token-shingle Jaccard
   similarity (k = 5) between each new body and each candidate body, and between
   new symbols of the pull request.
3. **Dependency inventory.** Every declared dependency (`go.mod` requires,
   `package.json` dependencies) with its version and a base call site, and every
   internal package, from `git ls-tree -d -r <base>`. For Go modules, the inventory
   names the module cache directory of each required version when the operator's
   cache holds it, mounted read-only; a dependency whose source is not available
   locally is marked `source unavailable`.
4. **Test mapping** (`pr-review`). For each new or modified symbol: test files the
   pull request adds or changes in the symbol's package or directory; added test
   lines that reference the symbol, or its exported caller in the diff; and
   table-driven case names containing the symbol's name tokens. The coverage run
   also counts: a changed line it executed is covered by whichever test executed it.
5. **Purpose lookup** (the design review). The pull request's body, commits and
   linked issues are pinned text; a `stated` purpose must quote one of them.

### 7.3 Leads

A **lead** is a deterministic pointer, computed by plugin code (`src/leads.ts`)
before the first pass of the sweep, at something the 0.26 detail questions used to
ask. It is not a finding and is never posted. It goes to the maintainability
reviewer's first pass, beside the earlier findings, as data with an id (`L1`…, per
run), its kind, its place and the measured facts behind it. The reviewer returns
one entry for each lead it was given: `raised`, naming the comment the pass raised
about it, or `not-an-issue`, with a reason. A missing, repeated or unknown lead id
goes back to the same session as a correction. A raised finding is an ordinary
finding: verified, and posted only when confirmed. Its kind sets its priority, not
the reviewer: the last column is what plugin code drafts a confirmed finding of
that kind at, whatever priority the reviewer proposed. That drafted priority is the
finding's only one: every report, the posted review and the ledger show it, and the
proposed one stays in the aspect record ([§8.4](#84-draft)).

| Lead kind | Computed from | Priority of its finding |
|---|---|---|
| `untested-feature` | A high-level change of the context report whose every new or modified function, in the files its cites name, has no covering test: the test map finds none, and coverage, when measured, executed none of their statements. None without a report (`none`) | P1: the one non-behavioral finding that may be drafted at P1. Its proof is the recorded test map and coverage, which `findings-proven` recomputes; the verifier confirms that no test of the pull request or the base exercises the feature |
| `missing-test` | A new or modified function with no covering test by the same rule, not inside an `untested-feature` lead | At most P2 |
| `weak-test` | A surviving mutant at a covered site | P0 |
| `split-function` | A changed function with complexity ≥ 10 or nesting > 3, with whether the excess is inherited, made worse or introduced ([§6.8](#68-measurements)) | P0 |
| `crap` | A changed function with measured coverage and CRAP ≥ 30, or unknown coverage and complexity ≥ 10 | P0 |
| `reuse` | A new symbol whose whole-repository search found a name or signature hit, or a body at least `questions.similarity` similar, outside the files the pull request changes; or another new symbol of the pull request above that similarity | P0 |

- **The fixed P0 (since 1.1.0).** A confirmed finding raised from a `weak-test`,
  `split-function`, `crap` or `reuse` lead is drafted at P0 whatever the reviewer
  proposed, needs no reproducing test (its proof is its lead, which
  `findings-proven` recomputes and finds recorded as raised by that finding), and
  makes the recommendation `request-changes` ([§10.3](#103-verdict)). A P3 comment
  raising one of these leads is a finding, verified and drafted, not a counted
  nit; a P3 comment raising a `missing-test` or `untested-feature` lead is still a
  nit. A refuted one is dismissed and a disputed one goes to "Needs your judgment",
  as for any finding. A finding the reviewer or the verifier classes as
  behavioral keeps the proof rule of [§8.2](#82-reproducing-tests): proven, it is
  drafted at P0; unproven, it is never P0 or P1 and goes to "Needs your judgment".
  When several leads name one finding (one comment, or comments merged on
  overlapping lines), the finding keeps the first, unless a later one is of these
  four kinds and the first is not. When such a finding is linked with another
  aspect's on overlapping lines, the one entry is P0 and names the lead.

- **Scope.** Leads are computed for the functions and symbols in the review's scope
  only (in large mode, the files of the scoped areas). With coverage off or not run,
  the test map alone decides and `crap` uses its unknown-coverage rule. Mutation is
  not measured yet, so no measurement record carries a surviving mutant and there is
  no `weak-test` lead. Past `limits.maxNewSymbols` the searches are not run and there
  are no `reuse` leads; `review-scope` says so.
- **Bound.** At most 60 leads are given, `untested-feature` first, then by kind in
  the table's order and by path; the rest are recorded as not given and need no
  status.
- **Context for correctness.** The correctness reviewer's assignment also lists, with
  no status required, the surviving mutants and untested functions of its scope: an
  untested edge case can point at wrong behavior, which is then a behavioral finding
  with a reproducing test.
- **Records.** The leads and their statuses are in `review-aspect-maintainability`
  (`pr-review-aspect-v2`); `leads-judged` recomputes them from the measurement
  records, the test map and the search reports. The appendix of `review.html` lists
  them. The ledger keeps their counts per head (`leads: { given, raised }`), not the
  leads: a later head computes them again, and a finding raised from a lead is an
  earlier finding there, re-checked like any other ([§9.3](#93-re-checking-earlier-findings)).

### 7.4 The maintainability aspect

After the split no Q&A answers reuse, duplication, complexity splits or missing
tests, so the maintainability rule file (`rules/maintainability.json`) no longer
excludes them:

| Aspect | Focus | Out of scope |
|---|---|---|
| `maintainability` | Readability, structure and naming, duplication and reuse of existing code, coupling, complexity, test coverage and test quality, the leads it is given | Whether a whole feature or mechanism already exists in the codebase, only when the context source is `design-review` (the design review's `existing-feature` answers it); whether behavior is correct or safe |

When the source is `prelude` or `none`, a whole feature that already exists is a
maintainability finding.

## 8. The review layer

The review layer is `pr-review`'s Review and Draft stages. It runs in every
`pr-review` run, whatever round 1 found: round 2 does not gate on round 1. It is
issue-fix's [review convergence](design-issue-fix-graph.md#review-convergence)
with one candidate per run, the reviewed head, run once per aspect. issue-fix's
own code review is unchanged: one open-code-review pass with ocr's rules and no
reproducing tests.

### 8.1 Review

**Status (1.0).** Implemented as the text below says, with these differences:

- **Fresh sessions, seeded with `review.md` only.** Every reviewer pass starts a
  fresh session whose only seed is `review.md`, the context of
  [§7.1](#71-the-context-source), and the `review-scope` record says so (`context:
  seeded`, and the context source). No conversation reaches a reviewer: no human is
  in the flow, and `graphloom session open` conversations are not read.
- **Scope.** A standard pull request is reviewed whole. In large mode the reviewers
  review the files of the areas that the context report's "What you need to check"
  entries for risks, behavior and compatibility cite (a design review's cites mapped
  to this head). A report that cites no area, or no report (`none`), leaves nothing
  to narrow the scope by, so every readable area is reviewed (the generated area
  never is) and the scope's source says `all-areas`. The scope is decided once and
  recorded.
- **Aspects run one after another** (correctness, maintainability, security),
  each with its own sweep, so the findings are numbered `F1`, `F2`, … aspect
  by aspect. A comment whose `aspect` is not its pass's stays in the raising
  pass's sweep and verification and is listed under its own aspect in the draft.
- **Rule groups are resolved by plugin code, not by `ocr delegate rule`.** The
  effective rule file is written to `.graphloom/review/rules/<aspect>.json`
  in the format ocr honors, and plugin code asserts from the written bytes
  that every file of the scope falls under one entry (the first whose glob
  matches, `**` last) and gives the reviewer those groups; a file under none
  fails the aspect before any reviewer runs. The ocr binary is not run.
- **The leads** go to the maintainability reviewer's first pass, and the
  correctness reviewer gets the untested functions of its scope as context
  ([§7.3](#73-leads)).
- **Reproducing tests** are read by `proofOf` (`src/proof.ts`) from the
  `graphloom-repro-v1` command reports and the verifier's `test` judgment; what is
  implemented is listed under [§8.2](#82-reproducing-tests).
- **Not in this version:** the deterministic rule checks (`rules`) and the Checks
  stage (the profile refuses both as a later version's), "already raised" human
  threads, `comments.nits` (P3 comments are counted and not verified, except one
  raising a `weak-test`, `split-function`, `crap` or `reuse` lead, [§7.3](#73-leads)), and the
  reroute of off-aspect findings into another aspect's sweep.

**Three aspect reviewers.** Three reviewer sessions review the same file
scope, each for one aspect:

| Aspect | Focus | Out of scope |
|---|---|---|
| `correctness` | Each feature does what the report and the pull request say: logic, edge cases, error handling, concurrency, data integrity, API contracts | Readability and structure; exploitability |
| `maintainability` | Readability, structure and naming, duplication and reuse of existing code, coupling, complexity, test coverage and test quality, the leads it is given ([§7.4](#74-the-maintainability-aspect)) | Whether a whole feature already exists, only when the context is the design review's; whether behavior is correct or safe |
| `security` | Input validation, injection, authentication and authorization, secrets, unsafe deserialization, resource exhaustion and denial of service, dependency risk | Defects with no attacker-controlled input or trust boundary, which are correctness |

**Design principles in round 2.** The design review judges the change against the
project's principles in N1
([design review §5.6.1](design-pr-design-review.md#561-project-design-principles)).
These reviewers are about details, functionality and algorithms, and they are given
the same principles, read in Fetch by this graph, so they can find violations in the
code. When the profile names a principles file (`questions.principles`) and the
file is present, each reviewer's assignment lists the principles that apply to
**its scope** (a glob matches a file of the review's scope, or the principle names
none), through a bounded listing (a long list is shortened, the rest named by id
with the `git show <commit>:<path>` that reads them), with the file's path and the
ref or commit it was read at. Beside each principle is what round 1 concluded: N1's
verdict and the answer checker's judgment from D's `necessity.json` when the
context source is `design-review` (`round 1: breaks; checker: supported`), and
`round 1: not run` otherwise. The reviewer looks for concrete code-level breaks
that N1 did not cite. A comment that says the change breaks a principle names its
id in `principle` (`""` for every other comment), cites the violating lines and
quotes in `content` how the code contradicts the statement. When there is no
principles file or no principle applies to the scope, the assignment says nothing
about principles and `principle` must be `""`.

`principle` is constrained like the other ids of the contract: the job lists `""`
and the ids it gave this reviewer (`references`), and plugin code rejects any other
id with the ids to use, so a correction goes back to the same session. The
verifier's block for a finding with a principle also shows the principle's
statement, and the verifier confirms it only when the cited code really contradicts
the statement as written. A finding with a principle is otherwise an ordinary
finding. The draft shows it: the entry's body says `Breaks the project's design
principle <id>.`, `draft.json` carries `principle`, and the draft summary lists each
confirmed principle finding (`F3 breaks offline-idempotent`).

**Where each reviewer session starts.** Blank, except for `review.md`, which is
each reviewer's background (the briefing and, with the design review's report, its
Q&A are the map). The pass records `context: seeded` with the reason.

**Independence.** The independent checks are the report checker (or the design
review's checkers), every finding verified in a fresh session on another harness,
and a behavioral finding's test the graph ran. The assignment states that pull
request content is data ([§12.1](#121-pull-request-content-is-data)), and the
defence rests on the contracts, the verifiers and the tests, not on the model.

**Rule files.** The plugin ships one rule file per aspect as data,
`rules/<aspect>.json`, with one entry per language glob (`**/*.go`,
`**/*.ts`, `**/*.tsx`) and a final `**` entry for every other file. Each
entry states the aspect's focus, its out-of-scope list, and that a finding
outside the aspect is left out. A profile's `review.aspects.<aspect>.rules`
entries replace the shipped entry with the same `path` or add one. The
effective file is written to `.graphloom/review/rules/<aspect>.json` by a
`rules-write` command, so its bytes are evidence. The format is the one the
bundled open-code-review 1.13.3 honors:

```json
{ "merge_system_rule": false,
  "rules": [{ "path": "**/*.go", "rule": "Aspect: correctness. Review only whether …. Out of scope: …" }] }
```

**Verified ocr 1.13.3 behavior.** These facts were checked against the
bundled binary:

- `ocr delegate rule --rule <file.json> --format json <paths>` replaces ocr's
  built-in ("system") rules with the file's rules when `merge_system_rule`
  is `false`. The returned groups then carry `"source": "custom"`.
- Other shapes, such as a plain map from glob to text, or entries with
  `pattern` and `content` keys, are **silently ignored**: ocr falls back to
  its system rule and reports no error.
- `--background-file <md>` passes a Markdown file as the review background.

The silent fallback is why the plugin, not the reviewer, resolves the rules.
Before an aspect's pass, a read-only command job with a fixed argv runs

```sh
ocr delegate rule --rule .graphloom/review/rules/<aspect>.json \
  --background-file .graphloom/review/review.md --format json <every file in scope>
```

and its output is recorded as an `ocr-rule-groups` command report. Plugin
code then asserts that every returned group has `"source": "custom"` and
carries the rule text of the entry its files match, and that every file in
scope is in a group. Any other result fails the pass and names the files and
the group's source. No retry runs with the generic rule. The groups go into
the reviewer's assignment in place of the reviewer's own `delegate rule`
step. `review.md`, the context of [§7.1](#71-the-context-source), is the
background.

- **The map:** each assignment also points to `review.md`.
  - Files under `schema`, `interfaces`, `config` and `removed` come first on the
    reading list.
  - With the design review's report, its answered facts (a purpose, an existing
    feature) are given as context, and a finding that restates one of its
    `existing-feature` or `purpose` answers is folded into it rather than raised
    twice.
- **Passes** follow open-code-review's delegation workflow
  (`codeReviewInstruction`, `src/ocr.ts`), with every excluded file added back
  ([every changed file](design-issue-fix-graph.md#every-changed-file-and-the-change-as-a-whole)),
  `WHOLE_CHANGE_CHECK` and `DEDUPE_RULE`, against the aspect's rule groups.
- **Contract `pr-code-review-v1`:** `code-review-v2` plus `side`,
  `suggestion`, `aspect`, `kind` (`behavioral` or `non-behavioral`) and
  `repro` ([§8.2](#82-reproducing-tests)). issue-fix keeps v2.
- **Off-aspect comments.** A comment whose `aspect` is not the pass's is
  verified with the raising pass's findings, by that pass's verifier
  ([§13.1](#131-roles)), and listed under its own aspect. It costs no extra pass.
- **Sweep, rounds and limits apply per aspect.** Each aspect has its own
  sweep of up to `MAX_SWEEP_PASSES` (4) passes on the head. Hitting the cap
  is noted "unsaturated" for that aspect and does not fail the stage.
- **Verification:** after each pass and its reproducing tests, one
  `pr-finding-verification-v2` job (`verificationInstruction`,
  `src/findings.ts:615`, extended for tests) runs for the aspect's pending
  findings, on that aspect's verifier. It verifies every finding that would
  be posted (P0 to P2, and a P3 comment raising a lead drafted at P0,
  [§7.3](#73-leads)), and P3 nits only with `comments.nits`. A suggestion
  is kept only when the verifier says `fixes`, its fix run passes
  ([§8.2](#82-reproducing-tests)), it is within `suggestions.maxLines`, and
  it lies inside the comment's range.
- **Verifier corrections (since 1.1.2).** A verifier can confirm a finding whose
  text gets a checkable fact wrong (#1485's F6 said "All 9 drop sites" where
  there are six). Each verdict of `pr-finding-verification-v2` carries
  `corrections: [{ original, corrected }]` (`[]` for none, at most 5, each side
  at most 400 characters): `original` is a span of the finding's claim, and
  `corrected` the text that replaces it. Plugin code checks every span of a
  confirmation against the claim (whitespace runs match any whitespace, since
  the verifier reads the claim with its newlines folded): a span that occurs
  nowhere or more than once, or overlaps another, goes back to the verifier
  with the other contract problems (two retries, then the supervisor). A
  refuted or uncertain verdict's corrections are dropped. The draft applies
  them ([§8.4](#84-draft)). A verifier's result recorded under
  `pr-finding-verification-v1` (1.1.1 and earlier) still reads, as verdicts
  with no correction.
- **Cross-aspect dedupe.** Each aspect keeps its own findings and verdicts.
  After verification, confirmed findings of different aspects on the same
  path with overlapping lines are linked as one problem (`sameAs`) unless a
  reviewer marked them `distinct`. The draft shows one entry that lists every
  aspect, with the highest severity its proof allows and one proof.
- **Uncertain findings** and unproven behavioral findings are listed under
  "Needs your judgment" and are never posted unless the maintainer moves
  them.
- **Rule checks** (changelog, license header, dependency manifests against
  the license file), when a later version adds them, are pure functions of the
  snapshot, each failure a P2 finding with actor `rule`.

### 8.2 Reproducing tests

**Status (since 0.24, unchanged in 1.0).** Implemented, as the text below specifies unless a bullet says
otherwise:

- **Contract.** `pr-code-review-v1` comments carry `repro` (`{ dir, name, text, expect, oracle }`, every
  field empty when the reviewer writes no test), checked on every pass (`reproProblems`,
  `src/repro.ts`): at most `review.repro.maxTestBytes` (16 KiB), a Go `_test.go` file with its package
  clause declaring the one named `Test` function, or a vitest file declaring the named test, a safe
  repository-relative `dir`, an `oracle` of at most 600 characters, and no test on a non-behavioral
  comment. A problem goes back with the pass (the existing correction, two retries, then the supervisor).
  `pr-finding-verification-v2` carries `test: { demonstrates, reason }`. The verifier reclassifies a
  non-behavioral comment that claims wrong behavior, as before; it then has no test, so it is
  `unproven (no test)`.
- **Runs.** After a pass and before its verifier, each behavioral finding with a test (P0 first, then by
  id) runs in one Docker sandbox command job (`repro-<finding>`, the coverage job's image, limits,
  read-only caches, `{ from: "candidate" }` checkout and no network) through the plugin's fixed
  `tools/repro/repro.sh`. The test text travels as base64 in the argv and is written under the
  container's `/tmp/repro/`, never into the checkout (a test checks that the checkout is unchanged).
  Go uses `go test -overlay`; TypeScript runs vitest on a scratch file with the workspace's own config
  and the `resolveId` hook. The script writes the `graphloom-repro-v1` report: per run `failed`, `passed`,
  `build-failed`, `timeout` or `killed`, the failing location, a panic's frames and the failure message
  (at most 2 KiB, secret-scanned), and the test's SHA-256.
- **Setup (since 0.26.5).** A Go test runs after the profile's sandboxed setup (`metrics.sandbox.go.setup`,
  [§12.2](#122-confinement)), as coverage runs it: a repository that does not commit its generated code (BanyanDB's
  protobuf and mock code) builds nothing without it. The spec carries the same `setup <id> <_base64 argument>…` lines,
  plus `setuptime <seconds>`, so the recorded bytes are the bytes run and the validator recomputes them. Coverage and
  `repro.sh` run the steps through one shared script, `tools/sandbox/setup.sh`. Setup runs once per head: the first job
  to run it (coverage, normally) keeps its outcome in the run's scratch (`@scratch/go-setup`, writable in the Go
  sandbox only when the profile has a setup), keyed by the setup lines, the image's Go version and the inventory of
  the checkout's files, symbolic links and directories before setup: per path, its type and mode, and its content's
  SHA-256 or the link's target. What the setup changed is the difference between that inventory and the one after the
  steps, never a timestamp: a file written with a preserved old timestamp (`cp -p`, an archive), a new symbolic link, a
  file made executable, a new empty directory and a directory's changed mode all count. The changed entries are kept as
  a tar of the checkout's own entries (`--no-recursion`: a changed directory brings only its own entry, since its files
  are listed on their own), so links stay links and modes stay as set. Each test's job then extracts them into its own
  disposable checkout (`tar -xop`: the recorded modes, owned by the job), removes the deleted files and links, then the
  deleted directories deepest first (each must be empty by then, or the restore counts as failed and the steps run
  again), and the report says `setup-restored`. A failed setup is kept the same way, so
  later tests report it without running it again. When a test's job has to run the setup itself, its container gets
  15 more minutes (`perFindingMs` plus 3 minutes plus 15, never more than the sandbox's `wallClockMs`), and the steps
  together get that wall clock less the test's runs. A step still running then is stopped. A step that fails stops
  the job before the test, and the finding is `unproven (the sandbox setup failed (<step id>: <first error line>))`,
  never `inconclusive (build failed)`. The first error line is the first line of the step's whole output that reads
  as an error, else its last line; the record keeps the output's last 25 lines apart from it. A step that runs out of
  time says `did not finish within <n>s`. Go's refusal of the image's version gives the toolchain reason below.
  Known limits of the kept setup, each harmless for code generation: only the checkout outside `.git` is reproduced
  (what a step leaves in `/tmp`, `$HOME`, the build cache or `.git` is not; the build cache is shared anyway); fifos,
  sockets and devices, extended attributes and ACLs, and the checkout root's own mode are not kept; a new hard link to
  an unchanged file is restored as a copy; and a path with a backslash, a tab or a line break is compared by type and
  mode only, so a change to its content alone is not seen.
- **Build tags (since 0.26.5).** The profile's `metrics.sandbox.go.buildTags` reach the test's `go test` as they reach
  coverage's: a `tags a,b` line of the spec becomes `-tags=a,b` (never on the setup; `repro.sh` re-checks the characters
  and drops the tags rather than pass anything else on). A test in a package with tag-guarded files (BanyanDB's
  `querymetrics`) then builds as coverage builds it.
- **Outcome.** `judgeRun` and `settledProof` (`src/repro.ts`, `src/review.ts`) apply the four conditions
  of "Proven" below, and the finding records `proof`: `proven` with the run's record, or `unproven` with one
  of the reasons below. Nothing drafts an unproven finding as P0 or P1, or lets it make the verdict
  `request-changes`; a proven one is drafted normally, its comment says "Proven by a failing test the
  graph ran twice in a sandbox" with the failure, and `draft.json`, `draft.md` and the appendix carry the
  test text and its run for the maintainer. The review comment's label says `proven by a failing test`.
- **`findings-proven`** is a requirement of the Review stage with its own validator and receipt. It
  recomputes every `proven` finding from the recorded test text, the command's report and the verdict,
  and fails when the record does not match what the evidence says.

Differences from the text below, each deliberate:

- **Two invocations, not `-count=2`.** A Go panic ends the test binary, so a second run in the same
  binary never happens and an expected panic could not fail twice. The script runs `go test
  -count=1 -json` twice (the second run uses the warm build cache).
- **No `tsmutate`, so no shared config.** `tsmutate` ([metrics §3.1](design-code-quality-metrics.md#31-tsmutate))
  is not implemented yet. `tools/repro/vitest.config.mjs` is a template the script fills with paths it
  computed: it imports the workspace's own vitest or vite config, sets `test.dir`, `test.include` and
  `server.fs.allow`, and prepends the `resolveId` plugin. The workspace is the nearest directory at or
  above `dir` whose `package.json` declares vitest.
- **Panic attribution** requires a frame in the cited file (not yet inside a changed hunk).
- **Budget.** `timeBudgetMs / perFindingMs` (rounded down, so zero when the budget is under one cap; the profile is not rejected, every finding is then `unproven (repro budget exhausted)`) tests run on one head (default 10), each counted at the
  cap, since the controller records no durations; each run of a test's two gets half of `perFindingMs`.
  The rest are `unproven (repro budget exhausted)`. P0 and P1 first applies within a pass; aspects run one
  after another, so an earlier aspect's tests are not displaced.
- **A later head** does not rerun a proven finding's test: a finding re-judged on a later head has no test,
  so it is `unproven (no test)` there ([§9.3](#93-re-checking-earlier-findings)).

Not implemented (a follow-up): the **fix run** (a suggestion of a behavioral finding is not drafted; the
fix is checked in a later part with the overlay or `load` hook), the **one correction** of a test that is
unproven for a reason the reviewer can fix (only the contract-level correction exists), a reviewer's
**second run** per finding, `tsmutate`/`gomutate` sharing, and the hunk-level panic attribution.

**Rule.** A reviewer who finds a bug writes a test that shows it. Reading the
code is not enough. Each comment declares its `kind`:

| Aspect | `behavioral` (needs a test) | `non-behavioral` (no test, labelled as such) |
|---|---|---|
| `correctness` | Always | Never: the contract refuses it |
| `security` | An exploit condition: crafted input that panics, allocates without bound, bypasses an authorization check, or reaches an injection sink | A committed credential, or the risk of a newly added dependency |
| `maintainability` | A finding that claims wrong behavior | Naming, duplication, structure, coupling, test quality |

The verifier reclassifies a `non-behavioral` comment that in fact claims
wrong behavior. It then needs a test like any behavioral finding.
Non-behavioral findings are drafted at most as P2: they claim no wrong
behavior. The exceptions are lead findings: a confirmed `untested-feature`
finding may be P1, and a confirmed `weak-test`, `split-function`, `crap` or
`reuse` finding is P0 ([§7.3](#73-leads)).

**The test.** A behavioral comment's `repro` holds `{ dir, name, text,
expect, oracle }`:

- `text` is a whole test file in the repository's own framework: a Go
  `_test.go` file (internal or external test package) or a vitest file, at
  most `review.repro.maxTestBytes` (16 KiB);
- `dir` is the package or directory the test belongs in, and `name` is the
  one test it adds;
- `expect` is `assertion` (default) or `panic`;
- `oracle` says where the expected value comes from: the PR text, the
  report, a linked issue, documentation or the code's documented contract,
  never what the head happens to return.

A security test shows the exploit condition safely, inside the sandbox and
with no network: crafted input, then an assertion. Resource exhaustion is
asserted by the test itself, with `testing.AllocsPerRun`, a measured size or
a context deadline followed by `t.Fatal`. A process that the sandbox's memory
or wall-clock limit kills proves nothing.

The reviewer is read-only and never runs the test. Its text travels in the
result, and the graph runs it. The test is never written into the PR
checkout, the worktree or the review clone, and never committed or pushed.
The design therefore needs no checkout-write capability (issue-fix's
[executable confirmations](design-issue-fix-graph.md#executable-confirmations-second-phase)).

**Mechanism per language.** Each run is one graph command job in the Docker
sandbox ([§12.2](#122-confinement)), exactly like the coverage and mutation
jobs: the same image, limits, read-only dependency caches, per-run build
cache and `{ from: "candidate" }` checkout, and no network. The plugin's
fixed `scripts/repro.sh` gets the test text, and any generated file, as
base64 argv, so the bytes run are the bytes recorded. It writes them under
the container's `/tmp/repro/` and runs:

| Language | Mechanism | Command |
|---|---|---|
| Go | **`go test -overlay`**. `overlay.json` maps `/work/<dir>/graphloom_repro_<F>_test.go`, a path absent from the head, to `/tmp/repro/<F>_test.go` | `go test -overlay /tmp/repro/overlay.json -run '^<name>$' -count=2 -timeout <perFindingMs> -json ./<dir>` |
| TypeScript | **A scratch test file under `/tmp/repro/` with the repository's config.** The generated config is `tsmutate`'s ([metrics §3.1](design-code-quality-metrics.md#31-tsmutate)), which imports the workspace's own config, without the mutation plugin. It sets `test.dir` to `/tmp/repro`, `test.include` to the one file, and `server.fs.allow` to `/tmp/repro` plus the workspace. It prepends one `enforce: "pre"` plugin whose `resolveId(source, importer)` resolves every import from the scratch file as if imported from `<workspace>/<dir>/graphloom-repro-<F>.test.ts` | `vitest run --config /tmp/repro/vitest.config.mjs --root <workspace> --retry=0 --reporter=json`, run twice |

Why these:

- **Go.** `-overlay` is the go command's own way to add a file that is not
  on disk. The test compiles as part of its package, so it can reach
  unexported code, with no copy and no write to the checkout. `gomutate`
  already relies on it ([metrics §3](design-code-quality-metrics.md#3-tools)).
  `-count=2` runs the test twice in one job, and `-json` gives
  machine-readable test events.
- **TypeScript.** Vitest finds test files by globbing the disk, so the Vite
  `load` hook that `tsmutate` uses cannot add a test. It can only replace the
  bytes of a module that already exists. A copy of the package under `/tmp`
  breaks module resolution, as `tsmutate`'s rejected alternative records. The
  `resolveId` hook keys on the one scratch path, as the `load` hook keys on
  the one mutated path. Relative imports, workspace packages,
  `node_modules` and `vi.mock` paths then resolve exactly as for a test the
  author would add in `<dir>`, and the repository's transform pipeline
  applies.

**Fix run.** When the finding carries a suggestion, the same job then runs
the test once more with the suggestion applied. In Go, the overlay also maps
the cited file to a fixed copy. In TypeScript, `tsmutate`'s `load` hook
serves the fixed file. **Decision:** the fix run checks the suggestion, not
the bug. A test that passes with the fix keeps the suggestion. A test that
still fails, or a fix that does not compile, drops the suggestion, and the
finding stays proven. A bug is real whatever the quality of a proposed fix,
but a posted ` ```suggestion ` that does not make the reviewer's own test
pass would mislead the author. It costs one extra run, and only for findings
with a suggestion.

**Record.** Each job emits a `graphloom-repro-v1` command report: the
finding, language, virtual test path, the test text and its SHA-256, argv,
image digest, exit code, and per run its outcome (`failed`, `passed`,
`build-failed`, `timeout`, `killed`), the failing location, and the failure
message (at most 2 KiB, secret-scanned, [§12.3](#123-secrets)). The fix run
records its outcome the same way.

**Proven.** The `findings-proven` validator recomputes from these records and
never trusts the reviewer's claim. A behavioral finding is `proven` only when
all of these hold:

1. The graph's run of the recorded text built the package, ran exactly the
   named test, and that test failed in both runs.
2. Each failure is attributable to the cited behavior:
   - for `expect: assertion`, the failing assertion is reported at a line of
     the reviewer's test file (Go: the test's `-json` output lines
     `graphloom_repro_<F>_test.go:<n>:` from `t.Error` or `t.Fatal`;
     vitest: the failure's location in the scratch file and an assertion
     error);
   - for `expect: panic`, the panic or uncaught error's stack has a frame
     inside a changed hunk of the cited file at the head, below the test's
     own frame.

   A compile error, a build failure, a timeout, a sandbox kill, a panic
   outside the cited code, or a failure in setup or in another test is
   `inconclusive`, not proven. A test that fails in one run and passes in the
   other is `flaky`.
3. The test text the verifier judged has the recorded SHA-256.
4. The verifier `confirmed` the finding and judged that the test
   `demonstrates` the claimed bug.

**The verifier's judgement.** `pr-finding-verification-v2` is
`finding-verification-v1` plus, for behavioral findings, `test: {
demonstrates, reason }`, and the `corrections` of
[§8.1](#81-review) (v1, before 1.1.2, had no `corrections`). The verifier reads the test, the recorded run and
the cited code. `demonstrates` is false when the test checks an unrelated
behavior, behavior that the PR text or documentation states as intended, or
an expected value taken from the head's own output.

**One correction.** A test that is not proven for a reason the reviewer can
fix (it does not build, it passes, the failure is elsewhere) goes back once,
with the recorded output, to a seeded session for the aspect's reviewer. The
revised test is run again. Each finding gets at most two runs on the head,
plus its fix run.

**Unproven.** A behavioral finding is `unproven`, with one of these reasons:
`no test`, `test does not fail`, `inconclusive (<kind>)`, `flaky`,
`does not demonstrate` (the verifier), `sandbox unavailable` (Docker,
image or dependency), `the sandbox toolchain is older than the repository
requires` (since 0.26.4, below), `the sandbox setup failed (<step id>: <first
error line>)` (since 0.26.5, above), `execution disabled by the profile`
(`review.repro.enabled: false`), or `repro budget exhausted`. It is never
drafted as P0 or P1, never makes the verdict `request-changes`, and is listed
under "Needs your judgment" with its reason and its test, if it has one. A
profile that does not accept running PR code ([§12.2](#122-confinement))
also turns `review.repro` off. Every behavioral finding is then unproven, and
no finding can make the recommendation `request-changes`.

**Sandbox toolchain older than `go.mod`.** The sandbox runs `GOTOOLCHAIN=local`
with no network, so a `go.mod` whose `go` or `toolchain` line is newer than the
image's Go builds nothing; Go says `go: go.mod requires go >= 1.26.11 (running go
1.26.10; GOTOOLCHAIN=local)`. This is a fact about the profile's pinned image, not about
the test. Plugin code reads that line from the failed run's message, compares the two
versions (`1.26` equals `1.26.0`, a release candidate is older than its release) and, when
the running one is older, makes the finding `unproven` with the reason `the sandbox
toolchain is older than the repository requires (the sandbox's Go 1.26.10 is older than
go.mod's 1.26.11; update metrics.sandbox.go.image)`, not `inconclusive (build failed)`.
Coverage says the same ([§6.8](#68-measurements)). The run does not stop and no budget
changes: the review degrades as before, with the right reason. The check cannot run
before Fetch, because only the head's `go.mod` says what it needs.

**Cost.** A Go run in the build cache that the coverage job warmed takes
about 10 to 60 seconds, and a vitest run 5 to 30 seconds. Each run is capped
at `perFindingMs` (default 3 minutes), and all runs on one head, across the
three aspects, at `timeBudgetMs` (default 30 minutes). Findings left when the
budget runs out are `unproven (repro budget exhausted)`; P0 and P1 findings
run first. Runs go one at a time and share the run's build cache.

### 8.3 Checks

There is no Checks stage in 1.0: the profile refuses `checks` as a later version's
field. When it comes, contributor code will run only in a `{ from: "candidate" }`
checkout inside the Docker sandbox (`checks.sandbox`, [§12.2](#122-confinement)),
with no network, no credentials, no host home, limits on CPU, memory and
processes, and dependencies from read-only caches only; a missing cached
dependency will mean "not run", and a failing check a P1 finding with actor
`check`. GitHub CI status is shown in the report.

### 8.4 Draft

Plugin code composes the draft from the aspects' records (no model writes it)
and writes it to `draft.json` (`pr-review-draft-v2`, canonical) and `draft.md`.
The reporter writes only a prose summary (`review-summary-v1`, at most 1,200
characters). Confirmed findings are the comments, grouped by aspect, at most P2
unless proven, a confirmed `untested-feature` finding at P1, or a confirmed
`weak-test`, `split-function`, `crap` or `reuse` finding, always at P0 ([§7.3](#73-leads)); unproven
behavioral and disputed findings are listed under "Needs your judgment". The
recommendation is computed ([§10.3](#103-verdict)). The draft is what the Publish
stage posts from ([§8.5](#85-publish)), as it is composed: nobody edits it.

**One priority per finding (since 1.1.1).** A finding's priority is its final one,
the priority of the draft entry it is in (as its primary or linked finding), wherever
a person sees it or the ledger stores it: `draft.json` (its entries and its report
part), `draft.md`, the Review section and appendix of `review.md`, the grid and
appendix of the HTML report, the posted review, and the ledger's findings
([§9.1](#91-where-the-ledger-lives)). An unproven behavioral finding the reviewer
proposed at P0 is P2 everywhere; a `reuse` finding proposed at P3 is P0 everywhere.
An entry under "Needs your judgment" has the priority the same rules give it (an
unproven one at most P2; `draft.md` names none in its heading, as before). A
dismissed finding is in no entry and shows and stores no priority; a P3 nit is only
counted. The reviewer's proposed priority is kept only in its aspect record
(`review-aspect-<aspect>`), which the validators recompute from, and is never shown
or copied elsewhere. `draft-composed` recomputes every priority `draft.json` holds and
fails one that differs, naming it; `review-published` does the same for the ledger
patch it records.

**A verifier's corrections reach the posted text (since 1.1.2).** A confirmed
finding's text is its claim with its verifier's `corrections`
([§8.1](#81-review)) applied: each span is replaced where it occurs once in the
claim and overlaps no other, by plugin code, before the body is composed. That
corrected text is the finding's text wherever it is shown: the draft entry's body
(and so the posted comment and the ledger's item text), `draft.json`'s report part,
`review.md` and the HTML report, whose appendices also say what the verifier
corrected. A correction that cannot be applied in place (a record not checked as
v2 checks it) is not dropped: the body says it on a line of its own, `Corrected by
the verifier: "<original>" should read "<corrected>".` A disputed or dismissed
finding's corrections are never applied. The aspect record keeps the reviewer's
text and the verdict's corrections; `draft-composed` recomputes the corrected body
and fails a `draft.json` whose entry ignores a correction, naming the finding and
the span.

**No Q&A item is drafted.** The body has a section "Design review (round 1)",
from the `design` section Fetch read (its latest head with a recorded outcome):

- with open items: `Design review at <sha7> (this head)`, or `Design review as of
  <sha7>; run pr-design-review on this head to re-check them`, then each open
  item (`N1`, `Q<n>`) on a line that says what it is and its state (since 1.1.2):
  its id, its state (`open on this head`, or `open as of <sha7>, not re-checked on
  this head` when the design head is another one), its question, and a link to
  its comment, or `(not posted)` when that run did not post it:
  `- Q4 (open as of 8382af2, not re-checked on this head): What aggregation
  contract should operators use …? [comment](<link>)`. The question is the design
  head's `qa.json` question when the run read that head's records (the
  `design-review` context), else the first paragraph of the item's posted text
  after its `**<label>** (<id>).` lead-in (N1's is "Is this change necessary?"),
  on one line and clipped at 200 characters. No model writes it, and the counts
  are unchanged. Nothing of round 1 is posted again;
- with none: `Design review at <sha7>: no open item.`;
- with no design head: "Round 1 (the design review) was not run on this pull
  request; the verdict counts this review's findings only."

The section is a lead line and its items (`round1Section`), and each surface nests
the items under the lead: `- <item>` in the posted body and in `draft.md`'s and
`review.md`'s round-1 lines, indented two spaces under the lead's own bullet in
`draft.md`'s "For the maintainer" list (1.1.1 rendered those as `- - Q4: …`), and a
list in the HTML report.

### 8.5 Publish

The last stage posts the review; the post itself is the kit's (`kit/post.ts`),
parameterized by the graph's head marker, and the design review's differences are
in [its §9](design-pr-design-review.md#9-publish-and-the-runs-result). There is no
approval to wait for: the run decides, posts, and ends. It posts **one** review through the generic
`graphloom.github/create-pull-review` executor (`executors/github/src/executors.ts`),
whose `github` credential the runner binds ([§3.3](#33-credentials)); the plugin
names the executor and passes bytes, never a token. `commitId` is the pinned
head and the event is always `COMMENT`.

1. **What it posts** (`src/publish.ts`, from the records, not from a model):
   - round 2's postable findings: the draft's comments that are findings, and
     the round-1 section of [§8.4](#84-draft) (nothing of round 1 is posted
     again);
   - the **verdict as the body's first line** ([§10.3](#103-verdict)): `Review
     passed` when no `F` finding (new or earlier) is open and no round-1 item is
     open, else `Changes requested: <n> open`;
   - since 0.22, on a later head, an **Earlier items** section of the body: each earlier open
     item as `fixed in <sha7>` or `still open` with a link to its earlier comment
     ([§9.3](#93-re-checking-earlier-findings)). A still-open item is not posted again, unless
     its old thread is outdated on GitHub and its anchor was found again, when it is
     commented again at its place on this head, with its same marker;
   - an item with a diff anchor (a hunk of the file's patch at the head, on its
     side) is an inline comment, at most 50; the others are in the body;
   - each item ends with its marker, `<!-- graphloom-finding: F3 -->` (the
     design review's `N1` or `Q3`), and the body's second line is the graph's head
     marker, `<!-- graphloom-review: <head sha> <nonce> -->` here, which marks the head
     and this run (the nonce is the operation id of the stage's viewer read, so a
     stranger cannot know it). A design review item carries its **whole answer**,
     then **every citation** as a link to the file at the pinned commit of its tree
     (head or base; a dependency as `name@version` text); nothing is clipped to a few
     hundred characters. An item may take at most 12,000 characters
     (`MAX_ITEM_TEXT`), and GitHub accepts 65,536 in one comment. A longer posted
     body, inline or not, is shortened at a sentence end, else at a word boundary,
     never inside a word, before its marker is appended (a merged design-review
     item's covered answers are built by the same rule); the whole text is kept for the ledger and the input fits an
     executor's 256,000 bytes. A read cuts a body at 4,000 characters, so a body longer
     than that also leads with its marker, and an id is read back from the marker that
     starts or ends a comment's body. Marker-looking text in an item's content is
     neutralized (`<!--` becomes `&lt;!--`).
2. **Reconcile before posting** (core design: reconcile ambiguous effects before
   retrying). The stage first reads who the credential is (`graphloom.github/get-viewer`,
   `GET /user`), then the pull request's reviews (`list-pull-reviews`, paged by
   its own cursor flow, apart from Fetch's snapshot), and looks for a review of
   this head that this run posted: authored by that login, in state `COMMENTED`, and
   carrying the head marker with this run's nonce. The marker alone proves nothing (the head
   sha is public), so a review by anyone else, in another state or from another
   run is ignored. Found, from an earlier attempt of this run: nothing is posted and
   that review is the one (a later run on the same head posts its own). Not
   found: it posts with the idempotency key `review-<head12>` (the design review's
   `design-<head12>`), which
   the executor also reconciles by its own marker. An attempt that failed or
   whose outcome is unknown is followed by a fresh read of the reviews before
   anything else; a read that shows nothing allows the next attempt, at most
   three, then the supervisor.
3. **Read back.** The stage reads the review's comments
   (`list-pull-review-comments`, every page) and takes each inline item's comment id
   from its marker. A missing id is never recorded as null: the comments are read again
   (at most three whole reads), then the supervisor gets the missing item ids.
   Items not inline are never reduced to ids: when they do not all fit the body, an
   anchored one moves inline, the rest shrink evenly with their markers, and the ledger
   keeps each shortened item's whole text; if even that cannot fit, the stage escalates
   instead of posting. The whole input of the executor call, body, every inline comment
   and the JSON around them, is also measured in UTF-8 bytes against the executor's
   input bound (256,000, less a margin of 1,000): when it is over, items, inline ones
   included, are shortened largest first until it fits, and when none can shrink further
   the plan carries a `problem` and the stage escalates. A fenced block, a suggestion, is atomic: a shrinking item drops it whole first, with `(suggested change omitted for size; see the report)`, and only then has its prose cut; no posted text keeps an unclosed fence. A design review item is shortened by what matters least first: the
   end of the answer, cut at a sentence end, else a word boundary, followed by `(answer shortened; the full answer
   is in the report's Q&A, <id>)`; its citation links stay and, only when even one link per line is too much, all but the first are counted
   (`and <n> more in the report's Q&A, <id>`). Nothing is cut without saying so.
4. **Record.** The review id and the ids are evidence (the executor's and the
   reads' results) and are written to the graph's own ledger section by
   `ledger-published` ([§9.4](#94-section-writes-markers-and-migration)): one
   more commit that sets `reviewId` (and `verdict`, `open`) on the head and a `github` entry (`reviewId`, `commentId`, `inline`)
   on each item (a compacted item's whole text as `body`; since 0.22 also its text, key and
   anchor, and each earlier item's status for this head, with a `withdrawn` entry for each
   finding a verifier dismissed), by compare-and-swap from the
   ref's value it reads in the same command. The patch can be far past one argument, so
   it is written first as a bounded part set with a digest (`publish-patch-p<k>`, as
   `report.json` is) and the command reads the file; a review the ledger already holds
   is a no-op.

**Posting is the operator's to enable (since 0.23.1).** Without `github.writeTokenEnv`
the runner does not grant the `write` effect to `create-pull-review`. The stage reads
that from the run view (`executors[].effectGranted`, declared data the controller
does not interpret) before it dispatches anything, and ends the run with
`posting not enabled`: "draft ready; posting is not enabled (set the runner config's
`github.writeTokenEnv` and resume to post)", naming the draft (`.graphloom/review/draft.md`)
and the report (`.graphloom/review/review.html`) in the run's worktree (the design review's
names the report and the round-1 record, `.graphloom/review/round1/round1.json`, and a clean
design review that posts nothing never stops here). Everything before
Publish stays accepted, nothing is read from or written to GitHub, and no supervisor episode runs.
The clean stop relies on the runner reporting its grants (every built-in runner does); a runner that
reports none leaves the write to the controller's normal refusal and recovery. The stop is
**final** (`retryable: false`): a plain resume would only repeat it, and the controller keeps
a final stop held until something it depends on changes. Granting the effect is such a change
([core design §8](design-typescript-core.md#8-version-transitions-and-crash-recovery)): the stop mark records
the effects granted to each executor, so `resume` after setting the variable runs the run
again, and Publish posts. A failure recorded before that resume predates it and does not count.

## 9. Incremental re-review

A run reviews one head and ends; what a later run does with the earlier runs'
ledger is this section. **Continuity:** ids continue across heads (`N1` and
`Q<n>` in the design section, `F<n>` in the review section), and the same item on
a new head maps to its earlier id by a stable key ([§9.1](#91-where-the-ledger-lives)).
**Re-checking:** every earlier open item of a graph is judged on the new head by
that graph: the design review's by its new round 1
([design review §7](design-pr-design-review.md#7-a-later-head)), `pr-review`'s by
the aspect reviewers and their verifiers ([§9.3](#93-re-checking-earlier-findings));
closed items are never raised again. **Reporting:** the posted review lists each
earlier item as fixed (in which commit) or still open (with a link to its comment)
and counts the open ones in its verdict ([§8.5](#85-publish)), and the ledger
records each item's status per head. Not implemented: the commit and file mapping
for round 2's scope (round 2's scope on a new head is the same as on a first), the
rerun of a proven finding's test on a later head, a verifier's judgment of an
author's dispute, and the threads' own resolution state as an input.

### 9.1 Where the ledger lives

The ledger lives at **a Git ref in the operator's review clone**,
`refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`, shared by both graphs. Its
commit's tree (`graphloom-pr-ledger-v2`):

```text
ledger.json            graphloom-pr-ledger-v2: { schema, pull: { owner, repo, number }, sections: ["design", "review"] }
design/ledger.json     pr-design-review-ledger-v1
design/ledger.md
design/report.json     the latest design head's report, Q&A and necessity record
design/qa.json
design/necessity.json
review/ledger.json     pr-review-ledger-v1
review/ledger.md
```

- The top-level `ledger.json` is written once, by whichever graph creates or
  migrates the ledger, and never changed by a section write. A section absent from
  the tree is a graph that has not run on this pull request.
- `design/ledger.json`: `heads: [{ sha, base, files, commits, facts, round1:
  "items" | "clean", open, reviewId?, reviewUrl?, note? }]`, `purposes`, `qa: [{ id,
  type, key, symbol, item, status, answer, state, history[] }]` (earlier questions
  not asked on this head are kept, so their ids are never reused), and `items`, one
  entry per posted round-1 id with `state` `open`, `fixed`, `moved` or `superseded`.
- `review/ledger.json`: `heads: [{ sha, base, context: { source, head? }, round1: {
  head, open } | null, reviewId?, reviewUrl?, verdict?, open?, leads: { given,
  raised } }]` and `findings`, one entry per `F<n>`.
- **Posted items.** One entry per posted item id, whatever head posted it: `{ head
  (first posted), id, origin, key, state, path, line, endLine?, side?, aspect?,
  severity?, kind?, anchorText?, patchId?, hunk?, text, body?, github: { head,
  reviewId, commentId, inline }, fixedIn?, history: [{ head, status, reason?,
  carried?, reposted? }] }`. A finding's `state` is `open`, `fixed`, or `withdrawn`
  (a finding a verifier dismissed, never posted, kept so it is not raised again).
  A finding's `severity` is its final priority, the one it was posted at
  ([§8.4](#84-draft)); a withdrawn one has none (since 1.1.1).
- **Sections 1.0 and 1.1.0 wrote.** They stored the reviewer's proposed priority in
  `severity`, but posted the final one, and a posted item's `text` starts with its
  label (`**[P0] critical** · …`, after any `**Still open** (first raised on …).`
  lead-in of a repost). A later run reads a posted finding's priority from that
  label, and the stored `severity` only when the text has none (a withdrawn finding,
  or a 0.21 item); the section is not rewritten for it, but a finding this run
  records at a new place or posts again is written back at the priority read.
- **Ids and keys.** Each graph numbers from its own section only. A new finding
  takes the number after the highest `F`; a question whose stable key the section
  holds keeps its id. The key of a design question is `necessity|N1`, or its type
  and the high-level change's first cited path (`existing-feature|item|<path>`); the
  key of a finding is its aspect and its anchor (the file and the text of the
  commented line).

The ledger is **durable** (`graphloom delete` removes only the run's worktree,
branch and state), **atomic** (`git update-ref <ref> <new> <old>`), needs **no new
permission** (the write is a read-only command job) and is **inspectable**
(`git log -p <ref>`). GitHub hidden markers were rejected as the store: they exist
only once something is published and others can edit them. Posted comments still
end with `<!-- graphloom-finding: F3 -->` (or `N1`, `Q3`), so a ledger could be
seeded from them if the ref is lost.

**Reads.** Fetch lists the ledger commit's paths and reads the section files it
needs in parts (`ledger-prior`, `ledger-prior-<k>`, each printing a header with the
part count and the digest of the whole), all from the one commit it read the ref
at. `pr-review` reads `review/ledger.json`, `design/ledger.json` and, when the
context source may be `design-review`, the design head's three records.

### 9.2 Mapping a new head to the last reviewed one

L is an earlier head the ledger holds and H the new head; Lb and Hb are their
pinned bases. The design review uses this for N1's carry inputs, and `pr-review`
for a design report of an earlier head D (L = D). Fetch records, in the review
clone, with no repository code and no hook, two reads:

1. **The head delta:** `git diff -U0 --no-renames L H` over the files H's change
   touches and the files L's records cite, reduced to its file headers and hunk
   headers (`@@ -a,b +c,d @@`).
2. **The base delta:** for each base-tree path L's records cite, whether it differs
   between Lb and Hb.

Plugin code reads what those say, never a model:

- A range of lines is **changed** when a hunk touches it. For a range at H, a hunk's
  new side overlaps it, or a deletion lies inside it or on its edge. For a range at
  L, a hunk's old side does. A file with a header and no hunk, and a file added or
  deleted whole, is changed whole.
- A base citation is changed when its file differs between Lb and Hb. A dependency
  citation is changed when the declared dependencies differ.
- A line at L maps to its line at H by the offsets of the hunks before it.

Rebasing, merging the base or squashing need no separate rule: the diff is between
the two trees.

**The delta is not usable**, and the reason is recorded, when L's records are not in
the ledger commit or not of L, L and H are not of one mode (large mode's high-level
changes are rewritten every head), L's commit or Lb is not in the review clone, or
the diff fails, does not fit one command report, has a header the reader cannot
parse, or cannot be told complete. Both reads write their output to the report
file, never the stdout tail, and any doubt about completeness makes the delta
unusable. For the design review, `questions.incremental: false` also makes N1
asked again.

### 9.3 Re-checking earlier findings

`src/prior.ts`, `src/priorreview.ts`, `src/review.ts`. Each earlier open `F<n>`
finding is re-anchored to the new head: shifted when its file's patch is unchanged
(the patch with its hunk numbers stripped has the same id, so the finding moves by
its hunk's offset), else found by its `anchorText` within ±20 lines of its old place
in the new patch, else marked outdated; a finding whose file is no longer in the
pull request is `fixed` (its file left the change), and one whose file lies outside
this review's scope (large mode) is carried open, not re-checked. The rest are given
to their aspect's reviewer in its first pass, as `prior` findings (their text is
data): the reviewer returns `still_present` or `fixed` for each, with a reason. The
verifier confirms the ones still present like a new finding: `confirmed` keeps it
open, `refuted` (with quotes of the head that the tree check verifies) makes it
`fixed`, and anything it cannot settle leaves it open. A finding the reviewer calls
`fixed` is closed without a verifier job. Earlier findings are judged in the first
pass only; a finding a 0.21 run posted records no aspect or kind and goes to the
maintainability sweep.

| This head says | Result | Review body says |
|---|---|---|
| `fixed` by the reviewer, or the verifier refutes `still_present` | `fixed` | fixed in `<sha>` |
| `still_present` and confirmed (or not settled) | still open; a new inline comment only if the old thread is outdated on GitHub **and** its anchor was found again on this head (posted at that place). An anchor not found again is never posted at its old coordinates: the item is listed in the body with its link and the ledger marks it `outdated` | still open (link), or "its old thread is outdated, so it is commented again" |
| The file is outside the scope | still open, not re-checked | still open (link), with the reason |
| A new finding a verifier dismissed | recorded `withdrawn` | not listed |

Status goes in the **review body** with links (`…/pull/<n>#discussion_r<commentId>`,
or the review's own link for an item posted in a body); REST review submission
cannot reply in threads ([§19](#19-deferred-items)).

**Never raised again:** `fixed` and `withdrawn` findings are closed. A new comment
of a pass that overlaps a closed finding (or an earlier one being re-checked) on the
same file and side, at its place on the new head, is dropped before verification and
counted in the pass record (`suppressed`).

### 9.4 Section writes, markers and migration

**Writing a section.** Each graph advances only its own section, by
compare-and-swap on the ref, in one read-only command job:

1. it reads the ref's current value `cur` (absent: the zero id);
2. it checks that `cur`'s tree has, at its own section, exactly the section's
   **baseline**: the subtree this run's own latest accepted ledger write produced
   (each graph writes its section twice in a run: after the Q&A or the draft, and
   again in Publish, `ledger-published`), or, before its first write, the subtree
   Fetch read. The baseline is named in the command's argv, so it is evidence. When
   `cur`'s section differs from it, another run of the same graph advanced the
   section: the run stops retryably, "ledger moved";
3. it builds the new root tree from `cur`'s with its own section's subtree replaced
   (and, when `cur` is absent or a v1 commit, the migrated layout below), and a
   commit whose parent is `cur`;
4. it runs `git update-ref <ref> <new> <cur>`; a lost race starts again from 1, at
   most three times, then "ledger moved".

A concurrent run of the other graph on the same pull request therefore never stops
this one: its section is carried over from `cur` unchanged. The command's record
names `old`, the baseline, `cur` and the new commit, and `ledger-cas` (in the design
review, `answers-complete` and `review-published`) recomputes them. When another
`pr-review` run recorded findings after this run's Fetch, this run's draft is stale
and Publish stops, final, "ledger moved", rather than post it.

**Head markers and idempotency.** Each graph has its own head marker, the body's
second line, so a design-review post and a PR-review post on one head are told
apart before the nonce is compared:

| Graph | Head marker | Idempotency key | Section that records it |
|---|---|---|---|
| `pr-design-review` | `<!-- graphloom-design-review: <head> <nonce> -->` | `design-<head12>` | `design` |
| `pr-review` | `<!-- graphloom-review: <head> <nonce> -->` | `review-<head12>` | `review` |

Item markers (`<!-- graphloom-finding: N1 -->`, `Q3`, `F3`) are unchanged; the id
prefix says which graph owns an item. Marker-looking text in an item is neutralized
for both head markers.

**Migrating a v1 ledger.** A ledger whose `ledger.json` is `graphloom-pr-ledger-v1`
(pr-review 0.21 to 0.26) is read by both graphs, migrated in memory, and migrated in
the ref by the first write of either. The migration is one pure function in the kit
(`migrateV1`, `kit/ledgerv2.ts`), so both graphs build the same v2 tree from the
same v1 commit, and the validators recompute it.

| v1 | v2 |
|---|---|
| `heads[]` | Every head goes to `design.heads`: `round1: "issues"` becomes `items`, `clean` stays, `skipped` becomes `clean` with a note. A head with `reviewed: true` also goes to `review.heads`, with its review id, verdict and open count, and the context `design-review` of that head (`prelude` when round 1 was skipped) |
| `qa[]`, `purposes` | `design.qa`, `design.purposes`; a high-level `existing-reuse-common` key is rewritten to `existing-feature` |
| `findings[]` with an `N1` or `Q<n>` id | `design.items`, with the state rules below |
| `findings[]` with an `F<n>` id | `review.findings`, unchanged |
| `report.json`, `qa.json`, `necessity.json` | `design/`, as the latest design head's records |

An open v1 round-1 item whose question type round 1 no longer asks is closed with a
reason, and neither graph re-checks or counts it: **`moved`** for `missing-test`,
`split-function`, `complexity-coverage`, `weak-test` and a per-symbol
`existing-reuse-common` ("a detail question since the split; the PR review judges it
as a lead"; `pr-review` computes the lead again when the gap is still there), and
**`superseded`** for a `purpose` or `other` question about a change item or a symbol
("round 1 now asks per high-level change"). The next design review that posts lists
each once, with its reason and a link to its earlier comment.

**0.26.x and a v2 ledger.** 0.26.x reads a ledger only when its schema is
`graphloom-pr-ledger-v1`; any other schema stops its run in Fetch as unreadable.
Once a v2 writer (pr-review 0.27 or later, or `pr-design-review`) has written a pull
request's ledger, 0.26.x cannot review that pull request again, and it never
overwrites the v2 ledger. This is one-way on purpose: a v1 writer would drop the
sections it does not know.

## 10. Draft format and comment style

### 10.1 Files

`draft.json` (`pr-review-draft-v2`) is canonical: the pull request, head and
base, the verdict and the recommendation, the summary, the comments (`{ id,
aspects, severity, proof, path, side, startLine?, line, body, suggestion? }`), the
entries for the maintainer's judgment, the earlier findings, and the round-1 part
of [§8.4](#84-draft). Every comment is a finding, and every `severity` the file
holds, an entry's or a finding's in its report part, is the final one
([§8.4](#84-draft)). `proof` is
`proven` (with the test, its virtual path and the failure summary),
`non-behavioral`, or for an entry under "Needs your judgment" `unproven` with
its reason. Findings are grouped by aspect, in the order correctness,
security, maintainability; a finding linked across aspects sits under the
first and lists them all. `draft.md` is a rendering; nobody edits it, and the
Publish stage posts from the records ([§8.5](#85-publish)):

````markdown
# Review of apache/skywalking-banyandb#1234 at 9ab2…41
Verdict: request-changes        <!-- recommended: request-changes -->

## Summary
…
## Comments
### Correctness
#### F3 · P1 · correctness, security · banyand/measure/write.go:118-121 · RIGHT
The flush error is dropped when …; return it so the caller retries.
Proven by a failing test: `TestFlushReturnsWriteError` fails at the head (2 of 2 runs): `flush error = <nil>, want "disk full"`. The suggestion makes it pass.
<details><summary>Reproducing test (not part of this PR; adopt it if useful): banyand/measure/graphloom_repro_F3_test.go</summary>

```go
package measure

import (
	"errors"
	"testing"
)

func TestFlushReturnsWriteError(t *testing.T) {
	w := newWriter(failingSink{err: errors.New("disk full")})
	if err := w.Write(sample); err == nil || err.Error() != "disk full" {
		t.Fatalf("flush error = %v, want %q", err, "disk full")
	}
}
```
</details>

```suggestion
	if err := w.flush(); err != nil {
		return err
	}
```
### Maintainability
#### F7 · P2 · maintainability · non-behavioral · banyand/measure/write.go:60-95 · RIGHT
`encodeBlock` and `encodeTail` repeat the same 30-line header encoding; one helper would keep them in step.
#### F8 · P1 · maintainability · untested feature · pkg/schema/ttl.go:14 · RIGHT
Group retention by TTL (W1) has no test: no test of the pull request or the base exercises `ParseTTL` or its caller, and coverage executed none of their statements.
## Design review (round 1)
Design review at 9ab2c41 (this head): 1 open item:
- Q2 (open on this head): What is the purpose of the retention change? [comment](…)
## Needs your judgment (move an entry into Comments to post it)
### F5 · security · unproven: test does not fail · banyand/liaison/grpc/route.go:91 · RIGHT
A group name with `../` may escape the data root … The reviewer's test passed at the head (2 of 2 runs).
## For the maintainer (never posted)
…
````

### 10.2 Validation

The draft is composed by plugin code and the Publish stage posts the comments that are findings, as composed. Validation
refuses what GitHub or safety would refuse, and the posted comments are checked
the same way:

- An anchor must lie in a hunk of the file's GitHub patch at the head, on the
  given side, to be an inline comment; a comment on a file without a patch, or
  outside any hunk, goes in the review body.
- A suggestion must span exactly its `RIGHT` range; it is kept only when its
  verifier said it fixes the finding and it is at most 20 lines.
- Bodies must be non-empty and under 65,536 characters.
- No private reference, no secret ([§12.3](#123-secrets)) and no forged marker.

An entry under "Needs your judgment" (an unproven or disputed finding) is not
posted: nobody is there to judge it, and it stays in the draft and the appendix.

### 10.3 Verdict

Two verdicts exist. The **posted verdict** is the first line of the review's
body and the review's event is always `COMMENT`:

- `Review passed` when no `F` finding, new or earlier, is open and no round-1 item
  is open;
- `Changes requested: <n> open` otherwise, `n` counting the open `F` findings,
  earlier ones included, and the open round-1 items the body lists. Without a
  round-1 record (round 1 was not run), `n` counts the findings only.

The design review's verdict line counts its own open items
([design review §9](design-pr-design-review.md#9-publish-and-the-runs-result)).

The draft's **recommended verdict**, which is internal and shown in the report,
follows from the ledger:

- `request-changes` when a confirmed and proven P0 or P1 finding, a confirmed
  `untested-feature` finding at P1, or a confirmed `weak-test`,
  `split-function`, `crap` or `reuse` finding (drafted at P0,
  [§7.3](#73-leads)) remains open. Otherwise only behavioral findings reach P0
  or P1, and only proven ones are drafted there ([§8.2](#82-reproducing-tests));
- `comment` when only P2 or P3 findings remain;
- `approve` only when nothing is open.

Neither is ever posted as `APPROVE` or `REQUEST_CHANGES`: the event is `COMMENT`
([§12.5](#125-never-auto-approve)), so a recommended `approve` is drafted as
`comment` and means `Review passed`, and `request-changes` means `Changes
requested`.

### 10.4 Comment style

- Findings are concise and actionable: what fails, under which input, what to
  do. The design review's items are its questions with their answers and
  evidence.
- Cite `path:line` at the head. Never a run id or a `.graphloom` path
  (`withoutBookkeeping`).
- Labels: `**[P0] critical**`, `**[P1] major**`, `**[P2] minor**`,
  `**[P3] nit**`, `**[question]**`, followed by the aspects
  (`correctness`, `maintainability`, `security`) and, for a finding that
  needs no test, `non-behavioral`.
- A proven finding carries its reproducing test as a collapsed `<details>`
  block, named by its virtual path, with the failing assertion summarized.
  The author may adopt it; GraphLoom never pushes it.
- No model reasoning and no private references. `@`-mentions other than the
  author are escaped. The optional `footer` goes on the body only.

## 11. Approvals

**None.** Neither graph declares an approval, and no operator decision is part of
a run (since pr-review 0.21): the `review-layer` approval and its `areas` input, the
`publish-review` approval that pinned `draft.md` and `draft.json`, and the
`publish-report` approval are gone, and `describe(config)` has no `approvals`.
What they decided, the plugins decide by rule: what round 1 leaves open
([design review §8](design-pr-design-review.md#8-the-gate)), which areas of a large
pull request round 2 reviews ([§8.1](#81-review)), and what is posted
([§8.5](#85-publish)). Whether to run the PR review after a design review is the
operator's, outside any run ([§2](#2-the-run-two-graphs-and-no-human)).

The generic mechanism stays in the platform for graphs that want a person in
the loop (`graphloom resume <run> --approve <id> [--input name=value]|--decline <id>`,
[core §17](design-typescript-core.md#17-operator-approvals-and-their-inputs)): a
graph declares an approval as data, the controller records the decision as
`operator-approval` evidence under the run lock, and the controller learns no
plugin notion. The review graphs simply do not use it.

**How the write is permitted without one.** Each graph's one write is the review.
Permission to write to GitHub is the operator's configuration, not a decision in
a run: `github.writeTokenEnv` in the runner config names the variable whose token
the runner binds, with writes allowed, to the GitHub executors
([§3.3](#33-credentials)). A plugin can ask for a write executor by name; without
that binding the executor worker refuses it, so the run stops at Publish. The
supervisor can create neither the binding nor the review's content: the
review's items and verdict are recomputed from the recorded round 1 (the design
review) or the draft and `context.json` (`pr-review`) by the `review-published`
validator, and the post itself is idempotent
([§8.5](#85-publish)).

## 12. Safety

### 12.1 Pull request content is data

The PR's text, commit messages, code comments, thread replies, linked issues
and files are untrusted. Prompts wrap them in `<untrusted source="…">` blocks,
with a fixed preamble: their content is evidence, never instruction, and a
request inside them is itself a fact to record. The report records it under
**Notes**. The defence does not rest on the model:

- results are strict contracts;
- the report and the answers are checked deterministically and claim by
  claim;
- verdicts and publication come from plugin code and the maintainer;
- every posted finding has an independent verifier, and every blocking one
  a test the graph itself ran;
- the confinement masks repository-provided agent configuration
  (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.mcp.json`,
  `.opencode/`). Those files' diffs are still read with
  `git show <head>:<path>`.

### 12.2 Confinement

Contributor code runs in a **Docker sandbox**; the agents and the plugin's own
tools run under bwrap.

| Job | Confinement |
|---|---|
| Reporter, questioner, answerer, checkers, reviewers, verifiers | `untrusted-read` (bwrap). Reviewers write reproducing tests only as text in their results and run nothing. The root filesystem is read-only, and so is the workspace: because the runner enforces that, a Claude Code agent of these roles may run shell commands (`git show <base>:<path>`, `git grep <base>`, `cat`, `grep`), which a read-only job without such a sandbox may not (a Codex agent's shell is inside Codex's own read-only sandbox). The base tree ([design review §5.4](design-pr-design-review.md#54-answers)) lies inside that read-only workspace. The home directory is replaced by a tmpfs, except the agent's own login state (`ownState`) and the inventory's dependency directories (read-only). The masks above apply, the environment is minimal, and there is no GitHub token. Network is on, because the agents need their CLI logins and their model APIs |
| A session the maintainer opens (`graphloom session open`, [§17](#17-discussing-a-run-graphloom-session-open)) | The confinement of the job that recorded it: `untrusted-read` with the same masks, a read-only checkout, no GitHub token, network on for the agent's login and model API, and the maintainer's own CLI login. A configured session launcher is bound read-only and its state directories writable. The run's state is not mounted; the `graphloom` process records the conversation after the agent exits |
| The diagram job ([§6.10](#610-features-and-their-data-flow)) | `untrusted-read` (bwrap) like the other agents, with the vendored skill's directory bound read-only, and told not to read the repository |
| The skill's checks on a diagram (`diagram-check-<attempt>-<n>`) | bwrap with no network, read-only, the plugin's directory read-only: `python3` runs the skill's `self_check.py` and `verify-geometry.py` on a scratch file in the run's temporary directory |
| Static metrics (`gometrics`, `tsmetrics`) | bwrap with no network, read-only, binding the plugin directory, the Go root, the Node installation and the `typescript` package as Node resolves it from the plugin (a release install keeps it in an ancestor `node_modules` beneath the hidden home). They run the plugin's own parser over the head tree and execute none of it, so they always run, with or without Docker |
| Checks, coverage, mutation, reproducing tests: **everything that runs PR code** | `sandbox: docker` (below) |
| Materialize, searches, writes | Graph commands with fixed argv over pinned trees. No repository code runs |
| GitHub reads and writes | The sandboxed executor package |

**The Docker sandbox.** Each job that runs PR code is one `docker run`:

```sh
docker run --rm --pull never --name graphloom-<run>-<op> --label graphloom.run=<run> \
  --network none --cpus <cpus> --memory <mem> --memory-swap <mem> --pids-limit <pids> \
  --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=<tmp> --user <uid>:<gid> \
  --cap-drop ALL --security-opt no-new-privileges \
  -v <checkout>:/work -v <run build cache>:/cache \
  -v <GOMODCACHE>:/go/pkg/mod:ro --env HOME=/tmp --env GOFLAGS=-mod=readonly --env GOPROXY=off \
  --env GOCACHE=/cache/go -w /work <image>@sha256:<digest> <argv>
```

- **Built by the runner, as shipped in P1.** The platform piece is generic
  (`packages/runner/src/sandbox-docker.ts`, [core design](design-typescript-core.md#a-jobs-own-confinement)).
  The `/tmp` tmpfs is mounted `exec` because Docker's default is `noexec`, which
  stops `go test` and similar toolchains from running what they build there. The
  job's argv is the container's entrypoint plus arguments (`--entrypoint <argv[0]>`), so an image's own
  entrypoint never intervenes. A mount may be `.` (the checkout), a path under it, or
  `@scratch/<dir>` (the run's scratch directory, for the build cache). `graphloom sandbox pull
  <image@sha256:…> [--check]` is the seam for "checked, and pulled if missing, in Fetch":
  Fetch's environment check calls it, so no job ever pulls. `graphloom doctor` reports
  the CLI, the daemon and rootless or not.
- **Limits are profile data.** `metrics.sandbox` and `checks.sandbox` each
  hold `{ image, cpus, memory, pids, tmp, wallClockMs }`, with one image per
  language, pinned by digest: `golang@sha256:…` for Go and `node@sha256:…` for
  TypeScript. The defaults are 4 CPUs, 8 GiB of memory with no extra swap,
  512 processes, a 1 GiB `/tmp` and the step's wall clock. The CPU, memory
  and swap defaults are the limits issue-fix's banyandb-ql `bench-gates`
  already uses (`docker run --rm --cpus=4 --memory=8g --memory-swap=8g`,
  [`profiles/banyandb-ql.json`](../examples/plugins/issue-fix/profiles/banyandb-ql.json),
  [benchmark gates](design-issue-fix-graph.md#the-measure-ql-profile-and-benchmark-gates)).
- **Mounts.** Only two mounts are writable: the disposable
  `{ from: "candidate" }` checkout and a per-run build-cache directory under
  the run's scratch. The build cache is reused by the coverage and mutation
  jobs of one run. Dependency inputs are mounted read-only: the Go module
  cache, and for npm the operator's cache, installed inside the container
  with `--offline --ignore-scripts`. P1 verifies an offline npm install from
  a read-only cache; if npm needs a writable cache, it gets a per-run copy in
  scratch. There is no host home directory and no other host path.
- **Environment.** Only the variables listed are passed, so no credentials
  and no host environment reach the container.
- **Images are pulled before the run, never during it.** Fetch checks each
  profile image by digest (`docker image inspect`). A missing image is pulled
  there, as `docker pull <image>@sha256:<digest>`, by the daemon; the digest
  fixes its bytes. Every sandboxed job then runs with `--pull never`.
  `graphloom check` and `graphloom doctor --task` report:
  - whether the `docker` CLI is present;
  - whether the daemon is reachable by the operator's user;
  - whether each image is local, or Fetch will pull it.
- **As built for coverage (P1, wave 3b).**
  - **Profile.** `metrics.sandbox.<go|typescript>` is `{ image, cpus, memory, pids, tmp, wallClockMs, readOnly?, setup?, buildTags?, ginkgoLabelFilter? }` (the last four below), each
    checked by the SDK's own docker-confinement rules, so a tag is refused when the profile is read. Defaults are
    `--cpus=4 --memory=8g` (swap equal), 512 processes, a 1 GiB `/tmp` and 30 minutes. The TypeScript default image is
    `node:22-bookworm-slim` by digest; Go has none unless the profile pins one, because the right image follows the
    repository's `go.mod` (the BanyanDB profile pins `golang:1.26.11`, `golang@sha256:957952ae…`).
  - **Mounts and setup (profile data).** A repository whose tests need code that is not committed (BanyanDB's
    generated protobuf, `make generate`) would fail to build in a sandbox with no network, and the profile may not
    prepare the checkout on the host ([§3.2](#32-profile)). Two optional fields of `metrics.sandbox.<language>` solve
    that without running anything outside the container:
    - `readOnly: [{ name, path }]`: host directories mounted read-only at their own real path, for trusted tools and
      offline caches. A path is absolute or `~/…` (the operator's home; `~` alone, `..`, `:`, `,`, line breaks, `/` and
      relative paths are refused when the profile is read, since a relative path would name the pull request's own tree).
      Names are `[a-z][a-z0-9-]*` and unique. The container sees each resolved path in `GRAPHLOOM_MOUNT_<NAME>`
      (upper case, `-` as `_`), so a setup command names its tools without knowing the operator's home. Fetch resolves
      the paths on the host, from `/` (`host-mounts-<language>`: expand `~`, follow links, require a directory, print
      the real path); a missing one makes the language's functions `not run (sandbox mount <name> (<path>): … is not a
      directory on this host)`, and nothing runs. The runner refuses, when it prepares the job, an absolute read-only
      mount that lies inside the checkout or holds it. Tools never come from the pull request: they are the
      operator's, outside the checkout. A mounted directory is read-only in the container whatever its host mode.
    - `setup: [{ id, argv }]` (Go): commands run in order inside the same container configuration as the tests
      (no network, the same limits, the same read-only mounts and caches, the checkout and build cache writable), in
      the checkout's root, before any `go test`. They are part of the one coverage command: its spec carries them as
      `setup <id> <_base64 of each argument>` lines (so the recorded bytes are the bytes run, and the validator's
      comparison of the spec covers them), `go.sh` runs them and reports `setup <id> ok` per success. The first failure
      stops the run before any test with `setup-fail <id> <exit> <last output lines>`, and every function is `not run
      (setup failed: <id> exited <n> (<output>))`. The container's wall clock covers setup and tests together. TypeScript
      has no setup in this version. Each reproducing test runs the same setup before it builds, through the same script
      (`tools/sandbox/setup.sh`), and takes coverage's outcome from the run's scratch when coverage ran it on the head
      ([§8.2](#82-reproducing-tests)).
    - `buildTags: string[]` (Go): the tags `go test` compiles with, carried as one `tags a,b` line of the spec (so the recorded
      bytes are the bytes run) and passed as `-tags=a,b` to `go test` only, never to setup; the reproducing tests' `go test`
      gets the same tags (since 0.26.5, [§8.2](#82-reproducing-tests)). BanyanDB sets `querymetrics`,
      as its own integration workflow does (QLB-T02 asserts it). `go.sh` re-checks the characters and drops the tags
      rather than pass anything else on.
    - **Timeout.** `go test` stops at its own 10 minutes unless told otherwise, which made a 30-minute sandbox end a slow
      integration package early (apache/skywalking-banyandb#1444). The spec carries `timeout <seconds>`, the profile's
      `wallClockMs` less 2 minutes (at least 60 seconds), the budget of every `go test` of the run counted from the start of
      `go.sh` (setup included); each `go test` gets `-timeout=<seconds left>s` (at least 1s, as 0 disables it). `go.sh` ignores a
      value that is not 1 to 86400. A package that still times out is recorded as `timeout <pkg> <duration> [<tests,...>]` (at most
      5 lines, 5 tests each, from `panic: test timed out after <d>` and the `running tests:` list).
    - **Ginkgo label filter.** `ginkgoLabelFilter` is carried as one `ginkgo <filter>` line (the recorded bytes are the bytes
      run) and re-checked by `go.sh` against the same characters. BanyanDB sets `!slow`, as its integration workflow's
      `--label-filter`. A plain test binary refuses `-ginkgo.label-filter` ("flag provided but not defined"), so with a filter
      `go.sh` asks `go list` (offline) which touched packages of a module have tests, internal or external, that import
      `github.com/onsi/ginkgo/v2`, and runs the rest as before and those with `-args -ginkgo.label-filter=<filter>`, each with its
      own coverprofile; the profiles are merged in set mode (a block's largest count) before the changed functions are read.
      A package that reaches Ginkgo only through a helper package gets no filter. No other Ginkgo flag is passed. Without a filter
      there is one `go test`, as before.
    - **Failing tests.** `go.sh` names failures in dedicated report lines, not the output tail: `failed <text>` per Go
      `--- FAIL:`, Ginkgo `[FAIL]` (colour codes stripped) and `FAIL <pkg>` line, and `build-error <text>` for the first
      compiler error. `parseCoverageReport` reads them, so the validator recomputes the same list.
    - **Not cached between runs.** The setup's outputs are not kept between runs. They depend on the head (the protobuf sources, the
      sources mockgen reflects over), so a cache keyed by their content would be a new store the sandboxed code writes
      and a later run trusts; issue-fix's prepare cache has a host-side trust model that this sandbox does not share.
      Regeneration is offline and measured in seconds to a minute (BanyanDB: protobuf 2 s, mocks 35 s on 4 CPUs, with
      the build cache of the run shared with the tests), so this version regenerates every run. Within one run (one
      head), the outcome is kept in the run's scratch (`@scratch/go-setup`), as the build cache already is, so that the
      reproducing tests do not regenerate per finding (since 0.26.5, [§8.2](#82-reproducing-tests)). Only sandbox jobs of
      the same run read and write it, and they already share the writable build cache, so it adds no trust the run did
      not have.
    - **BanyanDB.** `api/Makefile`'s `generate` target is `buf generate` with the `protoc-gen-*` plugins on `PATH`, and
      `buf.yaml` depends on three BSR modules (`protoc-gen-validate`, `googleapis`, `grpc-gateway`), pinned by
      `buf.lock`. The profile mounts `~/.graphloom/tools/banyandb/bin` (`buf`, `protoc-gen-go`, `protoc-gen-go-grpc`,
      `protoc-gen-doc`, `protoc-gen-grpc-gateway`, `protoc-gen-openapiv2`, `protoc-gen-validate`, built by the operator
      at the versions of `scripts/build/version.mk`, for example by symlinking the review clone's `bin/`) and
      `~/.cache/buf` (the buf module cache that already holds those three modules), and runs two setup commands:
      `proto` copies the cache to the container's `/tmp` (buf writes lock files into its cache) and runs
      `cd api && PATH=<tools>:<proto dir>:$PATH <tools>/buf generate`, exactly the Makefile's invocation, offline; and
      `mocks` runs `go generate ./...` with a `mockgen` built inside the container from the module cache
      (`go build go.uber.org/mock/mockgen`), because a prebuilt `mockgen` is built by one Go version and refuses
      a repository that moved to a newer one. The first generates everything the failing packages imported
      (`api/proto/banyandb/**/v1/*.pb.go`, `*.pb.validate.go`, `*_grpc.pb.go`, `*.pb.gw.go`); the second generates the
      git-ignored `*_mock.go` of `banyand/metadata`, `banyand/metadata/schema`, `banyand/queue`, `pkg/flow`,
      `pkg/meter` and `pkg/node`, which the tests of those packages and their dependents import. Nothing else in
      `make generate` is needed to compile a package's tests (`api-reference.md` and the OpenAPI output are documents).
      `~/.cache/buf` is the operator's trust root for the three modules; a head that changes `buf.lock` to a module not
      in the cache makes `buf generate` fail offline, and the coverage `not run (setup failed: proto exited …)`.
  - **Fetch.** After the ledger read, a read-only command job (`sandbox-go`, `sandbox-typescript`,
    `host-go-modcache`, `host-npm-cache`, and `host-mounts-<language>` when the profile names mounts) runs `graphloom sandbox pull <image@digest>` (the docker CLI itself when
    `graphloom` is not on `PATH`) and asks the host where its Go module cache and npm cache are, from `/`, so the
    pull request's `go.mod` and `.npmrc` answer nothing. Each prints `ready` or `unavailable: <why>` and exits 0.
    The evidence is the `measurements` validator's: it carries the digest of the head's checkout, which the
    environment checks, run before it, do not. `graphloom check` and `doctor --task` still report each image's state
    through non-pulling environment checks (`docker-go`, `docker-typescript`), which never fail.
  - **The job.** One graph command job per language, `checkout: { from: "candidate" }` with a `docker` confinement:
    writable are the checkout and (Go) `@scratch/gocache`; read-only are the plugin (its scripts under
    `tools/cover/`) and the host's module cache (Go) or npm cache (TypeScript, installed with
    `npm ci --offline --ignore-scripts` into the checkout's ignored `node_modules`); the environment is
    `GOFLAGS=-mod=readonly GOPROXY=off GOTOOLCHAIN=local GOCACHE=<scratch> GOMODCACHE=<host cache> HOME=/tmp` (Go) or the
    npm cache variables (TypeScript). The generic runner changes are two: a docker environment value may name
    `@scratch/<dir>`, a value that names scratch is checked like a mount (no `..`) before anything is created, and the command's `GRAPHLOOM_REPORT_FILE` is mounted into its container (only that file), so a
    report larger than the output tail travels as the command's report.
  - **The report.** `go.sh` and `ts.sh` write `graphloom-coverage-v1`: the test command's exit status and result lines,
    and the coverage facts filtered to the changed functions' line ranges (`goprofile.awk`; `tscover-cli.js`). The
    spec (packages or workspace, files, function ranges) travels in the command's argv, so the recorded bytes are the
    bytes measured, and the validator rejects a report whose argv names other functions than the records.
  - **Attribution.** A function owns a Go block that starts in its lines, a nested function owning the blocks from its
    first line (its opening brace) to the one before its last; a TypeScript statement on a nested function's boundary
    lines is the enclosing function's. A block that several test binaries profiled counts once, covered when any
    covered it. A failing test does not void coverage; a package that did not build, or has no test files, is `not run`
    with that package named, and only that package.
- **Lifecycle.** A job's wall clock, a run stop or a cancellation ends in
  `docker kill`, by the container's name. A resume removes leftover
  containers labelled with the run (`docker rm -f`) before it dispatches.
- **Not run.** When Docker is missing, the daemon is unreachable, the image
  pull failed, a dependency is not cached, a TypeScript repository does not
  declare `@vitest/coverage-v8` at its vitest major (`not run (no vitest
  coverage provider)`; GraphLoom never installs it into the repository), or
  the image's toolchain is older than `go.mod` asks for
  (`GOTOOLCHAIN=local`; since 0.26.4 the reason reads `the sandbox toolchain is
  older than the repository requires: the sandbox's Go 1.26.10 is older than
  go.mod's 1.26.11; update metrics.sandbox.go.image`, taken from Go's own
  error line, which `go.sh` reports as the first build error, and the same
  sentence is the reason of a failed setup command; when a PR touches several Go modules and only some need the newer Go, `go.sh`
  reports each module that wrote no profile with its own first error (`module-error <dir> <line>`), and only the
  functions of a module whose own error is the toolchain refusal get this reason; a module that failed for another reason
  keeps that reason and its error line, and the others keep their measured coverage; a report from before 0.26.4 has no
  `module-error` lines and keeps the single-error reading), the record says `not run` with that reason. Static
  metrics still run. No job falls back to running PR code outside the
  sandbox.

**Contributor tests run by default.** Coverage and mutation run the PR's own
test code on the operator's machine for every run, inside the Docker sandbox:
for Go always, and for TypeScript in a repository that declares
`@vitest/coverage-v8` ([metrics §2.3](design-code-quality-metrics.md#23-coverage-covm)).
CPU, memory, process count, filesystem and network are all contained. Some
risk remains, and the design accepts it:

- **Container or kernel escape.** Containers share the host kernel. Dropped
  capabilities, `no-new-privileges`, Docker's default seccomp and AppArmor
  profiles and a non-root user narrow this, but a kernel or runtime
  vulnerability would still let test code out.
- **Trust in the Docker daemon.** The daemon runs as root. An operator user
  in the `docker` group is root-equivalent on the host. That is a
  precondition of using Docker at all, not something GraphLoom adds.
  Rootless Docker works unchanged and is the recommended setup.
- **Image supply chain.** Images are pinned by digest in the profile, so a
  re-tagged image cannot change a run. Changing a digest is a profile change
  the operator reviews.
- **Agent-written tests.** A reproducing test is code a reviewer wrote
  after reading untrusted PR content. It runs in the same sandbox, with the
  same limits and no network, so it adds no access the PR's own tests lack.
- **Output.** Test output enters evidence bounded and secret-scanned
  ([§12.3](#123-secrets)). The container sees only the checkout and the
  read-only dependency caches, so it holds no host secret to leak, and
  nothing is posted without approval.

A profile that does not accept this sets `metrics.coverage: false`, which also
stops mutation, sets `review.repro.enabled: false`, and leaves `checks` out.
The report then says `not run (coverage disabled by the profile)`, and every
behavioral finding is `unproven (execution disabled by the profile)`.

### 12.3 Secrets

Only publish jobs hold a credential. Every report, Q&A and draft write,
and every approval, is scanned for private-key headers,
`gh[pousr]_`/`github_pat_` tokens, AWS keys, `xox` tokens, and high-entropy
strings of 40 or more characters in check tails. A match refuses the write and
names the location.

### 12.4 The vendored diagram-design skill

`examples/plugins/<plugin>/vendor/diagram-design/`, in both `pr-review` and `pr-design-review`, is the third-party agent skill
[diagram-design](https://github.com/cathrynlavery/diagram-design) (MIT, Cathryn
Lavery), copied unmodified at commit `0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1`:
its `SKILL.md`, the references the diagram job reads (the **Data flow** type,
`type-data-flow.md`, for the features, and the **State machine** type for the
lifecycle entries; 0.16 added the Data flow reference and its example from the same
commit, and the Architecture delta files of the earlier versions stay in the
subset, undrawn), the light minimal template and the examples of the types drawn,
and the two scripts the plugin runs
(`scripts/self_check.py`; `scripts/verify-geometry.py`, which the source repository
keeps at its root). `LICENSE` is the source repository's, `VENDORED.md` records the
URL, the commit and what was left out (screenshots, the other types, the icon set,
the import and export tools). The files are pinned by the plugin manifest like the
rest of the plugin, so a repair or an update changes the digest, and the third-party
notices list it with its license text (`scripts/release/notices.mjs` reads each
`vendor/<name>/VENDORED.md`, judges its license against the allowlist and writes it
into `THIRD_PARTY_NOTICES`). `scripts/check-headers.mjs` exempts any `vendor/`
directory from the SPDX header rule, because the files stay as they came.

The skill is a model-facing document and two scripts; none of it runs inside the
controller or the graph. What it makes is untrusted: a diagram document is checked
by the skill's own scripts, by the inertness check, and by the **label rule** (every
visible text is a label of the checked data the job was given, [§6.10](#610-features-and-their-data-flow)),
so a drawing cannot carry a claim the claim checker never saw. The plugin embeds
only the `<svg>` it re-serializes from an allow-list, with the title and description
its own. The skill's scripts read the document and print findings; they open
no network connection, and run with no network in any case.

### 12.5 Never auto-approve

The graph never posts `APPROVE` or `REQUEST_CHANGES`: the review's event is
`COMMENT`, fixed in `createInput` (`src/publish.ts`), and its first line is the
verdict. The `review-published` validator and the publish tests assert the
event. A person approves or requests changes
on GitHub, by hand.

## 13. Agent roles, supervisor, budgets

### 13.1 Roles

Roles are declared through `agentRoles` (`AgentRoleDeclaration`), as issue-fix
does. Each role is a fresh session per job; the reviewers start seeded with
`review.md` only ([§8.1](#81-review)). `pr-review`'s roles, and its declared
constraints (the design review's are in
[its §10](design-pr-design-review.md#10-roles-budgets-and-sessions)):

| Role | Default harness | Access | Constraint |
|---|---|---|---|
| `reporter` | `claude-code` | read | The report-only prelude, and the draft summary; in large mode the one high-level reporter job ([§6.9](#69-large-pull-requests)) |
| `diagrammer` | the `reporter`'s | read | Optional. The diagram job only ([§6.10](#610-features-and-their-data-flow)). No `distinctFrom`: its drawings are checked by code, and it receives only data the claim check already judged |
| `report-checker` | `codex` | read | `distinctFrom: ["reporter"]` |
| `reviewer-correctness` | `claude-code` | read | Correctness passes; writes reproducing tests |
| `reviewer-maintainability` | `claude-code` | read | Maintainability passes; judges the leads |
| `reviewer-security` | `claude-code` | read | Security passes; writes reproducing tests |
| `verifier-correctness` | first of claude-code, codex, pi that is not its reviewer's | read | `distinctFrom: ["reviewer-correctness"]` |
| `verifier-maintainability` | first of claude-code, codex, pi that is not its reviewer's | read | `distinctFrom: ["reviewer-maintainability"]` |
| `verifier-security` | first of pi, claude-code, codex that is not its reviewer's | read | `distinctFrom: ["reviewer-security"]` |

A reviewer defaults to Claude Code unless the profile names another; there is no
`sameAs` constraint (0.21 to 0.27 bound the reviewers to the answerer's harness, a
leftover of forking its session, and `pr-review` has no answerer). The verifiers
are the independent check: each runs in a fresh session, never a fork, on a harness
other than its reviewer's, and a finding rerouted to another aspect is still
verified by the verifier of the pass that raised it. Pi counts as available only
when the runner config names it, which `graphloom doctor --task` reports; a profile
without Pi sets the verifiers explicitly, as `profiles/banyandb.json` does.

**Model and effort per role.** A `harnesses.<role>` entry is either the harness id
or an object `{ "harness": "claude-code" | "codex", "model"?, "effort"? }` (unknown
keys are refused; an object cannot name `pi`). `effort` is checked against the
harness: `low`, `medium`, `high`, `xhigh` or `max` for Claude Code, `minimal`,
`low`, `medium`, `high` or `xhigh` for Codex. The plugin passes both in the job's
`harnessOptions`; a role that omits them inherits the harness's own settings.
`distinctFrom` compares harnesses, not model families. With too few harnesses to
satisfy a pair, `parseProfile` refuses the profile and names the pair. No role
writes the worktree.

### 13.2 Supervisor

The supervisor preference is `{ harnesses: ["pi", "claude-code", "codex"] }`,
Pi first ([supervisor harnesses §7.6](design-supervisor-harnesses.md#76-issue-fix)).
The supervisor handles executor failures, rate limits, malformed results and
a moved ledger. It cannot approve or decline, dismiss a finding or a lead, mark a
finding proven, or add a stage. Its confined jobs get the untrusted masks.

### 13.3 Budgets

These are estimates until measured ([budgets](budgets.md)).

- **Report** (the `prelude` source only): reporter about 25, report checker about
  15, one correction about 25, plus the diagram job. A `design-review` or `none`
  source runs no report agent.
- **Measurements:** no agent calls. Static metrics are one or two command jobs, in
  seconds; coverage is one sandboxed test run of the touched packages, about 2 to 15
  minutes for BanyanDB.
- **Review layer:** three aspects, each with its own sweep. A clean round is one
  pass (about 30 calls) and one verification (about 15) per aspect, about 135 calls;
  each test correction about 10; the worst case, four passes and four verifications
  in every aspect plus corrections, about 650 calls. Jobs: the rule files and rule
  groups, the passes and verifications, and one sandbox job per behavioral finding's
  test. Wall clock: the passes about 45 minutes to 1 hour, the reproducing tests at
  most `review.repro.timeBudgetMs` (30 minutes).

| Budget | Default (both graphs) |
|---|---|
| `agentInvocations` | 1,200 |
| `jobs` | 220 |
| `decisions` | 240 |
| `corrections` | 12 |
| `activeMs` | 4 h |
| `waitMs` | 6 h |

## 14. The review kit

**One source tree, `examples/plugins/review-kit/src`, copied as source into each
review plugin's `src/kit/`, with a drift test.**

- A dependency is not repairable in a run. Repair snapshots omit `node_modules`, so
  shared code behind a package boundary would be an opaque dependency with explicit
  repair limits (AGENTS.md).
- Vendored source is inside each bundle's digest. A run pins it with its plugin
  version, and a qualified repair in one graph's run cannot change the other graph.
- `npm run vendor -w @graphloom/plugin-pr-review` and `npm run vendor -w
  @graphloom/plugin-pr-design-review` copy the tree (`review-kit/vendor.mjs`); each
  plugin's `test/kit-drift.test.ts` fails, naming the file, when its copy differs
  from the kit, and each manifest is regenerated afterwards. `vendor/` stays
  reserved for third-party code, which the header check exempts; `src/kit/` is
  checked like any source.

The kit holds Fetch (the snapshot reads, the head checkout, the base export, the
principles read, the sandbox image probe), the ledger (the v2 layout, section reads
and compare-and-swap writes, the v1 migration, [§9](#9-incremental-re-review)), the
change report (template, detectors, briefing, claim check and its record, diagrams,
large mode, Markdown and HTML rendering, part-set writes, [§6](#6-the-change-report)),
the measurements and coverage with their recomputation (`metrics/`), symbol
extraction, searches and test mapping ([§7.2](#72-deterministic-groundwork)), the
profile parser, the `task new` plan, the post of one review
([§8.5](#85-publish)), the secret scan and the attempt bookkeeping. Where the
graphs differ the kit takes a parameter: `parseProfile(config, graph)`,
`requestedPull(request, profile, graph)`, the head marker a post carries,
`metrics.staticOnly`, `groundworkState({ perSymbol, maxSearched })`, and the
section a ledger write advances. Its README lists them.

What stays in one plugin: N1, the questions, the answers and the gate in
`pr-design-review`; the context source, the leads, coverage's use, the reproducing
tests, the review sweep and the draft in `pr-review`. issue-fix does not use the
kit: its review is one open-code-review pass with ocr's rules, unchanged.

## 15. Generic platform changes

Each change is generic. Following the controller-plugin boundary, no plugin
schema name enters the controller, SDK or CLI.

| Change | Where | Notes |
|---|---|---|
| Task field `base: <commit>` | `packages/controller/src/intake.ts`, task parsing, `inspect` | Pinned after `git rev-parse --verify <base>^{commit}`. Absent means `HEAD` |
| GitHub reads | `executors/github`: `list-pull-files`, `list-pull-commits`, `list-pull-reviews`, `list-pull-review-comments`, `list-review-threads` (GraphQL resolution and outdated state), `list-check-runs` | The same pagination and `complete` contract as today. Served by the stand-in (`src/rehearsal/github-standin.ts`) and `testing/fake-github.ts` |
| `JobSpec.confinement` kind `bwrap`: `{ kind: "bwrap", network, mask, binds }` | `packages/sdk/src/types.ts` (`JobSpec`, line 419), `packages/runner/src/confine.ts` | For agents and static tools: a hidden home with `ownState` holes, masks, read-only binds, network on or off. Refused without bwrap. A definition flag `untrustedWorkspace` applies the masks to supervisor jobs |
| `JobSpec.confinement` kind `docker`: `{ kind: "docker", image, cpus, memory, pids, tmp, wallClockMs, writable, readOnly, env }` | `packages/sdk/src/types.ts`; a new `packages/runner/src/sandbox-docker.ts`; `graphloom doctor` and `check` probes (CLI, daemon, image by digest) | A generic, plugin-neutral option for any graph command job that runs untrusted code. The runner builds the `docker run` of [§12.2](#122-confinement) from the data, refuses an image without a digest, always passes `--pull never`, labels the container with the run, and kills it by name on stop. issue-fix's `bench-gates` could move onto it |
| Approvals | `GraphDefinition.approvals`, `resume --approve/--decline`, `operator-approval` evidence, write admission by `approvalRef`, `github.writeTokenEnv`, `inspect` | [§11](#11-approvals). The mechanism is generic and stays; pr-review declares no approval since 0.21, and `github.writeTokenEnv` is the runner's grant of writes |
| Approval inputs | `ApprovalDeclaration.inputs` (`name`, `description`, `pattern`), `resume --approve <id> --input <name>=<value>`, the `inputs` of the `operator-approval` evidence | Implemented in 0.18: [core §17](design-typescript-core.md#17-operator-approvals-and-their-inputs) |
| `AgentSessionView.sessionRef` and `settledAt` | `packages/sdk/src/types.ts`, `packages/controller/src/agent-sessions.ts` | Implemented in 0.18: the plugin matches an `operator-conversation` (which names its `forkSession`) with its session row, to record the review base session's operation id |
| `graphloom session list/open` | `apps/graphloom`; `AgentSessionRecord` gains `harness`, `confinement`, `origin`, `parent` and `contextTokens`; fork, capture and turn-extract helpers beside the session save/restore in `@graphloom/agent-harness`; `operator-conversation` evidence; `maxConversationBytes`, and per harness `sessionLauncher` and `sessionLauncherStateDirs` (with the `GRAPHLOOM_<HARNESS>_SESSION_LAUNCHER` overrides and a `doctor` probe), in the runner config | [Core §15](design-typescript-core.md#15-opening-a-recorded-agent-session): the conversation is captured on exit, `--stage` continues the latest one, `--from-original` starts over |
| `JobSpec.forkFrom` | `packages/sdk/src/types.ts`, controller admission, the coding-agent executor | The fork form of `continueFrom`: across stages and dispatch keys, same harness only, the parent never written ([core §15](design-typescript-core.md#15-opening-a-recorded-agent-session)) |
| `AgentRoleDeclaration.sameAs` | `packages/sdk/src/types.ts`, role resolution and `inspect` | A role that must run on another role's harness. The reviewers ran on the answerer's from 0.18 to 0.27; neither review graph uses it now ([§13.1](#131-roles)) |
| Optional hook `GraphPlugin.prepareTask` and the `TaskPlan` schema with `validateTaskPlan` | `packages/sdk` (types and validation), `packages/plugin-host` (the call in the isolated child) | The plugin returns a plan as data: `fetch`, `resolve` (`revParse` or `mergeBase`), `updateRef` and one final `writeTask`. No step runs a command; written refs stay under `refs/graphloom/<graph>/`; the task path stays under `--out` ([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)) |
| `graphloom task new <graph> <args…> [--repo] [--profile] [--out] [--dry-run] [--force]` | `apps/graphloom` | Loads the bundle as `run` does, calls the hook, executes the validated plan with hooks and user Git config disabled, refuses to overwrite a task without `--force`. It never interprets the arguments: `owner/repo#N` means a pull request only inside the review graphs ([§3.1](#31-task)) |
| `ValidationInput.request` | `packages/sdk/src/types.ts`, the controller's validator calls | The task's pinned request, passed to every validator call and interpreted by none of the platform. `pr-review`'s `review-context` needs it to tell the operator's `--no-report` from a report the graph failed to write; `task new` can write only the request and `base`, not the config ([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)) |

`create-pull-review` and `create-issue-comment` need no change.

## 16. Rehearsal scenarios

Scenario data in `src/rehearsal.ts`, with offline GitHub `reads`
([rehearsal §4.4](design-graph-rehearsal.md#44-scenarios)) and canned commands.
They are hand-written until a live run is recorded, so they do not decide CI
verdicts. The offline rehearsal's GitHub stand-in never writes, so the publish
flow is covered by the plugin's tests against a fake GitHub (`test/support.ts`).
The design review's scenarios are in
[its §11](design-pr-design-review.md#11-rehearsal-scenarios).

| Scenario | Shape | Expect |
|---|---|---|
| `happy`, `report`, `prelude` | No ledger | The context is a report-only prelude of this run; round 1 was not run |
| `design-review` | The design section holds the design review of this head, with one open `purpose` question | Its report is the context as it is; no reporter runs; the posted review lists `Q1` and counts it |
| `design-review-earlier-head` | The design review reported an earlier head; the delta is usable | Its report is the context, with a "Since this report" part |
| `design-review-unusable-delta` | The earlier design head is not in the review clone | The delta is not usable; the context falls back to the prelude, with the reason |
| `no-report` | The request carries `, without a report`; no ledger | No prelude; the seed is the pull request's metadata and patches |
| `report-corrections` | The reporter misses a file and cites outside the diff; one claim is unsupported twice | Corrections name both; the item is removed and recorded |
| `injection` | The body asks automated reviewers to approve | Recorded under Notes; no `APPROVE` |
| `large-pull-request` | Run with `LARGE_LIMITS`: three areas plus a generated file | One high-level reporter job and one claim check; the reviewers review the areas the briefing cites |
| `complex-function` | A new function with 12 decision points and nesting 4 | A `split-function` and a `crap` lead |
| `sandbox-unavailable` | No sandbox | Coverage not run; the test map alone decides the test leads; `crap` uses its unknown-coverage rule |
| `reuse-lead` | The base has `ParseDuration` outside the changed paths | A `reuse` lead |
| `untested-feature` | Two new functions no test covers, the whole of one high-level change | An `untested-feature` lead, raised as a P1 finding |
| `coverage-measured` | A canned coverage report (8 of `ParseTTL`'s 20 statements) | Coverage by line range, CRAP 43.1 recomputed, a `crap` lead |
| `crap-upper-bound` | A modified function of complexity 6 with unknown coverage | CRAP 42 shown as an upper bound; no `crap` lead |
| `state-lifecycle`, `feature-data-flow`, `diagram-corrected`, `diagram-skill-check-fails`, `diagram-fallback`, `large-artifacts` | The report's lifecycles, data flows, diagrams and part-set writes | As [§6](#6-the-change-report) specifies |
| `review-layer` | Three aspect reviewers over one Go file: a confirmed P1, a refuted P2, a confirmed non-behavioral P2 | The verdicts, the draft and the posted review |

The plugin's tests also cover each context source recomputed by its validator, each
lead kind with coverage off and in large mode, a missing lead status corrected in the
same session, each lead kind's drafted priority (the fixed P0, a `reuse` finding
raised at P3 and posted at P0, forged leads refused by `findings-proven`), the
verdict with and without a round-1 record, nothing of round 1 posted again,
reproducing tests, the publish reconcile (already posted, an ambiguous
post, lost posts) and a stale ledger.

## 17. Discussing a run: `graphloom session open`

There is no `graphloom-review` skill. Starting a run and watching it use the
existing `graphloom-run` and `graphloom-watch` skills; the rest is the flow
of [§2](#2-the-run-two-graphs-and-no-human).

`graphloom session open` is **not part of the flow**: a run never waits for it
and nothing said in it reaches a later job. After a run ends, or while it runs,
anyone who wants to look may fork a recorded session in their terminal
([core §15](design-typescript-core.md#15-opening-a-recorded-agent-session)):

- **A design review:** `--stage answers` forks the answering session (the
  `answerer`'s, or in large mode the `batch-answerer`'s), `--stage questions` N1's
  answerer (the only answer when N1 skipped the rest).
- **A PR review:** `--stage review` forks a reviewer's session; the verifiers are
  under `review` too.
- **Either:** `--stage report` forks the reporter's, the way into an area of a
  large pull request.

- **The conversation is recorded.** When the agent exits, GraphLoom
  captures the fork's transcript into the run with `operator-conversation`
  evidence; the recorded session stays byte-identical. Running the same
  command again forks that conversation; `--from-original` starts a new one from
  the recorded session. Chat turns run on the person's own login and are not
  charged to the run. **Nothing reads the recording**: the review layer does not
  seed from it, and it changes no verdict and no post.
- **Diving into an area.** In large mode ([§6.9](#69-large-pull-requests)) the report is
  high level; the reporter's session already holds the pull request's digest and can read
  any file of the head or the base.
- `graphloom session list <run>` shows the other sessions by stage,
  operation, harness and session ref: the reporter and report checker under
  `report`, the questioner under `questions`, the answer checker and any
  conversations, each with its parent, under `answers` (a design review), and
  each reviewer and verifier under `review` (a PR review). A Pi session, such as the default
  `verifier-security`, is refused.
- The fork runs under its job's confinement ([§12.2](#122-confinement)), so
  the PR content in its transcript stays untrusted data. The opened agent
  may be steered by it as the job could have been, and it can do no more
  than the job could: it cannot write the checkout or the run.
- A run's saved transcripts are removed when it finishes; their evidence stays in
  run state, and forks already opened stay in the person's own agent store. A
  run now ends without waiting, so open a session while it runs, or soon after.

## 18. Version history

The release notes and `CHANGELOG.md` hold the detail; this is the shape of the
graph over time.

- **0.1 to 0.20:** the first layer (the report, the questions and their answers,
  the measurements and confined coverage), then large mode, the one-page briefing
  and HTML report, the diagrams drawn with the vendored skill, the necessity question
  N1 and the project's design principles, and the review layer (aspect reviewers,
  verifiers, rule files), with operator approvals between the layers.
- **0.21:** no human in a run. One run reviewed one head in two rounds: round 1 (the
  report and the Q&A) and, when it had no issue, round 2 (the review layer) in the
  same run; one `COMMENT` review per run whose first line is the verdict; the per-PR
  ledger ref (`graphloom-pr-ledger-v1`). 0.22 added fix checking on a later head,
  0.23 the `rounds` profile key and the clean `posting not enabled` stop, and 0.24
  reproducing tests.
- **0.26:** round 1 on a later head was incremental, carrying unchanged answers;
  0.26.1 to 0.26.5 posted whole answers, started a reentered stage's attempt fresh,
  matched the sandbox's Go to `go.mod`, and ran reproducing tests after the
  sandboxed setup. 0.26.x is the last two-round version that reads only a v1 ledger.
- **0.27.0:** ledger v2, a `design` and a `review` section, each advanced by its own
  compare-and-swap, with the v1 migration and the two head markers
  ([§9.4](#94-section-writes-markers-and-migration)); still two rounds.
- **0.27.1:** the shared machinery moved into the review kit, vendored into
  `src/kit/` ([§14](#14-the-review-kit)), with no behavior change.
- **`pr-design-review` 0.1.0** ([its document](design-pr-design-review.md)): round 1
  as its own graph, narrowed to design-level questions, with no Docker.
- **1.0.0:** round 2 only: Fetch, Report, Review, Draft, Publish; the three context
  sources and `--no-report`; the leads and `leads-judged`; the `untested-feature` P1
  rule; the maintainability rule file without the Q&A exclusion; the reviewers
  defaulting to Claude Code with no `sameAs`; the round-1 lines and the verdict
  count; `rounds` and `Report on …` refused; the record of the report's claim checks
  ([§5.1](#51-convergence-after-a-reentry)).
- **1.1.0:** a confirmed finding raised from a `weak-test`, `split-function`, `crap`
  or `reuse` lead is drafted at P0, whatever the reviewer proposed (a P3 one is
  verified and drafted, not counted as a nit), and makes the recommendation
  `request-changes`; `findings-proven` recomputes its lead. `missing-test` stays at
  most P2 and `untested-feature` at most P1 ([§7.3](#73-leads)).
- **1.1.1:** one priority per finding: `review.md`, the HTML report, `draft.json`'s
  report part and the ledger show and store the final (drafted, posted) priority, not
  the reviewer's proposed one, which stays in the aspect record; a dismissed finding
  has none; `draft-composed` and `review-published` check every stored priority
  against the recomputation; a section 1.0 or 1.1.0 wrote is read at the priority
  each finding's posted label carries ([§8.4](#84-draft), [§9.1](#91-where-the-ledger-lives)).
- **1.1.2:** fixes from the first live run (apache/skywalking-banyandb#1485). Each
  round-1 line says what the open item is and its state: its id, its question (the
  design head's `qa.json`, else the item's posted text; clipped at 200 characters)
  and `open on this head` or `open as of <sha7>, not re-checked on this head`; the
  counts are unchanged. The round-1 items nest under their lead everywhere, so
  `draft.md`'s maintainer list no longer renders `- - Q4: …`. The verification
  contract is `pr-finding-verification-v2`, adding `corrections` (spans of the claim
  and their replacements, checked against the claim and sent back when one does not
  occur once); the draft applies a confirmed finding's corrections to its posted
  text, or states one it cannot apply, and `draft-composed` fails a draft that
  ignores one; v1 results still read, with none ([§8.1](#81-review), [§8.4](#84-draft)).
- **1.1.3:** the changed lines' hunk headers of a large pull request are read in
  groups of files that each fit one command report (apache/skywalking-banyandb#1487:
  181 files whose headers were 71,735 bytes blocked the Report stage). The one
  `metrics-diff` command still reads them when they fit; when they do not, it is
  replaced by its halves in the measured files' order (`metrics-diff-a`,
  `metrics-diff-b`, then `metrics-diff-aa`, …), each naming its files, and a single
  file whose own headers do not fit is listed as not measured with its reason, never
  a failed stage ([§6.8](#68-measurements)). The review kit's change, shared with
  `pr-design-review` 0.1.3.
- **1.1.4:** every command the review kit plans fits the command executor's input
  bounds (apache/skywalking-banyandb#1487 again: 181 files split into groups of
  about 74 paths, each over the executor's 64 argv strings, which the executor
  rejected before running, so the plan repeated the same commands). A diff group
  over the bound is halved before it is dispatched, renames counted as two paths; a
  static batch likewise, a file whose hunks alone do not fit listed as not
  measured; paths over 1,024 characters are not observable; jobs are packed by
  count and bytes; and a command job over a bound goes to the supervisor rather than
  the executor ([§6.8](#68-measurements)). The review kit's change, shared with
  `pr-design-review` 0.1.4.
- **1.1.5:** the static Go tool runs with its own Go environment: `GOROOT` is the
  root of the `go` it runs (or unset for a bare `go`), not one the hub's
  environment inherited from the operator's shell, which the sandbox did not bind
  (apache/skywalking-banyandb#1487: every `static-go-*` batch exited 2 with `go:
  cannot find GOROOT directory`); `GOTOOLCHAIN`, `GOENV`, `GOWORK` and `GOFLAGS`
  are the tool's own and `GOPATH`, `GOMODCACHE`, `GOOS`, `GOARCH`, `GOEXPERIMENT`
  and `GOBIN` are dropped. The `go-root` check and the host's `go env GOMODCACHE`
  no longer stop on an inherited `GOROOT` either ([§6.8](#68-measurements)). The
  review kit's change, shared with `pr-design-review` 0.1.5; the kit's command-id
  pattern is spelled with both cases, as `executor-command` 0.1.4 publishes it.
- **1.1.6:** a part-set write is sized against the dispatch guard's own bound: a
  part's job, serialized with its chunks JSON-escaped, stays within the 247,808
  bytes the guard lets one command take, where the splitter measured against
  4,096 bytes less of reserve, so an artifact of more than one part planned its
  first part over the guard's bound and the write was refused before it ran
  (apache/skywalking-banyandb#1487: `report-json-p1` at 250,050 bytes). The
  single-command writes, the ledger write, the diagram check and the repro command
  are measured by the guard's own check too ([§6.6](#66-output)). The review kit's
  change, shared with `pr-design-review` 0.1.6.
- **1.1.7:** the diagram flow reads the diagram job's runs of the Report stage's
  latest attempt (`producer.attempt`), not the stage's first two runs, so after a
  reentry or a resume that sends the run back to Report the validators judge the
  drawings the graph wrote and `report.json` recomputes (apache/skywalking-banyandb#1487:
  the validator replayed the first attempt's drawing, fell back to the plugin's,
  and the Report stage could not be accepted again;
  [§5.1](#51-convergence-after-a-reentry), [§6.10](#610-features-and-their-data-flow)).
  The review kit's change, shared with `pr-design-review` 0.1.7.

**Where 1.0 differs from its design.** The split design (now
[a pointer](design-pr-review-split.md)) planned a Checks stage when the profile has
`checks`; 1.0 has none, and the profile refuses `checks`, `rules`, and
`comments.minSeverity`, `nits`, `maxComments` and `suggestions` as a later version's
fields. Mutation testing is not measured yet, so there is no `weak-test` lead in
practice. `claims-checked` is not bound as a separate reviewer, since a run whose
context is the design review's has no claim check of its own; its validator requires
a prelude's checks to be read-only review jobs.

**Coexistence with 0.26.x.** 0.26.x stays installable until both graphs are proven
on real pull requests: a live run of each that completes and posts (or, for a clean
design review, posts nothing) on at least two BanyanDB pull requests, one of them in
large mode, and a `pr-review` run that reuses a design review's report from an
earlier head. Until then the release notes name the last release that carries
0.26.x. An operator who wants it keeps that version installed (`graphloom self
prune` removes every version other than `current`, `previous` and those runs own, so
it is not run while that version is wanted) and links its bundle in a separate
`--out` workspace ([release §4.6](design-release.md#46-operator-plugins-and-profiles)).
A 0.26.x run cannot use a pull request's ledger once a v2 writer wrote it
([§9.4](#94-section-writes-markers-and-migration)). Runs in flight stay on the
version they pinned: `resume --update-plugin` from 0.26.x onto 1.x is refused by the
controller's check that a plugin update keeps the same stages, requirements and
validator bindings. A `graph: pr-review` task written for 0.26 and not yet run means
round 2 only under 1.x; a task whose request is `Report on …` is refused, naming
`pr-design-review`. An operator profile that sets `rounds` is refused by both graphs.

## 19. Deferred items

- **A delta-only report, and the commit mapping.** A later head still writes
  the whole report ([§6.7](#67-delta-report)): reusing the earlier items needs a
  reporter contract that returns only new and changed items and a plugin merge
  that keeps the rest with their citations mapped to the head, and the
  deterministic "commits added, dropped or rewritten" and "detector facts since
  L" lines need the patch-id commit mapping
  ([§9.2](#92-mapping-a-new-head-to-the-last-reviewed-one)).

- **Thread replies.** The status of earlier comments goes in the review body
  ([§9.3](#93-re-checking-earlier-findings)). Replying inside the threads
  through GitHub's multi-call pending-review flow is deferred.
- **The Checks stage, the rule checks, mutation testing** and the `comments`
  keys a later version reads ([§3.2.1](#321-refused-keys)).

**Open questions.**

1. **Reusing `pr-review`'s own prelude report.** A `prelude` report is not a
   round-1 report, so a later `pr-review` run does not reuse it as context, and the
   `review` section does not store it. Storing it and letting a later head use it
   under the same delta rule would save a reporter and a checker job per head when
   no design review runs. Should it?
2. **A `not-an-issue` status on an `untested-feature` lead.** Leads are judged by
   their reviewer, and only a raised finding is verified. For the one lead kind
   whose finding can be P1, should the aspect's verifier also check a
   `not-an-issue` reason?

The ledger is local to the review clone ([§9.1](#91-where-the-ledger-lives)).
GraphLoom is a local process, and the design has no cross-machine sharing.
