# Minimal hello example

Status: design fixture. GraphLoom has no executable runtime yet; the launch below
is the proposed interface for implementation and acceptance testing.

- [task.yaml](task.yaml) selects the graph, target repository, and request.
- [graphs/hello.yaml](graphs/hello.yaml) declares `write → review`.
- [graphs/hello.md](graphs/hello.md) defines the two stages and their evidence.
- [graphs/tdd.yaml](graphs/tdd.yaml) is a retained larger graph declaration,
  outside the minimal fixture; it does not yet have runnable stage definitions.

## Prepare the target repository

From this directory, once per disposable fixture:

```sh
git init test-repo
git -C test-repo -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit --allow-empty -m "Initialize hello fixture"
```

The empty baseline commit is required; the controller cannot create a worktree
from an unborn HEAD. The target repository is test data and is not part of the
GraphLoom source tree.

## Proposed execution

```sh
graphloom run task.yaml
```

Relative paths resolve from task.yaml. The controller creates its own worktree
and branch from test-repo's pinned HEAD, leaving test-repo's working files and
index untouched. A dirty source checkout is allowed; its local changes are not
copied into the run.

Expected result: only GREETING.txt changes in the run worktree, with exact bytes
`Hello, GraphLoom!\n`. The controller records a real content/scope check and the
independent review. Inspect reports the retained worktree and evidence references.
No automatic commit, push, or merge occurs.

## Negative acceptance cases

Use scripted writer responses that omit the newline or modify an unrelated file.
The actual check must fail, and the supervisor must direct a bounded correction.
Also test review requesting changes after Write was accepted: reentry invalidates
that receipt and requires a new check and review of the corrected revision.

Tests must compare the source checkout before and after execution, verify resume
uses the same worktree, and reject stale results or out-of-scope artifact paths.
