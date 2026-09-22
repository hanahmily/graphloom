# Loopx issue-fix: triage, patch, and PR publication

Source revision: `67ffe60df4135a2fbbad8b64fc9753ba501dd2a2`, inspected 2026-09-22.
This is a source study, not an executed issue-fix run. The calculator defect is
from Loopx's bundled fixture; owner/repo and issue 123 below are illustrative.
No repository was patched and no public action was performed for this study.

## Responsibility split

The host agent reads code, diagnoses and edits it, runs tests, and performs
separately authorized Git/GitHub actions. The issue-fix capability produces
structured plans, route decisions, validation packets, reviewer recommendations,
and lifecycle projections. The kernel retains task ownership, authority, quota,
and accepted state. A ready packet is not a created PR. [Capability responsibilities](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/README.md#L76)

## 1. Classify the issue and establish whether to work on it

There are two different decisions: understanding the issue's nature, and selecting
an action route. The inspected planner explicitly creates an agent task to
classify the issue from metadata and repository evidence. Its intake builder is
fixture-shaped and does not implement a general bug/feature/docs classifier.
Replacing its metadata does not turn its generic task templates into semantic
classification. [Intake implementation](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/intake_surface.py#L33) [Host classification task](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/workflow_plan.py#L387)

A host investigating a report should distinguish a product defect from a bad
fixture/test, environment failure, or insufficient information. These are stated
reproduction distinctions in the capability guide, not an automatic issue-type
classifier. A label such as bug is an input, not proof. [Reproduction guidance](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/README.md#L147)

Candidate preflight checks prior work before new implementation. It requires
complete issue-scoped evidence for relevant PRs and maintainer-comment metadata.
Cross-references require resolution tied to current source revisions; missing
information leads to collection/verification work. Final routes can include
proceed, reuse_existing_pr, comment_only, or skip. [Candidate admission implementation](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/candidate_preflight.py#L381)

For a proceed candidate, the host supplies reproduction status, scope assessment,
a named repro, a named validation surface, and whether a useful comment is possible.
The feasibility function selects deterministically:

| Condition, evaluated in order | Route |
|---|---|
| Reproduction confirmed or planned; scope bounded; repro and validation labels supplied | fix_pr |
| Otherwise, comment_value is clarification or diagnosis | comment_only |
| Otherwise | triage_only |

Planned reproduction first produces confirmation work. It does not permit skipping
reproduction before patching. These inputs are agent observations; the feasibility
function does not execute the reproduction to establish their truth. [Feasibility and successor code](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/feasibility.py#L42)

For the calculator defect, after reproduction and candidate admission:

```sh
loopx issue-fix feasibility \
  --url https://github.com/owner/repo/issues/123 \
  --reproduction-status confirmed \
  --scope-class bounded \
  --reproduction-label "add(2, 3) returns -1 instead of 5" \
  --validation-label "python test_calculator.py" \
  --format json
```

This is a route calculation, not a complete end-to-end launcher. Goal-scoped use
also persists and connects the appropriate candidate evidence and domain state;
it requires an existing configured goal. The intended planner sequence requires
candidate admission first, but the standalone feasibility handler does not enforce
that prerequisite: a caller can invoke the route calculation directly with supplied
observations. The flags above are defined by the CLI.
[Feasibility CLI arguments](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/cli.py#L435)

## 2. Write and validate the patch

Loopx's actual calculator fixture starts with:

```python
def add(left, right):
    return left - right
```

Its focused test calls `add(2, 3)` and expects `5`. The fixture executes the failing
test, replaces subtraction with addition, and reruns the test. This fixture's
patch is hard-coded; it is not evidence of general model-driven bug fixing.
[Fixture and fixed patch](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/acceptance_loop.py#L269)

For a real repository, the host agent chooses the patch based on repository
semantics, adds or adjusts a regression test, and runs validation. In this example:

```diff
 def add(left, right):
-    return left - right
+    return left + right
```

The host should retain failing-before and passing-after evidence for the same
reported requirement. The requirement must not be weakened to obtain a pass.
The existing fixture commands demonstrate the bounded evidence path:

```sh
loopx issue-fix acceptance-fixture --format json
loopx issue-fix repo-branch-fixture --format json
```

Their implementation uses a temporary fixture workspace/repository. They do not
create a public PR. [Fixture protocol](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/docs/protocols/issue-fix-acceptance-loop-v0.md)

For caller-approved code, the existing helper is:

```sh
loopx issue-fix caller-repo-branch \
  --repo-path /path/to/approved/repo \
  --url https://github.com/owner/repo/issues/123 \
  --base-branch main \
  --validation-command "python test_calculator.py" \
  --validation-label "python test_calculator.py" \
  --execute \
  --format json
```

It prepares or claims a `codex/issue-123-fix` branch, runs the supplied command,
and gathers changed-file evidence. Before a new branch, it checks the local base
against its local tracking ref when one exists; it does not fetch for the caller.
Branch switching from a dirty checkout is refused. Unlike the proposed GraphLoom
controller, this helper checks out a branch in the supplied checkout; it does not
automatically create an isolated worktree. The host must provide the intended
isolated checkout if that is required. [Local branch execution](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/acceptance_loop.py#L650)

Invoke it to prepare/validate the branch, let the host edit the code, then invoke
it again on that same branch to update evidence. It never chooses or writes the
real patch. Review readiness requires execution, passing validation, and nonempty
changed-file evidence. The packet explicitly reports `external_pr_created: false`.
A readiness result does not prove semantic correctness of the chosen validation.
[Readiness and publication flags](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/acceptance_loop.py#L715)

## 3. Open a PR through the host agent

PR creation remains a separately authorized host action. Loopx packet builders do
not silently publish. The host prepares a description explaining the defect,
approach, changes, validation, and risks, then commits and pushes the approved
branch and opens the PR with GitHub tooling. [Publication responsibility](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/README.md#L89)

Illustrative host-side commands, assuming origin is the approved writable
owner/repo remote, main is the target, and pr.md is an already prepared description:

```sh
git add calculator.py test_calculator.py
git commit -m "Fix addition result"
git push -u origin codex/issue-123-fix
gh pr create \
  --repo owner/repo \
  --base main \
  --head codex/issue-123-fix \
  --title "Fix incorrect addition result" \
  --body-file pr.md
```

These are explanatory commands, not actions run by this study. GitHub CLI supports
the explicit base/head/title and body-file arguments. A fork uses an appropriate
user:branch head. See [GitHub CLI documentation](https://cli.github.com/manual/gh_pr_create).

For complete fixes targeting the default branch, the description can include
`Fixes #123`; partial work uses a normal related-issue reference. Loopx's description
builder has explicit issue-reference policy and does not itself create the PR.
[Issue-reference policy](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/pr_description.py#L105)

After a PR exists, reviewer-request can request a reviewer under recorded authority,
and lifecycle handling observes checks, reviews, mergeability, and terminal state.
Failures become successors or blockers. Opening a PR and merging it are separate
actions. [Reviewer request implementation](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/reviewer_request.py#L349); [PR lifecycle observation](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/pr_lifecycle.py#L859)

## Consequence for GraphLoom

The transferable boundary is host/agent judgment plus controller-observed evidence
and explicit publication authority. Loopx's domain-specific route function should
not be mistaken for an LLM supervisor. GraphLoom's proposed supervisor can choose
checks and corrective graph nodes, while its controller owns actual execution,
accepted receipts, and the permitted delivery boundary.
