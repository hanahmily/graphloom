# Installable releases

Status: proposed design, 2026-10-26; not implemented. The repository license
(Apache-2.0: `LICENSE`, `NOTICE`, and `license` in every `package.json`) is in
place; everything else here is design. This covers how GraphLoom is packaged,
installed, upgraded, and released for an operator who runs it on their own Linux
machine. It specializes the [TypeScript core design](design-typescript-core.md)
(version transitions, §8) and the
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
| Hosted service | Out of scope. A hosted controller could be a later phase built on the same artifact |

### Current state

- Every core package and the CLI is `0.0.0` (`packages/*/package.json`,
  `apps/graphloom/package.json`); the built-in executors are `0.1.0`
  (`executors/*/package.json`); plugin bundles carry their own versions, such as
  issue-fix `0.13.0` in both `examples/plugins/issue-fix/package.json` and its
  `graphloom.manifest.json`. `graphloom version` prints a hard-coded
  `graphloom 0.0.0` (`apps/graphloom/src/main.ts`). There are no tags or releases.
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
  `typescript` is only a root `devDependency`, so a production-only install
  would break repair preflight. The CLI also runs `tsc` through its
  `#!/usr/bin/env node` shebang, which needs a `node` on `PATH`.
- `executors/coding-agent/scripts/patch-standin-shebang.mjs` rewrites the
  rehearsal stand-ins' shebang to the absolute path of the Node that built them.
  In a release built on the maintainer's machine, that path would not exist on
  the operator's machine.
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
in `runtimeProfile`. Every other `devDependency` is pruned.

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
  packages/{sdk,controller,plugin-host,supervisor,runner}/   # package.json + dist/ only
  apps/graphloom/                  # package.json + dist/ only
  executors/{coding-agent,command,github}/                   # complete source-repairable package
  examples/plugins/{hello,release,banyandb-fix,issue-fix}/   # complete source-repairable bundles
  examples/*.yaml  examples/README.md
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

### 2.5 Checksums, reproducibility, signing

- **Checksums.** `SHA256SUMS` covers every other asset. `install.sh` refuses a
  mismatch.
- **Reproducibility.** The tarball is built from `git archive <tag>`, not from
  the maintainer's working tree. Entries are sorted, the mtime is
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
- **Source headers.** Hand-written source files carry a two-line SPDX header,
  such as `// SPDX-License-Identifier: Apache-2.0` followed by the copyright
  line from `NOTICE`, `Copyright 2026 Hongtao Gao and the GraphLoom
  contributors`. This covers `.ts`, `.mjs`, `.js`, and `.sh` files,
  including tests. Generated files (`dist/`, manifests, lockfiles), JSON,
  Markdown, and fixtures are exempt. `scripts/check-headers.mjs` enforces this
  and joins the local gate. Headers are added in their own phase (R0) before
  the first release, not in this change. Adding them changes plugin and
  executor digests, so that change follows the version rule in §3.
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
published to the npm registry.

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
  runs/<runId>.json            # {version, stateDir}: which installed version owns a run
~/.local/bin/graphloom         # user shim (POSIX sh), stable across versions
~/.config/graphloom/           # operator config, unchanged location (runner.json, supervisor.json)
```

XDG paths are chosen to match the existing `~/.config/graphloom/` location. The
shim handles `graphloom self ...` itself (§4.3). Every other command runs
`exec "$GRAPHLOOM_HOME/current/bin/graphloom" "$@"`. That launcher starts the
version's bundled Node with the real path of `main.js`. As a result, a process
loads every module from `versions/<version>/` even if `current` changes while it
runs. The executor `entryModule` paths also come from `import.meta.url`, so they
point into the version directory too.

### 4.2 `install.sh`

```text
install.sh [--version <v> | --from <tarball>] [--home <dir>] [--bin-dir <dir>]
           [--require-signature] [--no-switch]
```

1. Download the release assets for `<v>`, defaulting to the latest release,
   with `gh release download -R hanahmily/graphloom`. This uses the operator's
   `gh` login. The repository is private, so each operator is granted read
   access individually. If `gh` is missing, not logged in, or lacks access, the
   installer stops and names which of these it is. `--from` takes a local
   tarball and its `SHA256SUMS`, for an operator who got the assets another
   way. A `curl` download from public release URLs is a later option, added
   only if the repository becomes public.
2. Verify the checksums and signature (§2.5).
3. Extract to `versions/.<v>.tmp-XXXX` and check that `release.json` names `<v>`
   and this platform. Check that `node/bin/node --version` matches
   `release.json`. Then run `chmod -R a-w` and rename the directory to
   `versions/<v>`. An existing `versions/<v>` is never overwritten. Reinstalling
   the same version is a no-op after checksum comparison.
4. Unless `--no-switch` is set, record `current` in `previous`. Then switch
   `current` atomically by creating a temporary symlink and renaming it over
   `current`.
5. Write the shim if it is absent or older, and tell the operator if
   `--bin-dir` is not on `PATH`.
6. Run `graphloom doctor`. Its failures are reported but do not undo the
   install.

The installer needs only POSIX sh, `tar`, `gzip`, `sha256sum`, and an
authenticated `gh` (not needed with `--from`). It never writes operator configuration or credentials, and never
needs root.

### 4.3 Shim commands (`graphloom self`)

These commands are in sh so that rollback still works when the current version
cannot start.

| Command | Behavior |
|---|---|
| `self list` | Installed versions, marking `current`, `previous`, and versions owned by runs |
| `self upgrade [<v>]` | `install.sh --version <v>` (default latest), then list runs owned by older versions (§5) |
| `self use <v>` / `self rollback` | Switch `current` to an installed version, or to `previous` |
| `self prune [--dry-run] [--force]` | Remove versions that are not `current`, not `previous`, and not owned by any `runs/<runId>.json` whose state directory still exists; `--force` is needed to override ownership |
| `self uninstall [--purge-config]` | Remove the shim and `$GRAPHLOOM_HOME`; `--purge-config` also removes `~/.config/graphloom`. Never touches run state or worktrees under target repositories, or harness logins |

### 4.4 `graphloom doctor`

The doctor checks the host core only and prints `pass`, `warn`, or `fail` per
check, with `--json` available. It exits 1 on any `fail`. It does not print
secret values. It does not check a host Node: GraphLoom runs on its bundled
runtime (§2.7).

| Check | Rule |
|---|---|
| Platform | Linux on the architecture named in `release.json` |
| git, flock | On `PATH`; version shown (`flock` is used by `packages/controller/src/lock.ts`) |
| Confinement | `bwrap` present and able to create a namespace, using the same probe as `confinementUnsupported()` in `packages/runner/src/confine.ts`; `fail` names the AppArmor `kernel.apparmor_restrict_unprivileged_userns` setting when the probe fails |
| Install integrity | The version directory is read-only; its bundled Node and its `release.json` digests match the installed executors and bundles |
| Runner config | Found at the documented location and accepted by the same parser `run` uses, which also refuses credentials. A missing file is a `fail` with a pointer to `graphloom setup` |
| Harnesses | For each enabled harness: Claude Code or Codex on `PATH` (or at its configured command) with the capability probe from `apps/graphloom/src/capability-probe.ts`; Codex `login status`; Pi model resolvable and `agentDir` present. Login state that cannot be checked without spending a call is a `warn` |
| Supervisor config | Optional; if present, it parses and each model's provider has a credential source (presence only) |
| GitHub | If `github.tokenEnv` is configured, that variable is set (presence only) |

Graph-specific prerequisites are not built into the doctor. These include a Node
toolchain for a Node target repository, Docker for bench gates, the Go toolchain
for BanyanDB profiles, and `ocr`. They are each profile's `environment`
declarations, and `graphloom check <task.yaml>` already runs them.
`doctor --task <task.yaml>` appends that check. This keeps plugin notions out of
the CLI.

### 4.5 First-run setup

`graphloom setup` writes `~/.config/graphloom/runner.json` only if it is absent.
It uses the README's Claude Code template,
`{ "harness": "claude-code", "allowUnrestricted": true }`, explains what
`allowUnrestricted` means, and prints credential guidance:

- Claude Code and Codex use their own logins (`claude`, `codex login`).
- Pi uses its agent directory or the provider variable (for example
  `MINIMAX_CN_API_KEY`).
- GitHub reads use the variable that `github.tokenEnv` names. The examples use
  `GRAPHLOOM_GITHUB_LIVE_TOKEN`.

`GRAPHLOOM_REHEARSAL_GITHUB_TOKEN` is a rehearsal stand-in variable that the
rehearsal sets itself, not an operator credential. Setup never asks for a token
or writes one.

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
  ways forward are `self upgrade <v>`, which reinstalls that version, or
  `resume --upgrade`.
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
version. Downgrading a run is never supported.

**Pruning and repair candidates.** A run-local repair candidate links
dependencies into the owning version's `node_modules`. Pruning that version
would break the run's resume, so `self prune` respects ownership and plugin
links.

**Uninstall.** See `self uninstall` (§4.3). Run state stays under each target
repository. It is removed with `graphloom delete` before uninstalling, or
manually afterward.

## 6. Release procedure (local)

`scripts/release.sh` is a script specification. It is not implemented by this
change. It runs on an otherwise idle Linux x64 machine with bubblewrap working,
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
3. **Stage and fetch.** Run `git archive <merge commit>` into an empty staging
   directory, and set `SOURCE_DATE_EPOCH` from the commit time. Fetch the Node
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
   8. **New fixture.** Copy the stopped run state that the new release produced
      in its own sub-step 7 run. Commit it in the next release PR as the
      migration fixture
      `packages/controller/test/fixtures/state-formats/v<minor>/`.
9. **Tag.** Create a signed annotated tag `v<version>` on the merge commit and
   push it.
10. **Publish.** Run
    `gh release create v<version> --notes-file <changelog section> <assets>`.
    Then download the published assets into a temporary directory and verify
    `SHA256SUMS` and its signature again. Finally, test the primary install
    path: in a fresh temporary `HOME`, using the maintainer's `gh` login, run
    the published `install.sh --version <version>` and then
    `graphloom version`.

A release's gate is local, like every merge gate today. Its record is the
`gate` field in `release.json` and the script's log, which is attached to the
release PR.

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
  listener.
- **Integrity checks are minimal.** The checksum and SSH signature cover
  download integrity only. They say nothing about supply-chain provenance
  beyond the recorded commit, lockfile digest, and Node digest.

## 8. Phases, verification, and open questions

| Phase | Deliverable | Verification |
|---|---|---|
| R0 | Apache-2.0 `LICENSE`, `NOTICE`, and `license` fields (done in this change); SPDX headers on hand-written source and `scripts/check-headers.mjs` in the gate, with the component bumps they cause; this design accepted | Gate passes; header check fails on a file without a header; manifests current |
| R1 | Product version source of truth, `release.json`, and `graphloom version` from it. `typescript` and `vitest` as CLI dependencies. GraphLoom's own scripts spawned with `process.execPath`, and the stand-in shebang patch removed. Bundled Node fetch and verification. `notices.mjs` and the license allowlist. SDK packing. `scripts/release.sh build` producing all assets | Tests for version output. Tarball content and no-absolute-path checks. A repair preflight test on a production-pruned tree with no `node` on `PATH`. A license check that fails on a planted disallowed license. Pack file-list check |
| R2 | `install.sh`, the shim, `self list/use/rollback/prune/uninstall`, and deterministic packing | Shell tests in a temporary `HOME` with no host Node: atomic switch, no overwrite, prune respects ownership and plugin links. Two independent builds give the same hash |
| R3 | Run ownership (`runs/<id>.json`, `install` record, `stateFormat`), dispatch to the owning version, `resume --upgrade` with ordered migrators, the gate fingerprint including the product version, and the `rehearse --stop-at` / `resume --rehearsal` hooks | Controller and CLI tests: resume under a new `current` dispatches with no pin mismatch. `--upgrade` migrates each committed fixture and completes it on a scripted runner. Transitions are recorded. Downgrade, crossing a major, an unknown format, a missing migrator, and an unsettled repair are each refused with the run unchanged. A cached gate result is not reused across versions |
| R4 | `doctor`, `setup` | Tests with a stubbed `PATH` and `HOME` for each check result. The doctor reuses the confinement and capability probes and never asks for a host Node |
| R5 | `release.sh prepare/publish`, signing, the external-plugin smoke test, and the first release `v0.1.0` | The full procedure in §6. The upgrade matrix starts with the second release, from its first fixture |

Open questions: none at present. Repository visibility is to be revisited
later. Making the repository public would add `curl` installs and
`npm i <release asset URL>` without changing the assets or checks.
