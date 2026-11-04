---
name: graphloom-deliver
description: Verify what a succeeded GraphLoom run delivered before it leaves the machine - the local branch, its commit message and pull request body (no private tracker references, required sections such as Benchmark when the profile has bench gates), and the repository's own checks re-run on a clean copy - then push and open the upstream pull request only with the user's explicit approval, noting stacked-PR dependencies. Use when a run succeeded and the user wants to ship its change.
---

# Deliver a run's change

## Hard rules

- **Ask before anything outward-facing.** Never `git push`, open or edit a pull
  request, create an issue, or publish anything without the user's explicit
  approval of the exact command, remote, branch and text. Approval for one
  push is not approval for the next.
- Never print or ask for a token or secret; let `gh` and `git` use the user's
  own login.
- Read run state only through `graphloom inspect`, `graphloom stats` and
  `graphloom wait`; never edit `state.json`.
- Use only commands and flags `graphloom --help` lists.
- Do not rewrite the delivered commit to make a check pass. A failing check on
  a clean copy is a finding: report it (and see graphloom-triage). Rebasing it
  onto a newer upstream base is allowed only on the user's yes (section 3).

## 1. Locate the delivery

```sh
graphloom inspect <run>
graphloom stats <run>
```

Confirm `status` is `succeeded` and every stage is complete. The issue-fix
graph delivers a local branch `fix/<issue>` in the target repository, with the
pull request body as its delivery report. Find the branch, its base, and the
report (the delivery evidence `inspect` lists).

## 2. Read the commit and the pull request body

- One commit (or the profile's shape) on top of the base; the diff touches
  only what the issue asked for.
- The commit message and body describe the change against the base, not the
  run (no review issue ids, no `.graphloom/` paths, no first-person agent
  narration).
- **No private references** when the profile uses `pullRequest.reference`
  (a private tracker): no `Fixes owner/private-repo#N`, no link to or name of
  the private repository or its documents. Search the message and body for the
  private repository's name.
- **Required sections are present**: the Test plan names checks that passed;
  a profile with `final` bench gates needs its `Benchmark` section (timings
  reported only, never judged); a "Review issues" table when the run tracked
  findings; follow-ups when there were any.
- Nothing secret-shaped anywhere in the diff, message or body.

## 3. Bring the base up to date, then check once

**First the base.** Fetch the upstream default branch and see whether the
branch still applies cleanly:

```sh
git -C <repo> fetch <upstream-remote> <default-branch>
git -C <repo> rev-list --count <base>..<upstream-remote>/<default-branch>
git -C <repo> merge-tree --write-tree <upstream-remote>/<default-branch> fix/<issue>
```

If the base is behind, tell the user by how many commits and whether it
conflicts, and ask whether to rebase onto the current upstream branch. On a
yes, rebase in a fresh `git worktree` (never the run's worktree), resolve only
mechanical conflicts such as neighbouring `CHANGES.md` lines, confirm the
patch is otherwise unchanged (`git range-diff`), and point `fix/<issue>` at the
result. Anything more than a mechanical conflict goes back to the user.

**Then the checks, once, on the tree you will push.** Never in the run's
worktree. `git worktree add` the (rebased) branch into a fresh directory and
run the repository's own checks there (the profile's build and test commands,
or the repository's pre-push target, for example `make pre-push`). Keep your
own helper scripts and logs **outside** that directory: checks such as a
format or clean-tree check fail on an untracked file. Use the repository's
toolchain on `PATH` (see graphloom-run, section 1). Report pass or fail per
command. Remove the copy afterwards.

## 4. Stacked pull requests

If this branch was built on another run's branch (its `repo` was a checkout of
an earlier `fix/<issue>`), the upstream pull request depends on that one:
say which, and that it must merge first (or the PR targets that branch).

## 5. Ship, with approval

Show the user: branch, base, remote, the commit message, the PR title and
body, and the check results. Ask. Only on an explicit yes, push and open the
pull request with the user's chosen tool (for example `git push <remote>
fix/<issue>` then `gh pr create --base <base> --head fix/<issue> --title
"<title>" --body-file <file>`), showing each command before running it. Report
the PR URL. Leave the run's state alone; `graphloom delete <run>` cleans it up
later, when the user asks.
