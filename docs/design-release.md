# Installable releases

Status: proposed design, 2026-10-26; not implemented. This covers how GraphLoom
is packaged, installed, upgraded, and released for an operator who runs it on
their own Linux machine. It specializes the
[TypeScript core design](design-typescript-core.md) (version transitions, §8) and
the [executor design](design-executors.md#restart-versions-and-recovery). It adds
no graph, controller, or executor behavior beyond what installs need.

## 1. Scope and decisions

A **release** is an installable product: the CLI, the core packages, the built-in
executors, the example plugin bundles (including issue-fix with its profiles),
an install script, prerequisite checks, and an upgrade and rollback path. Another
user installs it and runs graphs on their own machine with their own harness
logins.

| Decision | Choice |
|---|---|
| Channel | A tarball attached to a GitHub Release of `hanahmily/graphloom`. No npm publishing |
| Builder | A maintainer's machine. GitHub Actions is intentionally not used; the local CI gate plus release checks (§6) is the release gate |
| Artifact form | A pruned, built workspace tree with production `node_modules`, not a single-file bundle (§2.2) |
| Platform | `linux-x64` first |
| Version | One product version for the release; executors and plugin bundles keep their own versions, recorded in the release manifest (§3) |
| Install layout | Immutable version directories plus a `current` symlink; a run stays on the version it started with (§4, §5) |
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
- Qualified plugin repair builds candidates with "GraphLoom's own `tsc`," resolved
  from the CLI installation (`apps/graphloom/src/repair-config.ts`). However,
  `typescript` is only a root `devDependency`. A production-only install would
  therefore break repair preflight. The release must fix this (§2.2).
- Plugin bundles import `@graphloom/sdk` at runtime through a `file:` dependency
  (`"file:../../../packages/sdk"`). The import resolves only inside the workspace
  layout.
- The `run` gate caches a `ready` rehearsal by a fingerprint of bundle, task,
  runner config, environment output, and harness help text
  (`apps/graphloom/src/gate.ts`). The fingerprint does not include the GraphLoom
  version or executor digests.
- The production dependency tree includes platform-specific binaries (esbuild
  optional packages under `@earendil-works/pi-coding-agent`) and packages with
  install scripts (`protobufjs`, `@google/genai`). The tree is
  platform-specific.
- The repository is private and has no license file.

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
| `release.json` | The release manifest (§2.4), also inside the tarball |
| `install.sh` | The installer (§4.2), identical to `scripts/install.sh` at the tag |
| `SHA256SUMS` | SHA-256 of the three files above |
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

Node.js itself is not bundled. The operator provides it, and `doctor` checks it
(§4.4).

### 2.3 Tarball layout

The tree mirrors the repository, so workspace links and the plugins' `file:` SDK
dependency resolve unchanged. Bundle manifests and digests are therefore
identical to those at the tag.

```text
graphloom-<version>-linux-x64/
  release.json
  bin/graphloom                    # sh launcher: root=$(readlink -f ...); exec node $root/apps/graphloom/dist/main.js
  install.sh  README.md  CHANGELOG.md  LICENSE
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

Executable bits survive packing, including the coding-agent stand-ins that
`patch-standin-shebang.mjs` prepares.

### 2.4 Release manifest and provenance

`release.json`:

```json
{
  "product": "graphloom",
  "version": "0.1.0",
  "platform": "linux-x64",
  "git": { "tag": "v0.1.0", "commit": "<sha>", "sourceDateEpoch": 1761436800 },
  "lockfileSha256": "<sha256 of package-lock.json>",
  "node": { "required": ">=22.19.0", "builtWith": "v22.x.y", "npm": "10.x" },
  "sdkProtocol": 1,
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
  IDs, and the archive is compressed with `gzip -n`. The goal is that rebuilding
  the same tag with the same Node and npm major versions gives the same SHA-256.
  Phase 2 verifies this. Until then, the release records any difference instead
  of claiming reproducibility.
- **Signing (minimal viable).** The maintainer signs `SHA256SUMS` with an SSH
  key: `ssh-keygen -Y sign -n graphloom-release`. The public key is committed as
  `release/allowed_signers`, and the tag is annotated and signed. `install.sh`
  verifies the signature when `ssh-keygen` is available. Otherwise it warns and
  relies on the checksum, unless `--require-signature` is set. No PKI, Sigstore,
  or SLSA attestation is used in the first phase.

### 2.6 Platforms

The first platform is `linux-x64`. The prerequisites are Linux-only: `flock`,
bubblewrap, and Node's permission model. The production tree also contains
platform binaries, so each platform tarball is built on that platform.
`linux-arm64` uses the same procedure on an arm64 host when it is needed.
macOS and Windows are not supported.

## 3. Versioning

- **One product version.** The release uses semver `0.MINOR.PATCH` with the tag
  `v<version>`. The root `package.json`, `packages/*` except testkit, and
  `apps/graphloom` move in lockstep to that version. Core packages are not
  installed or upgraded separately, so separate versions would add nothing.
- **Executors and plugin bundles keep their own semver.** The executor design
  calls built-ins "versioned packages included with the standard installation."
  It also allows executors and bundles to be upgraded independently within the
  protocol. Runs pin them by digest, not by version. A release check (§6)
  enforces a rule: if a component's digest changed since the previous release's
  `release.json`, its version must also have changed. A plugin's
  `package.json` version must also equal its manifest `version`, and its
  generated manifest must be current (`npm run manifest` produces no diff).
- **Compatibility.** A plugin is compatible with a release when its manifest
  `sdkProtocol` equals the host's, which intake already enforces. An SDK protocol
  bump is a breaking product change and requires a minor release before 1.0.
- **Changelog.** `CHANGELOG.md` at the root uses a Keep a Changelog style. Each
  version section has:
  - Added, Changed, and Fixed entries
  - **Upgrade notes**, covering state format, configuration changes, and whether
    executor or plugin digests changed. A digest change means runs started on
    the previous version stay on it (§5).
  - a components table of executor and plugin versions, generated from
    `release.json`.

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
`exec "$GRAPHLOOM_HOME/current/bin/graphloom" "$@"`. Node resolves the main module
to its real path, so a process loads every module from `versions/<version>/` even
if `current` changes while it runs. The executor `entryModule` paths also come
from `import.meta.url`, so they point into the version directory too.

### 4.2 `install.sh`

```text
install.sh [--version <v> | --from <tarball>] [--home <dir>] [--bin-dir <dir>]
           [--require-signature] [--no-switch]
```

1. Download the release assets for `<v>`, defaulting to the latest release. Use
   `gh release download` because the repository is private today. Use `curl`
   on the public release URL only if the repository becomes public. `--from`
   takes a local tarball and its `SHA256SUMS`.
2. Verify the checksums and signature (§2.5).
3. Extract to `versions/.<v>.tmp-XXXX`, check that `release.json` names `<v>` and
   this platform, run `chmod -R a-w`, and rename the directory to `versions/<v>`.
   An existing `versions/<v>` is never overwritten. Reinstalling the same version
   is a no-op after checksum comparison.
4. Unless `--no-switch` is set, record `current` in `previous`. Then switch
   `current` atomically by creating a temporary symlink and renaming it over
   `current`.
5. Write the shim if it is absent or older, and tell the operator if
   `--bin-dir` is not on `PATH`.
6. Run `graphloom doctor`. Its failures are reported but do not undo the
   install.

The installer never writes operator configuration or credentials, and never needs
root.

### 4.3 Shim commands (`graphloom self`)

These commands are in sh so that rollback still works when the current version's
Node code cannot start.

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
secret values.

| Check | Rule |
|---|---|
| Platform | Linux on the architecture named in `release.json` |
| Node | `>=22.19.0` (the supervisor's engine; the executor sandbox needs `>=22.13`) |
| git, flock | On `PATH`; version shown (`flock` is used by `packages/controller/src/lock.ts`) |
| Confinement | `bwrap` present and able to create a namespace, using the same probe as `confinementUnsupported()` in `packages/runner/src/confine.ts`; `fail` names the AppArmor `kernel.apparmor_restrict_unprivileged_userns` setting when the probe fails |
| Install integrity | The version directory is read-only and its `release.json` digests match the installed executors and bundles |
| Runner config | Found at the documented location and accepted by the same parser `run` uses, which also refuses credentials. A missing file is a `fail` with a pointer to `graphloom setup` |
| Harnesses | For each enabled harness: Claude Code or Codex on `PATH` (or at its configured command) with the capability probe from `apps/graphloom/src/capability-probe.ts`; Codex `login status`; Pi model resolvable and `agentDir` present. Login state that cannot be checked without spending a call is a `warn` |
| Supervisor config | Optional; if present, it parses and each model's provider has a credential source (presence only) |
| GitHub | If `github.tokenEnv` is configured, that variable is set (presence only) |

Graph-specific prerequisites are not built into the doctor. These include Docker
for bench gates, the Go toolchain for BanyanDB profiles, and `ocr`. They are each
profile's `environment` declarations, and `graphloom check <task.yaml>` already
runs them. `doctor --task <task.yaml>` appends that check. This keeps plugin
notions out of the CLI.

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
An operator-authored or modified bundle is the operator's own source tree. How
such a bundle resolves `@graphloom/sdk` outside the workspace is an open
question (§8).

## 5. Upgrade, rollback, and uninstall

**Rule: a run belongs to the installed version that started it, until the
operator explicitly moves it.**

- **Recording ownership.** When the CLI creates a run, it writes
  `runs/<runId>.json`, using the existing `onRunCreated` hook in
  `apps/graphloom/src/main.ts`. It also records `install: { version, root }` in
  the run state, next to the executor catalog the run already pins.
- **Dispatch.** `resume`, `stop`, `wait`, `inspect`, `stats`, `replay`,
  `switch-model`, and `delete` on a run owned by another installed version
  re-exec that version's `bin/graphloom` and print one line saying so. This is
  how the existing rule takes effect: "resume resolves that exact committed
  version, not the newest installed package." The executor `source` paths and
  digests then match without any flag.
- **Explicit move.** `graphloom resume <run> --upgrade` runs the run on `current`.
  It implies `--update-executors`, which records old and new digests and
  sources in `executorTransitions`. The run's `install` record is also updated
  as a recorded transition. The plugin bundle is not touched, because it is the
  operator's link. `--update-plugin` remains a separate decision. Accepted
  receipts are never rewritten, as specified in the core design's section
  [Moving a run onto upgraded executors](design-typescript-core.md#moving-a-run-onto-upgraded-executors).
- **Missing owner.** If the owning version was pruned, the run-scoped commands
  refuse with `run <id> belongs to GraphLoom <v>, which is not installed`. The
  ways forward are `self upgrade <v>`, which reinstalls that version, or
  `resume --upgrade`.
- **Runs from a clone.** Runs created before release installs have no `install`
  record. They behave as they do today. Their pinned executor `source` paths
  point into the clone, so a resume from the install stops with
  `executor pin mismatch` until `--update-executors`.
- **State format.** Run state already evolves additively, and code reads missing
  optional fields as "runs saved before it existed." The release adds a
  `stateFormat` integer to new runs, starting at 1. It is bumped only for a
  non-additive change. A CLI refuses to resume, or otherwise write, a run whose
  `stateFormat` is newer than its own. A CLI may read older formats it lists in
  its supported set. Before 1.0 there is no migration tool. A run that the new
  format cannot carry finishes on its owning version, which pinning makes
  possible. The changelog's upgrade notes say whether `--upgrade` is supported
  from the previous minor.
- **Rehearsal cache.** The `run` gate's fingerprint gains the product version and
  the executor catalog digests. A `ready` result cached by one version is then
  not reused after an upgrade.
- **Rollback.** `self rollback` switches `current` back. Runs created, or moved
  with `--upgrade`, under the newer version stay owned by it, and dispatch still
  finds that version. Downgrading a run is not supported: the `stateFormat`
  check and owner records prevent it.
- **Pruning and repair candidates.** A run-local repair candidate links
  dependencies into the owning version's `node_modules`. Pruning that version
  would break the run's resume, so `self prune` respects ownership.
- **Uninstall.** See `self uninstall` (§4.3). Run state stays under each target
  repository. It is removed with `graphloom delete` before uninstalling, or
  manually afterward.

## 6. Release procedure (local)

`scripts/release.sh` is a script specification. It is not implemented by this
change. It runs on an otherwise idle Linux x64 machine with bubblewrap working,
Node 22, `gh` authenticated with push rights, and the signing key loaded. Each
step stops the release on failure.

```text
scripts/release.sh prepare <version>   # steps 1-2, opens a release PR
scripts/release.sh build   <version>   # steps 3-7 on the merged commit, no publication
scripts/release.sh publish <version>   # steps 8-9, after the maintainer confirms
```

1. **Preconditions.** The tree is clean, on `main`, and equal to `origin/main`.
   Tag `v<version>` does not exist, and `<version>` is greater than the latest
   release.
2. **Version and changelog.** Set the lockstep versions (§3) and refresh
   `package-lock.json` with `npm install --package-lock-only`. Check the
   component bump rule against the previous `release.json`. Check that each
   plugin manifest is current. Require a `CHANGELOG.md` section with upgrade
   notes. Commit these changes on `release/v<version>` and open a PR. The PR is
   merged through the normal local-gate review.
3. **Stage.** Run `git archive <merge commit>` into an empty staging directory.
   Set `SOURCE_DATE_EPOCH` from the commit time.
4. **Gate.** In the staging tree, run the same commands as local CI:
   `NODE_ENV=development npm ci --include=dev`, `npm run build`,
   `npm run typecheck`, and `npm test`. Bubblewrap is available, as in
   `.github/workflows/ci.yml`.
5. **Assemble.** Run `npm prune --omit=dev`. Restore `typescript` and `vitest` if
   step 2 has not yet moved them into dependencies. Copy the layout in §2.3 and
   write `bin/graphloom` and `release.json`, computing the executor digests with
   `digestExecutorSource`. Run the content checks:
   - nothing excluded by §2.3 is present
   - no symlink leaves the tree
   - no `.env*` file is present
   - the tree passes a credential-pattern scan, for example GitHub token
     prefixes and `sk-` keys
   Pack the tarball deterministically (§2.5). Write `SHA256SUMS` and sign it.
6. **Reproducibility check.** Assemble a second time from the same staged tree
   and compare SHA-256. Phase 2 makes the comparison cover a second full stage
   and build.
7. **Smoke install.** Use a fresh temporary `HOME`, and `PATH` limited to system
   tools and Node. Then:
   1. Run `install.sh --from <tarball> --require-signature`.
   2. Run `graphloom version --json`, and check that it matches `release.json`.
   3. Run `graphloom doctor`. Expected warnings are allowed, such as no runner
      config or no harness CLIs, but the platform, Node, confinement, and
      integrity checks must pass.
   4. Copy `examples/task.yaml` into a temporary directory, link `plugins/hello`
      as in §4.6, and initialize `test-repo` as in the example guide.
   5. Run `graphloom check task.yaml` and expect `ok`.
   6. Run `graphloom rehearse task.yaml --offline`. The verdict must not be
      `not-ready`. It must be `ready` when Claude Code and Codex are on the
      maintainer's `PATH`, and it is `inconclusive` without them. Rehearsal
      uses only the shipped stand-ins and makes zero provider calls.
   7. Test the upgrade path. Install the previous release, start a rehearsal run
      under it, install the new release, and confirm that `self list` shows the
      owner, that `inspect` dispatches to the old version, and that
      `self rollback` and `self use` round-trip.
8. **Tag.** Create a signed annotated tag `v<version>` on the merge commit and
   push it.
9. **Publish.** Run
   `gh release create v<version> --notes-file <changelog section> <assets>`.
   Then download the published assets into a temporary directory and verify
   `SHA256SUMS` again.

A release's gate is local, like every merge gate today. Its record is the
`gate` field in `release.json` and the script's log, which is attached to the
release PR.

## 7. Compatibility, support, and security

**Support (pre-1.0).**

- Only the latest release is supported.
- A minor release may change CLI flags, configuration, the SDK protocol, or the
  state format. Each change needs upgrade notes.
- A patch release contains fixes only and keeps `stateFormat` and
  `sdkProtocol`.
- Runner and supervisor config keys are removed only in a minor release, with a
  clear refusal message.
- Graph plugins are compatible across releases with the same `sdkProtocol`.

**Security.**

- **Credentials never enter the artifact or the installer.** The content scan in
  step 5 and the existing refusal of credentials in runner config enforce this.
  Logins remain with the harnesses.
- **Confinement is a prerequisite, not a dependency.** The release does not ship
  bubblewrap and does not change sysctls. `doctor` reports what is missing.
  Process separation does not replace enforced scopes. `allowUnrestricted`
  remains the operator's explicit consent, because coding agents still run shell
  commands with the operator's permissions.
- **Version directories are read-only.** A repair never writes to them. The
  executor design already requires run-local copies.
- **The install is user-level only.** It needs no root and starts no service or
  listener.
- **Integrity checks are minimal.** The checksum and SSH signature cover
  download integrity only. They say nothing about supply-chain provenance
  beyond the recorded commit and lockfile digest.

## 8. Phases, verification, and open questions

| Phase | Deliverable | Verification |
|---|---|---|
| R0 | License file and a decision on repository visibility; this design accepted | Docs checks |
| R1 | Product version source of truth, `release.json`, `graphloom version` from it; `typescript` and `vitest` as CLI dependencies; `scripts/release.sh build` producing the tarball and checksums | Tests for version output; tarball content checks; repair preflight test running against a production-pruned tree |
| R2 | `install.sh`, the shim, and `self list/use/rollback/prune/uninstall`; deterministic packing | Shell tests in a temporary `HOME`: atomic switch, no overwrite, prune respects ownership; double-assemble hash equality |
| R3 | Run ownership (`runs/<id>.json`, `install` record, `stateFormat`), dispatch to the owning version, `resume --upgrade`, gate fingerprint including the product version | Controller and CLI tests: resume under a new `current` dispatches to the old version with no pin mismatch; `--upgrade` records executor transitions; a newer `stateFormat` is refused; a cached gate result is not reused across versions |
| R4 | `doctor`, `setup` | Tests with stubbed `PATH`/`HOME` for each check result; doctor reuses the confinement and capability probes |
| R5 | `release.sh prepare/publish`, signing, first release `v0.1.0` | Full procedure in §6, including the smoke install and the upgrade step from the previous release (from R5's second release onward) |

Open questions:

1. **Visibility and license.** The repository is private and has no license.
   Installers need `gh` access until it is public, and a license is needed
   before others redistribute it. The owner decides.
2. **Third-party plugin authors** need `@graphloom/sdk` outside the workspace.
   One option is to attach `npm pack` output (`graphloom-sdk-<version>.tgz`) to
   the release. Another is to document linking to the install's
   `packages/sdk`.
3. **Bundling Node.** A pinned Node in the tarball would remove a prerequisite
   and make builds more reproducible, at the cost of size and patch duty.
   Revisit after R5.
4. **`--upgrade` across minors.** Should it be supported for every minor, or
   only within one minor, with older runs finishing on their own version?
