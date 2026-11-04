# Agent skills: driving GraphLoom from a coding agent

Status: implemented (skills, `wait --until progress`, `graphloom watch`, `graphloom skills`).

An operator often drives GraphLoom from an interactive coding agent (Claude
Code, Codex or opencode) rather than by hand: set the machine up, shape a
request into an issue, start a run, watch it for hours, diagnose a stop, check
the delivered branch. This design ships that knowledge as agent skills, adds the CLI
features watching needs (`graphloom wait --until progress`, and `graphloom watch` on top of it), and distributes the
skills with the release.

## 1. Skills

Claude Code, Codex and opencode all load `SKILL.md` skills: one directory per
skill, YAML frontmatter with `name` and `description`, then instructions. The
repository holds them in top-level [`skills/`](../skills):

| Skill | Does |
|---|---|
| `graphloom-setup` | `graphloom doctor`, explains each warn/fail, runs the `fix:` commands with the user's consent, then `graphloom setup`; supervisor routes per vendor |
| `graphloom-issue` | Shapes a requirement into an issue one run handles well: one deliverable PR, acceptance criteria, context documents (issue-fix `issues.context`), split or merged to size; the private-tracker option (`pullRequest.reference`) |
| `graphloom-run` | Refuses a request with unfilled placeholders, checks the checkout against the upstream default branch (asks before using a fresh base), writes `task.yaml`, `graphloom check`, starts the run in the background with an `--on-stop` marker file and the repository's pinned toolchain on `PATH`, hands off to watch (inside a HAPI session, to a detached `graphloom watch` and ends its turn) |
| `graphloom-watch` | A thin wrapper around `graphloom watch` (§2.1): Claude Code runs it as a background command and re-arms; Codex and opencode, which have no background-command notifications, loop in the foreground with `--timeout 9m` and re-arm silently on exit 2. Relays a move or heartbeat in one or two lines; on attention reports and asks the user; follows the last line of a `[graphloom watch]` message a HAPI watcher sends |
| `graphloom-triage` | A stopped run the user asks about: diagnose the cause from `inspect`, `stats` and evidence first, then choose the resume form with the user |
| `graphloom-deliver` | Verifies the delivered branch (commit message, PR body, required sections), rebases onto a newer upstream base only on the user's yes, then runs the repository's checks once on a clean copy of the tree to push (helper files kept outside it), then pushes or opens the PR only with explicit approval |

`graphloom-run` prepares the task with `graphloom task new`
([core §16](design-typescript-core.md#16-preparing-a-task-graphloom-task-new))
for a graph whose bundle implements `prepareTask` (pr-review), and still writes
`task.yaml` by hand for the others; it also covers a run that stops for a
decision (`session list`, `session open`, `resume --decline`). The skill
changed in the same change as the CLI, so the drift test (§4) keeps passing.

**Hard rules, in every skill.** Ask before anything outward-facing (push, pull
request, issue creation, release). Never print or ask for a token or secret.
Read run state only through `inspect`, `stats` and `wait`; never edit
`state.json`. Name only real CLI commands and flags (§4 tests this).
Run and watch start and monitor a run and never fix it: on any stop they
summarize why (the stop reason, its blocker and any question it asks, quoted)
and ask the user what to do next, without resuming, changing the environment,
task or repository, or answering the run's questions. Triage runs only when the
user asks; it diagnoses before it proposes a resume, changes nothing without the
user's yes, never answers a question the run asks the user, and never raises a
budget reflexively; a GraphLoom or plugin bug is fixed, not routed around.

**Finding a background run.** `graphloom run` prints
`graphloom: run <runId> started; state <stateDir>` on stderr as soon as intake
created the run (the report JSON still goes to stdout at the end), so a run
started in the background is found without listing state directories.

**Process liveness.** Skills never poll with `pgrep`: a `pgrep -f <pattern>`
run from a shell matches that shell's own command line, which once hid a stop
for two hours. Liveness comes from durable state (`graphloom wait`, which reads
the state and the controller's owner claim) and the `--on-stop` hook.

## 2. `graphloom wait --until progress`

```text
graphloom wait <stateDir|runId> [--state-root <dir>] [--until stop|progress]
               [--since <cursor>] [--timeout <dur>] [--json]
```

`--until stop` (the default) is the existing behaviour. `--until progress`
also returns when something meaningful happens. It is computed in the CLI
(`apps/graphloom/src/progress.ts`) by diffing the run's durable state, read
through the controller's public `loadRunState`, against a *mark* of what was
already reported. No controller event bus is added: every event below derives
from fields the controller already persists, and all of them are generic
controller notions, never plugin ones.

| Event | From |
|---|---|
| `stage_entered` | `current` (stage id and attempt) changed |
| `receipt_accepted` | Valid receipts with a sequence number above the mark (`rcpt-<n>`), grouped per stage, with whether the stage is now complete |
| `receipts_invalidated` | Invalid receipts the mark had not seen as invalid (by id), with their stages |
| `episode_started` | `mode: recovery` with a `recoveryEpisodeId` not yet reported, or episode records (`supervisorEpisodes`) of an unreported episode; detail is the recovery trigger |
| `episode_ended` | The reported open episode is no longer open, or an episode started and ended between two looks; detail is its last proposal's action and one-line reason, or its outcome |
| `quota_pause` | A new remedy record whose condition is a quota or usage limit; `resetAt` from `quotaHold.until`, `executorRetryAt`, or the remedy text |
| `budget_threshold` | A metered budget whose use reached 80% of the run's budget (operator raises included); it fires again only after a raise takes it below 80% and use crosses again |
| `run_resumed` | The mark saw the run stopped and it is running again |
| `run_stopped` | The run left `running` (any status), with its stop reason and class |

`--json` prints `{ runId, stateDir, outcome, events, summary, cursor }`.
`summary` is the current status, stop reason and class, mode, stage and
attempt, stages complete, each budget's use against its budget, episode
count, and any waiting state (a quota hold or quota retry with its `until`,
an ordinary executor retry backoff, a reconciliation required). `cursor` is an opaque `p1.` token encoding the mark;
`wait --since <cursor>` starts from that mark, so no event is reported twice
and none that happened between two waits is lost. Without `--since` the mark
is the state when `wait` starts (a run that is not running reports its stop at
once). A cursor names its run; another run's cursor is refused. The poll stats
`state.json` once a second and parses it only when it changed (the first
signature is taken before the first read, so a write in between is not lost).

Exit codes for `--until progress`: 0, events were reported or the run is not
running (read `summary.status`); 2, the timeout elapsed with nothing to report
(with `--json`, the unchanged cursor is still printed); 3, the state says
running but its controller died (as for `--until stop`); 1, an error such as
a malformed or foreign cursor. Text output prints one line per event and the
next command to run.

A run owned by another installed version dispatches to that version (release
design §5.1); a version older than this feature ignores `--until` and waits for
the stop. The mark compares episode and remedy timestamps written by one
controller at a time, so two records within the same millisecond, one on each
side of a look, can merge; budgets at 80% before the first look are part of the
starting mark, and the watch skill's own `stats` snapshot reports them.

### 2.1 `graphloom watch`

```text
graphloom watch <stateDir|runId> [--state-root <dir>] [--dir <path>]
                [--until report|stop] [--timeout <dur>] [--heartbeat <dur>]
                [--notify <command>] [--json]
```

Watching with `wait --until progress` left the judgment to the model: each wake
it pulled `inspect` (about 16 KB) and `stats --json` into context, diffed a
snapshot and wrote prose, and every wake is a model turn that re-sends the whole
conversation. `watch` moves that logic into the CLI (`apps/graphloom/src/watch.ts`),
so the agent is woken only when there is something to report. It reuses the
progress machinery (the mark in `<dir>/cursor`, default `.graphloom-watch`), keeps
its own bookkeeping in `<dir>/snapshot.json` (when it last reported, when evidence
last grew, which conditions it already raised, moves not yet reported), reads state
only through the same loaders as `wait`, `inspect` and `stats`, and never writes
`state.json`. It knows no plugin notion.

| Kind | Reported when |
|---|---|
| `move` | A stage entered or a new attempt of it; a stage accepted (complete); a supervisor episode started or ended, with its trigger and one-line reason; a quota pause started (with `resetAt`) or ended; the run resumed. Not individual receipts or jobs. Moves within 60 seconds of the first are one report |
| `heartbeat` | Nothing reported for `--heartbeat` (default 15m) while running: status, stage and attempt, elapsed wall time, `agentInvocations` used of its budget (and any budget that moved), age of the last evidence |
| `attention` | The run stopped (status, reason, retryable or final, the blocker, and any question it asks quoted); a reconciliation waits for a human; no new evidence for 45 minutes while running and not in a quota wait; a budget over 80% (which, the numbers, the stage spending it); a repeated identical failure (the same stage invalidated again with the same requirements, or consecutive supervisor episodes with the same trigger code and message); the controller died |

Each condition is raised once when it begins to hold and again only after it
cleared and returned. Evidence records carry no time, so evidence age and the
stall are measured from when the watch first saw the evidence count grow (from its
first look when it has seen none). Pending moves are sent before an attention
report from the same look.

A report is a message under about 1 KB. Its first line is `[graphloom watch] <kind> · run
<id> · <status> · <stage>#<attempt>`, then a few compact lines, then a closing line
for the receiving agent: for a move or heartbeat, `Relay this to the user in one or
two lines. Make no tool calls.`; for attention, `Report this to the user and ask
what to do next. Do not resume, fix, or answer the run's questions.` The message
carries the full summary, so no `inspect` or `stats` is needed.

`--until report` (the default) returns at the first report; `--until stop` keeps
running until the run is no longer running (for a detached watcher with
`--notify`). `--timeout` returns after that long with a one-line "still running,
nothing to report". `--json` prints `{ outcome, reports, summary }` (with `--until
stop`, one report per line as raised). Exit 0: a report was printed, or the run
stopped; 2: the timeout elapsed with nothing to report; 3: the controller died with
the state still running (also an attention report); 1: an error, such as a watch
directory that belongs to another run.

**Notify.** `--notify '<shell command>'` runs the command for each report with the
message on stdin and `GRAPHLOOM_WATCH_KIND` (`move`, `heartbeat`, `attention`),
`GRAPHLOOM_RUN_ID` and `GRAPHLOOM_STATUS` in its environment, killed after 60
seconds. A failing command is logged to `<dir>/watch.log` and does not stop the
watch. The command is generic shell; the CLI knows no agent host.

**The HAPI watcher.** An agent without background notifications that runs inside a
HAPI session (`HAPI_SESSION_ID` set) spends nothing while a run works: graphloom-run
starts, from the task directory,
`setsid nohup graphloom watch <run> --until stop --notify 'hapi ping-peer
"$HAPI_SESSION_ID" --message-file -' >/dev/null 2>&1 &` and ends its turn. Each
report arrives as a message in that session; graphloom-watch tells the agent to
follow the message's last line.

## 3. Distribution: `graphloom skills`

The release tree ships `skills/` at its root (`scripts/release/assemble.mjs`;
`check-tree.mjs` requires every skill directory to hold a `SKILL.md`).
`graphloom skills` is the one seam that installs, lists, refreshes and removes
copies; setup, doctor, the installer and uninstall call it rather than
re-implementing it:

```text
graphloom skills list [--agent <a>] [--dir <dir>] [--json]
graphloom skills install [<name>...] [--agent <a>] [--dir <dir>] [--force]
graphloom skills update [--agent <a>] [--dir <dir>] [--quiet]
graphloom skills remove [<name>...] [--agent <a>] [--dir <dir>] [--force]
```

- **Targets.** `--agent` names one; `--dir` names one directory instead.

  | Agent | Directory GraphLoom writes | Override | Found here when |
  |---|---|---|---|
  | `claude-code` | `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) | `GRAPHLOOM_CLAUDE_SKILLS_DIR` | `claude` on `PATH`, `GRAPHLOOM_CLAUDE_BIN`, or `$CLAUDE_CONFIG_DIR` (default `~/.claude`) exists |
  | `codex` | `$CODEX_HOME/skills` (default `~/.codex/skills`; codex-cli 0.162's bundled skill installer writes there) | `GRAPHLOOM_CODEX_SKILLS_DIR` | `codex` on `PATH`, `GRAPHLOOM_CODEX_BIN`, or `$CODEX_HOME` (default `~/.codex`) exists |
  | `opencode` | `$XDG_CONFIG_HOME/opencode/skills` (default `~/.config/opencode/skills`; the global config directory `opencode debug paths` prints) | `GRAPHLOOM_OPENCODE_SKILLS_DIR` | `opencode` on `PATH`, `~/.opencode/bin/opencode` (its installer's default), or `$XDG_CONFIG_HOME/opencode` exists |

  `install` defaults to the agents found here; `update`, `list` and `remove`
  default to every target. Besides its own directory, opencode (verified
  against 1.19, `opencode debug skill`) also reads `.../opencode/skill/`,
  project `.opencode/skill(s)/`, and the external `~/.claude/skills` and
  `~/.agents/skills` (`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` turns both off,
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` or `OPENCODE_DISABLE_CLAUDE_CODE=1`
  the first); Codex also reads `~/.agents/skills`. GraphLoom never writes
  either shared directory by default, so no agent loads a skill twice.
- **Duplicates.** When a shared directory an agent reads (`~/.agents/skills`
  for Codex and opencode; `~/.claude/skills` for opencode, unless that is
  Claude Code's own target) holds GraphLoom copies (with a marker) of skills
  that are also in that agent's own directory, `skills list` names them and
  the doctor warns (never fails) with a `skills duplicates (<agent>)` row and
  fix `graphloom skills remove <names> --dir <shared dir>`, which removes
  only the duplicated copies there. A shared directory that is
  some agent's own target (`~/.claude/skills` while `CLAUDE_CONFIG_DIR` is
  unset) holds that agent's copies and is not reported; directories without a
  marker are the user's and are never counted.
- **Marker.** Each installed copy holds `.graphloom-skill.json`:
  `{ product, skill, version, digest, installedAt }`. `digest` is the SHA-256
  of the `sha256sum`-style listing (`<sha256>  <relative path>` lines, sorted)
  of every other file in the directory, so the copy can be checked without the
  bundle it came from.
- **States.** `current` (files equal this version's bundle), `outdated`
  (unedited, from another version), `edited` (files differ from the marker's
  digest), `foreign` (a directory of that name without a marker: the user's
  own), and `missing`.
- **Never clobber.** `install` writes `missing` and `outdated` copies and
  skips `current` ones; it replaces an `edited` copy only with `--force`, and
  never touches a `foreign` directory. `update` refreshes only `outdated`
  copies GraphLoom installed, skipping `edited` ones with a notice, and never
  installs a missing one. `remove` removes unedited GraphLoom copies; an edited
  one only with `--force`; never a foreign directory. Each write goes to a
  temporary sibling directory renamed into place.
- **Setup** offers, after it writes the configs, to install the skills for each
  agent it found whose copies are missing or outdated (default yes). `--yes`
  installs nothing outside `~/.config/graphloom` and prints the command.
- **Doctor** reports a `skills (<agent>)` row in its configuration section for
  each agent found: `pass` when every copy is current (edited copies are
  named and kept), `warn` with fix `graphloom skills install --agent <a>` when
  some are missing, or `graphloom skills update` when some are outdated.
- **Upgrade and automatic updates.** After `install.sh` switches `current`
  (manual install, `graphloom upgrade`, or `--auto`), it runs the new
  version's `graphloom skills update --quiet` when that version ships
  `skills/`. Only copies GraphLoom installed are refreshed; edited ones are
  skipped with a notice (in `update/log` for automatic updates).
  `self use` and `self rollback` do not refresh; `graphloom skills update`
  does.
- **Uninstall.** `self uninstall` runs `current`'s `graphloom skills remove`
  before it removes the install home, so unedited copies go and edited ones
  stay with a notice. When `current` cannot start, it names the directories
  that still hold a marker.

A copy installed with `--dir` is found again only with the same `--dir`, or
when that directory is an agent's own target: the state comes from the marker
alone, so copies installed with `--dir ~/.config/opencode/skills` before
opencode was a target are GraphLoom's own copies there and `update`,
`upgrade` and `remove` treat them so.

## 4. Verification

- `apps/graphloom/test/skills-lint.test.ts`: every skill's frontmatter parses,
  `name` equals its directory, `description` is present and within bounds, the
  body is within size bounds, and each skill carries the hard rules.
- `skills-drift.test.ts`: extracts every `graphloom <command> [<sub>]
  [--flags]` from the skills' code spans and blocks and fails when the built
  CLI's own `--help` lacks the command or the flag.
- `skills-install.test.ts`: install, list, update, remove, edit detection,
  foreign directories, `--force`, and the marker digest against `sha256sum`,
  all in a temporary `HOME`; every target with its variables (opencode with
  and without `XDG_CONFIG_HOME`, `GRAPHLOOM_OPENCODE_SKILLS_DIR`), finding
  opencode on `PATH` and at `~/.opencode/bin` (stub binaries), adopting
  copies installed with `--dir` at a default location; setup's offer,
  doctor's row, and the duplicate warning.
- `watch.test.ts`: each move kind and the 60 second batch, the heartbeat, each
  attention rule, both modes, the timeout, `--notify` (stdin, environment, a failing
  command logged), and cursor and snapshot persistence, on recorded run state with a
  fake clock; and the built CLI for the exit codes and output.
- `progress.test.ts`: each event kind from synthetic state, the cursor and
  `--since`, timeout, stop, a foreign cursor; and an end-to-end scripted run of
  the hello graph watched with `wait --until progress` that reports deltas.
- `install.test.ts`: upgrade refreshes installed copies (Claude Code's and
  opencode's) and skips edited ones; uninstall removes them.
