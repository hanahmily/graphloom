# Splitting pr-review into `pr-design-review` and `pr-review`

Status: proposed, 2026-11-17; §5 (ledger v2) is implemented in pr-review 0.27.0, the kit
in 0.27.1, and §3 in `pr-design-review` 0.1.0 ([§11](#11-implementation-plan) items 1 to 4);
`pr-review` 1.0 (§4) is not. It changes the
[PR-review graph](design-pr-review-graph.md) as of pr-review 0.26.5; that
document keeps describing 0.26.x until the implementation pull requests of
[§11](#11-implementation-plan) rewrite it. Each section below says what changes
relative to it, by section.

Today one `pr-review` run reviews one head in two rounds: round 1 (the report,
N1 and the questions and answers) and, when round 1 has no issue, round 2 (the
aspect reviewers and the draft) in the same run
([§2](design-pr-review-graph.md#2-the-run-two-rounds-and-no-human),
[§9.4](design-pr-review-graph.md#94-rounds)). This design splits the two rounds
into two independent graphs, narrows round 1 to design-level questions, and
moves the detail questions to round 2 as deterministic leads for its reviewers.

## 1. Purpose and decisions

Round 1 is the design-level review: is the change necessary, what is each
feature for, does the codebase already have it. Round 2 is the detail review:
correctness, maintainability, security, tests and complexity. In 0.26 round 1
also asks per-symbol and per-function detail questions (missing tests, splits,
CRAP, surviving mutants, per-symbol reuse), so a pull request with sound design
and one missing test never reaches round 2 on that head, and round 1 needs the
Docker sandbox for coverage and mutation. The split puts each question in the
round it belongs to and lets the maintainer run either round alone.

The owner's decisions, which this document encodes:

| # | Decision | Consequence |
|---|---|---|
| 1 | Two independent graphs, each its own plugin; the shared machinery (Fetch, ledger, publish, GitHub reads, report) is vendored source | `pr-design-review` (new) runs Fetch → Report → Questions → Answers → Round 1 → Publish. `pr-review` keeps its name; its next major version, 1.0.0, is round 2 only: Fetch → Report (only when needed) → Review → Checks → Draft → Publish. A manifest declares one `graphId`, so two graphs are two bundles ([§2](#2-two-graphs-two-plugins)) |
| 2 | Round 1 is narrowed to design-level questions | N1 unchanged; `purpose` per high-level change; the feature-level part of `existing-reuse-common` stays (as `existing-feature`), its per-symbol part moves to round 2; `other` restricted to design level; `missing-test`, `split-function`, `complexity-coverage` and `weak-test` move to round 2. Coverage and mutation move to round 2; round 1 needs no Docker. The round-1 gate is N1 not `necessary`, any `needs author` or `partially answered`, any feature-level equivalent outside the change ([§3](#3-pr-design-review-round-1)) |
| 3 | Round 2 can run standalone | Context source, in order: the ledger's round-1 report (this head, or an earlier head with a usable delta), else a report-only prelude, else, only on `--no-report`, the pull request's metadata and diff. Round 2 does not gate on round 1: it lists and counts the open round-1 items when a round-1 record exists and says round 1 was not run when none does ([§4.2](#42-the-context-source)) |
| 4 | The moved questions become deterministic leads for the aspect reviewers | Each lead gets a status from its reviewer (finding raised, or not an issue with a reason); findings go through the existing verification and P0–P3 priority. A whole new feature with no test is a P1 lead ([§4.3](#43-leads)) |
| 5 | Chaining is outside the graphs | No run starts another and the controller learns nothing about rounds. A clean `pr-design-review` run's result names the next command; the `graphloom-run` skill starts it only when the user asks. A clean round 1 posts nothing by default ([§3.7](#37-publish-and-the-runs-result)) |
| 6 | One ledger per pull request, a section per graph | Each graph advances only its own section by compare-and-swap; `pr-design-review` owns `N1` and `Q<n>`, `pr-review` owns `F<n>`; each graph has its own head marker. The ledger schema becomes `graphloom-pr-ledger-v2` and a 0.26 ledger is migrated on first write ([§5](#5-the-ledger)) |

### 1.1 Choices this document makes

The decisions above leave these open; this document settles them as follows.

| Question | Choice | Why |
|---|---|---|
| Complexity and nesting in round 1 | They stay in round 1's report as facts (Measurements, hotspots), with no question and no gate; CRAP, coverage and mutation leave round 1 ([§3.4](#34-measurements-in-round-1)) | The static tools run under bwrap with no Docker and cost one tools job per batch; the report keeps its shape, so round 2 can use it as its map; and where complexity accumulates is design information |
| Round 1 on a later head | A full round 1 every head, except N1, which keeps its carry rule ([§3.5](#35-a-later-head)) | Every question is now per high-level change, whose ids the briefing rewrites every head, which is why 0.26 never made large mode incremental ([§9.2](design-pr-review-graph.md#92-mapping-a-new-head-to-the-last-reviewed-one)). The set is at most N1 and 15 questions |
| The feature-level question's type | A new type, `existing-feature`; a 0.26 high-level `existing-reuse-common` key maps to it on migration | The question no longer asks about common logic to share; a distinct type keeps the two meanings apart in the ledger |
| `other` in large mode | Allowed in both modes, at most 5, design-level subjects only ([§3.3](#33-the-other-question)) | 0.26 forbids additions in large mode because they were per-symbol; a design-level `other` is the same unit in both modes |
| Which aspect owns a test-gap lead | Maintainability owns every lead and gives its status; the correctness reviewer receives the surviving mutants and untested functions of its scope as context, with no status required ([§4.3](#43-leads)) | Test quality is maintainability's focus ([§8.1](design-pr-review-graph.md#81-review)); a correctness finding claims wrong behavior and needs a reproducing test, which a test gap alone is not, but a mutant can point the correctness reviewer at an unchecked edge case |
| How a P1 lead fits the P0/P1 rule | An `untested-feature` finding is the one non-behavioral finding that may be drafted at P1; its proof is the recorded test map and coverage, not a reproducing test ([§4.3](#43-leads)) | Only proven behavioral findings reach P1 today ([§8.2](design-pr-review-graph.md#82-reproducing-tests)); the owner made this lead P1 |
| How `--no-report` reaches the validators | A request suffix, plus one generic change: `ValidationInput` carries the task's pinned request ([§10](#10-generic-platform-change)) | `task new` can only write the request and `base` ([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)); a validator must tell an operator's opt-out from a missing report, as `rounds` needed the profile in 0.23 ([§3.2.1](design-pr-review-graph.md#321-rounds-run-round-2-directly)) |
| `--no-report` and a usable round-1 report | `--no-report` replaces the prelude only; a usable round-1 report is still the context ([§4.2](#42-the-context-source)) | The sources are ordered, and the round-1 report costs no job |
| How many leads a reviewer gets | At most 60, `untested-feature` first; the rest are recorded as not given ([§4.3](#43-leads)) | One assignment has to stay readable and fit its bounds; 0.26's standard mode asked a question per new symbol and per function over a limit, up to 200 new symbols, and leads now exist in large mode too |
| Where the ledger lives | The same ref, `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`, written by both graphs' command jobs | A migration in place; the task-plan namespace rule binds `task new` steps only, not command jobs |
| Profiles | One profile file may serve both graphs: each parser accepts the other graph's keys unread and still refuses any other unknown key; each bundle ships only its own keys ([§7.2](#72-profiles)) | `--profile <name>` looks in `<out>/profiles/` first, which both graphs share |
| The reviewers' harness | `pr-review` has no answerer, so `sameAs: "answerer"` is dropped; a reviewer defaults to `claude-code` | The constraint is vestigial since 0.21 ([§13.1](design-pr-review-graph.md#131-roles)) |
| The shared source tree | `examples/plugins/review-kit/src`, copied into each plugin's `src/kit/` with a drift test, as [§14](design-pr-review-graph.md#14-sharing-code-with-issue-fix) planned | `vendor/` stays reserved for third-party code, which the header check exempts |
| 0.26 items of moved question types | Closed as `moved` or `superseded` on migration, not re-checked by round 1 and not counted by either graph ([§5.4](#54-migrating-a-v1-ledger)) | Otherwise the first new round 1 would call them `fixed` because no question of theirs remains ([§9.3](design-pr-review-graph.md#93-re-checking-earlier-findings)) |

## 2. Two graphs, two plugins

| | `pr-design-review` | `pr-review` 1.x |
|---|---|---|
| Bundle | `examples/plugins/pr-design-review`, version 0.1.0 | `examples/plugins/pr-review`, version 1.0.0 |
| Stages | Fetch → Report → Questions → Answers → Round 1 → Publish | Fetch → Report → Review → Checks (when the profile has `checks`) → Draft → Publish |
| Agents | reporter, diagrammer, report-checker, questioner, answerer, batch-answerer, answer-checker | reporter, diagrammer and report-checker (the report-only prelude only), reviewer and verifier per aspect |
| Docker | Never | Coverage, mutation, reproducing tests, checks |
| Posts | Round 1's open items, when there are any; nothing when clean, unless the profile asks for a note | One review, always: round 2's findings, the round-1 status, the verdict |
| Ledger section | `design`: heads, `N1`, `Q<n>` | `review`: heads, `F<n>` |
| Head marker | `<!-- graphloom-design-review: <head> <nonce> -->` | `<!-- graphloom-review: <head> <nonce> -->` (unchanged) |

Each run reviews one head and ends, as in
[§2](design-pr-review-graph.md#2-the-run-two-rounds-and-no-human). Nothing in
either graph waits for a person. The usual sequence for a head is

```sh
graphloom task new pr-design-review apache/skywalking-banyandb#1234 --repo ../skywalking-banyandb --profile banyandb
graphloom check reviews/skywalking-banyandb-1234-design/task.yaml
graphloom run reviews/skywalking-banyandb-1234-design/task.yaml --on-stop '…'
# ends complete: "design review: changes requested: 2 open … posted (<url>)", or
# "design review clean at 9ab2…41; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#1234 --profile banyandb"
graphloom task new pr-review apache/skywalking-banyandb#1234 --repo ../skywalking-banyandb --profile banyandb
graphloom run reviews/skywalking-banyandb-1234/task.yaml --on-stop '…'
```

but the second pair can run first, alone, or on a head the design review never
saw.

**Shared code.** The machinery both graphs run is one source tree,
`examples/plugins/review-kit/src`, copied into each plugin's `src/kit/` by
`npm run vendor -w <plugin>`; each plugin's tests fail when its copy differs from
the kit, and the manifest is regenerated afterwards. This is the mechanism of
[§14](design-pr-review-graph.md#14-sharing-code-with-issue-fix), for the same
reason: a dependency is not repairable in a run, and vendored source is inside
each bundle's digest, so a qualified repair in one graph's run cannot change the
other graph. The kit holds:

- Fetch: the snapshot reads, the head checkout, the principles read, the sandbox
  image probe (used by `pr-review` only);
- the ledger: its v2 layout, section reads and writes, the v1 migration
  ([§5](#5-the-ledger));
- the change report: template, detectors, briefing, claim check, diagrams, the
  HTML and Markdown rendering, the part-set writes
  ([§6](design-pr-review-graph.md#6-the-change-report));
- the static measurements and their recomputation
  ([§6.8](design-pr-review-graph.md#68-measurements));
- symbol extraction, whole-repository search and test mapping
  ([§7.2](design-pr-review-graph.md#72-deterministic-groundwork));
- publish: the plan, the reconcile, the read-back, the shortening rules
  ([§8.5](design-pr-review-graph.md#85-publish)), parameterized by the head
  marker;
- the profile parser for the shared keys and the request and `prepareTask`
  helpers.

What stays in one plugin: N1, the questions, the answers and the round-1 gate in
`pr-design-review`; coverage, mutation, the reproducing tests, the review sweep,
the leads, checks and the draft in `pr-review`.

## 3. `pr-design-review`: round 1

### 3.1 Stages and requirements

Rows that differ from [§5](design-pr-review-graph.md#5-stages-and-requirements);
every other requirement of Fetch, Report, Questions and Answers holds as written
there. Review, Checks and Draft do not exist in this graph.

| Stage | Requirement | What changes | Validator checks |
|---|---|---|---|
| Fetch | `prior-ledger` | Reads the ledger's `design` section only (or a v1 ledger, migrated in memory, [§5.4](#54-migrating-a-v1-ledger)). No delta read for carried questions: only N1's carry inputs are read ([§3.5](#35-a-later-head)). No Docker image probe | `review-scope`: the section read, or recorded absent; N1's carry inputs read, or the reason N1 is asked again |
| Report | `measurements` | Complexity and nesting only, at the head and, for a modified function, at the base, by the pinned tools under bwrap. No coverage, CRAP or mutation, and no not-run reason for them: the section says they are measured by `pr-review` ([§3.4](#34-measurements-in-round-1)) | `measurements`: every value recomputes from its evidence ([metrics §5](design-code-quality-metrics.md#5-records-and-recomputation)); no coverage or mutation record is required or accepted |
| Questions | `questions-complete` | N1 first, unchanged. Then the required questions of [§3.2](#32-the-questions-after-narrowing), per high-level change in both modes, and at most 5 added design-level `other` questions. No question is required from a measurement, a test map or a symbol | `questions-complete`: recomputes the required set from the briefing's `whatsNew` (or the fallback items of [§7.6](design-pr-review-graph.md#76-questions-in-large-mode)) and the stated purposes; checks each added question by [§3.3](#33-the-other-question) |
| Answers | `answers-complete` | No proposal of a split, a test outline or an assertion: those were answers to the moved types | `answers-complete`: as today, for the types that remain |
| Answers | `answers-grounded` | The checker re-checks N1, every cited equivalent, mechanism and library, and every "none found"; no covering test is checked | `answers-grounded`: as today, for the types that remain |
| Answers | (ledger write) | Advances the `design` section only ([§5.2](#52-writing-a-section)) | `ledger-cas` |
| Round 1 | `round1-gated` | The gate of [§3.6](#36-the-gate): no `missing-test` kind. Record `pr-design-review-round1-v1` | `round1-gated`: recomputes the record from `necessity.json` and `qa.json` |
| Publish | `review-published` | Posts round 1's open items when there are any, with the design head marker. When round 1 is clean, posts nothing (or the note of [§3.7](#37-publish-and-the-runs-result)) and records the head as clean in the `design` section | `review-published`: the items and verdict recompute from `round1.json`; a clean round 1 has no post unless the profile asks for the note; the ledger's `design` section records the head, its result and any review ids |

The `rounds` profile key ([§3.2.1](design-pr-review-graph.md#321-rounds-run-round-2-directly))
is gone: a run of this graph is round 1, and a run of `pr-review` is round 2.
Both parsers refuse `rounds` with a message naming the two graphs.

### 3.2 The questions after narrowing

The question table of [§7.1](design-pr-review-graph.md#71-questions) and its
large-mode form in [§7.6](design-pr-review-graph.md#76-questions-in-large-mode)
become one table for both modes. A **high-level change** is a capability of the
briefing's `whatsNew` (`W1`…`W5`), or, when the claim check kept none, one of the
report's coarsest change items standing in for it, as §7.6 already defines.

| Type | Required for | Compared with 0.26 |
|---|---|---|
| `necessity` | Always, first, id `N1` ([§7.5](design-pr-review-graph.md#75-the-necessity-question-n1)) | Unchanged, the skip rule and `--all-questions` included |
| `purpose` | Every high-level change whose purpose the pull request's text does not state; a stated one is recorded with its quote | In standard mode it was per change item (`R<n>`); now per high-level change in both modes |
| `existing-feature` | Every high-level change: does the codebase already have this feature or mechanism, or does a declared library do it? One question, one answer | The feature-level part of `existing-reuse-common`, asked once per high-level change, as large mode already did. It no longer asks whether there is common logic to share, and it is never asked per new symbol |
| `other` | Added by the questioner, at most 5, design-level only ([§3.3](#33-the-other-question)) | Was any subject, at most 30, none in large mode |

Moved to `pr-review` as leads ([§4.3](#43-leads)): `missing-test`,
`split-function`, `complexity-coverage`, `weak-test`, and the per-symbol half of
`existing-reuse-common` (reuse of an existing helper, logic duplicated in the
base or in the pull request that could be shared). A pull request of any size
therefore asks N1 and at most 15 more questions (five changes of two, and five
added), one answer batch in large mode.

The groundwork of [§7.2](design-pr-review-graph.md#72-deterministic-groundwork)
shrinks with the questions: the dependency inventory and the purpose lookup
stay; symbol extraction stays for the report's digest; the per-symbol searches
and the test map leave round 1 (the answerer of `existing-feature` runs its own
searches, recorded and re-run as in
[§7.3](design-pr-review-graph.md#73-answers)).

### 3.3 The `other` question

`other` stays, restricted to design-level questions. The restriction is in three
places:

- **The questioner's prompt** says what a design-level question is about: the
  change's fit with the system's architecture, a data model or storage schema, an
  interface, a protocol or a configuration surface, compatibility with existing
  clients or data, where a mechanism belongs, and the change's interaction with
  another subsystem. It says what it is not about: a function's body, naming,
  tests, complexity, error handling inside a function, or anything `pr-review`'s
  reviewers judge.
- **Deterministic validation** of an added question: its `type` is `other`; its
  `symbol` is empty; its `item` is a high-level change (`W<n>`) or a change item
  of the `schema`, `interfaces`, `config`, `external` or `removed` sections; at
  most 5 are added. A violation goes back to the questioner as a correction
  ([§7.1](design-pr-review-graph.md#71-questions)'s two corrections, then the
  supervisor). No word list is applied to the text
  ([§6.5](design-pr-review-graph.md#65-deterministic-validation)).
- **The plugin drops** an addition whose type, item and empty symbol repeat a
  required question, as today.

### 3.4 Measurements in round 1

[§6.8](design-pr-review-graph.md#68-measurements) changes for this graph only:

- The static tools run as today, batched and split, over the head and, for a
  modified function, the base, so the table keeps `base → head` and the
  inherited, made-worse and introduced labels.
- The table has the columns Function, Change, Complexity and Nesting. The line
  under the heading says: "Coverage, CRAP and mutation are measured by the PR
  review (`pr-review`)."
- The hotspots of the briefing are the five functions with the highest
  complexity, then nesting, with a modified function that got worse shown as
  `base → head` (0.26 ranks by CRAP first).
- No measurement makes a question or a round-1 item.

`metrics.coverage`, `metrics.mutation` and `metrics.sandbox` are `pr-review` keys
([§7.2](#72-profiles)); this graph accepts them unread.

### 3.5 A later head

0.26 makes round 1 incremental on a later head
([§9.3](design-pr-review-graph.md#93-re-checking-earlier-findings)): questions
whose subject and citations did not change are carried. That rule is per symbol
and per change item, and large mode never used it. After the split every
question but N1 is per high-level change, so:

- **N1** keeps its carry rule (item 4 of §9.3): carried when it concluded
  `necessary`, asked every question, none of its citations changed, the
  principles file is the same commit and the pull request's text still holds its
  quotes. The head delta and base delta of
  [§9.2](design-pr-review-graph.md#92-mapping-a-new-head-to-the-last-reviewed-one)
  are read for N1's citations only.
- **Every other question is asked** on every head (a full round 1), at most 15.
  `questions.incremental: false` also makes N1 asked again.
- **Earlier open items** are judged against the new round 1 by their stable key,
  as a full round 1 judges them in 0.22: the key of a high-level change's
  question is its type and the change's first cited path
  ([§9.1](design-pr-review-graph.md#91-where-the-ledger-lives)). An earlier item
  is `fixed` when the question with its key is no longer an open item (its new
  answer raises nothing, or no question has that key: its subject is gone), and
  still open when it is one. The answer checker gets the author's replies on the
  item's earlier thread, as untrusted data, as today.

### 3.6 The gate

[§9.4](design-pr-review-graph.md#94-rounds) item 1, narrowed. Round 1's open
items are, computed by plugin code from `necessity.json` and `qa.json`:

- N1's conclusion when it is not `necessary` (a supported broken principle
  included, [§7.5.1](design-pr-review-graph.md#751-project-design-principles));
- every question whose answer is `needs author` or `partially answered`;
- every `existing-feature` answer that names an equivalent outside the code the
  pull request changes (a citation in a base or head file the pull request does
  not add, modify, rename or delete, or a declared library), by the rules §9.4
  gives `existing-reuse-common` today: `none_found` or `reusable: false` is
  never an `existing` item and is recorded under `noted`; an equivalent inside
  changed files is the change itself, also `noted`; answers citing one outside
  equivalent merge into one item with `covers`.

A missing test is not a round-1 item any more. The record's kinds are
`necessity`, `needs-author`, `partial` and `existing`.

### 3.7 Publish and the run's result

[§8.5](design-pr-review-graph.md#85-publish) applies with these differences.

- **Open items: one review.** One `COMMENT` review carries round 1's open items,
  whole as since 0.26.1, inline when anchored, with an `Earlier items` section on
  a later head. Its first line is `Changes requested: <n> open` (`n` the open
  round-1 items, earlier ones included); its second line is the head marker
  `<!-- graphloom-design-review: <head> <nonce> -->`; its third says it is the
  design review (round 1) and that the PR review (`pr-review`) reviews the
  details. The idempotency key is `design-<head12>`. Reconcile looks for a
  review of this head carrying this graph's marker and this run's nonce; a
  review carrying `graphloom-review` is never this graph's.
- **Clean: nothing posted by default.** The pull request would otherwise get two
  reviews per head, one of them saying nothing. The stage records the head in
  the `design` section as `clean` and passes with no write, so it needs no write
  grant: a clean run without `github.writeTokenEnv` ends complete, not with
  `posting not enabled`.
- **The note, by choice.** A profile that sets `comments.designPassedNote: true`
  (default `false`) has a clean round 1 post one `COMMENT` review with no item:
  first line `Design review passed`, the head marker, and one line saying the PR
  review follows. It is posted, reconciled and recorded like any review of this
  graph, and needs the write grant like one.
- **The result.** The run ends `complete` with one line: with open items,
  `design review: changes requested: <n> open … posted (<url>)`; clean,
  `design review clean at <sha7>; nothing posted. Next: graphloom task new
  pr-review <owner>/<repo>#<N> --profile <name>`, with the profile's `name`
  field. The line is data in the run's result; no run is started by it
  ([§6](#6-chaining)).

## 4. `pr-review` 1.x: round 2

### 4.1 Stages and requirements

Rows that differ from [§5](design-pr-review-graph.md#5-stages-and-requirements).
Questions, Answers and Round 1 do not exist in this graph; the requirements of
Review, Checks and Draft lose their "unless round 1 found issues" clause, since
nothing in this graph gates them.

| Stage | Requirement | What changes | Validator checks |
|---|---|---|---|
| Fetch | `prior-ledger` | Reads the `review` section (earlier findings) and the `design` section (its heads, its open items, and the latest design head's `report.json`, `qa.json` and `necessity.json`), or a v1 ledger migrated in memory; reads the head delta from that design head to this head when the context source needs it ([§4.2](#42-the-context-source)); probes the Docker images | `review-scope`: the two sections read or recorded absent; the delta read, or the reason it is not usable |
| Report | `review-context` (new) | The context source is decided by plugin code and recorded in `context.json` (`pr-review-context-v1`): `design-review` with its head, `prelude`, or `none` ([§4.2](#42-the-context-source)) | `review-context`: recomputes the source from the ledger reads, the delta's usability and the task's request; `none` only when the request says `without a report` and no round-1 report is usable |
| Report | `change-report` | Holds as written in §5 when the source is `prelude`; when it is `design-review` or `none` the requirement passes on the recorded source and the Report stage writes no report of its own. No N1, no Q&A: the briefing's verdict line says "no design review in this run", and the open questions section is absent | `change-report`, given the source |
| Report | `measurements` | Always, whatever the source: static at head and base, then coverage and mutation in the Docker sandbox, as §5 states today. The leads need them | `measurements`, unchanged |
| Report | `claims-checked` | Only for `prelude`; otherwise passes on the recorded source | `claims-checked`, given the source |
| Review | `code-review` | Each reviewer starts a fresh session seeded with the context of [§4.2](#42-the-context-source); the `review-scope` record names the source. The first pass of each aspect is given its leads ([§4.3](#43-leads)) beside the earlier findings. The maintainability rule file changes ([§4.4](#44-the-maintainability-aspect)). Contract `pr-code-review-v2`: `v1` plus `leads` | `code-review`: as today, plus the scope's recorded source equals `context.json`'s |
| Review | `leads-judged` (new) | Every lead has exactly one status from its aspect's reviewer, `raised` (naming the comment it raised) or `not-an-issue` (with a reason) | `leads-judged`: recomputes the leads from the measurement records, the test map and the search reports, and checks each status |
| Review | `findings-proven` | An `untested-feature` finding is proven by its recorded test map and coverage, not by a reproducing test ([§4.3](#43-leads)) | `findings-proven` |
| Draft | `draft-composed` | No Q&A item is drafted. The draft lists round 1's open items, or says round 1 was not run ([§4.5](#45-draft-publish-and-the-verdict)). A confirmed `untested-feature` finding may be P1 | `draft` |
| Draft | `ledger-recorded` | Advances the `review` section only, with this head's context source | `ledger-cas` |
| Publish | `review-published` | Always posts one `COMMENT` review with the `graphloom-review` head marker and the idempotency key `review-<head12>` ([§4.5](#45-draft-publish-and-the-verdict)) | `review-published`: the items, the round-1 lines and the verdict recompute from the draft, `context.json` and the `design` section read in Fetch |

### 4.2 The context source

The reviewers' context is the first of these that applies; plugin code decides,
from what Fetch recorded, and `context.json` and the `review-scope` record name
it.

1. **`design-review`: the ledger's round-1 report.** The `design` section holds a
   report of a head D: the latest design head, whose `report.json`, `qa.json` and
   `necessity.json` the section's tree carries ([§5.1](#51-layout)).
   - D is this head: the report is used as it is.
   - D is another head (usually an earlier one): the report is used when the
     delta from D to this head is usable by the rules of
     [§9.2](design-pr-review-graph.md#92-mapping-a-new-head-to-the-last-reviewed-one)
     items 2 and 3 (the records are there and of one mode with this head, D's
     commit and base are in the review clone, the diff is complete and fits).
     Item 4 (`questions.incremental`) does not apply. D's commit is kept alive by
     `pr-design-review`'s pinned ref,
     `refs/graphloom/pr-design-review/<owner>/<repo>/<N>/heads/<sha>`.
   - The seed, `review.md`, is rendered by plugin code from those three records,
     as round 1 renders it, with two changes: its Measurements section is this
     run's (coverage, CRAP and mutation included), and when D is not this head a
     section "Since this report" says the report and the Q&A describe D, and
     lists the files and hunks the delta changed. In large mode the review scope
     is taken from D's briefing cites, each mapped to this head by the delta; a
     cite whose file left the pull request is dropped, and when none remains the
     scope is every readable area, as [§8.1](design-pr-review-graph.md#81-review)
     already provides.
   - A round-1 report with open items is used all the same: round 2 does not gate
     on round 1.
   - With no design head, or a delta that is not usable, the source is the next
     one; the reason is recorded in `context.json`.
2. **`prelude`: a report-only prelude.** Fetch, then the Report stage as in
   [§5](design-pr-review-graph.md#5-stages-and-requirements): `change-report`
   (briefing, diagrams, HTML) and `claims-checked`. No N1, no questions, no
   answers, no gate. `review.md` is that report and this run's Measurements.
3. **`none`: `--no-report`.** Only when the operator asked
   (`graphloom task new pr-review … --no-report`, [§7.1](#71-tasks)), and in
   place of the prelude: a usable round-1 report (source 1) is still used, since
   it costs no job, and the order of the sources stays as listed. The seed is
   the pull request's metadata (title, body and commit messages as untrusted
   blocks), its file list with the diffstat, and the patches of the files in the
   review's scope, within the existing assignment bounds. In large mode there is
   no briefing to narrow the scope, so every readable area is reviewed. It is
   weaker, since the reviewers have no map, and never the default.

**Round 1 in the review.** When the `design` section has a head, the posted
review lists round 1's open items and counts them ([§4.5](#45-draft-publish-and-the-verdict)),
whatever the context source. When it has none, the review says round 1 was not
run.

**The design principles** reach the reviewers as in
[§8.1](design-pr-review-graph.md#81-review) ("Design principles in round 2"),
read in Fetch by this graph. Beside each principle is round 1's verdict and the
checker's judgment from D's `necessity.json` when the source is `design-review`,
and `round 1: not run` otherwise.

### 4.3 Leads

A **lead** is a deterministic pointer, computed by plugin code before the first
pass of the sweep, at something the moved questions used to ask. It is not a
finding and not posted. It goes to its aspect's reviewer in the first pass,
beside the earlier findings, as data with an id (`L1`…, per run), its kind, its
place and the measured facts behind it. The reviewer returns one entry for each
lead it was given in `leads[]`: `raised`, with the index of the comment the pass
raised about it, or `not-an-issue`, with a reason. A missing, repeated or unknown
lead id is rejected and goes back to the same session as a correction, as an
unknown principle id does. A raised finding is an ordinary finding: it is
verified, prioritized P0 to P3 and posted only when confirmed, with the one
exception in the table.

| Lead kind | Computed from (every source is a recorded measurement, test map or search) | Aspect | Highest priority of its finding |
|---|---|---|---|
| `untested-feature` | A high-level change of the report (`design-review` or `prelude` source) whose every new or modified function, in the files its cites name, has no covering test: the test map finds none, and coverage, when measured, executed none of their changed lines | maintainability | P1: the only non-behavioral finding that may be drafted at P1. Its proof is the recorded test map and coverage record, which the validator recomputes; the verifier confirms that no test of the pull request or the base exercises the feature |
| `missing-test` | A new or modified function (not a type or interface) with no covering test by the same rule, not already inside an `untested-feature` lead | maintainability | P2 |
| `weak-test` | A surviving mutant at a covered site: its file, line and mutation | maintainability | P2 |
| `split-function` | A changed function with complexity ≥ 10 or nesting > 3, with whether the excess is inherited, made worse or introduced ([§6.8](design-pr-review-graph.md#68-measurements)) | maintainability | P2 |
| `crap` | A changed function with measured coverage and CRAP ≥ 30, or unknown coverage and complexity ≥ 10 (the rule of `complexity-coverage` today) | maintainability | P2 |
| `reuse` | A new symbol whose whole-repository search ([§7.2](design-pr-review-graph.md#72-deterministic-groundwork) item 2) found a candidate outside the files the pull request changes: a name or signature hit, or a body with similarity at least `questions.similarity`; or another new symbol of the pull request above that similarity | maintainability | P2 |

- **Scope.** Leads are computed for the functions and symbols in the review's
  scope only (in large mode, the files of the scoped areas). With no report
  (`none`) there is no `untested-feature` lead. With coverage off or not run, the
  test map alone decides, `crap` uses its unknown-coverage rule, and there is no
  `weak-test` lead. Past `limits.maxNewSymbols`, `reuse` leads are not computed
  (the searches are what costs), and `review-scope` says so.
- **Bound.** At most 60 leads are given, `untested-feature` first, then by kind in
  the table's order and by path; the rest are recorded as `not given: over the
  lead bound of 60` and need no status.
- **Context for correctness.** The correctness reviewer's assignment also lists,
  with no status required, the surviving mutants and the untested functions of
  its scope: a mutant that survives can point at an edge case whose behavior is
  wrong, which is then a behavioral finding with a reproducing test
  ([§8.2](design-pr-review-graph.md#82-reproducing-tests)).
- **Records.** The leads and their statuses are in `review-aspect-maintainability`
  (`pr-review-aspect-v2`: `leads[]` with id, kind, place, facts, status, reason
  or finding id). The appendix of `review.html` lists them. The ledger keeps
  their counts per head, not the leads: a later head computes them again.
- **A later head.** A lead whose subject is unchanged comes back on the next head
  and is judged again; a finding raised from a lead is an earlier finding there,
  re-checked by [§9.3](design-pr-review-graph.md#93-re-checking-earlier-findings)
  like any other.

### 4.4 The maintainability aspect

The maintainability row of [§8.1](design-pr-review-graph.md#81-review)'s aspect
table excludes "what the Q&A already answers (reuse, duplication against the
codebase, complexity splits, missing tests)". After the split no Q&A answers
those topics, with or without a round-1 report, so the exclusion goes. The
shipped `rules/maintainability.json` becomes:

| Aspect | Focus | Out of scope |
|---|---|---|
| `maintainability` | Readability, structure and naming, duplication and reuse of existing code, coupling, complexity, test coverage and test quality, the leads it is given | Whether a whole feature or mechanism already exists in the codebase, when the context source is `design-review` (round 1's `existing-feature` answers it); whether behavior is correct or safe |

When the source is `prelude` or `none`, nothing is out of scope for reuse: a
whole feature that already exists is a maintainability finding. The map bullets
of §8.1 ("A finding that restates a Q&A item is folded into it") apply only to
round 1's `existing-feature` and `purpose` answers, and only for the
`design-review` source.

### 4.5 Draft, publish and the verdict

[§8.4](design-pr-review-graph.md#84-draft), [§8.5](design-pr-review-graph.md#85-publish)
and [§10.3](design-pr-review-graph.md#103-verdict) change as follows.

- **Round 1 lines.** The body has a section "Design review (round 1)":
  - when the `design` section has a head with open items: the head it reviewed
    (this head, or another, then `as of <sha7>; run pr-design-review on this
    head to re-check them`), then each open item (`N1`, `Q<n>`) with a link to
    its comment, or `not posted` when that run did not post it. Nothing of round
    1 is posted again: an item already on the pull request stays where it is;
  - when the `design` section has a head and no open item: `Design review at
    <sha7>: no open item.`;
  - when it has none: "Round 1 (the design review) was not run on this pull
    request; the verdict counts this review's findings only."
- **What is posted.** Round 2's postable findings, inline when anchored, the rest
  in the body, each with its `F<n>` marker; an `Earlier items` section for the
  earlier `F<n>` findings, as since 0.22. Q&A items are never drafted or posted.
- **Verdict**, the body's first line: `Review passed` when no `F` finding (new or
  earlier) is open and no round-1 item is open; else `Changes requested: <n>
  open`, where `n` counts the open `F` findings, earlier ones included, and the
  open round-1 items listed. Without a round-1 record, `n` counts `F` findings
  only.
- **Recommended verdict** ([§10.3](design-pr-review-graph.md#103-verdict)):
  `request-changes` also for a confirmed `untested-feature` finding at P1.
- **Reconcile and idempotency.** The head marker is `graphloom-review`, as today;
  a review of this head that carries `graphloom-design-review` is never this
  graph's. The idempotency key is `review-<head12>` (0.26 used
  `publish-<head12>-r<round>`).
- **Ledger.** `ledger-published` advances the `review` section with the head's
  `reviewId`, `verdict`, `open`, the context source and the round-1 head it
  counted.
- **Posting not enabled** (since 0.23.1): unchanged; the stop names the draft and
  `review.html`.

## 5. The ledger

**Status:** implemented in pr-review 0.27.0, still the two-round graph
([§11](#11-implementation-plan) item 1): it writes the `design` section after the
Q&A and with a round-1 post, and both sections with a round-2 post; it posts round 1
with the design-review marker and round 2 with the PR-review marker.

[§9.1](design-pr-review-graph.md#91-where-the-ledger-lives) changes from one
registry advanced by one graph to one ledger with a section per graph.

### 5.1 Layout

The ref stays `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`. Its commit's
tree:

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
  migrates the ledger, and never changed by a section write. A section absent
  from the tree is a graph that has not run on this pull request.
- `design/ledger.json`: `heads: [{ sha, base, files, commits, facts, round1:
  "clean" | "items", open, reviewId?, reviewUrl?, note? }]`, `purposes`, `qa:
  [{ id, type, key, symbol, item, status, answer, state, history[] }]` and
  `items`, one entry per posted round-1 id (`N1`, `Q<n>`) in the shape §9.1 gives
  posted items since 0.22, with `state` `open`, `fixed`, `moved` or `superseded`
  ([§5.4](#54-migrating-a-v1-ledger)).
- `review/ledger.json`: `heads: [{ sha, base, context: { source, head? },
  round1: { head, open } | null, reviewId?, reviewUrl?, verdict?, open?, leads:
  { given, raised } }]` and `findings`, one entry per `F<n>` (posted, or
  `withdrawn`), as §9.1 gives them.
- **Ids.** `pr-design-review` numbers `Q<n>` from its own section only;
  `pr-review` numbers `F<n>` from its own section only. Stable keys are unchanged
  ([§9.1](design-pr-review-graph.md#91-where-the-ledger-lives)), with the type
  `existing-feature` in the key of that question.

### 5.2 Writing a section

Each graph advances only its own section, by compare-and-swap on the ref. The
write command, one read-only command job as today:

1. reads the ref's current value `cur` (absent: the zero id);
2. checks that `cur`'s tree has, at its own section, exactly the section's
   **baseline**: the subtree this run's own latest accepted ledger write produced
   (each graph writes its section twice in a run, after the Q&A or the draft and
   again in Publish, `ledger-published`), or, before its first write, the
   subtree Fetch read at the old value `old` (both absent counts as equal). The
   baseline is named in the command's argv, so it is evidence. When `cur`'s
   section differs from it, another run of the same graph advanced the section:
   the command exits `LEDGER_MOVED` and the run stops retryably "ledger moved",
   as today;
3. builds the new root tree from `cur`'s, with its own section's subtree replaced
   (and, when `cur` is absent or a v1 commit, the migrated layout of
   [§5.4](#54-migrating-a-v1-ledger)), and a commit whose parent is `cur`;
4. runs `git update-ref <ref> <new> <cur>`; when that loses a race, it starts
   again from 1, at most three times, then exits `LEDGER_MOVED`.

A concurrent run of the other graph on the same pull request therefore never
stops this one: its section is carried over from `cur` unchanged. The command's
record names `old`, the baseline, `cur` and the new commit, and `ledger-cas`
recomputes that the baseline is the previous accepted write's subtree (or
Fetch's), that the other section's subtree is `cur`'s and this section's is the one written.

Reads follow the same split. Fetch reads the section files it needs with the
part reads of 0.26 (`ledger-prior`, `ledger-prior-<k>`, a header with the digest
of the whole), one set per file, all from the one commit it read the ref at.
`pr-design-review` reads `design/` only; `pr-review` reads `review/ledger.json`
and `design/ledger.json`, and `design/report.json`, `qa.json` and
`necessity.json` when the context source may be `design-review`.

### 5.3 Head markers and publish idempotency

[§8.5](design-pr-review-graph.md#85-publish) step 2 finds a review of this head
that this run posted by its head marker and nonce. Each graph has its own marker,
so a design-review post and a PR-review post on one head are told apart before
the nonce is compared:

| Graph | Head marker (the body's second line) | Idempotency key | Ledger section that records it |
|---|---|---|---|
| `pr-design-review` | `<!-- graphloom-design-review: <head> <nonce> -->` | `design-<head12>` | `design` |
| `pr-review` | `<!-- graphloom-review: <head> <nonce> -->` | `review-<head12>` | `review` |

Item markers (`<!-- graphloom-finding: N1 -->`, `Q3`, `F3`) are unchanged; the id
prefix already says which graph owns an item. Marker-looking text in an item is
neutralized for both head markers.

### 5.4 Migrating a v1 ledger

A ledger whose `ledger.json` is `graphloom-pr-ledger-v1` (0.21 to 0.26) is read by
both graphs and migrated by the first write of either. The migration is one pure
function in the kit, so both graphs build the same v2 tree from the same v1
commit, and the validators recompute it.

| v1 | v2 |
|---|---|
| `heads[]` | Every head goes to `design.heads`: v1 `round1: "issues"` becomes `items`, `clean` stays, `skipped` becomes `clean` with `note: "round 1 skipped (rounds: review-only)"`. A head with `reviewed: true` also goes to `review.heads`, with its `reviewId`, `verdict` and `open`, and `context: { source: "design-review", head: <sha> }` (`prelude` when round 1 was skipped). A head whose review was a round-1 post keeps its `reviewId` in `design` |
| `qa[]`, `purposes` | `design.qa`, `design.purposes`. The key of a high-level `existing-reuse-common` question (`existing-reuse-common\|item\|<path>`, a `W` change's first cited path) is rewritten to `existing-feature\|item\|<path>` |
| `findings[]` with an `N1` or `Q<n>` id | `design.items`, with the state rules below |
| `findings[]` with an `F<n>` id | `review.findings`, unchanged |
| `report.json`, `qa.json`, `necessity.json` | `design/`, as the latest design head's records |

**Open items of moved types.** A v1 round-1 item that is open and whose question
type round 1 no longer asks, or whose unit it no longer asks about, is closed
with a reason; neither graph re-checks or counts it:

- `moved`: `missing-test`, `split-function`, `complexity-coverage`, `weak-test`,
  and a per-symbol `existing-reuse-common`. Reason: "a detail question since the
  split; the PR review judges it as a lead". When the gap is still there,
  `pr-review` computes the lead again, and a confirmed finding gets a new `F<n>`.
- `superseded`: a `purpose` or `other` question about a change item or a symbol.
  Reason: "round 1 now asks per high-level change".

The next design review lists each such item once in its `Earlier items` section,
with its reason and the link to its earlier comment, and never again.

**0.26.x and a v2 ledger.** 0.26.x reads a ledger only when its schema is
`graphloom-pr-ledger-v1` (`priorState` in `src/ledger.ts`); any other schema
stops its run in Fetch as unreadable. Once a v2 writer (pr-review 0.27 or later,
or `pr-design-review`) has written a pull request's ledger, 0.26.x cannot review
that pull request again, and it never overwrites the v2 ledger. A pull request
no v2 writer has touched can still be reviewed by 0.26.x. This is one-way on purpose: a v1 writer would drop
the sections it does not know.

## 6. Chaining

No run starts another, and nothing in the controller, the SDK or the CLI knows
that two graphs are two rounds of one review: a round is a plugin notion, and
the controller-plugin boundary keeps it in the plugins.

- A clean `pr-design-review` run names the next command in its result
  ([§3.7](#37-publish-and-the-runs-result)); a run with open items names none.
- The `graphloom-run` skill relays that line. It starts the `pr-review` task
  (task new, check, run, as for any graph) only when the user asks for the PR
  review; it never starts it because a design review was clean.
- `pr-review` reads what `pr-design-review` left in the ledger and nothing else;
  it runs the same way whether a design review ran a minute earlier, on another
  head, or never.

## 7. Tasks and profiles

### 7.1 Tasks

[§3.1](design-pr-review-graph.md#31-task) changes as follows. Both plugins
implement `prepareTask` with the two-phase head plan of §3.1, each under its own
ref namespace, as `validateTaskPlan` requires.

| | `pr-design-review` | `pr-review` 1.x |
|---|---|---|
| Command | `graphloom task new pr-design-review <owner/repo#N or URL> --profile <name or path> [--base <branch>] [--all-questions] [--repo <clone>]` | `graphloom task new pr-review <owner/repo#N or URL> --profile <name or path> [--base <branch>] [--no-report] [--repo <clone>]` |
| Refs | `refs/graphloom/pr-design-review/<owner>/<repo>/<N>/` `head`, `base`, `heads/<sha>` | `refs/graphloom/pr-review/<owner>/<repo>/<N>/` `head`, `base`, `heads/<sha>` (unchanged) |
| Task path | `reviews/<repo>-<N>-design/task.yaml` | `reviews/<repo>-<N>/task.yaml` (unchanged) |
| Request | `Design review on <owner>/<repo>#<N> at <sha>[, asking every question].` | `Review on <owner>/<repo>#<N> at <sha>[, without a report].` |
| Refused | `--no-report`, `--review` | `--all-questions` (naming `pr-design-review`); a `Report on …` request (the 0.x form) |

- The two graphs' tasks live in separate directories because a task directory
  holds one `task.yaml` and one `profile.json` link beside it
  ([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)).
- `--review` has been accepted and ignored since 0.21; `pr-review` 1.x keeps
  accepting and ignoring it, so earlier invocations still work.
- `--no-report` is the request suffix `, without a report`. The validators see it
  through the generic change of [§10](#10-generic-platform-change).
- Fetch's check of the task against GitHub (the head sha, the base an ancestor)
  is unchanged in both.

### 7.2 Profiles

The keys of [§3.2](design-pr-review-graph.md#32-profile) are partitioned. One
operator profile may hold the union: each graph's parser accepts the keys only
the other graph reads, without reading or checking them, and refuses any key
neither reads, as today. Each bundle ships a profile with its own keys only
(`profiles/banyandb.json` in both).

| Key | `pr-design-review` | `pr-review` 1.x |
|---|---|---|
| `name`, `project`, `baseBranch`, `environment`, `report`, `symbols`, `context`, `issues`, `privateRepos`, `supervisor`, `budgets`, `limits` (but see `maxNewSymbols`) | reads | reads |
| `questions.excludeRoots`, `questions.principles` | reads | reads (the search of `reuse` leads; the reviewers' principles) |
| `questions.designDocs`, `questions.incremental` | reads | accepts unread |
| `questions.similarity`, `questions.maxCandidates` | accepts unread (round 1 has no per-symbol search) | reads (`reuse` leads) |
| `metrics.files`, the static tools' `argv`, `metrics.generated` | reads | reads |
| `metrics.coverage`, `metrics.mutation`, `metrics.sandbox` | accepts unread | reads |
| `review.*`, `rules`, `checks` | accepts unread | reads |
| `comments.minSeverity`, `nits`, `maxComments`, `suggestions` | accepts unread | reads |
| `comments.questions` | refused (there is no draft) | refused (no Q&A item is drafted) |
| `comments.footer` | reads | reads |
| `comments.designPassedNote` (new, default `false`) | reads ([§3.7](#37-publish-and-the-runs-result)) | accepts unread |
| `harnesses.reporter`, `diagrammer`, `report-checker` | reads | reads (the prelude only) |
| `harnesses.questioner`, `answerer`, `batch-answerer`, `answer-checker` | reads | accepts unread |
| `harnesses.reviewer-<aspect>`, `verifier-<aspect>` | accepts unread | reads; a reviewer defaults to `claude-code`, with no `sameAs` constraint; a verifier keeps `distinctFrom` its reviewer |
| `rounds` | refused | refused; both name the two graphs |
| `limits.maxNewSymbols` | accepts unread; round 1 asks nothing per symbol (`hardMaxNewSymbols` still refuses a task) | reads: past it, no `reuse` leads |

The validators of each graph see its pinned config only, as today.

## 8. Migration and coexistence

- **Versions.** `pr-review` 0.26.x is the last two-round version (0.27.x, the
  intermediate steps of [§11](#11-implementation-plan), is still two rounds).
  `pr-review` 1.0.0 is round 2 only and `pr-design-review` 0.1.0 is round 1.
- **0.26.x stays installable** until both new graphs are proven on real pull
  requests: a live run of each that completes and posts (or, for a clean design
  review, posts nothing) on at least two BanyanDB pull requests, one of them in
  large mode, and a `pr-review` run that reuses a design review's report from an
  earlier head. Until then the release notes name the last release that carries
  0.26.x; an operator who wants it keeps that version installed (`graphloom self
  prune` removes every version other than `current`, `previous` and those runs
  own, so it is not run while that version is wanted) and links its bundle in a
  separate `--out` workspace,
  `ln -s <that version's root>/examples/plugins/pr-review plugins/pr-review`
  ([release §4.6](design-release.md#46-operator-plugins-and-profiles)). A 0.26.x
  run cannot use a pull request's ledger once a v2 writer wrote it
  ([§5.4](#54-migrating-a-v1-ledger)).
- **Runs in flight** stay on the version they pinned. `resume --update-plugin`
  from 0.26.x onto 1.x is refused by the controller's existing check that a
  plugin update keeps the same stages, requirements and validator bindings
  (`packages/controller/src/pin.ts`); the operator finishes the run on 0.26.x or
  starts new tasks.
- **Existing task files.** A `graph: pr-review` task written for 0.26 and not yet
  run means round 2 only under 1.x, with the context source of
  [§4.2](#42-the-context-source). For both rounds, run `task new` for each graph.
  A task whose request is `Report on …` is refused by 1.x as incompatible,
  naming `pr-design-review`.
- **Existing ledgers** are migrated by the first write of either new graph
  ([§5.4](#54-migrating-a-v1-ledger)); nothing is done by hand.
- **Profiles.** An operator profile that sets `rounds` is refused by both new
  graphs, the message naming the graph to use (`review-only` meant: run
  `pr-review`). One that sets `comments.questions` drops it. One that relied on
  the reviewers taking the answerer's harness names them
  (`harnesses.reviewer-<aspect>`), as the shipped BanyanDB profile already does.

## 9. Not changed

- **N1**: its question, three parts, conclusion rules, checker, skip rule,
  `--all-questions`, principles and rendering
  ([§7.5](design-pr-review-graph.md#75-the-necessity-question-n1)).
- **The change report**: template, detectors, briefing, large mode, diagrams, the
  HTML report, the claim check and the part-set writes
  ([§6](design-pr-review-graph.md#6-the-change-report)), except round 1's
  Measurements columns and hotspots ([§3.4](#34-measurements-in-round-1)).
- **The answers**: the answerer, its confinement, ids, searches and their counts,
  batches, corrections and the answer checker
  ([§7.3](design-pr-review-graph.md#73-answers)).
- **The review layer**: three aspects, their rule files and the rule-group
  assertion, the sweep, verification, cross-aspect dedupe, reproducing tests and
  checks ([§8.1](design-pr-review-graph.md#81-review),
  [§8.2](design-pr-review-graph.md#82-reproducing-tests),
  [§8.3](design-pr-review-graph.md#83-checks)), except the leads and the
  maintainability scope.
- **Re-checking earlier round-2 findings** on a later head
  ([§9.3](design-pr-review-graph.md#93-re-checking-earlier-findings), round 2).
- **Publishing**: one `COMMENT` review, never `APPROVE` or `REQUEST_CHANGES`, the
  verdict as its first line, the read-back, the shortening rules, the posting
  grant and the `posting not enabled` stop
  ([§8.5](design-pr-review-graph.md#85-publish),
  [§12.5](design-pr-review-graph.md#125-never-auto-approve)).
- **Confinement, secrets, budgets, the supervisor and `graphloom session open`**
  ([§12](design-pr-review-graph.md#12-safety),
  [§13](design-pr-review-graph.md#13-agent-roles-supervisor-budgets),
  [§17](design-pr-review-graph.md#17-discussing-a-run-graphloom-session-open)),
  and every role constraint except the reviewers' `sameAs`.
  `session open --stage answers` opens a `pr-design-review` run's answerer.
- **issue-fix**: its review is unchanged, and this work does not vendor the kit
  into it.

## 10. Generic platform change

`ValidationInput` (`packages/sdk/src/types.ts`) gains `request?: string`, the
task's pinned request, which the run view already carries. The controller passes
it to every validator call and interprets nothing in it. A validator of
`pr-review` needs it to tell the operator's `--no-report` from a report the graph
failed to write, and `graphloom task new` can write only the request and `base`,
not the config
([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)).
The alternative, a profile key as `rounds` was, would make an operator copy a
profile for one run, the cost [§3.2.1](design-pr-review-graph.md#321-rounds-run-round-2-directly)
accepted for `rounds`.

## 11. Implementation plan

One pull request each, in this order. Each regenerates the manifests it touches
and keeps `npm test`, `npm run typecheck` and `npm run build` passing.

1. **Ledger v2, in pr-review 0.27.0**, still the two-round graph: sections,
   section reads, the section compare-and-swap with its retry, the v1 migration
   with `moved` and `superseded`, the two head markers (0.27 posts round 1 with
   the design marker and round 2 with the review marker) and the new idempotency
   keys. Tests: the migration of the v1 ledgers the rehearsal scenarios and
   `rereview.test.ts` build, field by field; real-Git tests of the write (the
   other section advanced between Fetch and the write is carried over; the same
   section advanced stops "ledger moved"; a run's second write (Publish's
   `ledger-published`) builds on its own first write, also when the other
   section moved in between; a lost `update-ref` race retries; the
   top-level `ledger.json` never changes); part reads of each section file; the
   publish reconcile ignores a review with the other marker; the validators
   recompute a migrated tree.
2. **`ValidationInput.request`** ([§10](#10-generic-platform-change)). Tests: the
   controller passes the pinned request to validators on run and on resume; a
   validator that ignores it behaves as before.
3. **The kit**, `examples/plugins/review-kit`, with pr-review 0.27.1 consuming it
   from `src/kit/` and no behavior change. Tests: the drift test; the pr-review
   suite unchanged; the header check covers `src/kit/`.
4. **`pr-design-review` 0.1.0**: the bundle, its `prepareTask`, its profile parser
   (the other graph's keys accepted unread), the narrowed questions, the `other`
   rules, static-only measurements, the full round 1 with N1 carried, the gate,
   publish with no post when clean and the optional note, the result line, the
   `design` section, rehearsal scenarios and manifest. Tests: the required set in
   each mode (`purpose` and `existing-feature` per high-level change, none of the
   moved types, the fallback when the briefing keeps no capability); each `other`
   rule; the gate has no `missing-test` kind; a clean run posts nothing and needs
   no write grant; the note when enabled; the result names `pr-review`; the plan
   writes refs only under `refs/graphloom/pr-design-review/`; a later head asks
   every question and carries N1; earlier open items are judged by key; the
   rehearsal converges with no Docker probe.
5. **`pr-review` 1.0.0**, round 2 only: the stage list, `review-context`, the
   three context sources, `--no-report`, the leads and `leads-judged`, the
   `untested-feature` P1 rule, the maintainability rule file, the round-1 lines
   and the verdict count, the `review` section, `rounds` and `Report on …`
   refused, the reviewers' default harness. Tests: each context source chosen by
   its rule (this head; an earlier head with a usable delta; an unusable delta
   falls back to the prelude; `none` only with the request suffix), recomputed by
   the validator; each lead kind from fixture measurement records, test maps and
   searches, with coverage off and in large mode; a missing lead status is
   corrected in the same session; a raised lead's finding is verified like any
   other; the verdict with and without a round-1 record; nothing of round 1 is
   posted again; a rehearsal scenario per context source.
6. **Skills and documents**: the `graphloom-run` skill (`task new` for both
   graphs, relaying the next command, starting it only on the user's request),
   README, AGENTS.md, `examples/README.md`, and the rewrite of
   [design-pr-review-graph.md](design-pr-review-graph.md) into the two graphs'
   designs, which replaces this document. Tests: `skills-drift.test.ts`; the link
   and anchor check.

After both graphs are proven on real pull requests
([§8](#8-migration-and-coexistence)), the release notes stop naming a 0.26.x
release to keep.

## 12. Open questions

1. **Reusing `pr-review`'s own prelude report.** A `prelude` report is not a
   round-1 report, so a later `pr-review` run does not reuse it as context
   ([§4.2](#42-the-context-source) reads the `design` section only), and the
   `review` section does not store it. Storing it and letting a later head use it
   under the same delta rule would save a reporter and a checker job per head
   when no design review runs. Should it?
2. **A `not-an-issue` status on an `untested-feature` lead.** Leads are judged by
   their reviewer, and only a raised finding is verified. For the one lead kind
   whose finding can be P1, should the aspect's verifier also check a
   `not-an-issue` reason (for example, that a test the reviewer names exercises
   the feature)?
