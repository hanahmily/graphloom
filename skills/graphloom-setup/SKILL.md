---
name: graphloom-setup
description: Set up GraphLoom on this machine. Runs graphloom doctor, explains every warn and fail, runs the doctor's fix commands only with the user's consent, then runs graphloom setup and picks a supervisor route per model vendor (Claude via Claude Code or Pi with ANTHROPIC_API_KEY, OpenAI via Codex or Pi with OPENAI_API_KEY, other vendors via Pi). Use when GraphLoom is newly installed, when graphloom run refuses for a missing runner config, or when the user asks to fix their GraphLoom setup.
---

# Set up GraphLoom

Goal: a machine where `graphloom doctor` shows no `fail`, a runner config and
(ideally) a supervisor config exist, and the user understands every remaining
`warn`.

## Hard rules

- Ask before anything outward-facing (pushing, opening a pull request, creating
  an issue, publishing a release). Setup itself has none; do not invent any.
- Never print or ask for a token or secret (an API key, a password; no echo,
  no paste). Name the
  environment variable (for example `ANTHROPIC_API_KEY`) and let the user set it
  in their own shell. Never `cat` credential files or Pi's auth store.
- Read run state only through `graphloom inspect`, `graphloom stats` and
  `graphloom wait`; never edit `state.json`.
- Use only commands and flags `graphloom --help` lists.
- Run a `fix:` command only after the user agrees to that specific command.
  Commands with `sudo` or `sysctl` change the system: say so plainly first.

## 1. Diagnose

Run the doctor in machine form and read it:

```sh
graphloom doctor --json
```

Each check has `section` (host, agents, configuration, setups, task), `name`,
`status` (`pass`, `warn`, `fail`), `detail` and, on every warn and fail, `fix`:
the exact next command. Report to the user grouped by section, failures first,
one line each: what is wrong, why it matters, and the fix. Typical rows:

| Row | Meaning | Usual fix |
|---|---|---|
| `git`, `flock` fail | Needed by every run (locks, worktrees) | Install the package the fix names |
| `confinement` fail | bubblewrap cannot create a namespace; Claude Code and Codex jobs and supervisors are confined by it | The `sysctl` the fix names (AppArmor `kernel.apparmor_restrict_unprivileged_userns`) |
| `claude-code` / `codex` warn | CLI missing, probe failed, or not logged in | `claude` (then `/login`), `codex login` |
| `pi` warn | No provider credential | Export the provider's variable the fix names |
| `gh` warn | Install, upgrade and automatic updates need an authenticated `gh` | `gh auth login` |
| `runner config` warn/fail | `run` refuses without a valid one | `graphloom setup` |
| `supervisor config` warn | No automatic recovery | `graphloom setup` |
| `skills (<agent>)` warn | These skills are missing or from another version | `graphloom skills install --agent <agent>` or `graphloom skills update` |
| `skills duplicates (<agent>)` warn | The agent also reads a shared directory (`~/.agents/skills`, or `~/.claude/skills` for opencode) holding GraphLoom copies of the skills in its own directory, so it loads them twice | The fix: `graphloom skills remove` with the duplicated names and `--dir` the shared directory |

A login the doctor cannot verify ("login not verified") still counts as
available; tell the user how to confirm it themselves.

## 2. Fix, with consent

For each fix, show the command and ask. Run it only on a yes. Commands that
need the user's own terminal (an interactive login such as `claude` or
`codex login`, or `gh auth login`) are for the user to run: tell them to run
it and come back. After the fixes, run `graphloom doctor` again and show what
changed.

## 3. Choose the supervisor route

The supervisor is the one agent that drives recovery when a run gets stuck.
Explain the routes the doctor's `supervisor routes` row reports:

| Vendor | Through a CLI login (no API key) | Through Pi (API key) |
|---|---|---|
| Claude | Claude Code, the user's own `claude` login | Pi provider `anthropic`, `ANTHROPIC_API_KEY` |
| OpenAI | Codex, the user's own `codex login` (a ChatGPT login) | Pi provider `openai`, `OPENAI_API_KEY` |
| Gemini, DeepSeek, Kimi, MiniMax, others | none | Pi with that provider's variable, or a custom provider in Pi's `models.json` |

Recommend the route the user already pays for. A plugin may prefer a harness;
`graphloom doctor --task <task.yaml>` shows the selection a run would make.

## 4. Run setup

`graphloom setup` asks questions on a terminal. Tell the user to run it in
their own terminal (it asks for consent to `allowUnrestricted`, which only the
user can give), or, if the user explicitly says to accept every
recommendation non-interactively, run:

```sh
graphloom setup --yes
```

Setup writes `~/.config/graphloom/runner.json` and `supervisor.json` (mode
0600, old files kept as `.bak-` copies), never a token. On a terminal it also
offers to install these skills for each agent found; `--yes` does not, so
offer `graphloom skills install` separately.

## 5. Confirm

Run `graphloom doctor` once more and summarise: what works now, what still
warns and why that is acceptable or what the user must do (logins, exported
variables). Point to `graphloom check <task.yaml>` as the next step before a
first run.
