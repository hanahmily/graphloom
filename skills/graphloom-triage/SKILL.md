---
name: graphloom-triage
description: Diagnose a stopped GraphLoom run before anything else. Reads graphloom inspect, graphloom stats, the stop reason and class, the cited evidence, supervisor episodes and remedies; finds the cause first; only then proposes how to resume (--reconciled after reconciling ambiguous effects, --update-executors or --update-plugin, --upgrade, --supervisor) and confirms with the user before resuming. Never resets or raises budgets reflexively; when the cause is a GraphLoom or plugin bug, fixes the real bug instead of routing around the stuck run. Never answers a question the run asks the user, and changes nothing without a yes. Use when the user asks why a run stopped, failed, or its controller died.
---

# Triage a stopped run

Diagnose first. A resume is a decision the user makes once the cause is known.

## Hard rules

- **Only when the user asks.** Triage runs when the user asks why a run
  stopped; graphloom-run and graphloom-watch never start it on their own.
- **A question the run asks is the user's.** A stop that asks for a decision
  (a graph's own stop such as `needs maintainer decision`, or a declared
  approval) is answered by the user. Quote the question; never answer it,
  never encode an answer in a new task or request, and never resume the run to
  get past it.
- **Diagnose; change nothing.** Read state and evidence, then report the cause
  and the resume or fix you propose. Do not change the environment (`PATH`,
  tool versions, config files), the task, the repository or the run until the
  user says yes to that exact change.
- **Cause before cure.** Do not run `graphloom resume` until you can say, with
  evidence, why the run stopped and why the chosen resume addresses it. Then
  ask the user and resume only on a yes.
- **Never reset or raise a budget reflexively.** An exhausted budget is a
  symptom: find what spent it (which stage, which loop). Raising is the
  operator's decision after diagnosis, done by editing the stopped run's
  budget as docs/budgets.md describes; you never edit `state.json` yourself.
- **Fix the real bug.** If the cause is a defect in GraphLoom or in the plugin
  (a validator that rejects correct work, a contract mismatch, a controller
  loop), say so and fix that code with a test, in its repository; do not
  resume repeatedly, swap harnesses, or hand-edit artefacts to push a stuck run
  through. Ask whether the user wants the fix first.
- Ask before anything outward-facing (push, pull request, issue creation,
  release).
- Never print or ask for a token or secret.
- Read run state only through `graphloom inspect`, `graphloom stats` and
  `graphloom wait`; never edit `state.json`.
- Use only commands and flags `graphloom --help` lists.
- Never decide liveness with `pgrep`/`ps`: use `graphloom wait`.

## 1. Gather

```sh
graphloom wait <run> --until progress --timeout 5s --json
graphloom inspect <run>
graphloom stats <run>
```

From `inspect`: `status`, `stopReason`, `blocker`, `stopRetryable` (retryable:
a resume runs the graph again; final: a resume shows the same blocker until
something it depends on changes), `stopEvidenceRefs`, `mode` and `current`
(stage and attempt), `receipts` (which requirements are valid), `budgets`,
`remedies`, `supervisorOutcomes`, `caseFile` (the supervisor's verified
facts, refuted claims, attempts), `lastResume`, `executorTransitions`,
`supervisorSelection`. From `stats`: what each stage used, attempts, episodes,
budget use against the run's budget.

Read the evidence the stop cites (the refs in `stopEvidenceRefs`, the
`receipts[].evidenceRefs`): `inspect` lists them; their artefacts are under
the run's state directory. For a coding agent's failure, look at what the
agent actually did in the run's worktree (`worktreePath`, read only).

Wait exit 3 (state says running, controller dead) is not a stop yet: the
controller died without recording one. Say so; `graphloom resume <run>` takes
it over once the user agrees.

## 2. Classify the cause

| Stop reason | Likely cause | What to check |
|---|---|---|
| `... budget exhausted` (final) | A loop that did not converge, or a budget too small for the work | Which stage spent it (`stats`), repeated attempts or episodes with the same trigger, the case file's settled attempts |
| `harness quota exhausted until <time>` | A harness usage limit; the wait did not fit `waitMs` | The reset time; nothing is wrong. Resume after it |
| `harness quota hit after possible effects; reconcile before resuming` | A usage limit cut a job off mid-change, and its session cannot continue | The worktree and any external state the job may have changed |
| `job failed: ...` | An executor or agent failure | The job's evidence and the agent's output |
| `executor pin mismatch` | Installed executor bytes changed since the run started | `inspect` and what changed (an upgrade?) |
| `pin mismatch` / plugin manifest changed | The plugin bundle changed since intake | Whether the change is intended |
| `environment check failed` / `changed` | A tool, login or pinned file the plugin declares | `graphloom check <task.yaml>` |
| `supervisor provider ...` | The supervisor's model provider failed (quota, auth, transient) | The remedies; the doctor's harness rows |
| `operator stop` | Someone ran `graphloom stop` | Ask the user why |
| a graph's own stop (`stopClass` by graph) | The plugin decided it cannot proceed | Its blocker text and cited evidence |

Look for a **repeated identical failure**: same stage re-entered for the same
requirement, or several episodes with the same trigger and reason. That is a
bug or a mis-specified task, not bad luck.

## 3. Propose the resume (only after the diagnosis)

Explain the cause in two or three sentences with the evidence, then the
option that addresses it:

| Situation | Command |
|---|---|
| Transient failure, quota reset passed, fixed environment | `graphloom resume <run>` |
| Partial effects reconciled by hand (you checked the worktree and external state, the user agreed) | `graphloom resume <run> --reconciled` |
| A GraphLoom upgrade changed a built-in executor | `graphloom resume <run> --update-executors` |
| The plugin was fixed (same graph id, stages, requirements, validator bindings) | `graphloom resume <run> --update-plugin` |
| The run belongs to an older installed GraphLoom and should move to this one | `graphloom resume <run> --upgrade` |
| The pinned supervisor harness is unavailable or unsuitable | `graphloom resume <run> --supervisor <harness> --reason "<why>"` |

Add `--on-stop` with the same marker command graphloom-run used, so watch
gets the next stop. With a supervisor configured, a plain resume of a
reconcile stop opens a recovery episode for it; without one, only
`--reconciled` lets the graph run again. Never pass `--reconciled` without
having actually reconciled.

If the right answer is "fix GraphLoom or the plugin first", say that instead,
and offer to make the fix (with a test). After a plugin fix, the resume is
`--update-plugin`.

## 4. Confirm and hand back

Ask the user to confirm the exact command. Run it only on a yes, in the
background as graphloom-run starts a run, then hand back to graphloom-watch.
