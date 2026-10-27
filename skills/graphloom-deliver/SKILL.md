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
  a clean copy is a finding: report it (and see graphloom-triage).

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

## 3. Re-run the checks on a clean copy

Never in the run's worktree. Clone or `git worktree add` the delivered branch
into a fresh directory, then run the repository's own checks there (the
profile's build and test commands, for example `npm ci && npm run build && npm
test`, or `make test-ci`). Report pass or fail per command. Remove the copy
afterwards.

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
