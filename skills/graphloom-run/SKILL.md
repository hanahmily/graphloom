---
name: graphloom-run
description: Start a GraphLoom run. Writes task.yaml (graph, repo, config profile, request), checks it with graphloom check, starts graphloom run in the background with an --on-stop hook that writes a marker file, captures the run id from the start line, and hands the run to the graphloom-watch skill (or, inside a HAPI session, to a detached graphloom watch that messages the session). Never polls the process table. Use when the user wants to run a graph (for example issue-fix on an issue) on a repository.
---

# Start a GraphLoom run

## Hard rules

- **Start and monitor; never fix.** Your job is to start the run and report its
  progress. When it stops, for any reason, summarize why (the stop reason, its
  blocker and any question it asks, quoted) and ask the user what to do next.
  Do nothing more: no `graphloom resume`, no change to the environment, the
  task or the repository, no new run, no answer to a question the run asks, and
  no reading of GraphLoom's or the target repository's source to work around
  the stop. The user decides every next step.
- **No placeholder reaches a run.** Before writing the task, read the request
  the user gave: an unfilled template value (`<...>`, `TODO`, `TBD`, `...`
  standing for a choice) is a question, not an answer. Ask the user for the
  value and never start a run with a placeholder in it.
- Ask before anything outward-facing (push, pull request, issue creation,
  release). Starting a run is local, but confirm the task with the user first:
  a live run spends real model calls against its budgets.
- Never print or ask for a token or secret. If the graph reads GitHub, the
  runner config's `github.tokenEnv` names a variable; the user exports it in
  the shell that starts the run (for example
  `export GRAPHLOOM_GITHUB_LIVE_TOKEN="$(gh auth token)"`, run by the user).
  Never echo it.
- Read run state only through `graphloom inspect`, `graphloom stats` and
  `graphloom wait`; never edit `state.json`.
- Use only commands and flags `graphloom --help` lists.
- **Never use `pgrep`, `ps | grep`, or `kill -0` to decide whether a run is
  alive.** A `pgrep -f <pattern>` started from a shell matches that shell's own
  command line, so it reports "running" forever; that once hid a stopped run
  for two hours. Liveness is `graphloom wait` (it reads the durable state and
  the controller's owner claim) and the `--on-stop` marker.

## 1. Write the task

A task file selects a graph; the plugin does the rest. Put it in a working
directory of its own (the operator's, not the target repository).
Everything needed to write one is here and in `graphloom --help`; do not read
GraphLoom's source or built files to work out a field.

```yaml
graph: issue-fix                                  # a bundle under plugins/<graph>/ beside the task
repo: ./widgets                                   # the target repository, relative to this file
config: profiles/widgets.json                     # the plugin's profile, if it takes one
request: "Fix acme/widgets#42."                   # what to do; issue-fix names one issue
```

- Link an installed bundle by its **versioned** real path, never `current`:
  `mkdir -p plugins && ln -s "$(graphloom version --root)/examples/plugins/issue-fix" plugins/issue-fix`.
- Profiles live beside the task (copy one from `plugins/issue-fix/profiles/`
  and adjust it). Intake pins the profile's bytes; later edits do not change a
  started run.
- A `budgets:` block overrides the profile's defaults key by key. Do not raise
  budgets "to be safe"; the defaults come from measured runs.
- **Paths:** `repo` and `config` are relative to the task file. The run's state
  goes to `<repo>/graphloom-state/<run>` and its worktree to
  `<repo>/graphloom/<run>` on branch `graphloom/<run>`, created from the
  checkout's `HEAD`, which is the base the delivered change sits on.
  Uncommitted changes in the checkout are only recorded, before and after
  (`sourceDirtyBefore`/`sourceDirtyAfter`); the run never uses them.
- A worked example ships with the install:
  `$(graphloom version --root)/examples/issue-fix-banyandb-task.yaml`.

### Start from a fresh base

The delivered change sits on the checkout's `HEAD`, so a stale checkout means
a stale pull request (and conflicts at delivery). Before writing the task,
fetch the upstream default branch and compare:

```sh
git -C <repo> fetch <upstream-remote> <default-branch>
git -C <repo> rev-list --count HEAD..<upstream-remote>/<default-branch>
```

If `HEAD` is behind, tell the user by how many commits and ask whether to
start from the current upstream branch (for example a new worktree:
`git -C <repo> worktree add <dir> <upstream-remote>/<default-branch>`) or to
keep this base. Never move or reset the user's branch without a yes.

### The repository's own toolchain

The run's command jobs (builds, tests, `npm ci`) use the `PATH` of the shell
that starts `graphloom run` or `graphloom resume`; GraphLoom itself always
runs on its bundled Node. When the repository pins a Node version (a
`.nvmrc`, or an exact `engines.node` in a `package.json`, often with
`engine-strict`), compare it with `node --version` in that shell. If they
differ and nvm has the pinned version (`$NVM_DIR/versions/node/v<version>/bin`),
put that directory first on `PATH` in the start command of section 3; if it is
not installed, ask the user. Do the same for any other toolchain the profile's
environment checks report as the wrong version.

### A graph that prepares its own task

Some graphs fetch refs and pin commits for you (a review of a pull request
needs the head fetched, pinned by hash, and its merge base found).
`graphloom task new` asks the graph's plugin for a plan, validates it, fetches
over https with no hook or user Git configuration, never checks anything out,
and writes the `task.yaml`. A graph that does not prepare tasks says so, and
the task is written by hand as above.

```sh
graphloom task new pr-review apache/skywalking-banyandb#1234 --repo ./skywalking-banyandb --profile banyandb --dry-run
graphloom task new pr-review apache/skywalking-banyandb#1234 --repo ./skywalking-banyandb --profile banyandb
```

- The first line prints the plan and the task it would write and changes
  nothing; show it to the user, then run the second. The bundle is
  `plugins/<graph>/` in the current directory (`--out` changes where), and a
  profile is a name looked up in `profiles/` there and in the bundle, or a path.
- It refuses to replace an existing task unless `--force`; refs it wrote stay
  under `refs/graphloom/<graph>/` in the repository. The last line names the
  next command, `graphloom check` on the new task. Skip the hand-written
  task above and continue with section 2.

## 2. Check before spending

```sh
graphloom check task.yaml
graphloom doctor --task task.yaml
```

`check` is free: the plugin loads, its declared data is valid, and its
environment checks (toolchains, logins, docker, ...) pass. `doctor --task`
adds the supervisor the run would pin and each agent role's harness. Fix every
failure before starting (see the graphloom-setup skill). For a new profile, a
zero-provider-call rehearsal is worth it: `graphloom rehearse task.yaml`.

## 3. Start it in the background

Make a watch directory beside the task, then start the run detached, with the
stop hook writing a marker file and stderr kept in a log (prefix the
repository's toolchain on `PATH` first when section 1 found one):

```sh
mkdir -p .graphloom-watch
rm -f .graphloom-watch/stopped
graphloom run task.yaml \
  --on-stop 'printf "%s %s %s\n" "$GRAPHLOOM_STATUS" "$GRAPHLOOM_RUN_ID" "$GRAPHLOOM_STOP_REASON" > .graphloom-watch/stopped' \
  > .graphloom-watch/report.json 2> .graphloom-watch/run.log
```

- **Claude Code**: run that command with the Bash tool's background option, so
  you are notified when it exits.
- **Codex or opencode** (or any shell): detach it so it outlives the command:
  `setsid nohup sh -c '<the command above>' >/dev/null 2>&1 &`.

The hook runs once when the run leaves `running` (or the CLI crashes); its
environment carries `GRAPHLOOM_RUN_ID`, `GRAPHLOOM_STATUS`,
`GRAPHLOOM_STOP_REASON`, `GRAPHLOOM_STOP_RETRYABLE` and
`GRAPHLOOM_STATE_DIR`. The final report JSON lands in `report.json`.

## 4. Find the run

The CLI prints one line on stderr as soon as the run exists:

```text
graphloom: run 1a2b3c4d-5e6 started; state /path/to/widgets/graphloom-state/1a2b3c4d-5e6
```

Read it from `.graphloom-watch/run.log` (retry for a few seconds; intake and
the environment checks come first). If the log ends with an error and no such
line, the run never started: show the error and stop here. The state directory
works anywhere a run id does (`graphloom stats <stateDir>`).

Confirm it is alive from durable state, not the process table:

```sh
graphloom wait <stateDir> --until progress --timeout 30s --json
```

Exit 0 or 2 with `summary.status` `running` is alive; 3 is a controller that
died (see graphloom-triage).

## 5. Hand over

Record the state directory in `.graphloom-watch/run`.

- **Inside a HAPI session** (`HAPI_SESSION_ID` is set): start a detached
  watcher from the task directory and end your turn, so no tokens are spent
  while the run works:

  ```sh
  setsid nohup graphloom watch <stateDir> --until stop --notify 'hapi ping-peer "$HAPI_SESSION_ID" --message-file -' >/dev/null 2>&1 &
  ```

  Tell the user the run id and that the run is running, and that progress, a
  15-minute heartbeat and anything needing attention will arrive as messages in
  this session. Each message starts with `[graphloom watch]` and ends with what
  to do; graphloom-watch says how to handle it.
- **Otherwise** hand over to the graphloom-watch skill. Tell the user: the run
  id, the stage it is in, where the marker and log are, and that watch reports
  only changes.

## 6. A run that stops for a decision

A graph may declare decisions for you as data and stop, final, with a result for
you to read before anything continues (`graphloom inspect` names them; pr-review
declares none: it posts its review and ends without waiting). Read what the stop
names, then decide:

```sh
graphloom session list <stateDir>
graphloom session open <stateDir> --stage answers
graphloom resume <stateDir> --decline <approval-id> --reason "the report is enough"
```

- `session open` forks a recorded Claude Code or Codex session in your own
  terminal, under the job's confinement with the checkout read-only, and
  records the conversation when you exit; it needs a terminal, so ask the user
  to run it themselves. It never changes the recorded session.
- `--decline <id>` and `--approve <id>` record your decision as evidence on the
  stopped run; only the user decides, so never run either without being told
  which. A version that cannot act on an approval refuses it and says why.
  An approval that declares inputs takes `--input <name>=<value>` with
  `--approve`, for example `graphloom resume <stateDir> --approve <approval-id>
  --input <name>=<value>`; ask the user for the values, never guess them.
