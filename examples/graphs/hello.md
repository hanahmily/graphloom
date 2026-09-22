# Hello graph: stage definitions

Status: proposed fixture for the minimal core. The runtime is not implemented yet.

## Task and delivery boundary

Use the request pinned from task.yaml as the authority. The fixture starts from a
committed baseline without GREETING.txt. Run in the controller-created worktree.
Deliver the verified local file change and review report. Do not commit, push,
merge, or modify the source checkout or shared Git metadata.

## Write

A writer agent creates GREETING.txt with exactly the UTF-8 bytes
`Hello, GraphLoom!\n`. The newline is one LF byte; the file has no BOM or extra
blank lines. No other workspace paths may differ from the pinned baseline.

The writer returns a structured result and an optional report in its private
output directory. The controller derives the actual workspace change manifest.
The writer's completion claim alone does not satisfy this stage.

The supervisor proposes a bounded command check for exact content and complete
change scope. An independent plan reviewer qualifies the check; the controller
executes it. Its passing receipt permits Write acceptance before Review begins.

## Review

A separate reviewer reads the pinned task, actual worktree contents, writer result,
and controller-observed check receipt for the same workspace revision. It checks
that both content and scope meet the request and returns a structured approve or
request_changes verdict with a report and evidence references.

The reviewer cannot edit the worktree. Its report goes into its own output
directory and does not change the delivered workspace fingerprint. A finding is
reported to the supervisor, which decides whether to inspect or reenter Write.
The reviewer never dispatches a writer directly.

## Completion

Both required stages need current accepted receipts. Checks, plan review, and
corrections are supporting execution nodes; they do not add required stages.
The controller retains the worktree and artifacts after success or stopping.
