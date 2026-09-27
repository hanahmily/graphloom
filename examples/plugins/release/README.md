# Release TypeScript graph plugin

Source-repairable Bump → Changelog → Review bundle for GraphLoom, written only
against the public `@graphloom/sdk`. Given a request that names a version, such
as `Release version 1.2.0 …`, it records the version in `VERSION` and adds a
[Keep a Changelog](https://keepachangelog.com/) entry to `CHANGELOG.md`.

## Stages and requirements

| Stage | Requirement | Validator |
|---|---|---|
| Bump version | `version-file`: `VERSION` is exactly `MAJOR.MINOR.PATCH` and a newline | `semver-file` |
| Changelog | `changelog-entry`: the first release section below `[Unreleased]` is headed `## [X.Y.Z]` for the version in `VERSION`, optionally with ` - YYYY-MM-DD`, and lists a `- ` change | `changelog-entry` |
| Changelog | `release-scope`: `VERSION` and `CHANGELOG.md` are the only changed paths | `release-scope` |
| Review | `release-review`: an independent read-only reviewer approves the release | `independent-reviewer` |

`changelog-entry` reads two observed files. Changelog carries two
requirements, so one Validate covers both.

## Behavior

| State | Action |
|---|---|
| Work stage, worker not yet run | Dispatch its writer, scoped to `VERSION` or `CHANGELOG.md` |
| Worker ran, not observed in this generation | Observe the stage's files and the workspace manifest |
| Every stage requirement passes | Validate the stage |
| A requirement fails | Dispatch one correction with the validator's reason, then Supervise |
| Reviewer requests changes | Reenter Changelog; the rewrite instruction quotes the reviewer |
| Reviewer approves | Validate Review |
| Every stage has valid receipts | Stop complete |
| Request names no version | Stop incompatible |

After a repair activation or a Changelog reentry, a new generation makes earlier
observations stale. A stage whose worker already ran is then observed and
validated again rather than redone, and Review always gets a fresh reviewer.

## Build and repair

```sh
npm run build -w @graphloom/plugin-release
npm test -w @graphloom/plugin-release
npm run manifest -w @graphloom/plugin-release   # after build; refreshes digests and requirements
```

`tsconfig.json` is self-contained, and the source uses no Node APIs. A run-local
repair copy, with `@graphloom/sdk` linked beside it, therefore rebuilds with plain
`tsc -p tsconfig.json`. The manifest's requirements and stages come from the built
`describe()`, so they cannot drift from the graph.

`apps/graphloom/test/release-e2e.test.ts` runs this bundle through the
controller. One run installs a copy whose changelog validator rejects dated
headings. The supervisor qualifies a source repair, and the preflight rebuilds
`dist` from the patched source. After activation, the run completes under the
repaired validator without redoing work already accepted.
