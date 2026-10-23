# Run budgets from real usage

Status: implemented, 2026-10-19 ([#150](https://github.com/hanahmily/graphloom/issues/150)).

Run budgets used to be guesses: the controller's 64 agent invocations, and
600 or 2,000 in the example tasks. Real runs used far more, so operators
raised or removed budgets by hand mid-run. That exposed two defects: stage
pacing read the intake copy of the agent budget, so a raised budget still
tripped `stalled` recovery, and a 30-day `activeMs` overflowed Node's timer
(fixed in #138). This document records what four recorded runs used, how the
profile defaults follow from that, and how budgets are layered and counted.

## Measuring a run: `graphloom stats`

```sh
graphloom stats <stateDir|runId> [--state-root <dir>] [--json]
```

`stats` reads a run's durable state through the controller's public API
(`resolveStateDir`, `loadRunState`) and writes nothing. It reports, per stage
and in total: attempts, agent calls reserved by the stage's jobs, jobs by kind
and purpose (review jobs among them), receipts kept and invalidated; every
budget as used, left, the run's budget (used plus left) and the intake value;
agent calls outside the stages (supervisor, proposal reviewer, repairs);
generations by reason (reentries, resumes, activated repairs); supervisor
episodes, turns and provider calls; and remedies.

Every number says how far it can be trusted:

- **exact**: the run kept the usage ledger (below) from intake, or the count
  comes from records the run keeps whole (receipts, version history, remedies
  under their bound). A stage's agent calls (`agentInvocationsByStage`) are
  exact for runs that kept the ledger from intake: every call a stage job
  makes counts for its stage, whether reserved per request or charged once at
  settlement (a runner that reserves no model calls). Older runs did not
  count settlement-charged calls, so their stage counts are a lower bound.
- **estimate**: a run saved before the ledger existed, with no visible edit:
  use is its intake budget less what remains.
- **unknown**: a run saved before the ledger whose numbers show a hand edit
  (an intake value other than the task's, or more left than intake gave). A
  budget delta there means nothing, so `stats` prints none.
- **lower bound**: counts from bounded or partial records: jobs (a job that
  failed before recording evidence leaves no trace), supervisor episodes
  (older runs keep only the episode ids their newest marks and case file
  name; `supervisorEpisodes` keeps the newest 50; a run that predates the
  records counts its recorded episodes together with every id its state
  still names), and a run's agent calls when its agent budget was edited.

The agent calls beyond the stages' are reported as the supervisor's, reviewer's
and repairs' only when the total is exact and the stage counts are complete;
otherwise `stats` reports them as *not attributed*, since they may include
stage calls the run never counted per stage.

## Measured usage

The four runs still on disk. The `stats` column gives what `graphloom stats`
reports; where it cannot be exact, the numbers were completed from the
`state.json.*.bak` copies the operator saved before each hand edit, and from
the supervisor's Pi session logs (`supervisor/*.jsonl`, one assistant message
per provider call), and are marked as such.

| | 4c70ff66-dd9 | cbef664d-c46 | 395ec998-6e4 | 9bfa446d-4ea |
|---|---|---|---|---|
| Graph, issue | issue-fix@0.2.0, graphloom#119 | issue-fix@0.4.2, graphloom#121 | issue-fix@0.4.2, graphloom#122 | banyandb-fix@0.4.0 (repaired in-run), skywalking#14092 |
| Budgets | edited mid-run, then 10⁶ | 10⁶ from intake, never edited | 10⁶ from intake, never edited | edited several times |
| Agent calls, stage jobs (fix / review) | 803 (182 / 621), lower bound | 491 (187 / 304), complete (Pi log accounts for the rest) | 306 (91 / 215), complete (Pi log accounts for the rest) | 1,924 (1,656 / 268), lower bound |
| Agent calls, supervisor and reviewer | ~92 (bak segments) / 98 (Pi log), estimate | 100, exact (Pi log agrees) | 17, exact (Pi log agrees) | ~995 (Pi log), estimate |
| Agent calls, total | ~895, estimate | 591, exact | 323, exact | ~2,920, estimate |
| Jobs charged | ~113 (86 + 27 over two bak segments), estimate; 81 recorded | 94, exact; 75 recorded | 64, exact; 49 recorded | ~122 (11 + 111), estimate; 94 recorded |
| Decisions | ~165 (131 + 34), estimate | 115, exact | 64, exact | ~248 (16 + 232), estimate |
| Corrections | ~15 (12 + 3), estimate | 9, exact | 4, exact | ~55 (1 + 54), estimate |
| Wait time | 0 | 0 | 0 | 0 (no waiting remedies), estimate |
| Active time | ~4 h 45 min (bak segments), estimate | 2 h 41 min, exact | 1 h 30 min, exact | ~10 h (timestamps), estimate |
| Wall clock, first to last record | 32 h 21 min | 12 h 53 min | 7 h 08 min | 72 h 00 min |
| Stage attempts (fix / review) | 11 / 11 | 7 / 8 | 4 / 4 | 9 / 3 |
| Review jobs | 21 | 13 | 8 | 21 |
| Generations: reentries, resumes, repairs | 22: 14, 7, 0 | 14: 9, 4, 0 | 5: 3, 1, 0 | 136: 14, 112, 9 |
| Supervisor episodes | 24 (Pi log); 23 in state, lower bound | 9 | 3 | 75 (Pi log); 1 in state, lower bound |
| Remedies | 9 | 1 | 0 | 0 |

How the estimates were made:

- **4c70ff66-dd9.** `state.json.before-unlimited-budgets.bak` is the state
  just before the operator replaced every budget with 10⁶: up to there the run
  used intake (the task's 2,000 / 1,024 / 2,048 / 16 / 12 h) less what that
  copy has left; after it, 10⁶ less what the final state has left. The sum
  assumes no other edit. The supervisor's share is the total less the stages'
  exact 803; its Pi log counts 98 provider calls, close to the 92 derived.
- **cbef664d-c46, 395ec998-6e4.** The task set 10⁶ for every budget and
  nothing was edited (the intake copy equals the task's), so intake less what
  remains is exact. The Pi logs count exactly the 100 and 17 supervisor calls
  the budget deltas give, which confirms it.
- **9bfa446d-4ea.** Its budgets were edited at least three times (grants,
  intake agent budget 600 → 1,100 → 100,000, remaining budgets to 10⁵). The
  first segment (intake to `state.json.before-grants-edit.bak`) is exact: 571
  agent calls, 11 jobs, 16 decisions, 1 correction, 1 h 30 min. The rest
  assumes the remaining budgets were last set to 100,000 (and `activeMs` to
  four days); what happened between those edits is not recorded, so jobs,
  decisions and corrections are estimates. Active time is estimated from
  record timestamps (version history, agent sessions, supervisor messages),
  summing gaps of at most 15 minutes: that method gives 2.6 h and 1.4 h for
  the two exactly measured runs (2.7 h and 1.5 h), so it reads about 10%
  low; for this run it gives 9.4 h (12.9 h with 30-minute gaps).

## Defaults per profile

Roughly the observed maximum doubled, rounded. They live in the issue-fix
profiles (`examples/plugins/issue-fix/profiles/*.json`, `budgets`), not in
the controller.

| Budget | graphloom: max of 3 runs → default | banyandb: 1 run → default | Controller default |
|---|---|---|---|
| `agentInvocations` | 895 → **1,800** | ~2,920 → **6,000** | 64 |
| `jobs` | 113 → **250** | ~122 → **250** | 128 |
| `decisions` | 165 → **350** | ~248 → **500** | 512 |
| `corrections` | 15 → **30** | ~55 → **100** | 8 |
| `activeMs` | 4 h 45 min → **10 h** | ~10 h → **20 h** | 4 h |
| `waitMs` | 0 → **6 h** | 0 → **6 h** | 15 min |
| `recoveryReserve` | 5% → 90 | 5% → 300 | max(8, 5%) |

No run waited, but a harness usage limit now pauses the run until its reset
([design-executors.md](design-executors.md)), and a Claude Code session limit
resets within 5 hours: 15 minutes cannot absorb one, so all three profiles
declare 6 h (the 5 h window plus margin; the canopy profile follows the same
numbers). A weekly or longer reset exceeds it and stops the run retryable
instead, so `graphloom resume` after the reset continues. Waiting is idle time,
not spend. The banyandb
numbers rest on one banyandb-fix run, whose many repairs drove its corrections
and supervisor calls; issue-fix on BanyanDB has not run live yet, so measure
its first runs with `stats` and adjust. banyandb-fix, which has no profile,
names the same numbers in [its example task](../examples/banyandb-fix-task.yaml).

## Budget layers

A graph may declare `GraphDefinition.defaultBudgets` from `describe(config)`:
issue-fix returns its profile's `budgets` there. Intake applies, key by key:

```
controller defaults  <  the graph's defaultBudgets  <  the task's budgets
```

`recoveryReserve` defaults from the resulting `agentInvocations`
(max(8, 5%)). Intake checks that each value the task sets is a positive
safe integer, and `describe` checks the graph's; the cross-budget check (the
reserve must stay below `agentInvocations`) runs once, on the final merged
budgets, so a task that sets only `recoveryReserve: 100` under a graph
defaulting to 1,800 calls is valid. A violation refuses the run before any
state is written, and `graphloom check` reports it. A rehearsal (and a probe,
which rehearses first) runs with small budgets of its own; when its scenario
names no `recoveryReserve`, it names one that fits its own allowance (the
controller's rule, kept below it) rather than inheriting a live reserve such
as 90 of 1,800. An explicit scenario reserve is used as is. Long `activeMs` and `waitMs` values are fine: timers
are armed in steps no longer than Node's limit (#138).

The controller never reads the task config: the plugin turns its own config
into a value the SDK defines, and the controller handles that value like any
other budget. Applying the defaults after `describe` rather than in intake
proper is what keeps it that way. The applied defaults are pinned with the
run (`intake.graphDefaultBudgets`); the merged result is `intake.budgets`.

`defaultBudgets` is not part of the definition a resume or a repair compares:
a run keeps the budgets it was intaken with, so a plugin that later declares
other defaults (or none), and `resume --update-plugin` onto it, still match
the pinned definition. Runs pinned before the field existed load unchanged.

## What "the run's budget" means

`state.budgets` holds what is left; the controller charges it and an operator
raises a budget by editing it while the run is stopped. The intake copy is
where the run started and never changes. Neither alone says what the run has
been given, so the controller keeps a usage ledger, `budgetUsage`, booked in
one place:

- `saveRunState` books any change in a remaining budget since the state was
  loaded or created as the controller's own: a decrease is spending, an
  increase a refund (an unused repair allowance, unspent wait).
- `loadRunState` books any difference between the remaining budgets on disk
  and the ledger's copy of them as the operator's edit: it changes what the
  run has been given, not what it used.

So for every budget, at every point, **the run's budget = used + left**,
operator raises included. A run saved before the ledger existed is estimated
on load (intake less what remains, and for agent calls at least what its
stages recorded) and booked exactly from then on (`budgetUsage.since`).

Stage pacing (`stagePacingMessage`) compares a stage's agent calls with half
of the run's agent budget in this sense, and so does the budget-exhaustion
message. Raising the agent budget mid-run therefore raises the pacing
threshold with it: a stage that spent 12 of a 20-call budget trips `stalled`;
after the operator raises what is left by 40, the same 12 are under half of
60 and the run continues. Lowering a budget by hand lowers what the run has
been given the same way.

## No fixed step cap

The controller loop has no per-invocation step cap (it once stopped every 64
steps with `step limit`, whatever the budgets held; #159). The finite budgets
bound a run because every step that does anything charges one:

| Step | Charges |
|---|---|
| graph `advance()` and its decision (dispatch, observe, validate, wait, accept, stop, supervise, ...) | `decisions` |
| a dispatch's job | `jobs`, and `agentInvocations` for the agent calls it reserves or settles; a correction also `corrections` |
| a supervisor turn | `decisions` for the proposal it returns or for each proposal refused, `agentInvocations` for a metered supervisor's and reviewer's provider calls, `probes` when the task sets them |
| a retry of a retryable executor failure | `decisions` and `jobs` |
| a return to the graph without a model call, a safe default after refused proposals | `decisions` |
| a wait | `decisions`, then `waitMs` |
| the environment check | `jobs` when it runs setup commands, otherwise nothing (once per active version) |
| a plugin host failure that enters recovery | nothing |
| a supervisor model switch | `agentInvocations` for a metered supervisor, otherwise nothing |
| every step | `activeMs`, by the clock |

The last three steps, and the environment check without setup, charge no count
budget. A run can only chain a few of them, so the loop stops after 16
consecutive steps that lowered none of `agentInvocations`, `jobs`, `decisions`,
`corrections` and `probes`: `no-progress loop` (retryable), with the last
action in the blocker. A resume starts the count over. Time budgets do not
count for the guard: they tick with the clock. A run saved with the retired
`step limit` still resumes and continues where it was.

## Verification

- `packages/controller/src/loop.test.ts` ("the loop is bounded by the run's budgets"): a run of 80 charged
  steps completes in one invocation; the decisions budget still stops a
  longer one; an uncharged loop (40 supervisor model switches) stops with
  `no-progress loop` naming its last action; a run saved with `step limit`
  resumes.
- `packages/controller/src/budgets.test.ts`: layer order and validation;
  the ledger booking charges, refunds and a hand edit; the legacy estimate;
  pacing tripping on the original budget and not after a mid-run raise
  (the raise test fails against the intake-copy check).
- `apps/graphloom/test/stats.test.ts`: `stats` on trimmed fixtures of
  395ec998-6e4 and 4c70ff66-dd9 (old state shapes, one with edited budgets),
  a state missing every optional field, the table and `--json` output, and an
  exact report for a run that keeps the ledger.
- `examples/plugins/issue-fix/test/profiles.test.ts` and
  `apps/graphloom/test/issue-fix-e2e.test.ts`: the shipped profiles declare
  their budgets, and the example tasks, which name none, start with them.
