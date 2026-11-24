# PR design review graph (`pr-design-review`)

Status: implemented, `pr-design-review` 0.1.6 (`examples/plugins/pr-design-review`).
This is round 1 of a pull request's review: the design-level review. Round 2, the
detail review, is the [PR-review graph](design-pr-review-graph.md) (`pr-review`
1.x). The two graphs are independent plugins that share the review kit
([PR review §14](design-pr-review-graph.md#14-the-review-kit)): Fetch, the change
report, the measurements, the ledger and the post of one review are described
once, in the PR-review document, and this document links to them. It describes
what differs: the questions and their answers, the gate, what is posted and the
run's result.

## 1. Purpose and decisions

`pr-design-review` asks, about an incoming pull request: is the change necessary,
what is each high-level change for, and does the codebase already have it? It
writes a neutral, cited change report, then questions and their answers, then
decides by plugin code whether round 1 leaves anything open for the author. It
needs no Docker: it runs no contributor code.

| Decision | Consequence |
|---|---|
| Round 1 is its own graph | Fetch → Report → Questions → Answers → Round 1 → Publish. A run of this graph is round 1; a run of `pr-review` is round 2. No run starts another ([§2](#2-the-run)) |
| Design-level questions only | N1 (is the change necessary) first, then `purpose` and `existing-feature` per high-level change, and at most 5 design-level `other` questions. Detail questions (missing tests, splits, CRAP, surviving mutants, per-symbol reuse) are `pr-review`'s leads ([PR review §7.3](design-pr-review-graph.md#73-leads)) |
| Reporter, questioner and answerer are three agents | Separate sessions, each checked by a session on another harness ([§10](#10-roles-budgets-and-sessions)) |
| Plugin code decides what reaches the author | The gate is computed from `necessity.json` and `qa.json` ([§8](#8-the-gate)) |
| A clean round 1 posts nothing | Unless the profile asks for a note. The run's result names the `pr-review` command; the operator, or the `graphloom-run` skill on the user's request, starts it ([§9](#9-publish-and-the-runs-result)) |
| Static measurements only | Complexity and nesting, as facts; coverage, CRAP and mutation are `pr-review`'s ([§6](#6-measurements-in-round-1)) |
| One ledger per pull request | This graph advances the ledger's `design` section only ([PR review §9.1](design-pr-review-graph.md#91-where-the-ledger-lives)) |

## 2. The run

```sh
graphloom task new pr-design-review apache/skywalking-banyandb#1234 --repo ../skywalking-banyandb --profile banyandb
graphloom check reviews/skywalking-banyandb-1234-design/task.yaml
graphloom run reviews/skywalking-banyandb-1234-design/task.yaml --on-stop '…'
# ends complete: "design review: changes requested: 2 open on apache/skywalking-banyandb#1234 at 9ab2c41; posted (<url>)", or
# "design review clean at 9ab2c41; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#1234 --profile banyandb"
```

1. **Fetch** reads the pull request, materializes the head and reads the ledger's
   `design` section ([PR review §5](design-pr-review-graph.md#5-stages-and-requirements)).
   It probes no Docker image.
2. **Report** writes the change report and the static measurements and has the
   report checked ([PR review §6](design-pr-review-graph.md#6-the-change-report)).
3. **Questions** asks and checks N1, then has the questioner phrase the required
   questions and its additions ([§5](#5-questions-and-answers)).
4. **Answers** answers and checks them, writes `qa.json`, `review.md` and the
   HTML report, and advances the ledger's `design` section.
5. **Round 1** computes the open items ([§8](#8-the-gate)).
6. **Publish** posts them as one `COMMENT` review, or posts nothing when there
   are none ([§9](#9-publish-and-the-runs-result)).

Nothing in a run waits for a person. The graph declares no approval
([PR review §11](design-pr-review-graph.md#11-approvals)).

**Chaining is outside the graphs.** Nothing in the controller, the SDK or the CLI
knows that the two graphs are two rounds of one review. A clean run's result
names the next command as data; the `graphloom-run` skill relays it and starts
the `pr-review` task only when the user asks for the PR review, never because a
design review was clean. `pr-review` reads what this graph left in the ledger
and nothing else, and runs the same way whether a design review ran a minute
earlier, on another head, or never.

## 3. Inputs

### 3.1 Task

`graphloom task new pr-design-review <owner/repo#N or URL> --profile <name or path> [--base <branch>] [--all-questions] [--repo <clone>]`
runs the plugin's `prepareTask` plan, the two-phase head plan of
[PR review §3.1](design-pr-review-graph.md#31-task) under this graph's own refs,
`refs/graphloom/pr-design-review/<owner>/<repo>/<N>/` (`head`, `base`,
`heads/<sha>`), and writes `reviews/<repo>-<N>-design/task.yaml` with the request

```text
Design review on <owner>/<repo>#<N> at <40-hex>[, asking every question].
```

- `--all-questions` appends `, asking every question`: every question is asked
  even when N1 judges the change unnecessary ([§5.6](#56-the-necessity-question-n1)).
- `--no-report` and `--review` are refused, each with a message naming
  `graphloom task new pr-review …`. Any other request is refused as an
  incompatible task.
- The task lives in its own directory because a task directory holds one
  `task.yaml` and one `profile.json` link
  ([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)).
- The ledger ref is the shared one, `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`,
  written by a command job, which the task-plan namespace rule does not bind.

### 3.2 Profile

The profile is parsed by the kit's parser for this graph
([PR review §3.2](design-pr-review-graph.md#32-profile), keys per graph in
[§3.2.2](design-pr-review-graph.md#322-keys-per-graph)). One profile file may
serve both graphs. This graph reads `name`, `description`, `project`,
`baseBranch`, `issues`, `environment` (`prepare` and `pinnedFiles` refused),
`report`, `symbols`, `questions.excludeRoots`, `designDocs`, `principles` and
`incremental`, `metrics.generated` and the languages' `files`, `context`,
`privateRepos`, `harnesses` (its roles, [§10](#10-roles-budgets-and-sessions)),
`supervisor`, `budgets`, `limits`, `agent.timeoutMs`, and `comments.footer` and
`comments.designPassedNote` (default `false`, [§9](#9-publish-and-the-runs-result)).
It accepts `pr-review`'s keys unread and refuses `rounds` and
`comments.questions`, each with its reason.

## 4. Stages and requirements

| Stage | Requirement | Statement (abridged) | Validator |
|---|---|---|---|
| Fetch | `pr-snapshot`, `head-checked-out` | As in [PR review §5](design-pr-review-graph.md#5-stages-and-requirements) | `pr-snapshot`, `head-tree` |
| Fetch | `prior-ledger` | The ledger was read or recorded absent, its `design` section (a v1 ledger migrated in memory). When the section holds the Q&A of an earlier head, N1's carry inputs were read ([§7](#7-a-later-head)), or the reason N1 is asked again was recorded. No Docker image is probed | `review-scope` |
| Report | `change-report` | As in PR review §5, with N1 and the Q&A pending until Answers | `change-report` |
| Report | `measurements` | Complexity and nesting at the head and, for a modified function, at the base, by the pinned static tools under bwrap; no coverage, CRAP or mutation ([§6](#6-measurements-in-round-1)) | `measurements` |
| Report | `claims-checked` | An independent report checker judged every item | `claims-checked` (`independence: separate-reviewer`) |
| Questions | `questions-complete` | N1 was asked first and checked, and recorded in `necessity.json`; unless it skipped the rest, every required question of [§5.1](#51-questions) was asked, and each added one follows [§5.2](#52-the-other-question) | `questions-complete` (`independence: separate-reviewer`: N1's check is its latest review) |
| Answers | `answers-complete` | Every question has an answer with evidence and a status; no answer proposes a split, a test outline or an assertion; `qa.json`, `review.md` and the HTML report are written; the ledger's `design` section was advanced by compare-and-swap (the check of the write is part of this validator) | `answers-complete` |
| Answers | `answers-grounded` | An independent answer checker re-checked N1, every cited equivalent, mechanism and library, and every "none found" | `answers-grounded` (`independence: separate-reviewer`) |
| Round 1 | `round1-gated` | The open items, computed by plugin code ([§8](#8-the-gate)) | `round1-gated` |
| Publish | `review-published` | Open items posted as one `COMMENT` review, or nothing posted when clean (or the note); the `design` section records the head ([§9](#9-publish-and-the-runs-result)) | `review-published` |

A reentered stage runs its own jobs again
([PR review §5.1](design-pr-review-graph.md#51-convergence-after-a-reentry)); the
record of the report's claim checks lets a reentry to Fetch with the candidate
unchanged accept the Report stage again.

## 5. Questions and answers

Two agents divide the work after N1:

- The **questioner** only asks. It works from the checked report and the
  groundwork, and never answers.
- The **answerer** answers every question from the report, the diff and the
  **whole base codebase**, its dependencies included.

### 5.1 Questions

A **high-level change** is a capability of the briefing's `whatsNew` (`W1`…`W5`,
each with its cites). When the claim check kept no capability, the report's
coarsest change items stand in, at most five, the features section's first,
numbered `W1`… with their text marked "(report item R<n>; the claim check kept no
capability)". The required set is the same in standard and large mode.

| Type | Required for |
|---|---|
| `necessity` | Always, first, id `N1` ([§5.6](#56-the-necessity-question-n1)). It is the plugin's own wording; the questioner neither asks nor drops it |
| `purpose` | Every high-level change whose purpose the pull request's text, linked issue and commit messages do not state. A stated purpose is recorded `stated` with its quote, matched after whitespace is collapsed, and no question is asked |
| `existing-feature` | Every high-level change: does the codebase already have this feature or mechanism, or does a declared library do it? One question, one answer |
| `other` | Added by the questioner, at most 5, design-level only ([§5.2](#52-the-other-question)) |

A pull request of any size therefore asks N1 and at most 15 more questions.
Questions carry no severity or verdict; N1 is the one answer that concludes, on
evidence. Missing tests, splits, CRAP, surviving mutants and per-symbol reuse are
not asked: `pr-review` computes them as leads.

### 5.2 The `other` question

`other` is restricted to design-level questions, in three places:

- **The questioner's prompt** says what a design-level question is about: the
  change's fit with the system's architecture, a data model or storage schema, an
  interface, a protocol or a configuration surface, compatibility with existing
  clients or data, where a mechanism belongs, and the change's interaction with
  another subsystem. It says what it is not about: a function's body, naming,
  tests, complexity, error handling inside a function, or anything `pr-review`'s
  reviewers judge.
- **Deterministic validation** of an added question: its `type` is `other`, its
  `symbol` is empty, its `item` is a high-level change (`W<n>`) or a change item of
  the `schema`, `interfaces`, `config`, `external` or `removed` sections, and at
  most 5 are added. A violation goes back to the questioner as a correction (two
  corrections, then the supervisor). No word list is applied to the text.
- **The plugin drops** an addition whose type, item and empty symbol repeat a
  required question.

### 5.3 Groundwork

Plugin code and read-only command jobs over the pinned trees prepare what the
questioner and the answerer receive: the dependency inventory, the purpose
lookup and the symbol extraction of
[PR review §7.2](design-pr-review-graph.md#72-deterministic-groundwork) (the
symbols feed the report's digest). The per-symbol searches and the test map are
not run: the answerer of `existing-feature` runs its own searches, recorded and
re-run ([§5.4](#searches-and-their-counts)). The first groundwork command,
`base-export`, exports the base tree ([§5.4](#54-answers)).

### 5.4 Answers

The **answerer** runs one read-only job (`answers-v1`), confined
`untrusted-read` with the dependency directories mounted read-only. It gets the
report, the questions, the groundwork and the pull request's text (untrusted). It
searches the whole base tree itself, with `git grep <base>` and `git show
<base>:<path>` in its shell (a read-only job under bwrap has one, with the
workspace mounted read-only;
[core design](design-typescript-core.md#a-jobs-own-confinement)), or with Read,
Grep and Glob over the exported **base tree** (below), and reads library source in
the mounted caches. It runs on Claude Code or Codex. Every answer has three parts:

- **The answer:** what exists, in factual terms, for example "`ParseDuration`
  (pkg/timestamp/duration.go:30) parses the same `<n><unit>` grammar and is called
  from 7 places".
- **Evidence:** `path:line` citations and quotes; each search run, as a structured
  record ([Searches](#searches-and-their-counts)) that the plugin re-runs; and
  dependency inventory entries, with their version.
- **Status:** `answered` (the code and its dependencies settle the question),
  `partially answered` (part is settled; the rest is stated, with what was
  searched) or `needs author` (it depends on intent the code cannot show).

A **"none found"** answer lists the whole-repository searches it ran (at least
three over the whole base tree, `tree` `base` with no `paths`), so an absence
rests on **measured** zero counts. A search scoped to paths, over the head or a
dependency is supplementary. A dependency marked `source unavailable` is a limit
of the inventory, recorded as a note on the answer (`qa.json` `notes`, shown under
the answer), not of the answer's status; an answer is `partially answered` only
when it relies on a dependency whose source the answerer could not read.

The `existing-feature` answer is one statement with one status and its evidence,
and the checker judges it as a whole. It carries `none_found` (the
whole-repository searches found nothing) and `reusable`: true only when it names
an equivalent feature, mechanism or library **outside the code the pull request
changes** that the change could use; false when it found none, even if it cites
related code. `none_found` true with `reusable` true is sent back. An answer that
names an existing feature, mechanism or library cites it. No answer carries a
proposal (a split, a test outline or an assertion): `proposal.kind` must be
`none`.

#### Ids

Every id field of a Q&A contract names one of the ids the job lists: the
answerer's `answers[].question`, the checker's `verdicts[].question`, the claim
checker's `verdicts[].item`, the questioner's `purposes[].item`, `questions[].item`
and `questions[].symbol`. The contract declares each as a reference path
(`ResultContract.references`), and the plugin passes the job's ids in
`knownReferences`, so the harness narrows the field to a JSON-schema `enum` of
exactly those ids and the controller records a result off it as an invalid
contract result (`checkReferences`). A tolerant read (`kit/ids.ts`) accepts an id
that begins with exactly one listed id token followed by a character that is not
alphanumeric (`Q1 [purpose]` reads as `Q1`), never an unknown or ambiguous one,
and the normalization is recorded as a note on the answer.

#### Searches and their counts

An agent's own hit count is a claim, not a fact. A search is a structured,
re-runnable record, in `answers-v1`, `necessity-v1` and the checker's
`answer-check-v1`:

| Field | Meaning |
|---|---|
| `pattern` | A POSIX extended regular expression, as `git grep -E` reads it: one line, at most 300 characters |
| `tree` | `base` (the pinned base commit), `head` (the working tree) or `dependency` (a dependency's mounted source) |
| `paths` | Pathspec globs relative to the tree's root, at most 8; empty is the whole tree. For a dependency, absolute directories inside the inventory's source directories |
| `ignoreCase` | Whether `-i` was used |
| `hits` | The number of matching lines the agent counted |

A pattern that is not a valid ERE, or a path that leaves its tree, is refused
without running anything. The plugin then re-runs every `base` and `head` search
in a read-only command job (`git grep -I -E -c`), once per distinct search
(content-addressed command ids), and records the measured count:
`54 hits (measured)`, `measured 54 hits in 9 files (reported 0: mismatch)`, or
`reported N, not measured (<why>)` for a dependency search or one past the bound.
A search an answer reports as finding nothing that measures hits sends the answer
back with the measured count. At most 200 distinct searches are re-run per answer
set and per checker result, the searches behind "none found" answers first, and
each answer reports at most 12 searches. The checker's searches are measured the
same way, for display only.

**The checks.** Deterministic checks first: every question has an answer with
evidence and a status; every search is valid and none that reports nothing
measures hits; every citation resolves in its tree; no proposal. Failures go back
to the answerer as one correction, then to the supervisor. Then the **answer
checker**, on a harness other than the answerer's (`claim-check-v1`), re-checks
each cited equivalent, mechanism and library against the trees, searches for
each "none found" with its own queries, and returns `supported`, `partial` (kept,
with its note) or `unsupported`. An unsupported answer goes back to the answerer
once with the checker's note; still unsupported, it becomes `needs author`, with
both statements recorded, so a disputed absence never shows as settled.

**The base tree.** The working tree is the head, so an agent that estimated a
base line from the head would cite a wrong one. The first groundwork command,
`base-export`, exports the pinned base commit into `.graphloom/review/base/` once
per run (a temporary index and `git checkout-index` with hooks and configuration
off, never `git archive` or `git worktree add`), checks that every entry arrived,
leaves out repository agent configuration (`CLAUDE.md`, `AGENTS.md`, `.claude`,
`.codex`, `.agents`, `.pi`, `.mcp.json`, `.opencode`, at any depth), and records
the base tree's object id as its evidence. The N1 answerer and its checker, the
questioner, the answerer and the answer checker get its absolute path; a citation
still names a repository-relative path and its tree.

### 5.5 Output: one file

The graph writes one human-readable file, `.graphloom/review/review.md`, with the
**Briefing** first and then the **Appendix**: **Necessity** (N1's answer), the
**Report**'s change items, **Measurements** and the **Q&A**
([PR review §6.6](design-pr-review-graph.md#66-output),
[§6.11](design-pr-review-graph.md#611-the-html-report)). The machine-readable
copies are `report.json` (`pr-change-report-v1`), `qa.json` (`pr-qa-v1`) and
`necessity.json` (`pr-necessity-v1`); the ledger's `design` section keeps the
latest head's three, which is what `pr-review` reads as its context.

The briefing's verdict says **Open items for the author: n**, and its open list
names those items, each with its kinds, the first lines of its answer and a link
into the appendix; every other question is a count. They are round 1's open
items ([§8](#8-the-gate)), not a separate rule: the Answers stage writes the
briefing before the gate runs, so it calls the gate's own pure function
(`openItems` in `src/round1.ts`) on the `qa.json` and `necessity.json` it writes
and the pull request's changed files. `review.md`, `review.html` (a tile beside
the question grid), `review-appendix.html` and the posted review's first line
(`Changes requested: <n> open`) therefore count the same items; a `partially
answered` answer, an `existing` item and N1 when it is not `necessary` count, as
the gate counts them. The question grid and the Q&A headings still count answers
by status. The Q&A part is grouped by high-level change. Every search shows the
count the plugin measured.

### 5.6 The necessity question N1

The first question is whether the pull request is necessary: did it fix a real
thing? A live example is
[apache/skywalking-banyandb#1443](https://github.com/apache/skywalking-banyandb/pull/1443):
it replies to a write only after the groups are flushed, so the write waits on
flushing, and BanyanDB's write path design has a write return once it is
buffered, with a background worker flushing it.

| Part | The answerer must |
|---|---|
| 1. **Is the problem real on the base?** | Quote the claimed problem from the pull request's title, body or a commit message (the quote must match the pinned text). Trace the base behavior through the **base code**, each step citing `path:line` in the base tree, and say whether the claimed failure can happen on the base (`yes`, `no`, `unclear`). This graph runs no test, so the answer says `not attempted` and rests on the trace |
| 2. **Does the fix fit the system's design?** | Search the repository's design and architecture documents (the profile's `questions.designDocs` globs, its `context` documents and `docs/`) and the code comments that state intent, listing every search as a structured record. Cite the **design statement** and the **changed lines** and say whether the change `preserves` or `breaks` them, is `unrelated`, or that no design statement is `not stated`. When the profile names a principles file, also one verdict per applicable principle ([§5.6.1](#561-project-design-principles)) |
| 3. **Is there a simpler or existing way?** | Say whether the caller, another layer or an existing mechanism already handles it, or the fix belongs elsewhere, and cite where |

**Conclusion**, one line with its rationale: `necessary`, `questionable`,
`unnecessary` or `needs author`. The deterministic rules (`src/necessity.ts`) hold
it to its evidence: `unnecessary` needs a ground it cites (the failure cannot
happen, traced; the change breaks a cited design statement; or an existing way is
cited); `necessary` needs the failure shown possible, no broken design statement
and no existing way; neither is allowed when the pull request states no problem to
quote. Every quote matches the pinned text and every citation resolves in its tree.

**The checker**, on a harness other than the answerer's, verifies each cited design
statement, each trace step, the changed lines, the alternatives and the
conclusion, with searches of its own, and returns `supported`, `partial` or
`unsupported`. An `unsupported` N1 goes back once; still unsupported, its
conclusion becomes `questionable` (status `needs author`, both statements
recorded).

**The skip rule.** When N1 concludes `unnecessary` and the checker supports it
(`partial` does not count), no further question is asked: the questioner and the
answerer do not run, Questions and Answers complete with N1 alone, and
`review.md` says "Remaining questions skipped: the change was judged unnecessary
(see N1)." `questionable` and `needs author` never skip. `--all-questions`
(request suffix `, asking every question`) overrides the skip; the record says so.
It is a request option, not an approval: the skip is decided mid-run from
evidence, and the request is where the operator's intent is recorded before the
run starts.

**Where it runs.** N1 is answered and checked in the Questions stage, before the
questioner, so a skipped run never pays for the rest. Its checked answer and the
decision are written by a graph command as `necessity.json`, whose bytes are
evidence; `questions-complete` is bound with `independence: separate-reviewer`, so
the controller admits it only when N1's check is the latest review and comes from
a read-only review job. After a skip, `graphloom session open <run> --stage
questions` opens N1's answerer.

#### 5.6.1 Project design principles

A project can keep its design principles in its own repository as an agent skill,
so the same file guides contributors' agents and this review. The profile names it
(`questions.principles`: `{ "path": "<repo-relative .md>", "ref"?: "<git ref>" }`);
BanyanDB's is `skills/design-principles/SKILL.md`.

**Format** (`kit/principles.ts`): YAML frontmatter, a title and an intro, which are
skipped, then one `## <id>` per principle (`^[a-z0-9][a-z0-9-]*$`), its statement
paragraph, and optional `- Why:`, `- Applies to: <glob>, …` (absent: every change)
and `- Source:` bullets. Bounds: at most 50 principles, a statement of at most
1,000 characters, at most 20 globs; what is over a bound is cut with a note.

**Where it is read from.** `questions.principles.ref`, or else the task's pinned
base commit, never the head, so a pull request cannot change the rules it is
judged by. Fetch reads it with one read-only command (`principles-read`); its
output is evidence and the parse recomputes from it. A missing file is recorded
`absent` and N1 proceeds without principles. When the pull request changes the
file, `review.md` says so.

**What N1 does with it.** A principle applies when it names no globs or a changed
file matches one. N1's result (`necessity-v1`) carries one `principles` entry per
applicable principle: its `id` (a per-job `enum`), a `verdict` (`preserves`,
`breaks` or `not-applicable`), an `explanation` and `citations` (required for
`preserves` and `breaks`). The checker judges each verdict on its own. **When the
checker supports a `breaks`**, N1's conclusion becomes at most `questionable` and
names the broken principle ids; a principle break never skips a question. An
unsupported break is recorded with both statements and changes nothing.
`necessity.json` and `qa.json` record the file, its commit, the parse, the
verdicts, the checker's judgments and the supported breaks.

`pr-review`'s aspect reviewers get the same principles, with round 1's verdicts
beside them ([PR review §8.1](design-pr-review-graph.md#81-review)).

### 5.7 Questions in large mode

In large mode ([PR review §6.9](design-pr-review-graph.md#69-large-pull-requests))
the report is high level and the questions are the same set of [§5.1](#51-questions),
per high-level change. The **batch-answerer** role (the answerer's harness, model
and effort when the profile names none) answers the questions in batches of at
most 15, continuing its own session from one batch to the next; N1 keeps the
`answerer`. The answer checker checks each batch in a fresh session. `qa.json` and
`review.md` are written once, after the last batch.

## 6. Measurements in round 1

The kit's parser sets `metrics.staticOnly` for this graph and turns coverage and
mutation off. The static tools run as in
[PR review §6.8](design-pr-review-graph.md#68-measurements), batched and split,
over the head and, for a modified function, the base, so the table keeps
`base → head` and the inherited, made-worse and introduced labels.

- The table has the columns Function, Change, Complexity and Nesting. The line
  under the heading says "Coverage, CRAP and mutation are measured by the PR review
  (`pr-review`)."
- The briefing's hotspots are the five functions with the highest complexity,
  then nesting (test files excluded), a modified function that got worse shown as
  `base → head`.
- No measurement makes a question or a round-1 item. A sandbox probe is never
  dispatched.

## 7. A later head

Every question but N1 is per high-level change, whose ids the briefing rewrites
every head, so a later head asks **every question** again (a full round 1, at most
N1 and 15). Question ids continue by stable key
([PR review §9.1](design-pr-review-graph.md#91-where-the-ledger-lives)): `necessity|N1`,
else `<type>|item|<the change's first cited path>`, a repeat suffixed `#2`….

**N1 is carried** from the `design` section's latest head L when all of these
hold, and asked again otherwise (with the reason recorded):

- L's `qa.json` and `necessity.json` are in the section and of L;
- N1 concluded `necessary` (after any principle break), asked every question, and
  was not an earlier open item;
- the checker's verdict was `supported` or `partial`;
- the principles record is the same commit and parse, and the pull request's text
  still holds every quote N1 used;
- no citation changed: head citations by the head delta from L (`git diff -U0`
  over N1's head paths, reduced to hunk headers), base citations by whether the
  file differs between the two bases, dependency citations by the declared
  dependencies ([PR review §9.2](design-pr-review-graph.md#92-mapping-a-new-head-to-the-last-reviewed-one));
- `questions.incremental` is not `false`.

A carried N1 is recorded in `necessity.json` with `carried: { head }`, and no N1
job runs.

**Earlier open items** are judged against the new round 1 by their stable key: an
item is still open when an open item of this head has its key or a merged item
covers it, open and "not re-checked" when only N1 was asked (the skip), and
`fixed` otherwise. The answer checker gets the author's replies on an item's
earlier thread, as untrusted data. Items a v1 ledger closed as `moved` or
`superseded` ([PR review §9.4](design-pr-review-graph.md#94-section-writes-markers-and-migration))
are listed once, with their reason, in the next review this graph posts, and
never again.

## 8. The gate

The Round 1 stage computes the open items from `necessity.json` and `qa.json`
(`src/round1.ts`, plugin code, no model) and records `round1/round1.json`
(`pr-design-review-round1-v1`). The kinds are `necessity`, `needs-author`,
`partial` and `existing`; one question may carry several.

- **`necessity`:** N1's effective conclusion is not `necessary` (`questionable`,
  `unnecessary` or `needs author`, a supported principle break included).
- **`needs-author`, `partial`:** every question whose answer needs the author or
  is partially answered.
- **`existing`:** every `existing-feature` answer that names an equivalent
  **outside the code the pull request changes**: a citation in a `dependency` tree,
  or in a base or head file the pull request does not add, modify, rename or
  delete (a renamed file's old path counts as changed). An answer that is
  `none_found`, or says `reusable: false`, is recorded under `noted` and is never
  an `existing` item; one whose citations all lie in changed files names the
  change itself and is `noted` too. An answer with no citation that does not say
  `reusable: false` is an item. Answers whose only kind is `existing` and that cite
  one outside equivalent merge into one item, hosted by the lowest id, which lists
  the others in `covers`.

A missing test is not a round-1 item. Each item has its id (`N1`, `Q<n>`), kinds,
status, text and, when its place lies inside a hunk at the head, its anchor. The
record recomputes from the recorded Q&A and must equal what was written.

A question's item is placed where its answer's evidence lies in the diff, by plugin
code and no model: the answer's citations are read in their own order, and the
first `head` citation with a line inside a hunk of its file's patch at the head
anchors the item at its first such line. Base, dependency and unchanged-line
citations never anchor. When no citation reaches the diff, the item is placed as
before: at the first head cite of the change it is about (the high-level change or
change item), inline when that lies in a hunk, else in the review body. N1 is placed
at the first head line of its `design.changed`. On #1485 both `other` items had
been anchored at the doc comment of the change item's first cite, though one was
about the aggregation query in the docs the answer cited first.

## 9. Publish and the run's result

Publish uses the kit's post of one review
([PR review §8.5](design-pr-review-graph.md#85-publish)) with this graph's marker.

- **Open items: one review.** One `COMMENT` review carries the open items, whole,
  inline when anchored (at most 50), the rest in the body. Its first line is
  `Changes requested: <n> open` (earlier items included), its second the head
  marker `<!-- graphloom-design-review: <head> <nonce> -->`, its third says it is
  the design review (round 1) and that the PR review (`pr-review`) reviews the
  details. On a later head the body has an `Earlier items` section: each earlier
  item fixed or still open with a link (a still-open item whose thread is outdated
  is posted again at its place), and the items the split closed. The idempotency
  key is `design-<head12>`; reconcile looks for a review of this head with this
  graph's marker and this run's nonce, and a review carrying `graphloom-review` is
  never this graph's.
- **Clean: nothing posted.** The stage makes no GitHub call, records the head in
  the `design` section as `clean` and passes, so a clean run needs no write grant.
- **The note, by choice.** With `comments.designPassedNote: true`, a clean round 1
  posts one `COMMENT` review with no item: `Design review passed`, the head marker,
  and a line saying the PR review follows. It is posted, reconciled and recorded
  like any review of this graph.
- **Posting not enabled.** With open items (or the note) and no
  `github.writeTokenEnv`, the run stops final with `posting not enabled`, naming
  the report and the round-1 record; a resume after the grant posts.
- **Ledger.** `ledger-published` advances the `design` section (from this run's
  Answers write) with the head's `round1` (`items` or `clean`), `open`, and any
  review and comment ids. The `review` section is never written.

**The result.** The run ends `complete`, the line in its result:

- with open items: `design review: changes requested: <n> open on <owner>/<repo>#<N> at <sha7>; posted (<url>)`;
- clean: `design review clean at <sha7>; nothing posted. Next: graphloom task new pr-review <owner>/<repo>#<N> --profile <name>`, with the profile's `name`;
- clean with the note: the same, saying the design-review-passed note is posted, with its link.

The line is data; no run is started by it ([§2](#2-the-run)).

## 10. Roles, budgets and sessions

| Role | Default harness | Constraint |
|---|---|---|
| `reporter` | `claude-code` | Writes the neutral report |
| `diagrammer` | the reporter's | Optional; the diagram job only ([PR review §6.10](design-pr-review-graph.md#610-features-and-their-data-flow)) |
| `report-checker` | `codex` | `distinctFrom: ["reporter"]` |
| `questioner` | `codex` | `distinctFrom: ["reporter"]`. Asks only |
| `answerer` | `claude-code` | `distinctFrom: ["questioner"]`. Claude Code or Codex only, so its session can be opened. Answers N1 in every mode, and the other questions in standard mode |
| `batch-answerer` | the answerer's | Optional; large mode's answer batches only. Claude Code or Codex only |
| `answer-checker` | `codex` | `distinctFrom: ["answerer", "batch-answerer"]` |

A `harnesses.<role>` entry is a harness id or `{ harness, model?, effort? }`
([PR review §13.1](design-pr-review-graph.md#131-roles)). The `reviewer-<aspect>`
and `verifier-<aspect>` keys are `pr-review`'s, accepted unread. The supervisor
preference is Pi, then Claude Code, then Codex. The default budgets are
`agentInvocations` 1,200, `jobs` 220, `decisions` 240, `corrections` 12,
`activeMs` 4 h and `waitMs` 6 h.

`graphloom session open <run> --stage answers` forks the answering session (the
batch-answerer's in large mode), `--stage questions` N1's answerer, and `--stage
report` the reporter's, as in
[PR review §17](design-pr-review-graph.md#17-discussing-a-run-graphloom-session-open).
Nothing said there reaches the run.

## 11. Rehearsal scenarios

Scenario data in `src/rehearsal.ts`, with offline GitHub reads and canned
commands; none probes Docker. `report`, `report-corrections`, `injection`,
`large-pull-request`, `state-lifecycle`, `feature-data-flow`, the diagram variants
and `large-artifacts` exercise the shared report. The design review's own:

| Scenario | Expect |
|---|---|
| `design-clean` | Round 1 finds nothing: Publish posts nothing, records the head as clean, makes no GitHub call and needs no write grant; the run ends `complete` |
| `added-other` | The questioner adds a design-level `other` question about `W1`; it is asked and answered like any other |
| `other-corrected` | The questioner first adds a detail question of another type; it is refused and corrected |
| `answer-finds-existing-feature` | The `existing-feature` answer cites `ParseDuration` outside the change: an `existing` item |
| `answer-no-library-with-whole-repo-search` | "None found", with the whole-repository searches and every go.mod entry with its source status |
| `answer-checker-contradicts` | The checker's own search finds an equivalent in a vendored directory: one correction |
| `needs-author-purpose`, `purpose-stated` | A purpose nobody states is `needs author`; a stated one is recorded with its quote and not asked |
| `necessity-unnecessary`, `necessity-disputed`, `necessity-necessary` | The skip; the downgrade to `questionable` after two refutations; every question after `necessary` |
| `necessity-principles`, `necessity-principle-broken`, `necessity-principle-unsupported` | Principle verdicts; a supported break makes N1 `questionable`; an unsupported one changes nothing |
| `incremental-round1` | A later head: N1 carried, every other question asked |

## 12. Version history

- **0.1.0:** round 1 as its own graph, split out of the two-round `pr-review`
  0.26/0.27 ([PR review §18](design-pr-review-graph.md#18-version-history)): the
  narrowed questions, the `other` rules, static-only measurements, N1 carried on a
  later head, the gate without a missing-test kind, nothing posted when clean and
  the optional note, the result naming `pr-review`, and the ledger's `design`
  section.
- **0.1.1:** the kit's record of the report's claim checks, so a reentry to Fetch
  with the candidate unchanged accepts the Report stage again
  ([PR review §5.1](design-pr-review-graph.md#51-convergence-after-a-reentry)).
- **0.1.2:** the briefing counts round 1's open items with the gate's own
  function, labelled **Open items for the author** in `review.md`, `review.html`
  and `review-appendix.html`, so it always agrees with `round1.json` and the
  posted verdict (it counted only `needs author` answers, and said 0 while
  apache/skywalking-banyandb#1485 had two partially answered items)
  ([§5.5](#55-output-one-file)); an item anchors at the first in-diff line its
  answer cites, before the change's first cite ([§8](#8-the-gate)).
- **0.1.3:** the review kit reads a large pull request's hunk headers in groups of
  files that each fit one command report, and lists a file whose own headers do not
  fit as not measured, rather than failing the Report stage (it blocked
  apache/skywalking-banyandb#1487, 181 files)
  ([PR review §6.8](design-pr-review-graph.md#68-measurements)).
- **0.1.4:** every command the review kit plans fits the command executor's input
  bounds: a diff group whose argv would be over 64 strings (a path each, two for a
  rename) is halved before it is dispatched, where 0.1.3's halves of
  apache/skywalking-banyandb#1487's 181 files were rejected unrun and planned again;
  static batches likewise, jobs packed by count and bytes, and a command job over a
  bound goes to the supervisor rather than the executor
  ([PR review §6.8](design-pr-review-graph.md#68-measurements)).
- **0.1.5:** the static Go tool runs with its own Go environment: `GOROOT` is the
  root of the `go` it runs, not one inherited from the operator's shell that the
  sandbox did not bind (apache/skywalking-banyandb#1487: every `static-go-*` batch
  exited 2 with `go: cannot find GOROOT directory`), and the toolchain, workspace,
  flags and paths settings are the tool's own; the `go-root` check and the host's
  `go env GOMODCACHE` no longer stop on an inherited `GOROOT` either
  ([PR review §6.8](design-pr-review-graph.md#68-measurements)).
- **0.1.6:** a part-set write is sized against the dispatch guard's own bound, so
  each part's job, with its chunks JSON-escaped, stays within the 247,808 bytes the
  guard lets one command take (apache/skywalking-banyandb#1487: the Report stage
  planned `report-json-p1` at 250,050 bytes, which the guard refused, and
  `report.json` was never written); single-command writes, the ledger write and
  the diagram check use the guard's own check too
  ([PR review §6.6](design-pr-review-graph.md#66-output)).
