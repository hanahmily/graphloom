# Splitting pr-review into `pr-design-review` and `pr-review`

Status: implemented and retired. The split of the two-round `pr-review` 0.26 into
two graphs landed in pr-review 0.27.0 (ledger v2), 0.27.1 (the review kit),
`pr-design-review` 0.1.0 and `pr-review` 1.0.0. The designs of the two graphs
replace this document:

- [PR design review](design-pr-design-review.md): `pr-design-review`, round 1.
- [PR-review graph](design-pr-review-graph.md): `pr-review` 1.x, round 2, and the
  review kit both graphs share.

Source comments and earlier pull requests cite sections of this document. They
are now here:

| Section of this document | Now |
|---|---|
| §1 Purpose and decisions | [PR review §1](design-pr-review-graph.md#1-purpose-and-fixed-decisions), [design review §1](design-pr-design-review.md#1-purpose-and-decisions) |
| §2 Two graphs, two plugins | [PR review §2](design-pr-review-graph.md#2-the-run-two-graphs-and-no-human), [§14](design-pr-review-graph.md#14-the-review-kit) |
| §3 `pr-design-review`: round 1 (§3.1 stages, §3.2 questions, §3.3 `other`, §3.4 measurements, §3.5 a later head, §3.6 the gate, §3.7 publish and the result) | [design review §4](design-pr-design-review.md#4-stages-and-requirements), [§5.1](design-pr-design-review.md#51-questions), [§5.2](design-pr-design-review.md#52-the-other-question), [§6](design-pr-design-review.md#6-measurements-in-round-1), [§7](design-pr-design-review.md#7-a-later-head), [§8](design-pr-design-review.md#8-the-gate), [§9](design-pr-design-review.md#9-publish-and-the-runs-result) |
| §4 `pr-review` 1.x: round 2 (§4.1 stages, §4.2 the context source, §4.3 leads, §4.4 maintainability, §4.5 draft, publish and the verdict) | [PR review §5](design-pr-review-graph.md#5-stages-and-requirements), [§7.1](design-pr-review-graph.md#71-the-context-source), [§7.3](design-pr-review-graph.md#73-leads), [§7.4](design-pr-review-graph.md#74-the-maintainability-aspect), [§8.4](design-pr-review-graph.md#84-draft), [§8.5](design-pr-review-graph.md#85-publish), [§10.3](design-pr-review-graph.md#103-verdict) |
| §5 The ledger (§5.1 layout, §5.2 writing a section, §5.3 head markers, §5.4 migrating a v1 ledger) | [PR review §9.1](design-pr-review-graph.md#91-where-the-ledger-lives), [§9.4](design-pr-review-graph.md#94-section-writes-markers-and-migration) |
| §6 Chaining | [PR review §2](design-pr-review-graph.md#2-the-run-two-graphs-and-no-human), [design review §2](design-pr-design-review.md#2-the-run) |
| §7 Tasks and profiles (§7.1 tasks, §7.2 profiles) | [PR review §3.1](design-pr-review-graph.md#31-task), [§3.2.2](design-pr-review-graph.md#322-keys-per-graph), [design review §3](design-pr-design-review.md#3-inputs) |
| §8 Migration and coexistence | [PR review §18](design-pr-review-graph.md#18-version-history) |
| §10 Generic platform change (`ValidationInput.request`) | [PR review §15](design-pr-review-graph.md#15-generic-platform-changes) |
| §11 Implementation plan | Done; [PR review §18](design-pr-review-graph.md#18-version-history) |
| §12 Open questions | [PR review §19](design-pr-review-graph.md#19-deferred-items) |

The full text is in the repository's history before this document was retired.
