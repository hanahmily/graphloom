#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# Local release procedure (docs/design-release.md §6).
#
#   scripts/release.sh prepare <version> [--previous <release.json> | --first] [--no-pr]
#                      [--remote <name>] [--node-dir <dir>] [--keep-work]
#   scripts/release.sh build   <version> [--commit <rev>] [--out <dir>] [--keep-work] [--compare-to <dir>]
#                      [--signing-key <file> | --unsigned] [--previous <release.json>]
#   scripts/release.sh publish <version> [--assets <dir>] [--remote <name>] [--signing-key <file>] [--dry-run]
#
# `prepare` (steps 1-2) runs on main, equal to <remote>/main: it bumps the
# lockstep versions, refreshes the lockfiles and plugin manifests, requires a
# CHANGELOG.md section with upgrade notes (writing a draft when there is
# none), commits on release/v<version>, gates that commit in a clean staged
# clone on the pinned Node, checks the component bump rule against the
# previous release, and opens the release PR (or, with --no-pr, prints the
# commands that would).
#
# `build` (steps 3-8) runs on a committed revision (default HEAD) and publishes
# nothing: it stages a clean checkout of <rev>, fetches and verifies the pinned
# Node, runs the gate on that Node, packs the SDK, prunes to production
# dependencies, assembles the tree, checks licenses and content, packs the
# tarball deterministically, writes and signs SHA256SUMS, and smoke-tests the
# result, installed with install.sh, with no Node on PATH, including an
# external plugin built against the packed SDK. Assets land in <out> (default
# release-out/<version>/, which Git ignores), with the whole log in
# <out>/build.log. --compare-to <dir> names an earlier, independent build of
# the same commit: the build fails unless its tarball and SDK hashes equal
# that build's SHA256SUMS (§2.5), and records the match in <out>/reproduced.json,
# which publish requires. --unsigned makes a development build that publish refuses.
#
# `publish` (steps 9-10) checks the assets of a reproduced, signed build of a
# commit on <remote>/main, creates and pushes the signed tag, creates the
# GitHub release, re-downloads and re-verifies it, and installs it through gh
# in a fresh HOME. --dry-run runs every check, signs the tag in a scratch
# clone, prints the commands it would run instead of pushing the tag or
# creating the release, and rehearses the install against the local assets.
#
# The signing key is the maintainer's: --signing-key <file>, else
# $GRAPHLOOM_RELEASE_SIGNING_KEY. It may be a private key file or the public
# half of a key loaded in ssh-agent. Its public half is committed as
# release/allowed_signers (§2.5); release.sh never writes either.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
gh_repo=${GRAPHLOOM_RELEASE_REPO:-hanahmily/graphloom}
# The SSH signature identity and namespace of SHA256SUMS.sig (§2.5); install.sh uses the same.
sig_identity=graphloom-release
sig_namespace=graphloom-release

usage() {
  sed -n '7,11p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() { echo "release.sh: $*" >&2; exit 1; }

cmd=${1:-}
case "$cmd" in
  prepare | build | publish) ;;
  *) usage ;;
esac
shift
version=${1:-}
[ -n "$version" ] || usage
shift
rev=HEAD
out=
keep_work=0
compare_to=
signing_key=${GRAPHLOOM_RELEASE_SIGNING_KEY:-}
unsigned=0
previous_json=
first=0
no_pr=0
remote=origin
node_dir_flag=
assets=
dry_run=0
while [ $# -gt 0 ]; do
  case "$cmd:$1" in
    build:--commit) rev=${2:?--commit needs a revision}; shift 2 ;;
    build:--out) out=${2:?--out needs a directory}; shift 2 ;;
    build:--compare-to) compare_to=${2:?--compare-to needs a build output directory}; shift 2 ;;
    build:--unsigned) unsigned=1; shift ;;
    build:--signing-key | publish:--signing-key) signing_key=${2:?--signing-key needs a key file}; shift 2 ;;
    build:--previous | prepare:--previous) previous_json=${2:?--previous needs a release.json}; shift 2 ;;
    build:--keep-work | prepare:--keep-work) keep_work=1; shift ;;
    prepare:--first) first=1; shift ;;
    prepare:--no-pr) no_pr=1; shift ;;
    prepare:--node-dir) node_dir_flag=${2:?--node-dir needs a directory}; shift 2 ;;
    prepare:--remote | publish:--remote) remote=${2:?--remote needs a remote name}; shift 2 ;;
    publish:--assets) assets=${2:?--assets needs a directory}; shift 2 ;;
    publish:--dry-run) dry_run=1; shift ;;
    *) usage ;;
  esac
done

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "version must be MAJOR.MINOR.PATCH, got $version" >&2
  exit 2
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  *) echo "release.sh builds linux-x64 on a Linux x86_64 host only (§2.6)" >&2; exit 2 ;;
esac
for tool in git tar gzip xz sha256sum; do
  command -v "$tool" >/dev/null || { echo "release.sh needs $tool on PATH" >&2; exit 2; }
done
command -v node >/dev/null || { echo "release.sh needs a host node to fetch the pinned runtime" >&2; exit 2; }
if [ -n "$previous_json" ] && [ "$first" = 1 ]; then echo "--previous and --first are mutually exclusive" >&2; exit 2; fi
if [ -n "$signing_key" ] && [ "$unsigned" = 1 ]; then echo "--signing-key and --unsigned are mutually exclusive" >&2; exit 2; fi
[ -z "$previous_json" ] || previous_json=$(cd "$(dirname "$previous_json")" && pwd -P)/$(basename "$previous_json")
# File modes in the tarball come from what the build creates; fix them (§2.5).
umask 022

name="graphloom-$version-$platform"
tag="v$version"
step() { printf '\n== %s\n' "$*"; }
# Prints a command as a shell would read it back, indented.
show_cmd() {
  local s
  s=$(printf '%q ' "$@")
  echo "  ${s% }"
}
started=$(date +%s)
host_npm_cache=

# ---------------------------------------------------------------- shared

work=
cleanup() {
  status=$?
  [ -n "$work" ] || return 0
  if [ "$status" -ne 0 ] || [ "$keep_work" -eq 1 ]; then
    echo "work directory kept: $work" >&2
  else
    chmod -R u+w "$work" 2>/dev/null || true
    rm -rf "$work"
  fi
}
trap cleanup EXIT
make_work() {
  work=$(mktemp -d "${TMPDIR:-/tmp}/graphloom-release-XXXXXX")
  work=$(cd "$work" && pwd -P)
}

signing_instructions() {
  cat >&2 <<EOF
release.sh: to sign releases, create the release key once and commit its public half:
  ssh-keygen -t ed25519 -C graphloom-release -f ~/.ssh/graphloom-release
  printf 'graphloom-release namespaces="graphloom-release,git" %s\n' "\$(cat ~/.ssh/graphloom-release.pub)" >release/allowed_signers
  git add release/allowed_signers   # through a reviewed PR to main
then pass --signing-key ~/.ssh/graphloom-release (or set GRAPHLOOM_RELEASE_SIGNING_KEY).
Never commit the private key. "git" in namespaces lets the same key sign the release tag (§6 step 9).
EOF
}

# The allowed_signers lines for the release identity that admit the release namespace.
check_signers() { # file
  [ -f "$1" ] || { signing_instructions; die "there is no release/allowed_signers"; }
  grep -Eq "^${sig_identity}[[:space:]]+namespaces=\"([^\"]*,)?${sig_namespace}(,[^\"]*)?\"[[:space:]]+(ssh-|ecdsa-|sk-)" "$1" ||
    { signing_instructions; die "$1 has no '${sig_identity} namespaces=\"${sig_namespace},...\" <public key>' line"; }
}

# The key file to sign with: a private key, or a .pub whose private half ssh-agent holds.
resolve_key() {
  [ -n "$signing_key" ] || { signing_instructions; die "no signing key: pass --signing-key <file> or set GRAPHLOOM_RELEASE_SIGNING_KEY"; }
  [ -f "$signing_key" ] || die "no such signing key: $signing_key"
  signing_key=$(cd "$(dirname "$signing_key")" && pwd -P)/$(basename "$signing_key")
  command -v ssh-keygen >/dev/null || die "signing needs ssh-keygen on PATH"
}

sign_file() { # file -> file.sig
  rm -f "$1.sig"
  ssh-keygen -q -Y sign -f "$signing_key" -n "$sig_namespace" "$1" </dev/null >/dev/null 2>"$1.sign-err" ||
    { cat "$1.sign-err" >&2; rm -f "$1.sign-err"; die "ssh-keygen could not sign $(basename "$1") with $signing_key"; }
  rm -f "$1.sign-err"
}

verify_file() { # signers file sig
  ssh-keygen -Y verify -f "$1" -I "$sig_identity" -n "$sig_namespace" -s "$3" <"$2" >/dev/null 2>&1
}

# Fails early, before any gate, unless the key signs what the allowed_signers file verifies.
probe_key() { # signers
  resolve_key
  check_signers "$1"
  printf 'graphloom release signing probe\n' >"$work/sign-probe"
  sign_file "$work/sign-probe"
  verify_file "$1" "$work/sign-probe" "$work/sign-probe.sig" ||
    { signing_instructions; die "the signing key $signing_key is not the one release/allowed_signers names"; }
  echo "signing key: $signing_key verifies against $1"
}

# Puts the pinned Node first on PATH: fetched and verified (§2.7), or an extracted copy named by --node-dir.
use_pinned_node() { # src
  if [ -n "$node_dir_flag" ]; then
    node_dir=$(cd "$node_dir_flag" && pwd -P)
    want=v$(node -p 'require(process.argv[1]).version' "$1/release/node.json")
    [ "$("$node_dir/bin/node" --version)" = "$want" ] || die "--node-dir $node_dir is not Node $want, the pin in release/node.json"
  else
    node_dir=$(node "$1/scripts/release/fetch-node.mjs" --pin "$1/release/node.json" --dest "$work/node")
  fi
  pinned=$node_dir/bin
  node_version=$("$pinned/node" --version)
  echo "pinned runtime: $node_dir ($node_version)"
  export PATH="$pinned:$PATH"
  hash -r
  [ "$(node --version)" = "$node_version" ] || die "the pinned Node is not first on PATH"
}

# A clean clone detached at a commit: exactly its tracked files, as git archive would give,
# and a work tree, which the gate's example-task tests need (their `repo: .` is the checkout).
stage_clone() { # commit dest
  git clone -q --no-checkout "$repo" "$2"
  git -C "$2" -c advice.detachedHead=false checkout -q --detach "$1"
  git -C "$2" remote remove origin
  [ -z "$(git -C "$2" status --porcelain)" ] || die "the staged checkout is not clean"
}

# Step 4, the same commands as local CI.
gate() { # dir
  (
    cd "$1"
    NODE_ENV=development npm ci --include=dev
    npm run build
    npm run typecheck
    npm test
  )
}

# Previous release tags, from git (local and remote) and gh, one per line.
release_tags() {
  git -C "$repo" tag -l 'v*'
  git -C "$repo" ls-remote --tags --refs "$remote" 'v*' 2>/dev/null | sed 's|.*refs/tags/||' || true
  if command -v gh >/dev/null; then
    gh release list -R "$gh_repo" --limit 1000 --json tagName,isDraft,isPrerelease 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{for(const r of JSON.parse(s||"[]"))if(!r.isDraft&&!r.isPrerelease)console.log(r.tagName)})' || true
  fi
}

# Whether gh has a release (published or draft) with this tag.
gh_has_release() { # tag
  gh release list -R "$gh_repo" --limit 1000 --json tagName,isDraft,isPrerelease |
    node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.exit(JSON.parse(s||"[]").some((r)=>r.tagName===process.argv[1])?0:1))' "$1"
}

# The latest published release's release.json, or nothing for the first release.
fetch_previous() { # below-version dest-dir -> prints the path, or nothing
  release_tags >"$work/tags"
  prev=$(node "$rel/prepare.mjs" latest --tags "$work/tags" --below "$1")
  [ -n "$prev" ] || return 0
  mkdir -p "$2"
  gh release download "v$prev" -R "$gh_repo" -D "$2" -p release.json >/dev/null 2>&1 ||
    die "cannot download release.json of v$prev from $gh_repo to check the component bump rule; pass --previous <release.json>"
  printf '%s\n' "$2/release.json"
}

# A PATH of host tools with no Node, its package managers, or gh (§6 step 8).
no_node_path() { # dir
  node "$rel/no-node-path.mjs" --dir "$1" >/dev/null
  rm -f "$1/gh"
  printf '%s\n' "$1"
}

# ---------------------------------------------------------------- prepare (steps 1-2)

do_prepare() {
  command -v gh >/dev/null || [ "$no_pr" = 1 ] || die "prepare needs gh to open the release PR (or pass --no-pr)"
  make_work
  rel=$repo/scripts/release
  cd "$repo"
  echo "graphloom release prepare $version"

  step "1. preconditions"
  branch=$(git symbolic-ref --short -q HEAD || true)
  [ "$branch" = main ] || die "prepare runs on main, not ${branch:-a detached HEAD}"
  git fetch -q "$remote" main || die "cannot fetch main from $remote"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$remote/main")" ] || die "main is not equal to $remote/main"
  dirty=$(git status --porcelain --untracked-files=all | grep -v -E '^( M|\?\?|M |A |AM) CHANGELOG\.md$' || true)
  [ -z "$dirty" ] || die "the tree is not clean (only CHANGELOG.md may differ from main):
$dirty"
  ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag already exists"
  [ -z "$(git ls-remote --tags --refs "$remote" "$tag")" ] || die "tag $tag already exists on $remote"
  ! git rev-parse -q --verify "refs/heads/release/$tag" >/dev/null || die "branch release/$tag already exists"
  [ -z "$(git ls-remote --heads "$remote" "release/$tag")" ] || die "branch release/$tag already exists on $remote"
  release_tags >"$work/tags"
  latest=$(node "$rel/prepare.mjs" latest --tags "$work/tags")
  if [ -n "$latest" ]; then
    [ "$first" = 0 ] || die "--first, but $latest is already released"
    [ "$(node -e 'const [a,b]=process.argv.slice(1).map((v)=>v.split(".").map(Number));console.log(a[0]-b[0]||a[1]-b[1]||a[2]-b[2])' "$version" "$latest")" -gt 0 ] ||
      die "$version is not greater than the latest release $latest"
    if [ -z "$previous_json" ]; then previous_json=$(fetch_previous "$version" "$work/previous"); fi
    echo "previous release: $latest"
  elif [ -z "$previous_json" ]; then
    echo "previous release: none; $version is the first release"
  fi

  step "2. version $version and changelog"
  if ! node "$rel/prepare.mjs" notes --file CHANGELOG.md --version "$version" >/dev/null 2>&1; then
    range=HEAD
    if [ -n "$latest" ] && git rev-parse -q --verify "refs/tags/v$latest" >/dev/null; then range="v$latest..HEAD"; fi
    # One line per change on main: a merge's PR title, or a direct commit's subject.
    git log --first-parent --format='%H %P' "$range" | while read -r h p1 p2; do
      if [ -n "${p2:-}" ]; then git log -1 --format=%b "$h" | sed -n '/./{p;q}'; else git log -1 --format=%s "$h"; fi
    done >"$work/subjects"
    printf '{"node":"%s"}\n' "$(node -p 'require(process.argv[1]).version' "$repo/release/node.json")" >"$work/facts.json"
    set +e
    node "$rel/prepare.mjs" draft --file CHANGELOG.md --version "$version" --date "$(date -u +%Y-%m-%d)" \
      --log "$work/subjects" --facts "$work/facts.json"
    drafted=$?
    set -e
    [ "$drafted" = 3 ] || die "could not write a CHANGELOG.md draft"
    die "wrote a draft $version section into CHANGELOG.md from $(wc -l <"$work/subjects") changes on main.
Edit it to what an operator notices, fill in every TODO (the upgrade notes above all), and run release.sh prepare $version again."
  fi
  # Fail on the changelog before changing anything else.
  node "$rel/prepare.mjs" changelog --root "$repo" --version "$version"
  use_pinned_node "$repo"
  git checkout -q -b "release/$tag"
  echo "branch: release/$tag"
  node "$rel/prepare.mjs" bump --root "$repo" --version "$version" | sed 's/^/bumped: /'
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
  # Each plugin's generated manifest digests its package.json and lockfile (§3), and a
  # manifest script may read the plugin's build. So regenerate them on a built copy of the
  # bumped tree, leaving this checkout's node_modules and dist alone.
  gen=$work/manifests
  stage_clone "$(git rev-parse HEAD)" "$gen"
  git diff --binary HEAD -- . ':!CHANGELOG.md' | git -C "$gen" apply --whitespace=nowarn
  (cd "$gen" && NODE_ENV=development npm ci --include=dev --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm run manifest --workspaces --if-present >/dev/null)
  for f in $(cd "$gen" && git ls-files 'examples/plugins/*/graphloom.manifest.json'); do
    cmp -s "$gen/$f" "$f" || { cp "$gen/$f" "$f"; echo "regenerated: $f"; }
  done
  node scripts/check-headers.mjs
  node "$rel/prepare.mjs" changelog --root "$repo" --version "$version"
  node "$rel/prepare.mjs" lockstep --root "$repo" --version "$version"
  git add -u
  git add CHANGELOG.md
  git -c core.hooksPath=/dev/null commit -q -m "release: $tag" -m "Lockstep versions, lockfiles, plugin manifests, and the CHANGELOG.md section for $version (docs/design-release.md §6 step 2)."
  commit=$(git rev-parse HEAD)
  echo "commit: $commit"

  step "2. gate the release commit in a clean staged clone"
  src=$work/src
  stage_clone "$commit" "$src"
  gate "$src"
  # The generated manifests are current: regenerating them changes nothing (§3).
  (cd "$src" && npm run manifest --workspaces --if-present >/dev/null)
  [ -z "$(git -C "$src" status --porcelain)" ] || { git -C "$src" status --porcelain >&2; die "a plugin manifest is not current"; }
  node "$rel/prepare.mjs" components --src "$src" --out "$work/components.json"
  if [ -n "$previous_json" ]; then
    node "$rel/prepare.mjs" check-components --current "$work/components.json" --previous "$previous_json" --src "$src"
  else
    echo "components: no previous release to compare with"
  fi
  sed 's/^/  /' "$work/components.json"

  node "$rel/prepare.mjs" notes --file CHANGELOG.md --version "$version" >"$work/notes.md"
  {
    echo "Release $tag: lockstep versions, lockfiles, plugin manifests, and the changelog (docs/design-release.md §6 step 2)."
    echo
    echo "Gated by \`release.sh prepare\` on $node_version in a clean clone of $commit: \`npm ci --include=dev\`, \`npm run build\`, \`npm run typecheck\`, \`npm test\`."
    echo
    echo "After merge: \`scripts/release.sh build $version --commit <merge commit> --signing-key <key>\` twice (the second with \`--compare-to\`), then \`scripts/release.sh publish $version\`."
    echo
    echo "## Changelog"
    echo
    cat "$work/notes.md"
  } >"$work/pr-body.md"
  push_cmd=(git push -u "$remote" "release/$tag")
  pr_cmd=(gh pr create -R "$gh_repo" --base main --head "release/$tag" --title "release: $tag" --body-file "$work/pr-body.md")
  if [ "$no_pr" = 1 ]; then
    keep_work=1
    step "release PR (not opened: --no-pr)"
    show_cmd "${push_cmd[@]}"
    show_cmd "${pr_cmd[@]}"
  else
    step "open the release PR"
    "${push_cmd[@]}"
    "${pr_cmd[@]}"
  fi
  echo
  echo "release prepare $version done in $(($(date +%s) - started))s on release/$tag ($commit)"
}

# ---------------------------------------------------------------- build (steps 3-8)

do_build() {
  if [ -n "$compare_to" ]; then
    [ -f "$compare_to/SHA256SUMS" ] || { echo "--compare-to $compare_to has no SHA256SUMS" >&2; exit 2; }
    compare_to=$(cd "$compare_to" && pwd -P)
  fi
  commit=$(git -C "$repo" rev-parse --verify "$rev^{commit}")
  epoch=$(git -C "$repo" show -s --format=%ct "$commit")
  out=${out:-$repo/release-out/$version}
  mkdir -p "$out"
  out=$(cd "$out" && pwd -P)
  if [ -n "$(ls -A "$out")" ]; then
    echo "$out is not empty; remove it or pass another --out" >&2
    exit 2
  fi
  make_work
  exec > >(tee "$out/build.log") 2>&1

  echo "graphloom release build $version ($platform) from $commit"
  echo "SOURCE_DATE_EPOCH=$epoch, work directory $work"
  [ "$unsigned" = 1 ] && echo "UNSIGNED development build: publish refuses it"

  # 3. Stage and fetch.
  step "3. stage a clean checkout of $commit and fetch the pinned Node"
  src=$work/src
  stage_clone "$commit" "$src"
  export SOURCE_DATE_EPOCH=$epoch
  staged_version=$(node -p 'require(process.argv[1]).version' "$src/package.json")
  if [ "$staged_version" != "$version" ]; then
    echo "the product version at $commit is $staged_version, not $version (root package.json, §3)" >&2
    exit 1
  fi
  rel=$src/scripts/release
  signers=$src/release/allowed_signers
  # Before the gate, so a missing or wrong key costs nothing (§2.5).
  if [ "$unsigned" = 0 ]; then
    probe_key "$signers"
    node "$rel/prepare.mjs" notes --file "$src/CHANGELOG.md" --version "$version" >/dev/null ||
      die "CHANGELOG.md at $commit has no $version section; run release.sh prepare $version"
  fi
  use_pinned_node "$src"
  # The cache the gate's npm ci fills; the external-plugin smoke (8.6) installs from it offline.
  host_npm_cache=$(npm config get cache)

  # 4. Gate.
  step "4. gate on $node_version: npm ci, build, typecheck, test"
  gate "$src"

  # 5. Pack the SDK.
  step "5. pack the SDK"
  cp "$src/LICENSE" "$src/NOTICE" "$src/packages/sdk/"
  (cd "$src" && npm pack -w @graphloom/sdk --pack-destination "$out" >/dev/null)
  sdk=$out/graphloom-sdk-$version.tgz
  [ -f "$sdk" ] || { echo "npm pack did not produce $sdk" >&2; exit 1; }
  node "$rel/check-pack.mjs" --tarball "$sdk" --version "$version"
  mkdir -p "$work/sdk-check"
  tar -xzf "$sdk" -C "$work/sdk-check"
  node "$rel/notices.mjs" --root "$work/sdk-check/package" --allowlist "$src/release/license-allowlist.json" --self

  # 6. Assemble.
  step "6. prune to production dependencies and assemble $name"
  (cd "$src" && npm prune --omit=dev)
  for dep in typescript vitest; do
    [ -f "$src/node_modules/$dep/package.json" ] || { echo "npm prune removed $dep; it must be a @graphloom/cli dependency (§2.2)" >&2; exit 1; }
  done
  assembly=$work/assembly
  dest=$(node "$rel/assemble.mjs" --src "$src" --out "$assembly" --node "$node_dir" --node-pin "$src/release/node.json" \
    --version "$version" --commit "$commit" --epoch "$epoch" --sdk-tgz "$sdk" --platform "$platform")
  node "$rel/notices.mjs" --root "$dest" --allowlist "$src/release/license-allowlist.json" \
    --out "$dest/THIRD_PARTY_NOTICES" --node-license "$dest/node/LICENSE" --node-version "$node_version"
  forbid=(--forbid "$work" --forbid "$repo")
  if [ -n "${HOME:-}" ] && [ "${#HOME}" -gt 1 ]; then forbid+=(--forbid "$HOME"); fi
  node "$rel/check-tree.mjs" --root "$dest" --platform "$platform" "${forbid[@]}"
  cp "$dest/release.json" "$out/release.json"
  if [ "$unsigned" = 0 ]; then
    cmp -s "$signers" "$dest/release/allowed_signers" || die "the tree does not carry the commit's release/allowed_signers"
    # The release notes carry the components table release.json records (§3).
    node "$rel/prepare.mjs" changelog --root "$src" --version "$version" --release "$out/release.json"
  fi
  if [ -n "$previous_json" ]; then
    node "$rel/prepare.mjs" check-components --current "$out/release.json" --previous "$previous_json" --src "$src"
  fi
  tarball=$out/$name.tar.gz
  # Deterministic (§2.5): names sorted, every mtime SOURCE_DATE_EPOCH, numeric 0:0
  # owners, no atime/ctime or other pax records, and a gzip header without a name
  # or time, so the bytes depend only on the tree's paths, modes, and contents.
  pack() {
    tar --sort=name --format=gnu --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
      --mode=go-w -C "$assembly" -cf - "$name" | gzip -n -9 >"$1"
  }
  pack "$tarball"
  echo "tarball: $(basename "$tarball"), $(stat -c %s "$tarball") bytes compressed, $(du -sb "$dest" | cut -f1) bytes unpacked"

  cp "$src/scripts/install.sh" "$out/install.sh"
  chmod 755 "$out/install.sh"
  asset_names=("$(basename "$tarball")" "$(basename "$sdk")" release.json install.sh)
  (cd "$out" && sha256sum "${asset_names[@]}" >SHA256SUMS)
  if [ "$unsigned" = 0 ]; then
    sign_file "$out/SHA256SUMS"
    verify_file "$signers" "$out/SHA256SUMS" "$out/SHA256SUMS.sig" || die "SHA256SUMS.sig does not verify against release/allowed_signers"
    echo "signed: SHA256SUMS.sig verifies against release/allowed_signers"
  fi

  # 7. Reproducibility: a second pack of the same tree, and with --compare-to, an independent build.
  step "7. reproducibility"
  pack "$work/repack.tar.gz"
  first_sha=$(sha256sum "$tarball" | cut -d' ' -f1)
  second_sha=$(sha256sum "$work/repack.tar.gz" | cut -d' ' -f1)
  [ "$first_sha" = "$second_sha" ] || { echo "repack of the same tree differs ($first_sha vs $second_sha)" >&2; exit 1; }
  echo "repack: identical ($first_sha)"
  if [ -n "$compare_to" ]; then
    differs=0
    for asset in "${asset_names[@]}"; do
      mine=$(grep "  $asset\$" "$out/SHA256SUMS" | cut -d' ' -f1)
      theirs=$(grep "  $asset\$" "$compare_to/SHA256SUMS" | cut -d' ' -f1 || true)
      if [ "$mine" = "$theirs" ]; then
        echo "reproduced $asset: $mine"
      else
        echo "NOT reproduced $asset: $mine here, ${theirs:-absent} in $compare_to" >&2
        differs=1
      fi
    done
    [ "$differs" = 0 ] || exit 1
    # The record publish requires (§6 "R2 as implemented").
    node -e 'const fs=require("fs");const [sums,dir,commit]=process.argv.slice(1);const assets={};for(const l of fs.readFileSync(sums,"utf8").trim().split("\n")){const [h,n]=l.split(/\s+\*?/);assets[n]=h}console.log(JSON.stringify({commit,comparedTo:dir,assets},null,2))' \
      "$out/SHA256SUMS" "$compare_to" "$commit" >"$out/reproduced.json"
  fi

  # 8. Smoke tests, with no Node on PATH.
  step "8. smoke tests on the tarball installed by install.sh, with no node on PATH"
  smoke=$work/smoke
  mkdir -p "$smoke/home" "$smoke/tmp"
  nonode=$(no_node_path "$smoke/bin")
  printf '[user]\n\tname = GraphLoom Release Smoke\n\temail = release-smoke@example.invalid\n' >"$smoke/home/.gitconfig"
  # No automatic-update check from the smoke tests: it would query the real release source.
  in_smoke() { env -i HOME="$smoke/home" PATH="$nonode" TMPDIR="$smoke/tmp" LANG=C.UTF-8 GRAPHLOOM_DISABLE_AUTOUPDATE=1 "$@"; }
  # stdin from /dev/null: the install is not interactive, so it offers no setup (§4.2 step 6).
  # A standalone install.sh carries no trust anchor, so the commit's is named, as a first install names it.
  if [ "$unsigned" = 0 ]; then
    in_smoke sh "$out/install.sh" --from "$tarball" --require-signature --allowed-signers "$signers" </dev/null
  else
    in_smoke sh "$out/install.sh" --from "$tarball" </dev/null
  fi
  shim=$smoke/home/.local/bin/graphloom
  installed=$(readlink -f "$smoke/home/.local/share/graphloom/current")
  [ "$installed" = "$smoke/home/.local/share/graphloom/versions/$version" ] || { echo "install.sh did not switch current to $version" >&2; exit 1; }
  [ "$(in_smoke "$shim" self list)" = "$version (current)" ] || { in_smoke "$shim" self list; echo "graphloom self list does not show $version as current" >&2; exit 1; }
  if touch "$installed/.write-probe" 2>/dev/null; then echo "the installed version directory is writable" >&2; exit 1; fi

  in_smoke "$shim" version --json >"$smoke/version.json"
  node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));const b=JSON.parse(fs.readFileSync(process.argv[2]));if(JSON.stringify(a)!==JSON.stringify(b)){console.error("graphloom version --json does not match release.json");process.exit(1)}' \
    "$smoke/version.json" "$out/release.json"
  [ "$(in_smoke "$shim" version --root)" = "$installed" ] || { echo "graphloom version --root is not the installed version directory" >&2; exit 1; }
  echo "version: $(in_smoke "$shim" version) (matches release.json), installed at $installed"

  # 8.1: the doctor may warn (no runner config, no harness CLIs), but platform, confinement, and integrity must pass.
  in_smoke "$shim" doctor --json >"$smoke/doctor.json" || true
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const bad=["platform","confinement","install integrity"].map((n)=>r.checks.find((c)=>c.name===n)).filter((c)=>!c||c.status!=="pass");if(bad.length){console.error("graphloom doctor: "+JSON.stringify(bad));process.exit(1)}' \
    "$smoke/doctor.json"
  echo "doctor: platform, confinement, and install integrity pass"

  in_smoke "$installed/node/bin/node" "$rel/smoke-preflight.mjs" --root "$installed"
  in_smoke "$installed/node/bin/node" "$rel/smoke-pi.mjs" --root "$installed"

  # 8.2-8.4: the shipped hello plugin, linked by its versioned real path (§4.6).
  smoke_task() { # dir plugin-dir label
    mkdir -p "$1/plugins"
    cp "$installed/examples/task.yaml" "$1/task.yaml"
    ln -s "$2" "$1/plugins/hello"
    git init -q "$1/test-repo"
    git -C "$1/test-repo" -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit -q --allow-empty -m "Initialize hello fixture"
    (cd "$1" && in_smoke "$shim" check task.yaml >"$1/check.json") || { cat "$1/check.json"; echo "graphloom check failed ($3)" >&2; exit 1; }
    echo "check ($3): ok"
    (cd "$1" && in_smoke "$shim" rehearse task.yaml --offline >"$1/rehearse.json") || { cat "$1/rehearse.json"; echo "graphloom rehearse --offline was not-ready ($3)" >&2; exit 1; }
    verdict=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).verdict' "$1/rehearse.json")
    echo "rehearse --offline ($3): $verdict"
    [ "$verdict" != "not-ready" ] || exit 1
  }
  smoke_task "$smoke/hello" "$installed/examples/plugins/hello" "shipped hello"

  # 8.6: an external plugin, authored outside any checkout against the packed SDK, with the
  # pinned Node and its npm (the one sub-step with a Node on PATH), run by the installed release.
  step "8.6 external plugin built against the packed SDK"
  author=$smoke/author
  mkdir -p "$author"
  cp -R "$installed/examples/plugins/hello" "$author/hello"
  chmod -R u+w "$author/hello"
  rm -rf "$author/hello/dist"
  cp "$sdk" "$author/"
  node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.dependencies["@graphloom/sdk"]="file:../"+process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' \
    "$author/hello/package.json" "$(basename "$sdk")"
  # --offline: every dependency comes from the npm cache the gate filled, none from the network.
  (cd "$author/hello" && env -i HOME="$smoke/home" PATH="$pinned:$nonode" TMPDIR="$smoke/tmp" LANG=C.UTF-8 npm_config_cache="$host_npm_cache" \
    npm i --offline --no-audit --no-fund --ignore-scripts >/dev/null)
  [ ! -L "$author/hello/node_modules/@graphloom/sdk" ] || die "the external plugin links the SDK instead of installing the tarball"
  got=$(node -p 'require(process.argv[1]).version' "$author/hello/node_modules/@graphloom/sdk/package.json")
  [ "$got" = "$version" ] || die "the external plugin installed SDK $got, not $version"
  (cd "$author/hello" && in_smoke "$installed/node/bin/node" "$installed/node_modules/typescript/bin/tsc" -p tsconfig.json)
  (cd "$author/hello" && in_smoke "$installed/node/bin/node" scripts/generate-manifest.mjs >/dev/null)
  echo "external plugin: built with the release's typescript against graphloom-sdk-$version.tgz; manifest regenerated"
  smoke_task "$smoke/external" "$author/hello" "external hello"

  step "checksums"
  cat "$out/SHA256SUMS"
  echo
  echo "release build $version done in $(($(date +%s) - started))s; assets in $out:"
  (cd "$out" && ls -l "${asset_names[@]}" SHA256SUMS $([ -f SHA256SUMS.sig ] && echo SHA256SUMS.sig))
}

# ---------------------------------------------------------------- publish (steps 9-10)

do_publish() {
  for tool in gh ssh-keygen; do command -v "$tool" >/dev/null || die "publish needs $tool on PATH"; done
  resolve_key
  assets=${assets:-$repo/release-out/$version}
  [ -d "$assets" ] || die "no assets directory $assets; run release.sh build $version first"
  assets=$(cd "$assets" && pwd -P)
  make_work
  rel=$repo/scripts/release
  echo "graphloom release publish $version from $assets$([ "$dry_run" = 1 ] && echo ' (dry run: no tag push, no release)')"

  step "preconditions"
  sdk_name=graphloom-sdk-$version.tgz
  asset_names=("$name.tar.gz" "$sdk_name" release.json install.sh)
  for a in "${asset_names[@]}" SHA256SUMS SHA256SUMS.sig; do [ -f "$assets/$a" ] || die "$assets has no $a"; done
  listed=$(sed -E 's/^[0-9a-f]{64} [ *]//' "$assets/SHA256SUMS" | sort | tr '\n' ' ')
  wanted=$(printf '%s\n' "${asset_names[@]}" | sort | tr '\n' ' ')
  [ "$listed" = "$wanted" ] || die "SHA256SUMS lists '$listed', not '$wanted'"
  (cd "$assets" && sha256sum -c --quiet SHA256SUMS) || die "an asset does not match SHA256SUMS"
  commit=$(node -p 'const r=require(process.argv[1]);if(r.product!=="graphloom"||r.version!==process.argv[2]||r.git.tag!==process.argv[3]||r.platform!==process.argv[4])throw new Error("release.json does not name graphloom "+process.argv[2]+" "+process.argv[4]);r.git.commit' \
    "$assets/release.json" "$version" "$tag" "$platform") || die "release.json does not describe $tag"
  git -C "$repo" cat-file -e "$commit^{commit}" 2>/dev/null || die "the release commit $commit is not in this repository"
  # The trust anchor is the commit's, never the working tree's or the download's (§4.7).
  git -C "$repo" show "$commit:release/allowed_signers" >"$work/allowed_signers" 2>/dev/null || { signing_instructions; die "release/allowed_signers is not committed at $commit"; }
  check_signers "$work/allowed_signers"
  verify_file "$work/allowed_signers" "$assets/SHA256SUMS" "$assets/SHA256SUMS.sig" || die "SHA256SUMS.sig does not verify against release/allowed_signers at $commit"
  echo "signature: SHA256SUMS.sig verifies against release/allowed_signers at $commit"
  probe_key "$work/allowed_signers"
  tar -xzf "$assets/$name.tar.gz" -O "$name/release.json" | cmp -s - "$assets/release.json" || die "release.json differs from the one inside the tarball"
  git -C "$repo" show "$commit:scripts/install.sh" | cmp -s - "$assets/install.sh" || die "install.sh differs from scripts/install.sh at $commit"
  [ "$(sha256sum "$assets/$sdk_name" | cut -d' ' -f1)" = "$(node -p 'require(process.argv[1]).sdk.sha256' "$assets/release.json")" ] || die "the SDK tarball's digest differs from release.json"
  # R2 requires a reproduced build: two independent builds of the commit agree (§2.5).
  [ -f "$assets/reproduced.json" ] || die "$assets has no reproduced.json; build again with --compare-to $assets into another --out, and publish that output"
  node -e 'const fs=require("fs");const [rj,sums,commit]=process.argv.slice(1);const r=JSON.parse(fs.readFileSync(rj,"utf8"));if(r.commit!==commit)throw new Error("reproduced.json is for "+r.commit);for(const l of fs.readFileSync(sums,"utf8").trim().split("\n")){const [h,n]=l.split(/\s+\*?/);if(r.assets[n]!==h)throw new Error("reproduced.json does not record "+n+" at "+h)}' \
    "$assets/reproduced.json" "$assets/SHA256SUMS" "$commit" || die "reproduced.json does not match these assets"
  echo "reproduced: $(node -p 'require(process.argv[1]).comparedTo' "$assets/reproduced.json")"
  git -C "$repo" fetch -q "$remote" main || die "cannot fetch main from $remote"
  git -C "$repo" merge-base --is-ancestor "$commit" "$remote/main" || die "the release commit $commit is not on $remote/main"
  git -C "$repo" show "$commit:CHANGELOG.md" >"$work/CHANGELOG.md" || die "CHANGELOG.md is not committed at $commit"
  node "$rel/prepare.mjs" notes --file "$work/CHANGELOG.md" --version "$version" >"$work/notes.md"
  mkdir -p "$work/changelog-root"
  cp "$work/CHANGELOG.md" "$work/changelog-root/CHANGELOG.md"
  node "$rel/prepare.mjs" changelog --root "$work/changelog-root" --version "$version" --release "$assets/release.json"
  local_tag=$(git -C "$repo" rev-parse -q --verify "refs/tags/$tag^{commit}" || true)
  [ -z "$local_tag" ] || [ "$local_tag" = "$commit" ] || die "tag $tag exists at $local_tag, not $commit"
  remote_tag=$(git -C "$repo" ls-remote --tags "$remote" "refs/tags/$tag^{}" | cut -f1)
  [ -n "$remote_tag" ] || remote_tag=$(git -C "$repo" ls-remote --tags "$remote" "refs/tags/$tag" | cut -f1)
  [ -z "$remote_tag" ] || [ "$remote_tag" = "$commit" ] || die "tag $tag exists on $remote at $remote_tag, not $commit"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in; run gh auth login"
  ! gh_has_release "$tag" || die "$gh_repo already has a release $tag"
  previous_json=$(fetch_previous "$version" "$work/previous")
  if [ -n "$previous_json" ]; then
    prev=$(node -p 'require(process.argv[1]).version' "$previous_json")
    node "$rel/prepare.mjs" check-components --current "$assets/release.json" --previous "$previous_json"
  else
    prev=
    echo "previous release: none; $version is the first release"
  fi
  echo "release: $tag at $commit; assets verified"

  # 9. Tag: annotated and signed with the release key (git's SSH signing, namespace "git").
  step "9. signed tag $tag"
  tag_cmd=(git -C "$repo" -c gpg.format=ssh -c "user.signingKey=$signing_key" tag -s -a -m "GraphLoom $tag" "$tag" "$commit")
  verify_cmd=(git -C "$repo" -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$work/allowed_signers" verify-tag "$tag")
  push_cmd=(git -C "$repo" push "$remote" "refs/tags/$tag")
  if [ "$dry_run" = 1 ]; then
    # Sign the tag where nothing is shared, to prove the key and allowed_signers sign and verify it.
    git clone -q --no-checkout "$repo" "$work/tag-check"
    git -C "$work/tag-check" -c gpg.format=ssh -c "user.signingKey=$signing_key" tag -s -a -m "GraphLoom $tag" "$tag" "$commit"
    git -C "$work/tag-check" -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$work/allowed_signers" verify-tag "$tag" 2>&1 | sed 's/^/  /'
    echo "dry run: the tag signs and verifies in a scratch clone; would run:"
    [ -n "$local_tag" ] || { show_cmd "${tag_cmd[@]}"; }
    show_cmd "${verify_cmd[@]}"
    [ -n "$remote_tag" ] || { show_cmd "${push_cmd[@]}"; }
  else
    [ -n "$local_tag" ] || "${tag_cmd[@]}"
    "${verify_cmd[@]}" || die "tag $tag does not verify against release/allowed_signers"
    [ -n "$remote_tag" ] || "${push_cmd[@]}"
    echo "tag: $tag pushed to $remote"
  fi

  # 10. Publish.
  step "10. GitHub release $tag"
  cp "$work/notes.md" "$work/release-notes.md"
  create_cmd=(gh release create "$tag" -R "$gh_repo" --verify-tag --title "GraphLoom $tag" --notes-file "$work/release-notes.md")
  for a in "${asset_names[@]}" SHA256SUMS SHA256SUMS.sig; do create_cmd+=("$assets/$a"); done
  published=$work/published
  if [ "$dry_run" = 1 ]; then
    echo "dry run: would run:"
    show_cmd "${create_cmd[@]}"
    echo "  (release notes: the $version section of CHANGELOG.md at $commit, $(wc -l <"$work/release-notes.md") lines)"
    # Rehearse the published install path through gh, served from the local assets.
    mkdir -p "$work/stub-releases/$tag" "$work/stub-bin"
    for a in "${asset_names[@]}" SHA256SUMS SHA256SUMS.sig; do cp "$assets/$a" "$work/stub-releases/$tag/"; done
    cp "$rel/stub-gh.sh" "$work/stub-bin/gh"
    chmod 755 "$work/stub-bin/gh"
    gh_bin=$work/stub-bin
    gh_env=(GRAPHLOOM_STUB_GH_RELEASES="$work/stub-releases")
    published=$work/stub-releases/$tag
    echo "dry run: rehearsing the published install with a stub gh that serves $assets"
  else
    "${create_cmd[@]}"
    mkdir -p "$published"
    gh release download "$tag" -R "$gh_repo" -D "$published"
    for a in "${asset_names[@]}" SHA256SUMS SHA256SUMS.sig; do
      cmp -s "$assets/$a" "$published/$a" || die "the published $a differs from $assets/$a"
    done
    (cd "$published" && sha256sum -c --quiet SHA256SUMS) || die "the published assets do not match SHA256SUMS"
    verify_file "$work/allowed_signers" "$published/SHA256SUMS" "$published/SHA256SUMS.sig" || die "the published SHA256SUMS.sig does not verify"
    echo "published: $tag re-downloaded; SHA256SUMS and its signature verify"
    gh_bin=$work/gh-bin
    mkdir -p "$gh_bin"
    ln -s "$(command -v gh)" "$gh_bin/gh"
    # The maintainer's gh login, in a fresh HOME: its config directory, or a token from it.
    gh_env=(GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}")
    token=${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}
    [ -z "$token" ] || gh_env+=(GH_TOKEN="$token")
    # A stand-in gh (the release tests) keeps its release directory.
    [ -z "${GRAPHLOOM_STUB_GH_RELEASES:-}" ] || gh_env+=(GRAPHLOOM_STUB_GH_RELEASES="$GRAPHLOOM_STUB_GH_RELEASES")
  fi
  [ -z "${GRAPHLOOM_STUB_GH_LOG:-}" ] || gh_env+=(GRAPHLOOM_STUB_GH_LOG="$GRAPHLOOM_STUB_GH_LOG")

  # The primary install path, in a fresh HOME with no Node on PATH: the published install.sh through gh.
  nonode=$(no_node_path "$work/bin")
  fresh() { # home cmd...
    local h=$1
    shift
    mkdir -p "$h" "$h.tmp"
    env -i HOME="$h" PATH="$gh_bin:$nonode" TMPDIR="$h.tmp" LANG=C.UTF-8 GRAPHLOOM_DISABLE_AUTOUPDATE=1 \
      GRAPHLOOM_RELEASE_REPO="$gh_repo" "${gh_env[@]}" "$@"
  }
  fresh "$work/home" sh "$published/install.sh" --version "$version" --require-signature --allowed-signers "$work/allowed_signers" </dev/null |
    sed 's/^/  /'
  got=$(fresh "$work/home" "$work/home/.local/bin/graphloom" version)
  short=${commit:0:7}
  [ "$got" = "graphloom $version ($short)" ] || die "graphloom version printed '$got', not 'graphloom $version ($short)'"
  echo "installed through gh in a fresh HOME: $got"
  if [ -n "$prev" ]; then
    if [ "$dry_run" = 1 ]; then
      echo "dry run: would also install $prev in a fresh HOME, run graphloom upgrade, and require graphloom $version"
    else
      git -C "$repo" show "v$prev:release/allowed_signers" >"$work/previous_signers" 2>/dev/null || cp "$work/allowed_signers" "$work/previous_signers"
      fresh "$work/home-upgrade" sh "$published/install.sh" --version "$prev" --require-signature --allowed-signers "$work/previous_signers" </dev/null | sed 's/^/  /'
      fresh "$work/home-upgrade" "$work/home-upgrade/.local/bin/graphloom" upgrade </dev/null | sed 's/^/  /'
      got=$(fresh "$work/home-upgrade" "$work/home-upgrade/.local/bin/graphloom" version)
      [ "$got" = "graphloom $version ($short)" ] || die "after graphloom upgrade from $prev, graphloom version printed '$got'"
      echo "upgraded from $prev in a fresh HOME: $got"
    fi
  fi
  echo
  if [ "$dry_run" = 1 ]; then
    echo "release publish $version dry run done in $(($(date +%s) - started))s: nothing was tagged, pushed, or released"
  else
    echo "release publish $version done in $(($(date +%s) - started))s: $tag is released"
  fi
}

case "$cmd" in
  prepare) do_prepare ;;
  build) do_build ;;
  publish) do_publish ;;
esac
