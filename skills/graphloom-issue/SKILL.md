---
name: graphloom-issue
description: Turn a requirement into an issue (or a set of issues) that one GraphLoom issue-fix run handles well - exactly one deliverable pull request, testable acceptance criteria, the context documents the work defers to (issue-fix issues.context), and a size that is neither trivially small nor too big for one PR. Splits a big request into leaf issues or merges tiny ones, and offers the private-tracker option (pullRequest.reference) that keeps private references out of the delivered commit and PR. Drafts only; never creates an issue without the user's approval. Use before starting a run on a new requirement.
---

# Shape a requirement into issues a run can deliver

The issue-fix graph fixes **one issue per run**: it plans, implements with a
RED/GREEN proof, reviews, and delivers one `fix/<issue>` branch with one
commit message and one pull request body. Its request names the issue as
`owner/repo#N` (for example `Fix hanahmily/graphloom#119.`), and the profile's
`issues` names where issues live.

## Hard rules

- Ask before anything outward-facing: never create, edit, label, or comment on
  an issue, push, or open a pull request without the user's explicit approval
  of that exact text and target. Draft first, show the draft, wait.
- Never print or ask for a token or secret. If the tracker needs a GitHub token
  for the run to read it, name the variable the runner config's
  `github.tokenEnv` uses; the user sets it.
- Read run state only through `graphloom inspect`, `graphloom stats` and
  `graphloom wait`; never edit `state.json`.
- Use only commands and flags `graphloom --help` lists.

## 1. Understand the requirement

Read what the user gave and the code it touches. Find: the observable outcome,
the files or packages likely involved, how the repository tests it (the
profile's regression runner: `go-test` or `vitest`), and any design document
it depends on. Ask about anything that would change the scope.

## 2. Size it: one deliverable pull request

Good size: a reviewer can read the diff in one sitting, one regression test can
fail before and pass after (RED/GREEN), and the change stands alone on its
base branch.

- **Too big** (several independent behaviours, a migration plus a feature,
  more than one package boundary with separate tests, "and also"): split into
  **leaf issues**, each one PR. Order them; say which one builds on which
  (a later run's `repo` is a checkout of the earlier run's delivered branch,
  so the change is part of its base). Keep an umbrella issue only as a list.
- **Too small** (a typo, a rename, two-line tweaks in the same area): merge
  with neighbours into one issue with one coherent outcome, or suggest the user
  makes the change by hand; a run has fixed overhead (plan, checks, review).
- **Not a fit**: no testable behaviour, needs a human decision mid-way, or needs
  credentials or services the run cannot reach. Say so.

## 3. Write each issue

```markdown
## Problem
What is wrong or missing, observably. Link the code (path:line).

## Expected behaviour
What should happen instead.

## Acceptance criteria
- [ ] Each a checkable statement a test can prove (input -> output, error, state).
- [ ] Includes the regression test to add (package / test name if known).
- [ ] Names what must NOT change (public API, file formats, other packages).

## Context
- Design documents this defers to (repository and path).
- Constraints: performance gates, compatibility, style rules.

## Out of scope
- What a reviewer should not expect in this PR.
```

The planner turns the acceptance criteria into the plan's `acceptance` list and
the implementer maps each to files and tests, so make every criterion
testable and specific.

## 4. Context documents

When the issue defers to a document (a design, a ticket list, a spec), list it
in the profile's `issues.context` rather than pasting it into the issue:

```json
"issues": {
  "owner": "acme",
  "repo": "widgets",
  "context": [
    { "repo": "acme/widgets-design", "path": "docs/design.md" },
    { "path": "docs/architecture.md", "ref": "main" }
  ]
}
```

An entry with `repo` is read through the GitHub executor (the token must read
that repository); one without is a file of the target repository at the base
commit. A missing document, or more than 200,000 bytes in total, stops the run
before any agent. Profiles are operator files beside the task (copy a bundled
profile from `plugins/issue-fix/profiles/`, adjust it, name it with `config:`);
never edit the installed bundle.

## 5. Private tracker option

If the issues live in a private repository but the pull request goes to a
public one, the delivered commit and PR must not name the private tracker.
Offer the profile's `pullRequest.reference`:

```json
"pullRequest": { "reference": { "style": "implements", "subject": "the Widgets" } }
```

The commit's last line and the PR heading then say "Implements the Widgets
<issue title>", there is no `Fixes owner/repo#N` line, the footer may not use
`{issue}`, and any mention of the private repository the agents wrote is
dropped. Write the issue text itself so it stands alone without the private
links (the planner and implementer are told to write public text).

## 6. Hand over

Show the drafts (and the split/merge reasoning in two or three lines). On the
user's approval, and only then, create the issues the way the user chooses
(for example with `gh issue create`, showing the exact command first). Then
point to the graphloom-run skill with the issue reference for `request:`.
