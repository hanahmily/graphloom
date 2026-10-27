# Installable releases

Status: proposed design, 2026-10-26; phases R0 to R5 implemented; `v0.1.0` is not yet prepared or published. The repository
license (Apache-2.0: `LICENSE`, `NOTICE`, and `license` in every `package.json`)
and the source headers with their check (§2.8) are in place (R0). So are the
product version and `graphloom version` (§2.4), the repair toolchain as CLI
dependencies (§2.2), `process.execPath` for GraphLoom's own scripts and the
pinned Node fetch (§2.7), the license check and notices (§2.8), SDK packing
(§3.1), and `scripts/release.sh build` (§6, "R1 as implemented"). R2 added
`install.sh`, the shim, `graphloom upgrade`, `graphloom self`, automatic
updates, and deterministic packing (§4.7, §5.5, and §6, "R2 as
implemented"). R3 added run ownership, dispatch to the owning version,
`resume --upgrade` with state formats and migrators, the product version in
the gate fingerprint, and the upgrade-matrix hooks (§5.6). R4 added
`graphloom doctor`, guided `graphloom setup`, the automatic first run, and
the installer's setup offer (§4.8). R5 added `release.sh prepare` and
`publish`, signing, and the external-plugin smoke test (§6, "R5 as
implemented"); the first release waits for its remaining work and the maintainer's
release key.
This covers how GraphLoom is packaged, installed, upgraded, and released
for an operator who runs it on their own Linux machine. It specializes the
[TypeScript core design](design-typescript-core.md) (version transitions, §8) and the
[executor design](design-executors.md#restart-versions-and-recovery). It adds no
graph, controller, or executor behavior beyond what installs need.

## 1. Scope and decisions

A **release** is an installable, self-contained product: the CLI, the core
packages, the built-in executors, the example plugin bundles (including issue-fix
with its profiles), a bundled Node.js runtime, an install script, prerequisite
checks, and an upgrade and rollback path. Another user installs it and runs graphs
on their own machine with their own harness logins. Plugin authors get the SDK as
a release asset.

| Decision | Choice |
|---|---|
| License | Apache License 2.0, as for Apache SkyWalking BanyanDB; copyright "Hongtao Gao and the GraphLoom contributors" in `NOTICE` and source headers; SPDX headers on hand-written source (§2.8) |
| Channel | A GitHub Release of `hanahmily/graphloom`. No npm registry publishing |
| Access | The repository stays private for now. Installers and plugin authors are granted read access per user and download with an authenticated `gh` (§4.2). Public URLs are a later option, revisited with visibility |
| Builder | A maintainer's machine. GitHub Actions is intentionally not used; the local CI gate plus release checks (§6) is the release gate |
| Artifact form | A pruned, built workspace tree with production `node_modules` and a pinned Node runtime, not a single-file bundle (§2.2, §2.7) |
| SDK | `npm pack` of `@graphloom/sdk` attached to every release (§3.1) |
| Platform | `linux-x64` first |
| Version | One product version for the release and the SDK; executors and plugin bundles keep their own versions, recorded in the release manifest (§3) |
| Install layout | Immutable version directories plus a `current` symlink; a run stays on the version it started with (§4, §5) |
| Upgrading a run | `resume --upgrade` moves a run forward across minor versions within a major, through ordered state migrations (§5.2) |
| Upgrading the install | `graphloom upgrade [<version>]` installs a release beside the others and switches `current`; `self upgrade` is dropped (§5.3) |
| Automatic updates | On by default (`autoUpdate: "auto"`). A detached check at most once a day installs non-breaking releases and only announces breaking ones. It never moves a run (§5.4) |
| Hosted service | Out of scope. A hosted controller could be a later phase built on the same artifact |

### Current state

This records the starting point the design was written against. Items that
phase R1 changed say so.

- Every core package and the CLI is `0.0.0` (`packages/*/package.json`,
  `apps/graphloom/package.json`); the built-in executors are `0.1.0`
  (`executors/*/package.json`); plugin bundles carry their own versions, such as
  issue-fix `0.13.0` in both `examples/plugins/issue-fix/package.json` and its
  `graphloom.manifest.json`. `graphloom version` printed a hard-coded
  `graphloom 0.0.0`; since R1 it reads `release.json` or the root
  `package.json` (§2.4, `apps/graphloom/src/version.ts`). There are no tags or
  releases.
- Operators run `node apps/graphloom/dist/main.js` from a built clone
  ([example guide](../examples/README.md)).
- A task's `graph:` selects `plugins/<graph>/` beside the task file. Intake pins
  that path, the manifest bytes and digest, and the entry module digest
  (`packages/controller/src/intake.ts`). A task `config:` resolves relative to the
  task file and is pinned by digest. Resume rejects a changed bundle unless
  `--update-plugin` is used (`packages/controller/src/pin.ts`).
- The CLI serves built-in executors from its own installation. Each package's
  `entryModule` comes from `import.meta.url`
  (`executors/*/src/package.ts`). The runner digests the package root, excluding
  `node_modules` and `.git`, and refuses symlinks (`packages/runner/src/digest.ts`,
  `packages/runner/src/builtin.ts`). A run pins each executor's `digest` and its
  absolute `source` path. On resume, a changed digest **or a moved source path** is
  an `executor pin mismatch` unless `--update-executors` re-pins it
  (`packages/controller/src/executor-catalog.ts`).
- Runner config comes from `$GRAPHLOOM_RUNNER_CONFIG`, otherwise
  `~/.config/graphloom/runner.json` (`apps/graphloom/src/runner-config.ts`).
  Supervisor config comes from `$GRAPHLOOM_SUPERVISOR_CONFIG`, otherwise
  `~/.config/graphloom/supervisor.json` (`apps/graphloom/src/supervisor-config.ts`).
  Run state defaults to `<repo>/graphloom-state` (`packages/controller/src/controller.ts`).
- Run state has no format version. It evolves additively; code reads a missing
  optional field as "runs saved before it existed"
  (`packages/controller/src/state.ts`).
- Qualified plugin repair builds candidates with "GraphLoom's own `tsc`," resolved
  from the CLI installation (`apps/graphloom/src/repair-config.ts`). However,
  `typescript` was only a root `devDependency`, so a production-only install
  would break repair preflight. The CLI also ran `tsc` through its
  `#!/usr/bin/env node` shebang, which needs a `node` on `PATH`. R1 fixed
  both (§2.2, §2.7).
- `executors/coding-agent/scripts/patch-standin-shebang.mjs` rewrote the
  rehearsal stand-ins' shebang to the absolute path of the Node that built them.
  In a release built on the maintainer's machine, that path would not exist on
  the operator's machine. R1 removed it (§2.7).
- Plugin bundles import `@graphloom/sdk` at runtime through a `file:` dependency
  (`"file:../../../packages/sdk"`). The import resolves only inside the workspace
  layout. The SDK has no runtime dependencies (`packages/sdk/package.json`).
- The `run` gate caches a `ready` rehearsal by a fingerprint of bundle, task,
  runner config, environment output, and harness help text
  (`apps/graphloom/src/gate.ts`). The fingerprint does not include the GraphLoom
  version or executor digests.
- The production dependency tree includes platform-specific binaries (esbuild
  optional packages under `@earendil-works/pi-coding-agent`) and packages with
  install scripts (`protobufjs`, `@google/genai`). Its declared licenses are
  MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0, 0BSD, and Unlicense
  (from `package-lock.json`).
- The repository is private, and stays private for now (§4.2).

### The operational lesson this layout encodes

Rebuilding a checkout while a live run loads code from it mixes old and new
modules within one run. It also changes executor and bundle digests underneath
the run. The install layout makes this structurally impossible. Each version
directory is written once, made read-only, and never rebuilt. A running process
loads its code by the real path of its version directory. Upgrading changes only
which version *new* invocations start.

## 2. Release artifact

### 2.1 Assets

Each GitHub Release `v<version>` carries:

| Asset | Content |
|---|---|
| `graphloom-<version>-linux-x64.tar.gz` | The installable tree (§2.3) |
| `graphloom-sdk-<version>.tgz` | `npm pack` of `@graphloom/sdk` (§3.1) |
| `release.json` | The release manifest (§2.4), also inside the tarball |
| `install.sh` | The installer (§4.2), identical to `scripts/install.sh` at the tag |
| `SHA256SUMS` | SHA-256 of every asset above |
| `SHA256SUMS.sig` | SSH signature of `SHA256SUMS` (§2.5) |

The release notes are the version's `CHANGELOG.md` section.

### 2.2 Bundled `node_modules`, not a single-file bundle

Ship the built workspace tree with its pruned production `node_modules`. Do not
bundle it with a tool such as esbuild or ncc. Reasons:

- **Pins depend on package trees.** Executor digests cover each package root.
  The executor sandbox grants reads to the package closure it finds from
  `package.json` files (`packages/runner/src/sandbox.ts`). A single bundle file
  would change every pin's meaning and collapse the per-package read scope.
- **Repair needs real source and dependencies.** Plugin and executor repair
  snapshots a package and links the dependencies that the installed package
  resolves (`linkDependencies`, `packages/controller/src/repair.ts`). It then
  builds with `tsc` and runs the bundle's `scripts/qualify.mjs`. AGENTS.md makes
  source, build inputs, and tests a requirement of repairability.
- **Child processes need their own entry points.** The plugin host, executor
  workers, and rehearsal stand-ins are separate entry points that run in child
  processes. The pi packages use dynamic imports and native optional binaries.

**Repair toolchain.** The tarball keeps `typescript` and `vitest` as runtime
dependencies. `typescript` moves into `@graphloom/cli` `dependencies`, which makes
the `repair-config.ts` claim true. `vitest` is the test runner the bundles declare
in `runtimeProfile`. Every other `devDependency` is pruned. As implemented in
R1, both are `@graphloom/cli` `dependencies` with the ranges they had as root
`devDependencies`, and the root no longer lists them; the lockfile resolves
the same versions. `npm query .prod` shows them in the production closure.

### 2.3 Tarball layout

The tree mirrors the repository, so workspace links and the plugins' `file:` SDK
dependency resolve unchanged. Bundle manifests and digests are therefore
identical to those at the tag.

```text
graphloom-<version>-linux-x64/
  release.json
  bin/graphloom                    # sh launcher: root=$(readlink -f ...); exec $root/node/bin/node $root/apps/graphloom/dist/main.js
  node/bin/node  node/LICENSE      # pinned Node runtime (§2.7)
  install.sh  README.md  CHANGELOG.md  LICENSE  NOTICE  THIRD_PARTY_NOTICES
  package.json  package-lock.json
  node_modules/                    # production closure + typescript, vitest; workspace links are relative
  packages/{sdk,agent-harness,controller,plugin-host,supervisor,runner}/   # package.json + dist/ only
  apps/graphloom/                  # package.json + dist/ only
  executors/{coding-agent,command,github}/                   # complete source-repairable package
  examples/plugins/{hello,release,issue-fix}/   # complete source-repairable bundles
  examples/*.yaml  examples/README.md
  skills/<name>/SKILL.md           # agent skills `graphloom skills` installs (design-agent-skills.md §3)
```

A **complete source-repairable package** contains `package.json`, its lockfile if
any, tsconfigs, `src/`, `test/`, `scripts/`, `profiles/`, the manifest, and the
built `dist/`. It contains everything except `node_modules`. Keeping tests in these
packages is required, not optional: plugin manifests digest their `test/` files,
and repair must run them.

Excluded:

- `packages/testkit`
- core package sources and tests
- `legacy/`
- `docs/`, which is linked from the README at the tag
- `.github/`
- `examples/skywalking-banyandb/` and any `graphloom-state` or `graphloom/` directory
- `.env*` files and caches

Executable bits survive packing.

### 2.4 Release manifest and provenance

`release.json`:

```json
{
  "product": "graphloom",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "platform": "linux-x64",
  "git": { "tag": "v0.1.0", "commit": "<sha>", "sourceDateEpoch": 1761436800 },
  "lockfileSha256": "<sha256 of package-lock.json>",
  "node": { "version": "24.x.y", "sha256": "<sha256 of the nodejs.org tarball>" },
  "sdk": { "version": "0.1.0", "sdkProtocol": 1, "sha256": "<sha256 of graphloom-sdk-0.1.0.tgz>" },
  "stateFormat": 1,
  "executors": [{ "package": "@graphloom/executor-github", "version": "0.1.0", "digest": "<digestExecutorSource>" }],
  "plugins": [{ "graphId": "issue-fix", "version": "0.13.0", "manifestSha256": "<sha256>", "sourceTree": "<manifest digests.sourceTree>" }],
  "gate": ["npm ci --include=dev", "npm run build", "npm run typecheck", "npm test"]
}
```

`graphloom version` prints the product version and commit from this file.
`--json` prints the whole file, and `--root` prints the real path of the version
directory. In a clone with no `release.json`, it prints
`<root package.json version>-dev+<short sha>`.

As implemented in R1 (`apps/graphloom/src/version.ts`):

- The root `package.json` `version` is the product version's source of truth.
  `release.sh build` refuses a version that differs from it, and it refuses a
  core package, the SDK, or the CLI that is out of lockstep with it (§3).
- The root is three directories above `apps/graphloom/dist/version.js`, by
  real path. A release prints `graphloom <version> (<short commit>)`.
- In a clone, `--json` prints
  `{ "product": "graphloom", "version": "<v>-dev+<sha>", "git": { "commit": "<sha>" } }`.
  The commit is that of the Git work tree whose top level is the root.
  Without one, as in a tree extracted from a tarball, the version is
  `<v>-dev` and no commit is printed. A tree nested inside some other
  repository does not take that repository's commit.
- `executors`, `plugins`, and `stateFormat` are computed when the tree is
  assembled. `stateFormat` is the staged controller's
  `CURRENT_STATE_FORMAT` (R3, §5.6). `node.sha256` is the digest of the
  nodejs.org tarball from `release/node.json`.

### 2.5 Checksums, reproducibility, signing

- **Checksums.** `SHA256SUMS` covers every other asset. `install.sh` refuses a
  mismatch.
- **Reproducibility.** The tarball is built from a clean checkout of the
  commit, not from the maintainer's working tree. R1 stages it as a clone
  detached at the commit rather than `git archive <tag>` (§6, "R1 as
  implemented"). Entries are sorted, the mtime is
  `SOURCE_DATE_EPOCH`, which is the commit time, the owner is `0:0` with numeric
  IDs, and the archive is compressed with `gzip -n`. The gate and build run
  under the bundled Node, so the toolchain is pinned too. The goal is that
  rebuilding the same tag gives the same SHA-256. Phase R2 verifies this. Until
  then, the release records any difference instead of claiming reproducibility.
- **Signing (minimal viable).** The maintainer signs `SHA256SUMS` with an SSH
  key: `ssh-keygen -Y sign -n graphloom-release`. The public key is committed as
  `release/allowed_signers`, and the tag is annotated and signed. `install.sh`
  verifies the signature when `ssh-keygen` is available. Otherwise it warns and
  relies on the checksum, unless `--require-signature` is set. No PKI, Sigstore,
  or SLSA attestation is used in the first phase.

### 2.6 Platforms

The first platform is `linux-x64`. The prerequisites are Linux-only: `flock`,
bubblewrap, and Node's permission model. The production tree and the Node
runtime contain platform binaries, so each platform tarball is built on that
platform. `linux-arm64` uses the same procedure on an arm64 host when it is
needed. macOS and Windows are not supported.

### 2.7 Bundled Node runtime

The release runs without a host Node. The host still needs the tools in §4.4.

- **Pin.** `release/node.json` records the exact Node version and the SHA-256 of
  `node-v<version>-linux-x64.tar.xz`. The pinned line is the newest Node LTS
  major that the gate passes on; the first is Node 24. A Node bump is a
  reviewed commit. The person bumping it checks the digest against nodejs.org's
  `SHASUMS256.txt` and that file's signature by a Node release key.
- **Fetch.** `release.sh` downloads the tarball from
  `https://nodejs.org/dist/v<version>/` and refuses it unless it matches the
  committed digest. A verified cache under the maintainer's cache directory
  avoids repeated downloads.
- **Contents.** The release keeps `bin/node` and Node's `LICENSE` only. It drops
  npm, corepack, headers, and docs, because GraphLoom never runs them. The
  runtime adds about 120 MB unpacked and about 30 to 40 MB to the compressed
  tarball. The release script reports the total size and warns when it grows
  more than 20% over the previous release.
- **Measured size (R1, `0.0.0`).** The tarball is 94.2 MB compressed and
  348 MB unpacked:
  - Node 24.22.1 is 122 MB.
  - `node_modules` is 280 MB, of which pi's own shrinkwrapped
    `node_modules` is 102 MB.
  - GraphLoom's own packages, executors, and example bundles are under
    10 MB.
  Without the platform prune and the dedupe (§6, "R1 as implemented"), the
  same build was 215 MB compressed and 672 MB unpacked.
- **Use.** The launcher runs `node/bin/node`. GraphLoom never relies on a `node`
  on `PATH` for its own code. It spawns its own scripts as
  `process.execPath <script>`; this already happens for the plugin host,
  executor workers, and `qualify.mjs`. R1 changes the two places that use a
  shebang instead:
  - `tsc` in repair preflight runs as `process.execPath <typescript>/bin/tsc`.
  - The rehearsal stand-ins are spawned as `process.execPath <stand-in>`.
    `patch-standin-shebang.mjs` is removed, which keeps the coding-agent
    package bytes independent of the build machine.
  The launcher does not put the bundled Node on `PATH`. Command jobs use the
  target repository's own toolchain, which each graph's environment checks
  verify.
- **R1 as implemented.**
  - `release/node.json` pins Node `24.22.1`, the newest Node 24 LTS on
    2026-10-26, with `version`, `platform`, `sha256`, and a `verified` record.
    The record names the `SHASUMS256.txt` that the digest was checked
    against, and the release key whose signature on it was verified with
    `gpgv` against the `nodejs/release-keys` keyring.
  - `scripts/release/fetch-node.mjs` does the fetch. Besides the committed
    digest, it requires the release's own `SHASUMS256.txt` to list the same
    digest. It caches the tarball under
    `${XDG_CACHE_HOME:-~/.cache}/graphloom-release/node` and re-verifies the
    cached copy on every use; a mismatched copy is discarded and fetched again.
    It extracts the tarball and requires `bin/node --version` to name the pin.
    `--base-url` also takes a directory or `file://` URL, which the tests use
    with a local fixture instead of the network.
  - The stand-ins run as `process.execPath <stand-in>` through a launcher
    that the rehearsal writes into its own scratch directory, `bin/claude`
    and `bin/codex` (`writeStandInLauncher`,
    `executors/coding-agent/src/rehearsal/launcher.ts`). A launcher is
    `#!/bin/sh` followed by `exec '<process.execPath>' '<stand-in>' "$@"`,
    and it is bound as `claude.command` and `codex.command`.
  - A harness option cannot carry the Node path itself, because a graph's
    environment checks also run the bound command from a shell, as in
    `"$GRAPHLOOM_CODEX_BIN" --version`.
  - Unlike the removed patch, the launcher writes the absolute Node path on
    the running machine, at rehearsal time, and it is never shipped. The
    stand-ins are plain `tsc` output, with no executable bit and an unused
    `#!/usr/bin/env node` line.
- **Patching.** A Node security release that affects GraphLoom's use is shipped
  as a GraphLoom patch release within seven days of a high or critical
  advisory. The patch release changes only the Node pin and the changelog.
  Other Node patch releases ship with the next GraphLoom release. A new Node
  major arrives only in a GraphLoom minor release. A runtime that reaches its
  end of life is replaced before that date.

### 2.8 Licensing

- **Project license.** GraphLoom is Apache-2.0. The repository has `LICENSE` with
  the full Apache-2.0 text and a minimal `NOTICE`. Every `package.json` declares
  `"license": "Apache-2.0"`. The tarball and the SDK tarball both carry
  `LICENSE` and `NOTICE`. `release.sh` copies them into `packages/sdk` before
  `npm pack`.
- **Third-party notices.** `scripts/release/notices.mjs` generates
  `THIRD_PARTY_NOTICES` from the pruned `node_modules`. It reads each
  package's `package.json` and license file, and lists name, version, SPDX
  license, and the license text. The file ends with the bundled Node's
  `LICENSE`, which covers Node's own bundled components. The script needs no
  third-party license tool.
- **License check.** The notices step fails the release when a shipped package
  has a missing, unparseable, or disallowed license. The allowlist is
  `release/license-allowlist.json`:
  - Apache-2.0, MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0,
    Unlicense, and CC0-1.0
  - an `OR` expression is allowed when one side is allowed
  - per-package exceptions with a recorded reason
  GPL, LGPL, AGPL, SSPL, and `UNLICENSED` are never allowed. The same check
  runs on the SDK tarball, which has no dependencies today.
- **Notices and license check as implemented (R1).**
  - `notices.mjs` reads every package under `node_modules`, including nested
    `node_modules`, deduplicated by name and version. Workspace links are
    GraphLoom's own packages, which `LICENSE` and `NOTICE` cover, so they are
    skipped. `--self` also checks the package at the root, which is how the
    SDK tarball is checked.
  - The declared license is `license`, or the legacy `licenses` array, read as
    an `OR` of its entries. In an expression, `AND` needs every side allowed,
    and `X WITH <exception>` is judged as `X`.
  - "Never allowed" is enforced in the script, whatever the allowlist says. It
    matches each family by prefix, so `GPL` also covers `GPL-3.0-only`.
  - An exception is `{ "package", "version"?, "license", "reason" }`, where
    `license` is the exact declared string, or `null` when none is declared.
    Its reason is printed in the notices. An exception never admits a
    never-allowed license.
  - The license text comes from the package's `LICENSE*`, `LICENCE*`,
    `COPYING*`, or `UNLICENSE*` files. A package without such a file is not
    a failure, because its declared license is what the check judges. Its
    notice says that it has no license file.
  - The production tree of the first R1 build needs no exception: 192
    packages after the platform prune and the dedupe.
- **Source headers.** Hand-written source files carry a two-line SPDX header,
  such as `// SPDX-License-Identifier: Apache-2.0` followed by the copyright
  line from `NOTICE`, `Copyright 2026 Hongtao Gao and the GraphLoom
  contributors`. This covers `.ts`, `.mjs`, `.js`, and `.sh` files,
  including tests. Generated files (`dist/`, manifests, lockfiles), JSON,
  Markdown, and fixtures are exempt. `scripts/check-headers.mjs` enforces this
  and joins the local gate. Headers are added in their own phase (R0) before
  the first release, not in this change. Adding them changes plugin and
  executor digests, so that change follows the version rule in §3.
- **R0 as implemented.** `npm run check:headers` runs the check, and `npm test`
  runs it after the build, so the local gate and the release gate (§6 step 4)
  include it. `--fix` inserts missing headers.
  - The header is the file's first two lines, or the two lines right after a
    shebang. `.sh` files use `#`; the JavaScript and TypeScript extensions
    (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`) use `//`.
  - Exempt: `.d.ts` files, any `dist/`, `node_modules/`, or `fixtures/`
    directory, and `legacy/`, which CI does not build. JSON, Markdown, YAML,
    and lockfiles are not covered extensions.
  - In a Git work tree, the check reads `git ls-files`. In a tree without Git
    metadata, such as an extracted tarball, it walks the files.
  - Adding the headers changed every example plugin's source digests, so the
    four manifests were regenerated. It also changed every built-in executor
    digest. For the same reason as the license change below, no component
    version was bumped: no previous `release.json` exists for the §3 rule to
    compare against, and the change is comments only.
- **The license change itself.** Adding `license` changed each plugin's
  `package.json` and `package-lock.json`, so the four example plugin manifests
  were regenerated. It also changes built-in executor digests, because they
  cover `package.json`. No component version was bumped:
  - The §3 bump rule compares against the previous release's `release.json`,
    and none exists yet.
  - The change is metadata only.
  A resumed run that pinned the old bytes stops with a pin mismatch until the
  operator passes `--update-plugin` or `--update-executors`, as with any
  changed checkout.

## 3. Versioning

- **One product version.** The release uses semver `MAJOR.MINOR.PATCH`, starting
  at `0.1.0`, with the tag `v<version>`. The root `package.json`, `packages/*`
  except testkit, and `apps/graphloom` move in lockstep to that version. This
  includes `@graphloom/sdk`. Core packages are not installed or upgraded
  separately, so separate versions would add nothing.
- **Executors and plugin bundles keep their own semver.** The executor design
  calls built-ins "versioned packages included with the standard installation."
  It also allows executors and bundles to be upgraded independently within the
  protocol. Runs pin them by digest, not by version. A release check (§6)
  enforces a rule: if a component's digest changed since the previous release's
  `release.json`, its version must also have changed. A plugin's
  `package.json` version must also equal its manifest `version`, and its
  generated manifest must be current (`npm run manifest` produces no diff).
- **Breaking changes.** Before 1.0, a breaking change needs a minor release;
  after 1.0, a major release. Breaking changes include the SDK protocol
  (`sdkProtocol`), CLI flags, configuration keys, and the support window for
  state migrations (§5.2).
- **Changelog.** `CHANGELOG.md` at the root uses a Keep a Changelog style. Each
  version section has:
  - Added, Changed, and Fixed entries
  - **Upgrade notes**, covering:
    - the state format and its migrations
    - configuration changes
    - the SDK protocol
    - the Node version
    - whether executor or plugin digests changed. A digest change means runs
      started on the previous version stay on it unless moved (§5).
  - a components table of executor and plugin versions, generated from
    `release.json`.

### 3.1 The SDK as a release asset

`@graphloom/sdk` is the public interface for plugin authors (core design §12).
Each release attaches `graphloom-sdk-<version>.tgz`, packed from the staged and
gated tree. It is listed in `SHA256SUMS`, which the signature covers. It is not
published to the npm registry. The SDK's `files` lists `dist`, `LICENSE`, and
`NOTICE` (R1). npm always packs `LICENSE`, but without the `NOTICE` entry it
would drop the `NOTICE` that `release.sh` copies in.

**Compatibility contract.**

- The SDK version equals the product version that shipped it.
- A plugin built against SDK `X.Y.*` runs on any GraphLoom release with the same
  `sdkProtocol`. Intake already enforces that the protocols are equal.
- An SDK minor version may add exports. Within the same `sdkProtocol`, it does
  not remove or change exports.
- A protocol change bumps `sdkProtocol` and is a breaking product change (§3).
  The changelog then states which SDK range each release accepts.
- A plugin carries its own SDK copy in its `node_modules`, as the example
  bundles do through their `file:` link. Only the wire protocol must match the
  host.

**How authors depend on it.**

```sh
gh release download v0.1.0 -R hanahmily/graphloom -p 'graphloom-sdk-*.tgz' -p SHA256SUMS -p SHA256SUMS.sig
sha256sum -c --ignore-missing SHA256SUMS
npm i ./graphloom-sdk-0.1.0.tgz
```

This needs read access to the repository and an authenticated `gh`. If the
repository later becomes public, `npm i <release asset URL>` also works, and npm
records the same integrity hash.

npm records the tarball's integrity hash in the plugin's `package-lock.json`. The
plugin's manifest digests that lockfile, so the SDK a plugin was built against is
pinned with the plugin. Authors use their own Node and npm at authoring time;
the installed release needs neither.

## 4. Install layout and commands

### 4.1 Layout

```text
$GRAPHLOOM_HOME  (default ${XDG_DATA_HOME:-~/.local/share}/graphloom)
  versions/<version>/          # extracted tarball, read-only after install
  current -> versions/<version>
  previous                     # text file: the version current pointed to before the last switch
  runs/<runId>.json            # {version, stateDir, plugin?}: which installed version owns a run
  install.lock                 # flock held by every install, switch, and prune
  update/                      # automatic-update state (§5.4): last-check, skip, notice, last-failure, log
  .staging/                    # downloads and extractions in progress; never selectable
~/.local/bin/graphloom         # user shim (POSIX sh), stable across versions
~/.config/graphloom/           # operator config, unchanged location (runner.json, supervisor.json)
```

XDG paths are chosen to match the existing `~/.config/graphloom/` location. The
shim handles `graphloom upgrade` and `graphloom self ...` itself (§4.3), and
starts the daily update check (§5.4). Every other command runs
`exec "$GRAPHLOOM_HOME/current/bin/graphloom" "$@"`. That launcher starts the
version's bundled Node with the real path of `main.js`. As a result, a process
loads every module from `versions/<version>/` even if `current` changes while it
runs. The executor `entryModule` paths also come from `import.meta.url`, so they
point into the version directory too.

### 4.2 `install.sh`

```text
install.sh [--version <v> | --from <tarball>] [--home <dir>] [--bin-dir <dir>]
           [--require-signature] [--no-switch] [--auto]
```

Every run of the installer holds `install.lock` (`flock`) from download to
switch. `self use`, `self rollback`, and `self prune` take the same lock.
`--auto` is the unattended mode the update check uses (§5.4): it does not wait
for the lock, requires the signature, skips step 6, and writes its outcome to
`update/` instead of the terminal.

1. Download the release assets for `<v>`, defaulting to the latest release,
   with `gh release download -R hanahmily/graphloom`. This uses the operator's
   `gh` login. The repository is private, so each operator is granted read
   access individually. If `gh` is missing, not logged in, or lacks access, the
   installer stops and names which of these it is. `--from` takes a local
   tarball and its `SHA256SUMS`, for an operator who got the assets another
   way. A `curl` download from public release URLs is a later option, added
   only if the repository becomes public.
2. Verify the checksums and signature (§2.5).
3. Download into and extract to `.staging/<v>-XXXX`, and check that
   `release.json` names `<v>` and this platform. Check that
   `node/bin/node --version` matches `release.json`. Then run `chmod -R a-w` and
   rename the directory to `versions/<v>`. Only that rename makes a version
   visible, so an interrupted download or extraction is never listed or
   selectable; the next install removes stale `.staging/` entries under the
   lock. An existing `versions/<v>` is never overwritten. Reinstalling the same
   version is a no-op after checksum comparison.
4. Unless `--no-switch` is set, record `current` in `previous`. Then switch
   `current` atomically by creating a temporary symlink and renaming it over
   `current`.
5. Write the shim if it is absent or older, by writing a temporary file and
   renaming it over the old one; a running `sh` that is reading the old shim
   is never affected. Tell the operator if `--bin-dir` is not on `PATH`.
6. Run `graphloom doctor`. Its failures are reported but do not undo the
   install. Then, if stdin and stdout are terminals and no runner config
   exists, ask whether to run `graphloom setup` now (§4.5), defaulting to yes.
   With a runner config present, it prints `graphloom setup` as the way to
   review it. A non-interactive install skips setup and prints
   `graphloom setup --yes`.

The installer needs only POSIX sh, `tar`, `gzip`, `sha256sum`, `flock`, and an
authenticated `gh` (not needed with `--from`). It never writes operator
configuration or credentials itself; only `graphloom setup`, with the
operator's answers, writes configuration. It never needs root.

### 4.3 Shim commands (`graphloom upgrade`, `graphloom self`)

These commands are in sh so that upgrade and rollback still work when the
current version cannot start.

| Command | Behavior |
|---|---|
| `upgrade [<v>] [--no-switch]` | Install `<v>` (default latest) and switch `current`, then list runs owned by older versions (§5.3) |
| `self list` | Installed versions, marking `current`, `previous`, versions owned by runs, and a skipped version (§5.4) |
| `self use <v>` / `self rollback` | Switch `current` to an installed version, or to `previous`. Switching to an older version records the version left as skipped by automatic updates (§5.4) |
| `self prune [--dry-run] [--force]` | Remove versions that are not `current`, not `previous`, and not owned by any `runs/<runId>.json` whose state directory still exists; `--force` is needed to override ownership |
| `self uninstall [--purge-config]` | Remove the shim and `$GRAPHLOOM_HOME`; `--purge-config` also removes `~/.config/graphloom`. Never touches run state or worktrees under target repositories, or harness logins. Removes the agent skill copies GraphLoom installed and the user did not edit ([agent skills §3](design-agent-skills.md#3-distribution-graphloom-skills)) |

There is no `self upgrade`. No release has shipped, so no operator depends on
it, and one spelling avoids two documented paths. The shim answers
`self upgrade` by naming `graphloom upgrade` and exiting non-zero.

### 4.4 `graphloom doctor`

The doctor finds what this machine can run and says how to finish setting it
up. It prints `pass`, `warn`, or `fail` per check, with `--json` available,
and exits 1 on any `fail`. **Every `warn` and `fail` carries a `fix:` line with
the exact next command** (a `fix` field in `--json`), such as `claude` to log
in, `codex login`, `gh auth login`, or `graphloom setup`. It never prints a
secret value and never spends a model call. It does not check a host Node:
GraphLoom runs on its bundled runtime (§2.7).

**Host.**

| Check | Rule |
|---|---|
| Platform | Linux on the architecture named in `release.json` |
| git, flock | On `PATH`; version shown (`flock` is used by `packages/controller/src/lock.ts`) |
| Confinement | `bwrap` present and able to create a namespace, using the same probe as `confinementUnsupported()` in `packages/runner/src/confine.ts`; `fail` names the AppArmor `kernel.apparmor_restrict_unprivileged_userns` setting when the probe fails |
| Install integrity | The version directory is read-only; its bundled Node and its `release.json` digests match the installed executors and bundles |

**Agents.** Each harness is discovered whether or not it is configured. The
command is the configured one (`claude.command`, `codex.command`, or
`GRAPHLOOM_CLAUDE_BIN` / `GRAPHLOOM_CODEX_BIN`), otherwise the name on `PATH`.

| Agent | Discovery | Login or credential |
|---|---|---|
| Claude Code | `claude` found and executable; `--version`; the capability probe from `apps/graphloom/src/capability-probe.ts` | The CLI's own status command when its `--help` lists one (`claude auth status`); otherwise a `warn` "login not verified" with fix `claude`. GraphLoom never reads Claude Code's credential files ([supervisor harnesses §6.2](design-supervisor-harnesses.md#62-credentials)) |
| Codex | `codex` found and executable; `--version`; the capability probe | `codex login status`; fix `codex login` |
| Pi | In-process; nothing to find on `PATH` | Per provider, for every provider in Pi's registry (each one Pi ships and each custom provider in `agentDir`'s `models.json`), whether a credential is present: the provider's own variable from Pi's table (for example `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `MINIMAX_CN_API_KEY`) is set, Pi's auth store in `agentDir` has an entry for it, or its `models.json` `apiKey` resolves (a `$NAME` reference to a variable that is set). Presence only, never the value. A configured `pi.provider` and `pi.modelId` must resolve in Pi's model registry |
| GitHub CLI | `gh` on `PATH`; `gh auth status`; read access to the release repository | Fix `gh auth login`. Used by install, `upgrade`, and automatic updates |

A harness is **available** when it is found, passes its probe, and shows a
login or credential. Claude Code and Codex also need the confinement check to
pass. These are the conditions of the supervisor's `probe()`
([supervisor harnesses §7.3](design-supervisor-harnesses.md#73-precedence-and-fallback)),
so the doctor and `run` agree.

The doctor also reports each vendor's **supervisor routes**, as
[supervisor harnesses §6.2](design-supervisor-harnesses.md#62-credentials)
lists them: Claude via Claude Code (its login) or via Pi (`ANTHROPIC_API_KEY`),
OpenAI via Codex (phase S4) or via Pi (`OPENAI_API_KEY`), and every other
vendor via Pi, with what is present here.

**Configuration.**

| Check | Rule |
|---|---|
| Runner config | Found as `run` finds it and accepted by the same parser, which also refuses credentials. A missing file is a `warn` with fix `graphloom setup`. A file that does not parse, or that enables a harness that is not available, is a `fail`, because `run` would refuse it |
| Supervisor config | Optional. A missing file is a `warn` ("no automatic recovery") with fix `graphloom setup`. A present file must parse (`fail` otherwise); a listed harness that is not available is a `warn`, because selection falls back past it |
| GitHub token | If `github.tokenEnv` is configured, that variable is set (presence only) |
| Updates | The effective `autoUpdate` mode and where it came from, the last check, the skipped version, and the last failure from `update/` (§5.4). Unless the mode is `off`, the GitHub CLI row above applies. A problem here is a `warn` that names why automatic updates are a no-op, never a `fail` |

**Viable setups.** From the available harnesses, the doctor reports which
setups would work. Without a task it knows only generic harness capabilities,
which are executor facts, not plugin notions:

| Harness | Agent jobs | Supervisor and repair reviewer | Credential |
|---|---|---|---|
| Claude Code | Read and write | Yes | Its own CLI login |
| Codex | Read-only jobs only (`executors/coding-agent/src/codex-harness.ts` refuses others) | Yes | Its own CLI login |
| Pi | Read and write | Yes | A provider credential, plus `pi.provider` and `pi.modelId` |

It names the candidates for the default harness (available and able to
write), the other harnesses worth enabling, and the supervisor harness that
[supervisor harnesses §7.3](design-supervisor-harnesses.md#73-precedence-and-fallback)
resolves with no plugin preference: Pi when available, else Claude Code, else
Codex. The repair reviewer always uses the supervisor's agent
([§7.5](design-supervisor-harnesses.md#75-repair-reviewer-rule)). A Claude
Code or Codex supervisor counts only from the release that ships it (phases S3
and S4). If no available harness can write, that is a `warn` whose fix lists
each login still missing.

**Decision: the doctor learns per-graph rules only from plugin data, and only
with `--task`.** `doctor --task <task.yaml>` loads the selected plugin as
`check` does and appends three reports:

- The plugin's `environment` checks, which `graphloom check <task.yaml>`
  already runs. Graph-specific prerequisites belong there, such as a Node
  toolchain for a Node target repository or Docker for bench gates. A tool
  that a plugin bundles, such as issue-fix's `ocr`, needs no install; the
  plugin's own check confirms it.
- The supervisor selection that `run` would resolve from the plugin's
  `GraphDefinition.supervisor` and the operator's configuration, including a
  `required` refusal.
- Each agent role that the plugin declares in a new optional
  `GraphDefinition.agentRoles`, returned from code like `defaultBudgets`:

```ts
interface AgentRoleDeclaration {
  role: string;            // the plugin's own name, shown as is
  harness: string;         // the harness the resolved profile assigns
  access: "read" | "write";
  distinctFrom?: string[]; // roles whose harness this one must not share
  setting?: string;        // where the operator changes it, e.g. "harnesses.verifier"
}
```

The SDK validates the shape only, the controller never reads it, and the CLI
treats `role` and `setting` as opaque text. For each role, the doctor reports
whether its harness is enabled, available, and able to give the access. It
also lists the available harnesses that satisfy `access` and `distinctFrom`,
with the fix "set `<setting>` in `<profile>`" or the missing login. For
example, issue-fix declares its implementer, reviewer, and verifier from the
resolved profile (by default Claude Code, Codex, and Claude Code), with the
verifier distinct from the reviewer. On a host with only Claude Code, the
doctor reports that the reviewer needs Codex (`codex login`) or a profile
change. Rules beyond these fields stay in the plugin's own validation, which
`check` reports.

### 4.5 First-run setup

`graphloom setup` is guided. It runs the doctor's discovery (§4.4) and offers
only choices that work on this machine, each with a recommendation:

1. **Default harness** (`harness`): an available harness that can write.
   Recommended: Claude Code, else Pi.
2. **Enabled harnesses** (`harnesses`): the other available harnesses.
   Recommended: all of them, so that a plugin role such as a Codex reviewer
   can run.
3. **Pi model** (`pi.provider`, `pi.modelId`), when Pi is enabled: any
   provider whose credential is present, built-in or custom, or `new` to add a
   custom provider of any API type Pi speaks to the agent dir's `models.json`
   (provider id, API type, base URL, model id, and the NAME of the variable
   holding its key, which the entry references as `$NAME`; the key itself is
   never asked for or written). Recommended: the model already configured
   (for the supervisor, the supervisor's; for the runner, the runner's) when
   its provider has a credential, else the first provider with a credential
   in Pi's registry order. Its model is the configured one, else
   `MiniMax-M3` on `minimax-cn`, else Pi's own default model for the
   provider.
4. **Supervisor** (`supervisor.json`): `harnesses` lists the available
   supervisor harnesses in the built-in order `pi`, `claude-code`, `codex`. So
   Pi is recommended when available, then Claude Code, then Codex. Setup
   writes no `select` unless the operator picks one, so a plugin's preference
   still applies
   ([supervisor harnesses §7.2](design-supervisor-harnesses.md#72-operator-configuration)).
   Setup says that the repair reviewer uses the same agent, and prints each
   vendor's supervisor routes as the doctor does. The operator may
   decline a supervisor; runs then have no automatic recovery.
5. **Consent.** Setup explains `allowUnrestricted`: coding agents run shell
   commands with the operator's permissions, and confinement limits what they
   write, not everything a shell can do. It writes `"allowUnrestricted": true`
   only after the operator agrees. Declining writes nothing and exits 1.

Setup then writes `~/.config/graphloom/runner.json` (or the file that
`GRAPHLOOM_RUNNER_CONFIG` names) and `supervisor.json`. Each file is checked
by the parser `run` uses, written to a temporary file with mode `0600`, and
renamed into place. Setup prints what remains: `claude` to log in,
`codex login`, the Pi provider's own variable (for example `DEEPSEEK_API_KEY`,
or the `$NAME` a custom provider references), or
the variable that `github.tokenEnv` names (the examples use
`GRAPHLOOM_GITHUB_LIVE_TOKEN`). It never asks for a token and never writes one.
`GRAPHLOOM_REHEARSAL_GITHUB_TOKEN` is a stand-in variable that the rehearsal
sets itself, not an operator credential. If no available harness can write,
setup writes nothing, prints the doctor's fixes, and exits 1.

- **`--yes`** accepts every recommendation without prompting and counts as the
  operator's consent to `allowUnrestricted`. It is for scripts and CI.
- **Re-running** shows the current configuration next to what discovery
  recommends, and offers each change. It never overwrites silently: a file is
  replaced only after the operator confirms, and the old file is first kept as
  `<name>.bak-<UTC timestamp>`. Unchanged answers write nothing. When a file
  exists, `--yes` leaves it unchanged and prints the differences.

**Automatic first run.** `run`, `resume`, `probe`, `check`, and `rehearse`
look for the runner config first. When it is missing at the default path and
the invocation is interactive, they start the guided setup and then continue
the original command with the new configuration. Interactive means that stdin
and stdout are terminals, no argument is `--json`, and `GRAPHLOOM_RUN_ID` is
unset, which excludes `--on-stop` hooks (§5.4). If setup is declined or fails,
the command continues as it would with no configuration. A non-interactive
invocation never prompts:

- `run`, `resume`, and `probe`, which cannot work without the file, exit 1
  with `no agent runner configured: run graphloom setup (graphloom setup --yes
  in scripts), or point GRAPHLOOM_RUNNER_CONFIG at a runner config`.
- `check` and `rehearse` report the missing configuration as they do today and
  point to `graphloom setup --yes`. Offline checks and the release smoke tests
  (§6 step 8) keep working without one.

A missing file named by `GRAPHLOOM_RUNNER_CONFIG` is an error and never starts
setup.

### 4.6 Operator plugins and profiles

Bundled plugins are examples inside the version directory. An operator task
uses one by linking the **versioned real path**, never `current`:

```sh
mkdir -p plugins
ln -s "$(graphloom version --root)/examples/plugins/issue-fix" plugins/issue-fix
```

Intake pins `plugins/issue-fix` and its bytes. Node resolves the bundle's
`@graphloom/sdk` import from the link's real path inside the version directory.
Repointing the link at a later version is an explicit plugin update. A resumed run
sees a manifest mismatch until the operator passes `--update-plugin`, as it does
today.

Operator profiles live next to the task, not in the read-only bundle. For
example, `config: profiles/myrepo.json` is resolved relative to the task file.
An operator-authored bundle is an ordinary directory under `plugins/<graph>/`.
It depends on the released SDK tarball (§3.1) and is built with its author's
own toolchain.

### 4.7 R2 as implemented

- **Files.** `scripts/install.sh` is the installer and every layout
  operation; the release tree carries it at its root, and `release.sh build`
  also writes it as a release asset listed in `SHA256SUMS`.
  `scripts/shim.sh` is the shim; the tree carries it as `shim.sh`, and
  `install.sh` writes it to `--bin-dir` (default `~/.local/bin`) with the
  install home filled in. The shim carries `GRAPHLOOM_SHIM_VERSION=<n>`;
  "older" in §4.2 step 5 means a lower `n`, and an equal `n` with other
  bytes (another home) is rewritten too.
- **One implementation of the layout.** Besides installing, `install.sh`
  takes the subcommands `upgrade [<v>] [--no-switch]` and
  `self list|use|rollback|prune|uninstall`. The shim runs `upgrade` and
  `self` through the `install.sh` of `current`, falling back to that of
  `previous`, as §5.3 says for `upgrade`. So these stay in sh and work when
  the current version cannot start. Starting a version directory's
  `bin/graphloom` with `upgrade` or `self` names the shim and exits 2.
- **Ownership records.** `runs/<runId>.json` is
  `{ "version", "stateDir", "plugin"? }`, written by the CLI from R3.
  `plugin` is the run's bundle path, its link included. `self prune` reads
  the records in sh. A record counts while its `stateDir` exists, and it
  keeps both its `version` and the version directory that `plugin`
  resolves into. A plugin link that no run records is not seen, so prune
  can remove the version it points into. `--force` overrides both kinds of
  keep, but never `current` or `previous`.
- **Trust anchor.** The `allowed_signers` that verifies `SHA256SUMS.sig`
  comes with the installer that runs, never with the download: the
  `release/allowed_signers` of the version tree `install.sh` sits in (or
  of the checkout, for `scripts/install.sh`), or `--allowed-signers
  <file>`. The signing identity and namespace are both `graphloom-release`.
  Until the maintainer commits the release key (§6, "R5 as implemented"),
  nothing can be verified, so a manual install warns and relies on the
  checksum, and `--auto` and `--require-signature` refuse. A standalone
  `install.sh` downloaded from a release carries no anchor, so a first
  install names one with `--allowed-signers`.
- **Install steps.**
  - The lock is taken before the download, which goes into `.staging/`.
    Every `.staging/` entry left by an interrupted install is removed by the
    next one, under the lock.
  - Renaming a directory into another parent needs write permission on the
    directory itself on Linux. So `install.sh` makes everything in the tree
    read-only except its top directory, renames it to `versions/<v>`, and
    then removes write permission from the top.
  - The tarball's SHA-256 is recorded in `versions/<v>/.graphloom-tarball.sha256`.
    Reinstalling a version compares with it: the same bytes are a no-op
    (and still switch, unless `--no-switch`), other bytes are refused.
  - The bundled Node's version check runs that Node on `release.json`, and
    also checks `product`, `version`, and `platform`.
  - Step 6, `graphloom doctor` and the setup offer, arrived with R4 (§4.8).
- **Switching.** `current` is a relative link, `versions/<v>`, replaced with
  `mv -T` over it, which is a `rename(2)`. A switch to an older version
  writes the version left to `update/skip`. A switch to the skipped version
  or a newer one clears it.
- **Prune.** A pruned version is first renamed out of `versions/` into
  `.staging/`, then removed, so an interrupted prune never leaves a partial
  version listed.
- **`upgrade`** reads each listed run's status from its `state.json` with the
  new current's bundled Node, and prints `unknown` when it cannot.
- **Uninstall** refuses a home that holds neither `versions/` nor
  `install.lock`, and it removes the shim only when the file is a GraphLoom
  shim.
- **Tests.** `apps/graphloom/test/install.test.ts` and
  `apps/graphloom/test/auto-update.test.ts` run under `npm test`. They build
  small fake release trees from the real `install.sh`, `shim.sh`, and
  launcher, signed with a throwaway key. They install them in a temporary
  `HOME` whose `PATH` has no Node and no real `gh`, and a stub `gh` serves
  the releases from a directory. The fake tree's `node/bin/node` links to
  the Node that runs the tests, standing in for the bundled runtime.

### 4.8 R4 as implemented

- **Files.** `apps/graphloom/src/discovery.ts` finds what the machine can run,
  `doctor.ts` turns it into the report, and `setup.ts` is the guided setup.
  `main.ts` adds `doctor [--task <task.yaml>] [--json]`, `setup [--yes]`, and
  the automatic first run. The CLI now depends on `@graphloom/agent-harness`
  for Pi's model registry and auth store.
- **Discovery.**
  - Claude Code and Codex: the command is `claude.command` / `codex.command`,
    else `GRAPHLOOM_CLAUDE_BIN` / `GRAPHLOOM_CODEX_BIN`, else the name on
    `PATH`. Then `--version`, the capability probe
    (`probeHarnessCommand`, which `probeHarnessCapabilities` now uses too),
    and the login: `claude auth status --json` (only its `loggedIn` field is
    read) when `claude --help` lists an `auth` command, and `codex login
    status`. The configured `claude.configDir` and `codex.codexHome` are
    passed as `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  - **Decision: a login that cannot be verified still counts as available**,
    with a `warn` "login not verified" and the login command as its fix. §4.4
    says an available harness "shows a login". But `run` never reads the login
    either, so refusing such a harness would make `setup` refuse a working
    Claude Code whose CLI only lacks a status command.
  - Pi: `ModelRuntime` over `agentDir` (`pi.agentDir`, else
    `GRAPHLOOM_PI_AGENT_DIR`, else `~/.pi/agent`), created without a catalog
    refresh, so no network. A stored or `models.json` credential is known from
    `getProviderAuthStatus` without resolving it, so no credential command
    runs; otherwise `checkAuth` asks whether the provider's variable is set.
    Every provider in the registry is asked, so each provider Pi ships and
    each custom `models.json` provider is discovered the same way, with the
    Pi API types its models speak and Pi's own default model for it. A fix
    names the provider's own variable from Pi's table
    (`providerCredentialEnvVars`), never a fixed MiniMax one.
    The value is never printed or written. Pi is available when the runner
    config's `pi.provider` has a credential and `pi.modelId` resolves, or, with
    no Pi configured, when any provider has a credential.
  - `gh`: `gh auth status`, then `gh repo view <repo> --json name` for read
    access (`$GRAPHLOOM_RELEASE_REPO` overrides the repository, as for the
    updater). No model call is made anywhere.
  - Install integrity, in an installed version: the version directory is not
    writable, the running Node is the bundled `node/bin/node` at the version
    `release.json` pins, each `executors[]` digest equals
    `digestExecutorSource` of the installed package, and each `plugins[]`
    `manifestSha256` equals the installed manifest's. A clone has nothing
    installed and passes with that said.
  - Confinement: `confinementUnsupported()`. When `bwrap` is on `PATH` but the
    probe fails, the `fail` names `kernel.apparmor_restrict_unprivileged_userns`
    (with its value when `/proc` shows it), and the fix is the `sysctl`.
- **Report.** Rows are grouped Host, Agents, Configuration, Viable setups,
  and Task. Every `warn` and `fail` has a `fix`. The runner config row runs
  `requireRunnerConfig`, so it fails exactly when `run` would refuse, and also
  when it enables a harness that is not available. The updates row is a
  `warn` for each way automatic updates are a no-op: `off` (from the
  environment or the runner config), a clone (no shim updates it), a `gh`
  problem, a recorded `update/last-failure`, and, in `auto` mode, a release
  that can only be announced because `ssh-keygen` or the version's
  `release/allowed_signers` is missing (§5.5).
- **Supervisor harnesses (with S3 and S4).** `SHIPPED_SUPERVISOR_HARNESSES`
  (`discovery.ts`) is `["pi", "claude-code", "codex"]`; S4 added Codex.
  - A Pi supervisor counts when a provider has a credential, any provider.
  - A Claude Code supervisor counts when the doctor's CLI and login check
    passes and S3's own probe (`probeSupervisorHarness`, which also needs
    bwrap and Claude Code's login marker in its config dir) passes too.
  - A Codex supervisor counts the same way: the doctor's CLI and `codex
    login status` check, then S4's probe (bwrap, `codex exec --help` naming
    every flag the harness passes, and `codex login status`). Setup writes
    its `codex` section with the runner config's Codex command and home.
  - The viable setups list every supervisor harness that counts, in the
    built-in order Pi, Claude Code, Codex, and recommend the first.
- **`doctor --task` reports the selection `run` makes.** The doctor probes
  each harness the existing `supervisor.json` enables, then runs S3's
  `selectSupervisorHarness` on those probes: `select`, else the first enabled
  harness that is available. The flat Pi form selects Pi unprobed, as `run`
  does, and then warns when Pi is not available. `run --supervisor` is a
  per-invocation flag, so it is not reported. Since phase S5 the plugin's own
  preference (`GraphDefinition.supervisor`, its order, model hints, and
  `required`) joins through the same function: the doctor's
  `supervisorSelection` runs `resolveSupervisorSelection`, which `run`,
  `resume`, and `check` also use, on its probes
  ([supervisor harnesses §7.7](design-supervisor-harnesses.md#77-as-built-in-s5)).
  A `required` preference the operator cannot meet is a `fail`, and each
  unconfigured model hint a `warn`.
- **`GraphDefinition.agentRoles`** is in the SDK with a shape check only:
  unique non-empty `role`, non-empty `harness`, `access` read or write, and
  optional non-empty `distinctFrom[]` and `setting`; any other key is refused.
  The controller stores the definition as before and never reads the field.
  A role fails when its harness is unknown, shares a harness with a role it
  must be distinct from (in either direction), cannot give write access
  (Codex), is not available, or is not enabled by the runner config. Each row
  lists the alternatives: available harnesses with the access, distinct where
  required. The fix is "set `<setting>` to … in `<the task's config path>`",
  the harness's login, or adding the harness to `harnesses`. issue-fix 0.15.0
  declares its implementer, reviewer, and verifier.
- **`doctor --task`** loads the plugin as `check` does (`describeTask`,
  `apps/graphloom/src/rehearsal.ts`) and runs its environment checks with
  `runEnvironmentChecks`, which `check` now shares. Its other static checks
  stay in `graphloom check`.
- **Setup.**
  - **The supervisor file.** Setup enables the supervisor harnesses the
    operator keeps, in the built-in order, with no `select`, so a plugin's
    preference applies (it does since S5). Pi alone is written in the flat
    Pi form (`{ "provider", "modelId" }`), which S3's parser still reads as
    `{ harnesses: ["pi"], pi: { … } }`. Any other choice is written in the
    per-harness form, for example `{ "harnesses": ["pi", "claude-code"],
    "pi": { … }, "claude": { … } }`.
    - The `claude` section names the runner's Claude Code command when it is
      not the `PATH` default, and the runner's `claude.configDir`, so the
      supervisor uses the same login. Its models default as S3's parser
      defaults them.
    - Every file is checked with S3's `parseSupervisorConfig` before it is
      written.
    - A new Pi entry also names `agentDir` when discovery found Pi in a
      non-default agent dir. The doctor checks an existing supervisor's Pi
      model in that file's own `agentDir`, and a rerun recommends a Pi model
      only for a supervisor that reads the same dir.
    - Setup offers Pi whenever a provider has a credential, so it can repair
      a runner config whose Pi model Pi does not know.
    - With no supervisor harness available it writes no supervisor file and
      says that runs have no automatic recovery.
  - Questions are asked only for real choices: the default harness when more
    than one writer is available, each other available harness, the Pi
    provider when more than one has a credential, the Pi model (checked
    against Pi's registry), each available supervisor harness (default yes), and the consent. The Pi supervisor's
    model is the runner's Pi choice when Pi is enabled for jobs.
  - The consent defaults to no, and end of input is no. It is asked when a
    runner config is created. A rerun on a valid file keeps the consent that
    file already records.
  - A rerun prints the current values and the recommendation, offers each
    differing value (default yes), shows the new file, and replaces it only
    after a final confirmation. Only `harness`, `harnesses`, and
    `pi.provider`/`pi.modelId` are managed. Every other key of the old file is
    kept. A file that `run` would refuse is replaced only when the operator
    agrees, and `--yes` leaves it as it is. The backup is
    `<name>.bak-<YYYYMMDDTHHMMSSZ>` with mode `0600`.
  - Without a terminal, `graphloom setup` without `--yes` exits 1 and names
    `graphloom setup --yes`.
  - It prints what remains: each enabled CLI's login command, the Pi
    credential fix, a `github.tokenEnv` variable that is unset, and the
    examples' `GRAPHLOOM_GITHUB_LIVE_TOKEN`.
- **Automatic first run.** It runs after dispatch to the owning version
  (§5.6), so an owned run's version runs its own setup. `resume --rehearsal`
  and `rehearse --record-from` read no runner config and never start setup.
  The `run`/`resume`/`probe` refusal text is `NO_RUNNER_CONFIG`
  (`runner-config.ts`). `probe` now reads the runner config before its
  rehearsal, so without one it refuses at once instead of after a
  rehearsal. Non-interactive `check` and `rehearse` print one stderr line
  naming `graphloom setup --yes`, and their capability notes say the same.
- **Installer.** Step 6 runs `versions/<v>/bin/graphloom doctor` for the
  version just installed (also with `--no-switch`), after releasing
  `install.lock`. A non-zero doctor is reported and the install stays. It is
  skipped by `--auto` and by `graphloom upgrade`. The setup prompt is
  `[Y/n]`, and the runner config it looks for is `$GRAPHLOOM_RUNNER_CONFIG`,
  else `~/.config/graphloom/runner.json`.
- **Release smoke (§6 step 8.1).** `release.sh build` installs with stdin
  from `/dev/null`, so the install never prompts. It then requires `doctor
  --json` to pass platform, confinement, and install integrity.
- **Tests.**
  - `apps/graphloom/test/doctor.test.ts` covers each Claude Code and Codex
    result (missing, probe failed, logged out, login not verifiable,
    available), Pi credentials from a variable and from the auth store, a
    configured model Pi does not know, each `gh` result, confinement with no
    `bwrap` and with one that cannot create a namespace, and the
    configuration rows. A stubbed `PATH` holds no Node and no real CLIs, and
    the output must contain no stub secret.
  - `doctor-report.test.ts` covers viable setups for Claude Code only, Codex
    only, Pi only, and all three, each reason automatic updates are a no-op,
    the supervisor selection, and the role checks.
  - `doctor-task.test.ts` runs a fixture plugin's roles (an unavailable
    harness, a read-only harness on a write role, and a `distinctFrom`
    conflict, each with its alternatives) and issue-fix on a host with only
    Claude Code.
  - `doctor-installed.test.ts` covers integrity and updates in an installed
    version with the real CLI.
  - `setup.test.ts` covers the choices, the consent, `--yes`, reruns, and
    backups.
  - `first-run.test.ts` runs under a real pseudo-terminal (util-linux
    `script`): `run` with no config completes setup and then the run;
    `--json`, `GRAPHLOOM_RUN_ID`, and no terminal each refuse naming `graphloom
    setup --yes`; and `check` continues.
  - `install.test.ts` covers the installer's step 6 with and without a
    terminal.

## 5. Upgrade, rollback, and uninstall

**Rule: a run belongs to the installed version that started it, until the
operator explicitly moves it.**

### 5.1 Ownership

- **Recording ownership.** When the CLI creates a run, it writes
  `runs/<runId>.json`, using the existing `onRunCreated` hook in
  `apps/graphloom/src/main.ts`. It also records
  `install: { version, root }` and `stateFormat` in the run state, next to the
  executor catalog the run already pins.
- **Dispatch.** `resume`, `stop`, `wait`, `inspect`, `stats`, `replay`,
  `switch-model`, and `delete` on a run owned by another installed version
  re-exec that version's `bin/graphloom` and print one line saying so. This is
  how the existing rule takes effect: "resume resolves that exact committed
  version, not the newest installed package." The executor `source` paths and
  digests then match without any flag.
- **Missing owner.** If the owning version was pruned, the run-scoped commands
  refuse with `run <id> belongs to GraphLoom <v>, which is not installed`. The
  ways forward are `graphloom upgrade <v> --no-switch`, which reinstalls that
  version without changing `current`, or `resume --upgrade`.
- **Runs from a clone.** Runs created before release installs have no `install`
  record and are treated as `stateFormat` 1. Their pinned executor `source`
  paths point into the clone, so a resume from the install stops with
  `executor pin mismatch` until `--update-executors` or `--upgrade`.
- **Rehearsal cache.** The `run` gate's fingerprint gains the product version and
  the executor catalog digests. A `ready` result cached by one version is then
  not reused after an upgrade.

### 5.2 Moving a run forward: `resume --upgrade`

`graphloom resume <run> --upgrade` moves a stopped run from its owning version
to `current`. It works across minor versions within one major version, both
before 1.0 and after.

**State format.** `stateFormat` is an integer that is bumped for any
non-additive change to durable run state. Additive optional fields do not bump
it. Each release declares the format it writes and an ordered list of
migrators in `packages/controller/src/state-migrations/`:

- Each migrator moves the state from one format to the next and nothing else.
  It is a pure function over the run's durable state files, keyed by the formats
  it converts between.
- Migrators are never removed within a major version. A release can therefore
  migrate any run from any earlier release of its major.
- `--upgrade` applies the migrators in order, under the run lock. Before writing
  anything, it keeps a copy of the original files as
  `<stateDir>/migrations/<from>-<to>/`. The migration is a recorded transition,
  with the evidence record and version-history entry that executor transitions
  get.
- A migrator must not change accepted receipts, evidence content, the pinned
  step set, or requirement statements. It may only change how they are
  stored.

**Re-pinning.**

- **Executors.** `--upgrade` implies `--update-executors`. Every built-in
  executor is re-pinned to the new version's descriptor, with old and new
  digests and sources recorded in `executorTransitions`. This follows the core
  design's section
  [Moving a run onto upgraded executors](design-typescript-core.md#moving-a-run-onto-upgraded-executors).
  Accepted receipts and evidence are never rewritten. The flag's existing
  refusals apply:
  - an executor is no longer shipped
  - an executor's isolation or built-in status changed
  - an executor has an active run-local repair whose base the new bytes moved
    past
- **Plugin.** The bundle is the operator's link and is not moved. If the
  bundle's `sdkProtocol` differs from the new host's, `--upgrade` is refused
  unless it is combined with `--update-plugin`. In that case, `--update-plugin`
  must name a bundle that passes its existing describe-compatibility checks.
  While the bundle still links into the old version directory, `self prune`
  keeps that directory.
- **Install record.** The run's `install` record and `runs/<runId>.json` move to
  the new version only after migration and re-pinning succeed. A failure in any
  step leaves the run, its files, and its owner unchanged.

**Refused, with a reason naming the cause:**

- **Downgrade.** The target is older than the owner, or the run's `stateFormat`
  is newer than the target writes.
- **Crossing a major.** This includes `0.x` to `1.0`. Such a run finishes on its
  owning version.
- **Unknown future format.** The state's `stateFormat` is above every format
  the target knows.
- **A missing migrator** for any step of the path.
- **An unsettled repair.** The run has a journaled repair activation that is
  not settled, or a qualified candidate that is not activated. Its candidate
  links into the old version's `node_modules`. The operator resumes on the
  owner until it settles.
- **The run is not stopped.** A run that is still `running` cannot be moved.

**Rollback** (`self rollback`) switches `current` back. Runs created under, or
moved to, the newer version stay owned by it, and dispatch still finds that
version. Downgrading a run is never supported. Rollback also pauses automatic
updates for the version left (§5.4).

**Pruning and repair candidates.** A run-local repair candidate links
dependencies into the owning version's `node_modules`. Pruning that version
would break the run's resume, so `self prune` respects ownership and plugin
links.

**Uninstall.** See `self uninstall` (§4.3). Run state stays under each target
repository. It is removed with `graphloom delete` before uninstalling, or
manually afterward.

### 5.3 Upgrading the install: `graphloom upgrade`

`graphloom upgrade [<version>] [--no-switch]` is the one command that installs a
newer release. It is handled by the shim in sh (§4.3) and runs the `install.sh`
of `current`, falling back to that of `previous` when `current` is missing.

1. Resolve `<version>`, defaulting to the latest published release, and
   download its assets with the operator's `gh` login (§4.2). A missing,
   logged-out, or unauthorized `gh` stops the command with the reason.
2. Verify `SHA256SUMS` and its signature (§2.5). A mismatch stops the command
   before anything is extracted.
3. Install into a new `versions/<v>/` and switch `current` atomically, under
   `install.lock`, exactly as `install.sh` steps 3 and 4 do. `--no-switch`
   installs without switching; it is how an operator restores a pruned owner
   (§5.1). Naming a version older than `current` implies `--no-switch`.
4. Clear the skipped version in `update/` (§5.4).
5. List each run still owned by an older installed version, with its status,
   and print the hint `graphloom resume <run> --upgrade` (§5.2). Nothing is
   migrated.

Upgrading the install never moves a run. Live runs continue on the version
that loaded them, and every run-scoped command still dispatches to the owner
(§5.1).

### 5.4 Automatic updates

Automatic updates follow the background updater of tools such as Claude Code:
installs stay current without the operator asking, and nothing in the
foreground waits for it.

**Trigger.** On every invocation, before its `exec`, the shim checks
`update/last-check`. If the file is missing or older than 24 hours, and updates
are not disabled by the environment, the shim touches it and starts
`current/bin/graphloom __auto-update` detached: in a new session, with stdin
from `/dev/null`, and output appended to `update/log`. The shim does not wait
for it. The foreground command's output and exit code are unchanged. The worker
is a hidden command of the Node CLI, so it reads the runner config with the
same lookup and parser as `run`. It bounds the release query to 15 seconds and
the whole job to 10 minutes.

**Notice.** The worker's result for the operator is a one-line `update/notice`.
The next invocation prints it once to stderr, then deletes it, but only when
stdout and stderr are both terminals, no argument is `--json`, and
`GRAPHLOOM_RUN_ID` is unset, which is the case inside an `--on-stop` hook. A
notice never appears in machine output or a hook.

**Policy.** The worker lists published releases (no drafts or prereleases) and
compares the newest with `current`:

| Newest release | `auto` | `notify` |
|---|---|---|
| Not newer, or equal to the skipped version | Nothing | Nothing |
| Non-breaking: same major from 1.0; before 1.0, same minor | Install with `install.sh --version <v> --auto` and switch `current`; the next invocation uses it. Notice: updated, and the runs that stay on older versions | Notice: available, `graphloom upgrade` |
| Breaking: a new major, or before 1.0 a new minor | Notice only | Notice only |

Before 1.0, a minor release can break CLI flags and configuration (§3), so it
is announced rather than installed. An unattended install requires the
signature: without `ssh-keygen`, the worker announces the release instead.

**Failure.** Every failure is silent in the foreground and retried at the next
daily check. This includes no network, a `gh` problem, a held lock, and an
unreadable runner config. A failed checksum or signature check never extracts
or switches. The worker records the version, the reason, and the time in
`update/last-failure`, and `doctor` reports it.

**Configuration.** `"autoUpdate": "auto" | "notify" | "off"` in the runner
config. The default is `auto`. Precedence, highest first:

1. `GRAPHLOOM_DISABLE_AUTOUPDATE=1` in the environment: no check is started,
   which is the same as `off`.
2. `autoUpdate` in the runner config, found as `run` finds it:
   `$GRAPHLOOM_RUNNER_CONFIG`, otherwise `~/.config/graphloom/runner.json`.
3. `auto`, when there is no runner config or it has no `autoUpdate`.

`off` stops the worker before any network access. The shim cannot parse JSON,
so it still starts the worker once a day when only the config says `off`.
`parseRunnerConfig` accepts the new key from the first release that ships the
updater, so every installed version accepts a runner config that sets it.

**Concurrency.** The worker takes `install.lock` without waiting and exits if
another install holds it. Two invocations that both see a stale
`update/last-check` therefore cannot install twice. The second finds the
version already installed, which is a no-op. The switch is the atomic symlink
rename in §4.2, and only a complete, verified, read-only version directory is
ever renamed into `versions/` (§4.2 step 3).

**Long runs.** Switching `current` never affects a live controller. It loads
every module, executor, and worker from the real path of its own version
directory (§4.1). `resume`, `stop`, `wait`, `inspect`, and the other run-scoped
commands dispatch to the owning version (§5.1), including when an `--on-stop`
hook calls `graphloom` through the shim. Automatic updates never migrate run
state; only an explicit `resume --upgrade` does.

**Pruning.** After each automatic install, the worker prunes under the same
lock. It keeps the three newest installed versions, `current`, `previous`, and
every version that `self prune` would keep for run ownership or plugin links.
It never uses `--force`. A manual `graphloom upgrade` does not prune.

**Private repository.** The query and the download use the operator's `gh`
login. Without `gh`, a login, or read access, automatic updates do nothing,
and `doctor` names which of these is missing (§4.4). If the repository becomes
public, the worker can query and download from public release URLs with the
same checks.

**Rollback.** `self rollback`, and `self use` to an older version, write the
version left to `update/skip`. The worker does not reinstall or switch back to
the skipped version. A release newer than it is handled by the policy as
usual, and `graphloom upgrade` clears the skip.

### 5.5 R2 as implemented (automatic updates)

- **Worker.** `graphloom __auto-update` (`apps/graphloom/src/auto-update.ts`)
  reads the install from `$GRAPHLOOM_HOME`, which the shim sets, and
  compares with `current/release.json`, not its own tree. It queries
  `gh release list --exclude-drafts --exclude-pre-releases` and keeps
  `v<MAJOR.MINOR.PATCH>` tags. It writes `update/last-check` as a JSON record
  of the result: time, mode, current, newest, and action. The shim uses only
  the file's mtime.
- **Skip.** A release equal to or older than `update/skip` is ignored.
  `install.sh --auto` checks the skip again under the lock.
- **Lock.** The worker does not take `install.lock` itself. It runs
  `install.sh --version <v> --auto`, which takes the lock without waiting
  and exits 75 when another install holds it. That is the "held lock" of
  §5.4: it is logged, but not recorded as a failure. A second concurrent
  check therefore either finds the lock held or finds the version
  installed. Under the lock, `--auto` decides again against the `current`
  it now sees: it installs nothing that is not newer than `current`, or that
  is breaking for it, so a stale decision never moves `current` back or
  across a breaking release.
- **Signature.** The worker announces instead of installing when it cannot
  verify a signature: `ssh-keygen` is missing, or `current` carries no
  `release/allowed_signers`. Until a release that carries the committed
  release key is installed, no release is installed automatically. A release without `SHA256SUMS.sig` fails
  `install.sh --auto`, which records it.
- **Failures.** `install.sh --auto` writes its own failures to
  `update/last-failure` as `{ "version", "reason", "time" }`, and the
  worker writes its own (a `gh` problem, an unreadable runner config) in the
  same shape. A successful automatic install removes the file.
- **Notice.** The worker writes the notice. After an automatic install, the
  notice names the versions, how many runs stay on older versions, and
  `graphloom self rollback`. A detached child cannot know whether a later
  invocation has a terminal, so the shim applies the §5.4 conditions.
- **Auto-prune** is `install.sh --auto`'s prune, run under its lock. It keeps
  the three newest versions plus what `self prune` keeps.
- **Bounds.** The release query is killed after 15 seconds, the install
  after the rest of the job's 10 minutes, and the worker exits at 10
  minutes. Each child runs in its own process group, and a timeout kills
  the whole group, so a hung `gh` under `install.sh` cannot keep holding
  `install.lock`.
- **Paths.** The worker runs from `/`, so the shim makes a relative
  `GRAPHLOOM_HOME` or `GRAPHLOOM_RUNNER_CONFIG` absolute before it starts the
  worker.

### 5.6 R3 as implemented (ownership and moving runs)

- **Who the CLI is.** `selfInstall()` (`apps/graphloom/src/ownership.ts`)
  reads the tree's version (§2.4). The CLI is an **installed** version when
  its root is `<home>/versions/<v>` and `release.json` names `<v>`, a plain
  `MAJOR.MINOR.PATCH`; `<home>` is then the install home. Anything else is a
  **clone**, including an extracted tarball outside `versions/`.
- **The `install` record and `stateFormat`.** `run`, and `rehearse
  --stop-at`, pass `install: { version, root }` to the controller
  (`RunRequest.install`), which writes it into the run state with
  `stateFormat`. A clone records `<v>-dev[+<sha>]` and its checkout. The run
  state is the authority on the owner; `runs/<id>.json` is the index that sh
  reads.
- **Ownership records.** Only an installed version writes
  `runs/<runId>.json`, from `onRunCreated`, in the flat form install.sh
  reads: `{ "version", "stateDir", "plugin" }`, where `plugin` is the task's
  `plugins/<graph>` path, its link included. The write is atomic (a temporary
  file renamed over the record) and best effort: a failure is reported, the
  run continues, and the next run-scoped command on the owner rewrites a
  missing or stale record. `delete` removes the run's record. A clone writes
  none, so prune and `upgrade` never see clone runs.
- **Dispatch.** Before any other work, `resume`, `stop`, `wait`, `inspect`,
  `stats`, `replay`, `switch-model`, and `delete` read the run's `install`
  record:
  - No record (a run from before R3), or a clone's record: the command runs
    where it was invoked, and the executor pins decide (an `executor pin
    mismatch` until `--update-executors` or `--upgrade`).
  - Owned by this version at this root: it runs here. The same version
    installed elsewhere, such as another home, dispatches to the recorded
    root while that root exists, because its executor sources differ. Once
    the recorded root is gone, this installation takes the run.
  - `resume --upgrade`: it runs here, which moves the run.
  - Owned by another installed version: the CLI runs that version's
    `bin/graphloom` with the same arguments and stdio, forwards SIGINT,
    SIGTERM, and SIGHUP, exits with its status, and prints one stderr line,
    `graphloom: run <id> belongs to GraphLoom <v>; running <cmd> there
    (<bin>)`. The version is found at the recorded root, else under the
    install home: the CLI's own, else `$GRAPHLOOM_HOME`, else the default.
    So a clone also dispatches a run an installed version owns.
  - That version is not installed: `run <id> belongs to GraphLoom <v>,
    which is not installed; reinstall it with graphloom upgrade <v>
    --no-switch, or move the run here with graphloom resume <run> --upgrade`,
    exit 1.
  - The child gets `GRAPHLOOM_DISPATCHED=<v>`. A version that is dispatched a
    run it does not own refuses instead of dispatching again. An `--on-stop`
    hook that the owner runs, and that calls back through a newer `current`,
    still reaches the owner.
- **State formats.** `packages/controller/src/state-migrations/index.ts`
  declares `CURRENT_STATE_FORMAT` (1) and `STATE_FORMATS`, the registry of
  this release's migrators, which is empty. `release.json` takes its
  `stateFormat` from it (`scripts/release/assemble.mjs`).
  - A migrator is `{ from, to, files?, migrate }`. `migrate` is a pure
    function over the run's durable files, given as UTF-8 text by path
    relative to the state directory: `state.json`, plus the `files` it
    names. Migrators are found by `from`, in any order, and each step must
    exist.
  - Each format can supply a *protected view*, which reads the accepted
    receipts, evidence, stages, and requirements from its files; format 1's
    view reads them from `state.json`. After each step, the views before and
    after must hash equal, or the migration is refused. So a migrator can
    change how they are stored, never what they say.
  - A plain `resume` refuses a state in any other format, unchanged. A newer
    format names "a newer GraphLoom"; an older one names `--upgrade`.
- **`resume --upgrade`** (`packages/controller/src/upgrade.ts`), under the run
  lock, before the run's state is loaded as this release's:
  1. Refusals are decided first, in this order, and each throws
     `cannot upgrade: …` with nothing written:
     - a different major version (`0.x` to `1.0` included)
     - a downgrade: the target is older than the owner, where a
       `-dev` build orders before its release
     - an unknown future format
     - a missing migrator
     - a run that is not `stopped` (`running`, `succeeded`, or `failed`)
     - an unsettled repair: an activation journaled as `intent`, or a
       candidate that is `qualifying` or `qualified`
     - an active repair: an executor running its activated run-local copy,
       or a plugin on a `@repair-` version. This goes beyond §5.2. The copy
       links its dependencies into the owner's tree, and moving the owner
       would let `self prune` remove that tree. Such a run finishes on its
       owner
     - a plugin `sdkProtocol` other than the host's without
       `--update-plugin`
     - with `--update-plugin`, an activated plugin repair (the resume would
       refuse the update), or a bundle that fails describe-compatibility in
       a throwaway host, as the resume would check it. The installed
       bundle's own `sdkProtocol` is what the update pins
     - an executor re-pin that `--update-executors` would refuse
     - a refusal the resume itself would make, such as a supervisor binding
       with no `restoreSupervisor` (the controller has no default restore;
       the CLI passes `supervisorRestore(config)` on every resume, `--upgrade`
       included, and `resume --rehearsal` restores the rehearsal's scripted
       supervisor)
  2. The migrators run in memory. The run's `install`, `stateFormat`,
     `installHistory`, `stateMigrations`, an `upgrade` evidence record, a
     version-history entry, and the executor re-pins are applied to the
     migrated state. `--upgrade` implies `--update-executors`.
  3. The commit then follows. Each step's original files are kept under
     `<stateDir>/migrations/<from>-<to>/`, any migrated side files are
     written, and `state.json` is written last as the single commit point.
     Then `onMoved` moves `runs/<id>.json`, or removes it when a clone took
     the run.
  4. The ordinary resume follows and finds the pins current. Executors that
     the move re-pinned count as updated, so they lift a final stop as
     `--update-executors` does.
  A run already owned by this exact version and root, in the current format,
  has nothing to move. `inspect` shows `install`, `stateFormat`,
  `installHistory`, and `stateMigrations`.
- **Rehearsal hooks** for the upgrade matrix (§6 step 8.7):
  - `rehearse <task> --stop-at <stage>` takes a stage name or id. Once
    every requirement of that stage has a valid receipt, the run stops
    before the graph's next step (`RunRequest.stopAfterStage`, an operator
    stop). The scratch directory is always kept, and the ownership record is
    written.
    - It prints `{ stoppedAt, ok, runId, stateDir, status, stopReason,
      blocker, resume }` and exits 0 only when the run stopped with that
      stage complete and the next one not.
    - The scratch directory also keeps the scenario name and the harness
      options as `rehearsal.json`.
  - `resume <stateDir> --rehearsal` continues a kept rehearsal run: a
    `rehearsal-*` run under `<scratch>/state/`, beside `scenario.json`.
    - It runs on the same stand-ins and scripted supervisor. It rewrites
      the stand-in launchers for this process's Node, so a moved run runs
      the new version's Node.
    - It reads no runner config. It combines with `--upgrade`,
      `--update-plugin`, `--update-executors`, and `--reconciled`.
- **Gate fingerprint.** It adds `productVersion` (the version from
  `graphloom version`) and `executors`, the `digestExecutorSource` of each
  built-in executor package by name (`builtinExecutorDigests`,
  `apps/graphloom/src/gate.ts`). The catalog that a run pins is only known
  at intake, after the gate. The built-in packages are the code that an
  upgrade changes.
- **Fixtures.** `packages/controller/test/fixtures/state-formats/v0.0/` is
  the first fixture, in format 1. It holds a run of a two-stage fixture graph
  stopped after Write on a scripted runner (`fixture.json`, `state/`, the
  pinned `bundle/` bytes, and the changed `worktree/` files). Machine paths
  and the pinned commit are placeholders (`@@STATE_DIR@@`, `@@WORKTREE@@`,
  `@@REPO@@`, `@@TASK_DIR@@`, `@@HEAD@@`).
  - `upgrade.test.ts` rebuilds the repository and worktree for each
    fixture. It moves the run with `--upgrade`, completes it on a scripted
    runner, and checks the recorded transition and migrations.
  - `GRAPHLOOM_CAPTURE_STATE_FIXTURE=<name>` re-captures one.
  - The root `.gitignore` re-includes everything under
    `packages/controller/test/fixtures/state-formats/`. Otherwise its `dist/`,
    `artifacts/`, and `*.log` rules would leave part of a fixture in the
    capturing work tree only. A test fails when a fixture file is ignored or
    untracked, or when a manifest entry point is not committed.
  - Fixture files are exempt from the header check (`fixtures/`).
- **Tests.**
  - `packages/controller/src/upgrade.test.ts`: the ownership record in
    state, the stop-at hook, the format refusal of a plain resume, the
    move, ordered migrators with backups, a migrator that changes receipts,
    each refusal with the state directory byte for byte unchanged, and the
    fixtures.
  - `apps/graphloom/test/ownership.test.ts`: release trees carrying the
    real CLI, installed with the real install.sh, with no Node on `PATH`.
    It covers the records the CLI writes and how `self prune`, `self list`,
    and `upgrade` read them. It also covers dispatch from a new `current`
    with no pin mismatch, `resume --upgrade --rehearsal` with re-pinned
    executors, a refused downgrade, dispatch from a clone, the refusal for
    a pruned owner and its restore, and `delete` removing the record.
  - `apps/graphloom/test/gate.test.ts`: no cached `ready` across product
    versions.

## 6. Release procedure (local)

`scripts/release.sh` implements this procedure: phase R1 `build` and R5
`prepare`, `publish`, and signing (see "R1 as implemented" and "R5 as
implemented" at the end of this section). It runs on an otherwise
idle Linux x64 machine with bubblewrap working,
`gh` authenticated with push rights, and the signing key loaded. It needs no host
Node beyond what fetches the pinned runtime. All gate, build, and smoke steps run
on the pinned Node (§2.7). Each step stops the release on failure.

```text
scripts/release.sh prepare <version>   # steps 1-2, opens a release PR
scripts/release.sh build   <version>   # steps 3-8 on the merged commit, no publication
scripts/release.sh publish <version>   # steps 9-10, after the maintainer confirms
```

1. **Preconditions.** The tree is clean, on `main`, and equal to `origin/main`.
   Tag `v<version>` does not exist, and `<version>` is greater than the latest
   release.
2. **Version and changelog.** Set the lockstep versions (§3) and refresh
   `package-lock.json` with `npm install --package-lock-only`. Check the
   component bump rule against the previous `release.json`. Check that each
   plugin manifest is current and that `scripts/check-headers.mjs` passes.
   Require a `CHANGELOG.md` section with upgrade notes. If `stateFormat`
   changed, require a migrator and a fixture (step 8). Commit these changes on
   `release/v<version>` and open a PR. The PR is merged through the normal
   local-gate review.
3. **Stage and fetch.** Check out the merge commit cleanly into an empty
   staging directory (a detached clone, so the gate runs in a work tree; see
   "R1 as implemented"), and set `SOURCE_DATE_EPOCH` from the commit time. Fetch the Node
   tarball named in `release/node.json` and verify it (§2.7).
4. **Gate.** With the pinned Node first on `PATH`, run the same commands as local
   CI in the staging tree: `NODE_ENV=development npm ci --include=dev`,
   `npm run build`, `npm run typecheck`, and `npm test`. Bubblewrap is
   available, as in `.github/workflows/ci.yml`. The test suite includes the
   state-migration fixtures for every earlier release in the major version
   (§5.2).
5. **Pack the SDK.** Copy `LICENSE` and `NOTICE` into `packages/sdk`. Then run
   `npm pack -w @graphloom/sdk` to produce `graphloom-sdk-<version>.tgz`, and
   check its file list: `package.json`, `dist/`, `LICENSE`, and `NOTICE`.
6. **Assemble.** Run `npm prune --omit=dev`. Restore `typescript` and `vitest` if
   step 2 has not yet moved them into dependencies. Copy the layout in §2.3,
   including `node/`. Write `bin/graphloom` and `release.json`, computing the
   executor digests with `digestExecutorSource`. Generate and check
   `THIRD_PARTY_NOTICES` (§2.8). Run the content checks:
   - nothing excluded by §2.3 is present
   - no symlink leaves the tree
   - no `.env*` file is present
   - the tree passes a credential-pattern scan, for example GitHub token
     prefixes and `sk-` keys
   - no file contains the staging or maintainer home path, such as an
     absolute shebang
   Pack the tarball deterministically (§2.5). Report its size, write
   `SHA256SUMS`, and sign it.
7. **Reproducibility check.** Assemble a second time from the same staged tree
   and compare SHA-256. From R2, the comparison covers a second full stage and
   build.
8. **Smoke tests**, in a fresh temporary `HOME`. `PATH` holds system tools only,
   **with no Node**, except in sub-step 6.
   1. **Install.** Run `install.sh --from <tarball> --require-signature`. Then
      run `graphloom version --json`, and check that it matches `release.json`.
      Run `graphloom doctor`. Expected warnings are allowed, such as no runner
      config or no harness CLIs, but the platform, confinement, and integrity
      checks must pass.
   2. **Hello.** Copy `examples/task.yaml` into a temporary directory, link
      `plugins/hello` as in §4.6, and initialize `test-repo` as in the example
      guide.
   3. **Check.** Run `graphloom check task.yaml` and expect `ok`.
   4. **Rehearse.** Run `graphloom rehearse task.yaml --offline`. The verdict
      must not be `not-ready`. It must be `ready` when Claude Code and Codex are
      on the maintainer's `PATH`, and it is `inconclusive` without them.
      Rehearsal uses only the shipped stand-ins and makes zero provider calls.
   5. **Rollback round trip.** Install the previous release, then the new one.
      Confirm that `self list` shows both, and that `self rollback` and
      `self use` round-trip.
   6. **External plugin.** Use the pinned Node and its npm for authoring here.
      1. Copy `examples/plugins/hello` to a directory outside any checkout.
      2. Rewrite its `@graphloom/sdk` dependency to the packed SDK tarball, and
         run `npm i --offline`.
      3. Build the plugin with the installed release's
         `node_modules/typescript`.
      4. Regenerate its manifest with its own script.
      5. Link it as `plugins/hello` beside a new task.
      6. Run `graphloom check` and `graphloom rehearse --offline` with the
         installed release, under the same verdict rule as sub-step 4.
   7. **Upgrade matrix.** For the latest patch of every earlier minor in the
      current major (at minimum the previous minor), test the move to the new
      version:
      1. Install that release.
      2. Create a stopped run on it: `graphloom rehearse --keep --stop-at Write`,
         which keeps a durable run stopped after its first stage, on stand-ins.
      3. Install the new release.
      4. Check that `inspect` dispatches to the old version.
      5. Run `graphloom resume <run> --upgrade --rehearsal`, which continues on
         stand-ins under the new version, and require `succeeded`.
      6. Check that `inspect` records the migration, the executor transitions,
         and the new owner.
      7. Check that a downgrade attempt is refused.
      `--stop-at` and `resume --rehearsal` are test hooks that R3 adds.
   8. **New fixture.** When the new release writes a new `stateFormat`,
      capture a stopped run in that format with the controller's capture
      mode (`GRAPHLOOM_CAPTURE_STATE_FIXTURE=v<minor>`, §5.6) and commit it
      in the next release PR as the migration fixture
      `packages/controller/test/fixtures/state-formats/v<minor>/`. The
      fixture is a scripted-runner run, not the sub-step 7 rehearsal state,
      so the controller's tests can complete it without the CLI or its
      stand-ins.
9. **Tag.** Create a signed annotated tag `v<version>` on the merge commit and
   push it.
10. **Publish.** Run
    `gh release create v<version> --notes-file <changelog section> <assets>`.
    Then download the published assets into a temporary directory and verify
    `SHA256SUMS` and its signature again. Finally, test the primary install
    path: in a fresh temporary `HOME`, using the maintainer's `gh` login, run
    the published `install.sh --version <version>` and then
    `graphloom version`. From the second release, also install the previous
    release in a fresh `HOME`, run `graphloom upgrade`, and check that
    `graphloom version` names the new release.

A release's gate is local, like every merge gate today. Its record is the
`gate` field in `release.json` and the script's log, which is attached to the
release PR.

### R1 as implemented

`scripts/release.sh build <version> [--commit <rev>] [--out <dir>] [--keep-work]`
runs steps 3 to 8 on `<rev>`, which defaults to `HEAD`. It publishes nothing.

- **Inputs and output.**
  - `<version>` must equal the root `package.json` version at `<rev>`. Until
    `prepare` (R5) sets the first release version, that is `0.0.0`.
  - The step 1 preconditions (on `main`, tag absent, version newer) and the
    step 2 checks belong to `prepare` and are not run.
  - The helpers under `scripts/release/` run from the staged commit, not the
    working tree.
  - The assets go to `<out>`, by default `release-out/<version>/`, which Git
    ignores and which must be empty. The whole log is `<out>/build.log`. The
    work directory is removed on success, and kept on failure or with
    `--keep-work`.
  - `prepare` and `publish` exit 2 and name phase R5.
- **Assets.** R1 produces `graphloom-<v>-linux-x64.tar.gz`,
  `graphloom-sdk-<v>.tgz`, `release.json`, and an unsigned `SHA256SUMS` over
  those three. `install.sh` (R2) and `SHA256SUMS.sig` (R5) are added by their
  phases.
- **Steps 3 and 4.** The stage is a local `git clone` detached at `<rev>`,
  with no remote, and it must be clean. It holds the same tracked files that
  `git archive <rev>` would extract, because the repository has no
  `export-ignore` attributes. It is also a work tree. The gate needs one:
  tests intake the shipped example tasks, whose `repo: .` must be inside a
  Git repository, so they fail in an archive extract. Nothing from `.git`
  reaches the assembled tree. `fetch-node.mjs`
  extracts the whole pinned Node, and its `bin` goes first on `PATH`, so the
  gate's `npm` is the pinned Node's own. Every later step runs on the pinned
  Node too.
- **Step 5.** `check-pack.mjs` checks the SDK file list and its
  `package.json` name, version, and license. `notices.mjs --self` checks the
  license of the extracted package.
- **Step 6.**
  - After `npm prune --omit=dev`, the build fails unless `typescript` and
    `vitest` are still installed.
  - `assemble.mjs` copies the §2.3 layout. From `node_modules` it leaves out
    the gate's tool caches (`.vite`, `.vitest`, `.cache`). From
    source-repairable packages it leaves out `node_modules`, `.git`, run
    state, caches, `.env*`, and `*.tsbuildinfo`.
  - `prune-tree.mjs` then shrinks the copied `node_modules` without changing
    what any module loads. This happens before the links, the digests, the
    notices, and the content checks, so each of them reflects what ships.
    - **Platform prune.** It removes every installed package whose
      `package.json` `os`, `cpu`, or `libc` excludes the release target,
      `linux`/`x64`/`glibc`, by npm's rules, including `!` negations. This
      is not a fixed list. `@earendil-works/pi-coding-agent` bundles an
      `npm-shrinkwrap.json`, and `npm prune` reifies its tree with every
      platform's optional esbuild binary, 26 packages and about 288 MB. Of
      those, `@esbuild/linux-x64` stays. The top level's
      `@rollup/rollup-linux-x64-musl` is removed too.
    - **Exact dedupe.** It removes a nested copy only when Node, once the copy
      is gone, would resolve the same name to a copy higher up with
      byte-identical files. The dependency closure must also resolve to
      identical files from both places. Removals go one at a time, each
      judged against the tree as it then is.
    - The shrinkwrap pins 56 packages at versions that the top level also
      has. The dedupe removes the 44 whose closure is identical, about 35
      MB. It keeps the rest, because sharing them would change what one of
      their dependencies loads. The 27 nested copies at other versions, and
      the 54 packages only pi has, stay as the shrinkwrap pins them.
    - A smoke step (`smoke-pi.mjs`) checks the result on the bundled Node.
  - It drops links that dangle once unshipped workspaces or pruned packages
    are absent, such as `node_modules/@graphloom/testkit` and pi's
    `node_modules/.bin/esbuild`. `bin/graphloom` is
    `scripts/release/launcher.sh`.
  - pi's own `docs/`, `examples/`, and `CHANGELOG.md`, about 4 MB, are kept.
    They are package content under its license, and the saving is small.
  - `check-tree.mjs` runs the content checks. It fails on any package that
    the platform prune would remove. It forbids the work directory,
    the checkout path, and `$HOME`. It allows a shebang only through
    `/usr/bin/env` or `/bin/sh`/`bash`. The credential patterns cover GitHub
    tokens, `sk-` keys, AWS access keys, Slack tokens, and PEM private keys.
    A key ending in `EXAMPLE` is a vendor's documented placeholder, such as
    the AWS SDK's `AKIAIOSFODNN7EXAMPLE`, and passes. Binary files are
    checked for forbidden paths only. A `*.tsbuildinfo` that a dependency
    publishes inside `node_modules` passes too.
  - The tarball is packed with sorted names, `SOURCE_DATE_EPOCH` mtimes,
    numeric `0:0` owners, and `gzip -n`, so step 7 has something to compare.
    R2 still owns the claim that builds reproduce. The build prints the
    compressed and unpacked sizes. The warning on more than 20% growth needs
    a previous release, so it waits for the second release.
- **Step 7** packs the same assembled tree a second time and records whether
  the hashes match. It never fails the build. R2 compares two full builds.
- **Step 8** in R1 runs the sub-steps that need no later phase.
  - It runs on the extracted tarball, made read-only like an installed
    version, in a fresh `HOME` and `TMPDIR`. `PATH` links every host tool
    except Node and its package managers (`no-node-path.mjs`).
  - `graphloom version --json` must equal `release.json`, and
    `version --root` must be the extracted directory.
  - `smoke-pi.mjs` imports the supervisor, the Pi harness, its rehearsal
    stand-in, and `@earendil-works/pi-coding-agent` as the harness resolves
    it. It then runs an esbuild transform through pi's
    `@earendil-works/chord`, which needs the linux-x64 native binary.
  - `smoke-preflight.mjs` runs the CLI's own repair preflight on a validator
    repair of the release example plugin. It must build the candidate with the
    tree's `typescript` and pass `qualify.mjs`, and it refuses to start if
    `PATH` has a `node`.
  - Hello `check` must be `ok`, and `rehearse --offline` must not be
    `not-ready`.
  - Sub-step 1 waits for `install.sh` (R2) and `doctor` (R4; both now run,
    see "R2 as implemented" and §4.8). Sub-step 5
    waits for R2 and sub-step 6 for R5. Sub-steps 7 and 8 wait for a
    second release; R3 added their hooks (§5.6).

### R2 as implemented

- **Assets.** `install.sh` joins the assets, and `SHA256SUMS` covers it.
  Only `SHA256SUMS.sig` waits for R5.
- **Step 6, packing.** `umask 022` is set for the whole build. The tarball is
  packed with GNU tar's `--sort=name --format=gnu --mtime=@$SOURCE_DATE_EPOCH
  --owner=0 --group=0 --numeric-owner --mode=go-w` and `gzip -n -9`. The GNU
  format records no atime, ctime, or pax headers.
- **Step 7** fails the build when a second pack of the same tree differs.
  `--compare-to <dir>` names an earlier, independent build of the same
  commit: a second stage, gate, and build. The build fails unless its
  tarball, SDK tarball, `release.json`, and `install.sh` hash the same as in
  that build's `SHA256SUMS`. `publish` (R5) is to require it.
- **Step 8** installs the tarball with the built `install.sh --from` into the
  fresh `HOME`. It checks `self list` and that the version directory is
  read-only. Every later sub-step runs through the shim, with
  `GRAPHLOOM_DISABLE_AUTOUPDATE=1`, so no smoke step queries the real
  release source. Sub-step 5 still waits for a previous release.

### R5 as implemented

- **The release key.** The repository carries no key, and `release.sh`
  never creates or writes one. The maintainer creates it once and commits
  its public half through a reviewed PR to `main`:

  ```sh
  ssh-keygen -t ed25519 -C graphloom-release -f ~/.ssh/graphloom-release
  printf 'graphloom-release namespaces="graphloom-release,git" %s\n' \
    "$(cat ~/.ssh/graphloom-release.pub)" >release/allowed_signers
  ```

  The private key never enters the repository. `release.sh build` and
  `publish` take it as `--signing-key <file>`, else
  `$GRAPHLOOM_RELEASE_SIGNING_KEY`; the file may also be the `.pub` of a key
  that `ssh-agent` holds. `git` in `namespaces` lets the same key sign the
  tag, because Git verifies SSH tag signatures in the `git` namespace.
  `install.sh` verifies `SHA256SUMS.sig` only in the `graphloom-release`
  namespace. There is no placeholder file: until the key is committed,
  `build` and `publish` refuse with these instructions, and installs behave
  as §4.7 says.
- **`prepare <version> [--previous <release.json> | --first] [--no-pr]`.**
  - Step 1: on `main`, equal to `<remote>/main` (`--remote`, default
    `origin`) after a fetch. The tree is clean except `CHANGELOG.md`. Tag
    `v<version>` and branch `release/v<version>` exist neither locally nor
    on the remote, and `<version>` is greater than the newest release among
    local tags, remote tags, and published GitHub releases. `--first`
    asserts that there is none.
  - Changelog: without a `## [<version>]` section, `prepare` writes a draft
    from the PR titles and direct commits on `main` since the previous tag,
    with `TODO` markers, and stops. A section passes when it has Added,
    Changed, or Fixed entries, `### Upgrade notes` with the five labelled
    entries `**State format:**`, `**Configuration:**`, `**SDK protocol:**`,
    `**Node:**`, and `**Digests:**`, and no `TODO`. `prepare` writes the
    components table (executor and plugin versions) into the section
    between generated markers.
  - Step 2: on a new `release/v<version>` branch, `prepare.mjs bump` sets
    the lockstep versions (§3) and every workspace's dependency on a
    lockstep package, testkit's and the executors' included, and the SDK
    entry of each plugin's own lockfile. `npm install --package-lock-only`
    refreshes the root lockfile on the pinned Node. The plugin manifests are
    regenerated on a built copy of the bumped tree, because a manifest
    script may read the plugin's build, so the maintainer's checkout keeps
    its `node_modules` and `dist`. Then the header check, the changelog
    check, and the lockstep check run, and everything is committed as
    `release: v<version>`.
  - The commit is gated like `build` step 4, in a clean clone on the pinned
    Node. In that clone, regenerating the manifests must change nothing, and
    the components are computed as `release.json` will record them.
    `check-components` then applies the §3 bump rule against the previous
    release's `release.json` (`--previous`, else downloaded from the newest
    release). A changed digest needs a changed version. A newer
    `stateFormat` needs the staged controller's `migrationPath` from the
    previous format and a committed fixture in that format. A changed
    `sdkProtocol` needs a breaking release.
  - It pushes the branch and runs `gh pr create`. `--no-pr` prints both
    commands instead and keeps the work directory with the PR body.
- **`build` signing.** A signed build needs the commit's
  `release/allowed_signers` with a `graphloom-release
  namespaces="graphloom-release,…"` line. Before the gate, it signs a probe
  and verifies it against that file, so a wrong key costs nothing. It also
  requires the commit's `CHANGELOG.md` section. After step 6, the tree must
  carry the same `allowed_signers`. The section's components table must
  equal one generated from `release.json`. `SHA256SUMS` is signed with
  `ssh-keygen -Y sign -n graphloom-release` and verified. The smoke install
  runs `install.sh --from <tarball> --require-signature --allowed-signers
  <the commit's file>`, as a first install names its anchor. `--previous
  <release.json>` also applies the bump rule. `--unsigned` makes a
  development build with no signature and no changelog check, which
  `publish` refuses.
- **`build` reproducibility record.** With `--compare-to`, a build whose
  four assets hash as in the other build writes `reproduced.json` (`commit`,
  `comparedTo`, and the hashes). It is written last, after every smoke test
  passes, so it also records a complete build. It is not a release asset.
- **Step 8.6, the external plugin.** The installed `examples/plugins/hello`
  is copied to the smoke directory, outside any checkout, without `dist/`,
  beside the packed SDK tarball. Its `@graphloom/sdk` dependency becomes
  `file:../graphloom-sdk-<version>.tgz`. `npm i --offline --ignore-scripts`
  runs on the pinned Node and npm, from the npm cache the gate filled. The
  SDK must be installed as a package of the product version, not a link.
  The plugin is built with the installed release's `node/bin/node` and
  `node_modules/typescript`, and its manifest is regenerated with its own
  script. Then a new task links it as `plugins/hello`, and `check` and
  `rehearse --offline` run through the shim, with no Node on `PATH`, under
  the verdict rule of sub-step 4.
- **`publish <version> [--assets <dir>] [--dry-run]`.** The assets default
  to `release-out/<version>/`.
  - Preconditions:
    - all six assets are present, and `SHA256SUMS` lists exactly the four
      others and matches them
    - `release.json` names the product, version, tag, and platform
    - the trust anchor is `release/allowed_signers` at `release.json`'s
      commit, never the working tree's or the download's; `SHA256SUMS.sig`
      verifies against it, and the signing key signs what it verifies
    - the tarball's `release.json` equals the asset, `install.sh` equals
      `scripts/install.sh` at the commit, and the SDK tarball's digest
      equals `release.json`'s
    - `reproduced.json` records these hashes for this commit
    - the commit is on `<remote>/main` after a fetch, and its
      `CHANGELOG.md` section, with a components table matching
      `release.json`, is the release notes
    - tag `v<version>` is absent, or already at the commit, locally and on
      the remote, and `gh` has no release of that tag, draft or published
    - the bump rule holds against the newest earlier release; for a newer
      `stateFormat`, the migrators are the tarball's controller and the
      fixtures those committed at the release commit
  - Step 9: `git -c gpg.format=ssh -c user.signingKey=<key> tag -s -a`,
    verified with `git verify-tag` against the commit's `allowed_signers`,
    then pushed as `refs/tags/v<version>`. A tag already on the remote is
    fetched into a scratch repository and must verify too, and equal the
    local tag when there is one; it is then used instead of a new one.
  - Step 10: `gh release create v<version> --verify-tag --title "GraphLoom
    v<version>" --notes-file <section>` with the six assets. The release is
    downloaded again, each asset compared byte for byte, and the checksums
    and signature verified.
  - The published `install.sh --version <version> --require-signature
    --allowed-signers <the commit's file>` runs in a fresh `HOME`, with no
    Node on `PATH`, through the maintainer's `gh` (its config directory and
    `gh auth token`). `graphloom version` must print `graphloom <version>
    (<short commit>)`.
  - When an earlier release exists, that release is installed in another
    fresh `HOME` and `graphloom upgrade` must reach `<version>`.
  - **`--dry-run`** runs every precondition. It signs and verifies the tag
    in a scratch clone (a tag that an earlier attempt left at the commit is
    verified as it is) and prints the tag, verify, push, and
    `gh release create` commands instead of running them. It then rehearses
    the published install through `scripts/release/stub-gh.sh`, a local
    `gh` stand-in that serves the local assets. It tags, pushes, and creates
    nothing.
- **Helpers.** `scripts/release/prepare.mjs` holds the version bump, the
  changelog draft, check, table, and notes, the tree's components, and the
  bump rule. `stub-gh.sh` is the `gh` stand-in for `--dry-run` and the tests.
- **Tests.** `apps/graphloom/test/release-publish.test.ts` covers the
  helpers. It also runs the real `release.sh` in a fixture repository with a
  bare remote, the stub `gh`, and throwaway keys:
  - `prepare`'s refusals, the draft and its refusal, and the bumped,
    regenerated, committed, and clone-gated release commit, with the PR
    commands printed or the PR opened
  - the bump rule against a published previous release
  - `publish --dry-run`, which changes no tag, remote, or release
  - a real `publish` to the stub, which tags, verifies, uploads, re-verifies,
    and installs
  - `publish`'s refusals: another key's signature, a wrong signing key, no
    reproduction record, a tampered asset, a commit not on `main`, an
    existing release, and no committed `allowed_signers`

  The full procedure runs by hand, as recorded in the release PR. It found
  that a committed key would break the install tests: the checkout's
  `scripts/install.sh` takes the checkout's `release/allowed_signers` as
  its anchor, which the tests' throwaway key does not match. The sandbox
  (`install-env.ts`) therefore runs a copy of `install.sh` outside the
  checkout.
- **`v0.1.0`.** A rehearsal of `prepare 0.1.0 --first` in a throwaway clone
  produced a release commit with lockstep `0.1.0`, the lockfiles and
  manifests, and `CHANGELOG.md`. No executor or plugin version moved,
  because there is no previous `release.json` (§2.8). The real release
  commit is prepared on `main` once the work it should include has merged.
  Publishing then needs the maintainer's key (above), the merged release
  commit, two builds of it with `--compare-to`, and `publish 0.1.0`.

## 7. Compatibility, support, and security

**Support.**

- Only the latest release receives fixes.
- Runs from any earlier release in the same major version can be moved forward
  with `resume --upgrade` (§5.2).
- A patch release contains fixes only. It keeps `stateFormat`, `sdkProtocol`,
  configuration keys, and the Node major version.
- Runner and supervisor config keys are removed only in a breaking release
  (§3), with a clear refusal message.
- Graph plugins are compatible across releases with the same `sdkProtocol`.

**Security.**

- **Credentials never enter the artifact, the SDK tarball, or the installer.**
  The content scan in step 6 and the existing refusal of credentials in runner
  config enforce this. Logins remain with the harnesses.
- **Confinement is a prerequisite, not a dependency.** The release does not ship
  bubblewrap and does not change sysctls. `doctor` reports what is missing.
  Process separation does not replace enforced scopes. `allowUnrestricted`
  remains the operator's explicit consent, because coding agents still run shell
  commands with the operator's permissions.
- **The bundled Node is patched on a schedule.** Its version is verified against
  a committed digest and shipped under the policy in §2.7.
- **Version directories are read-only.** A repair never writes to them. The
  executor design already requires run-local copies.
- **The install is user-level only.** It needs no root and starts no service or
  listener. The daily update check is a short-lived process started by an
  invocation, not a daemon or timer.
- **Unattended updates are verified and reversible.** They install only signed,
  checksummed, non-breaking releases, never touch a live run or its state,
  and can be undone with `self rollback` or disabled (§5.4).
- **Integrity checks are minimal.** The checksum and SSH signature cover
  download integrity only. They say nothing about supply-chain provenance
  beyond the recorded commit, lockfile digest, and Node digest.

## 8. Phases, verification, and open questions

| Phase | Deliverable | Verification |
|---|---|---|
| R0 | Apache-2.0 `LICENSE`, `NOTICE`, and `license` fields (done); SPDX headers on hand-written source and `scripts/check-headers.mjs` in the gate, with the component bumps they cause (done; no bumps were needed, §2.8); this design accepted | Gate passes; header check fails on a file without a header; manifests current |
| R1 | Product version source of truth, `release.json`, and `graphloom version` from it. `typescript` and `vitest` as CLI dependencies. GraphLoom's own scripts spawned with `process.execPath`, and the stand-in shebang patch removed. Bundled Node fetch and verification. `notices.mjs` and the license allowlist. SDK packing. `scripts/release.sh build` producing all assets (done; the assets of R1's phases, §6 "R1 as implemented") | Tests for version output. Tarball content and no-absolute-path checks. A repair preflight test on a production-pruned tree with no `node` on `PATH`. A license check that fails on a planted disallowed license. Pack file-list check (done: `apps/graphloom/test/version.test.ts`, `release-build.test.ts`, and `release.sh build`'s own step 6 and 8 checks) |
| R2 | `install.sh`, the shim, `graphloom upgrade`, `self list/use/rollback/prune/uninstall`, automatic updates (`__auto-update`, `autoUpdate` in the runner config, `update/`, `install.lock`, the skip record, auto-prune), and deterministic packing. A read-only version directory also needs the repair snapshot (`snapshotRepairCandidate`, `packages/controller/src/repair.ts`) to make its copy writable, because `cp` keeps the read-only modes (done: §4.7, §5.5, §6 "R2 as implemented"; `makeTreeWritable` serves the plugin and executor snapshots) | Shell tests in a temporary `HOME` with no host Node: atomic switch, no overwrite, prune respects ownership and plugin links, an interrupted install is never listed. `upgrade` installs, switches, lists runs on older versions, and `--no-switch` keeps `current`. Updater tests against a fake release source and a stub `gh`: at most one check per 24 hours; patch (and from 1.0, minor) installed and switched; a breaking release only announced; `notify` never installs; a bad checksum or signature records the failure and does not switch; two concurrent invocations install once; `GRAPHLOOM_DISABLE_AUTOUPDATE=1` and `off` make no network call; the notice never reaches a non-TTY, `--json`, or hook invocation, and the foreground exit code is unchanged; `self rollback` keeps the skipped version from being reinstalled until a newer release or `upgrade`; auto-prune keeps three versions plus owners; a process started from the old version keeps loading from it across a switch. Two independent builds give the same hash (done: `apps/graphloom/test/install.test.ts`, `auto-update.test.ts`, `packages/controller/src/repair.test.ts`, and `release.sh build --compare-to`) |
| R3 | Run ownership (`runs/<id>.json`, `install` record, `stateFormat`), dispatch to the owning version, `resume --upgrade` with ordered migrators, the gate fingerprint including the product version, and the `rehearse --stop-at` / `resume --rehearsal` hooks (done: §5.6) | Controller and CLI tests: resume under a new `current` dispatches with no pin mismatch. `--upgrade` migrates each committed fixture and completes it on a scripted runner. Transitions are recorded. Downgrade, crossing a major, an unknown format, a missing migrator, and an unsettled repair are each refused with the run unchanged. A cached gate result is not reused across versions (done: `packages/controller/src/upgrade.test.ts`, `apps/graphloom/test/ownership.test.ts`, `gate.test.ts`) |
| R4 | `doctor` with agent discovery (Claude Code, Codex, Pi credentials, `gh`), viable-setup reporting, `fix:` commands, and the updates check; `doctor --task` with `environment`, supervisor selection, and `GraphDefinition.agentRoles` (SDK shape check; issue-fix declares its roles); guided `setup` with `--yes`, rerun, and backups; automatic first-run setup in `run`, `resume`, `probe`, `check`, and `rehearse`; the installer's setup offer (§4.2 step 6, §4.4, §4.5) (done: §4.8; Pi and Claude Code (S3) supervisors are configured, and a Codex supervisor is reported but not configured until S4) | Tests with a stubbed `PATH` and `HOME` (stub `claude`, `codex`, `gh`, `bwrap`; Pi provider variables and auth store): each discovery result for each agent (missing, probe failed, logged out, login not verifiable, available), each with its `fix:` command; each reason automatic updates are a no-op. Viable setups for Claude Code only, Codex only, Pi only, and all three, including the supervisor order Pi, Claude Code, Codex. `doctor --task` on a fixture plugin's `agentRoles`: an unavailable role harness, a read-only harness on a write role, and a `distinctFrom` conflict, each with its alternatives. Setup offers only available choices with the recommendation; refusing `allowUnrestricted` writes nothing; `--yes` writes the recommendations; a rerun shows the current config, changes only confirmed answers, and keeps a `.bak-` copy, and `--yes` leaves an existing file unchanged. Under a pseudo-terminal, `run` with no config completes setup and then the run; without one, and with `--json` or `GRAPHLOOM_RUN_ID` set, `run` exits 1 naming `graphloom setup --yes` and `check` reports and continues. The installer offers setup only on a terminal. No written file contains a stub credential value. The doctor reuses the confinement and capability probes, spends no model call, and never asks for a host Node (done: `apps/graphloom/test/doctor.test.ts`, `doctor-report.test.ts`, `doctor-task.test.ts`, `doctor-installed.test.ts`, `setup.test.ts`, `first-run.test.ts`, `install.test.ts`, and `packages/sdk/src/index.test.ts`) |
| R5 | `release.sh prepare/publish`, signing, the external-plugin smoke test, and the first release `v0.1.0` (tooling done, §6 "R5 as implemented"; preparing and publishing `v0.1.0` wait for the remaining pre-release work and the release key) | The full procedure in §6. The upgrade matrix starts with the second release, from its first fixture (done for the tooling: `apps/graphloom/test/release-publish.test.ts`, and, in a rehearsal clone, `prepare 0.1.0`, two `build 0.1.0` runs with `--compare-to`, and `publish 0.1.0 --dry-run` with a throwaway key) |

Open questions: none at present. Repository visibility is to be revisited
later. Making the repository public would add `curl` installs and
`npm i <release asset URL>` without changing the assets or checks.
