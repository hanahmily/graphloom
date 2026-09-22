# LoopX gate-defect handling: source findings

Inspected local LoopX snapshot `67ffe60df4135a2fbbad8b64fc9753ba501dd2a2`. This note reports source and existing-test inspection; no tests were executed and no runtime self-repair was demonstrated.

## Conclusion

LoopX explicitly permits diagnosing and repairing defects in its own control-plane source through a coding-agent development workflow. It also contains specific runtime state repairs and a preimplemented exception for measuring an already-failing baseline. These are distinct from a generic facility that diagnoses arbitrary validator implementation bugs, hot-patches validator code, and accepts its own changed criterion. The inspected sources do not establish that latter capability.

## Concrete defective-gate example: baseline measurement deadlock

The testing policy identifies a real gate design problem: if an otherwise valid historical base already exceeds its old output-size ceiling, enforcing that ceiling before measuring the candidate prevents the repair from being evaluated. Its remedy is narrowly specified: skip absolute size checks only while measuring the base; retain parsing, required keys, anchors and semantic differential checks; always enforce current candidate budgets. Measurement mode is not a merge bypass. [Policy, lines 598–610](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/docs/development/testing-and-quality.md#L598-L610).

This is implemented, not just proposed. The differential runner invokes the base with `enforce_budget=False` and candidate with `enforce_budget=True`, then rejects a failed receipt comparison. [Base/head invocation, lines 170–189](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/examples/control_plane/cli-output-base-head-differential-smoke.py#L170-L189); [comparison, lines 204–217](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/examples/control_plane/cli-output-base-head-differential-smoke.py#L204-L217). The probe has separate semantic-shape validation and budget-validation branches. [Probe implementation, lines 127–195](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/examples/control_plane/cli-output-probe-runner.py#L127-L195).

An existing test confirms that semantic required-key checking still rejects a missing key. Despite its broad test name, the inspected test itself exercises `_assert_output_contract`, not the full base/head integration or a failing ceiling. [Existing test, lines 995–1020](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/tests/control_plane/test_cli_output_differential.py#L995-L1020).

Interpretation: this is a source-level repair of the development gate, codified as a bounded measurement path. It does not demonstrate a running system editing an arbitrary validator.

## Test/fixture defects are first-class diagnoses

Issue Fix requires distinguishing product defects, test/fixture defects, environment/dependency failure and insufficient reproduction evidence. The next step is a focused patch in a clean worktree with regression proof. [Issue Fix README, lines 144–162](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/capabilities/issue_fix/README.md#L144-L162).

This supports treating a faulty test or fixture as the repair target rather than automatically changing product behavior to appease it. It is workflow guidance, not evidence of an automatic validator-replacement API.

## Self-repair can include source edits

The self-repair skill explicitly assigns failures to responsible layers and tells the agent to fix CLI/status/quota projection code plus a focused smoke when the machine projection misled the agent. It requires validation before resuming and durable lesson writeback. [Skill, lines 31–62](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/skills/loopx-self-repair/SKILL.md#L31-L62).

A concrete incident documents a user gate intended for agent B incorrectly blocking agent A. The reported PR #629 repair corrected gate scoping while preserving B's legitimate block; listed validation includes both target and non-target behavior. This is documentary evidence of a shipped source fix, not an independently rerun experiment in this study. [Incident repair and validation, lines 73–98](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/docs/archive/incidents/agent-scoped-user-gate-overreach-incident-20260624.md#L73-L98).

## Independent validator failure routes do not themselves patch code

The command validator runs a caller-supplied argv in the project workspace. Command launch failure/timeout becomes `inconclusive` plus `repair_required`; nonzero exit becomes `failed` plus configured `repair_required` or `replan_required`. [Command validator, lines 98–145](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/control_plane/turn_driver/command_validation.py#L98-L145).

The executor fails closed when the validator is missing, throws, returns malformed evidence, or tries to skip independent validation for material host results. These branches construct typed recovery receipts; they do not diagnose the validator's implementation or rewrite its source. [Executor, lines 441–495](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/loopx/control_plane/turn_driver/executor.py#L441-L495).

The protocol keeps the host's candidate result separate from independent postcondition validation, then routes to pass/repair/replan and durable writeback. [Turn protocol, lines 217–247](https://github.com/loopx-project/loopx/blob/67ffe60df4135a2fbbad8b64fc9753ba501dd2a2/docs/reference/protocols/loopx-turn-v0.md#L217-L247).

Precise comparison vocabulary: **typed recovery routing**, **bounded gate/state reconciliation**, **agent-driven source repair with regression checks**, and **arbitrary autonomous validator self-modification** are four different claims. The inspected evidence supports the first three in specific forms; it does not establish the fourth.
