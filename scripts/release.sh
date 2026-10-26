#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# Local release procedure (docs/design-release.md §6).
#
#   scripts/release.sh build <version> [--commit <rev>] [--out <dir>] [--keep-work]
#
# `build` runs steps 3-8 on a committed revision (default HEAD) and publishes
# nothing: it stages a clean checkout of <rev>, fetches and verifies the pinned
# Node, runs the gate on that Node, packs the SDK, prunes to production
# dependencies, assembles the tree, checks licenses and content, packs the
# tarball, writes SHA256SUMS, and smoke-tests the result with no Node on PATH.
# Assets land in <out> (default release-out/<version>/, which Git ignores),
# with the whole log in <out>/build.log. `prepare` and `publish`, signing,
# and install.sh arrive in later phases (§8).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)

usage() {
  echo "usage: scripts/release.sh build <version> [--commit <rev>] [--out <dir>] [--keep-work]" >&2
  exit 2
}

cmd=${1:-}
case "$cmd" in
  build) ;;
  prepare | publish)
    echo "release.sh $cmd is not implemented yet (phase R5, docs/design-release.md §8)" >&2
    exit 2
    ;;
  *) usage ;;
esac
shift
version=${1:-}
[ -n "$version" ] || usage
shift
rev=HEAD
out=
keep_work=0
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) rev=${2:?--commit needs a revision}; shift 2 ;;
    --out) out=${2:?--out needs a directory}; shift 2 ;;
    --keep-work) keep_work=1; shift ;;
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

commit=$(git -C "$repo" rev-parse --verify "$rev^{commit}")
epoch=$(git -C "$repo" show -s --format=%ct "$commit")
name="graphloom-$version-$platform"
out=${out:-$repo/release-out/$version}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
if [ -n "$(ls -A "$out")" ]; then
  echo "$out is not empty; remove it or pass another --out" >&2
  exit 2
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/graphloom-release-XXXXXX")
work=$(cd "$work" && pwd -P)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] || [ "$keep_work" -eq 1 ]; then
    echo "work directory kept: $work" >&2
  else
    chmod -R u+w "$work" 2>/dev/null || true
    rm -rf "$work"
  fi
}
trap cleanup EXIT
exec > >(tee "$out/build.log") 2>&1

step() { printf '\n== %s\n' "$*"; }
started=$(date +%s)
echo "graphloom release build $version ($platform) from $commit"
echo "SOURCE_DATE_EPOCH=$epoch, work directory $work"

# 3. Stage and fetch.
step "3. stage a clean checkout of $commit and fetch the pinned Node"
src=$work/src
# A clone detached at the commit holds exactly its tracked files, as git archive would, and
# is a work tree, which the gate's example-task tests need (their `repo: .` is the checkout).
git clone -q --no-checkout "$repo" "$src"
git -C "$src" -c advice.detachedHead=false checkout -q --detach "$commit"
git -C "$src" remote remove origin
[ -z "$(git -C "$src" status --porcelain)" ] || { echo "the staged checkout is not clean" >&2; exit 1; }
export SOURCE_DATE_EPOCH=$epoch
staged_version=$(node -p 'require(process.argv[1]).version' "$src/package.json")
if [ "$staged_version" != "$version" ]; then
  echo "the product version at $commit is $staged_version, not $version (root package.json, §3)" >&2
  exit 1
fi
node_dir=$(node "$src/scripts/release/fetch-node.mjs" --pin "$src/release/node.json" --dest "$work/node")
pinned=$node_dir/bin
node_version=$("$pinned/node" --version)
echo "pinned runtime: $node_dir ($node_version)"
# From here on, every step runs on the pinned Node.
export PATH="$pinned:$PATH"
hash -r
[ "$(node --version)" = "$node_version" ] || { echo "the pinned Node is not first on PATH" >&2; exit 1; }
rel=$src/scripts/release

# 4. Gate.
step "4. gate on $node_version: npm ci, build, typecheck, test"
(
  cd "$src"
  NODE_ENV=development npm ci --include=dev
  npm run build
  npm run typecheck
  npm test
)

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
node "$rel/check-tree.mjs" --root "$dest" "${forbid[@]}"
cp "$dest/release.json" "$out/release.json"
tarball=$out/$name.tar.gz
pack() {
  tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -C "$assembly" -cf - "$name" | gzip -n -9 >"$1"
}
pack "$tarball"
echo "tarball: $(basename "$tarball"), $(stat -c %s "$tarball") bytes compressed, $(du -sb "$dest" | cut -f1) bytes unpacked"

# 7. Reproducibility check (R1: a second pack of the same assembled tree; R2 compares two full builds).
step "7. repack the same tree and compare"
pack "$work/repack.tar.gz"
first=$(sha256sum "$tarball" | cut -d' ' -f1)
second=$(sha256sum "$work/repack.tar.gz" | cut -d' ' -f1)
if [ "$first" = "$second" ]; then
  echo "repack: identical ($first)"
else
  echo "repack: differs ($first vs $second); recorded, not claimed reproducible (§2.5)"
fi

# 8. Smoke tests, with no Node on PATH.
step "8. smoke tests on the extracted tarball, with no node on PATH"
smoke=$work/smoke
mkdir -p "$smoke/home" "$smoke/tmp" "$smoke/install"
nonode=$(node "$rel/no-node-path.mjs" --dir "$smoke/bin")
printf '[user]\n\tname = GraphLoom Release Smoke\n\temail = release-smoke@example.invalid\n' >"$smoke/home/.gitconfig"
tar -xzf "$tarball" -C "$smoke/install"
installed=$smoke/install/$name
chmod -R a-w "$installed"
in_smoke() { env -i HOME="$smoke/home" PATH="$nonode" TMPDIR="$smoke/tmp" LANG=C.UTF-8 "$@"; }

in_smoke "$installed/bin/graphloom" version --json >"$smoke/version.json"
node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));const b=JSON.parse(fs.readFileSync(process.argv[2]));if(JSON.stringify(a)!==JSON.stringify(b)){console.error("graphloom version --json does not match release.json");process.exit(1)}' \
  "$smoke/version.json" "$out/release.json"
[ "$(in_smoke "$installed/bin/graphloom" version --root)" = "$installed" ] || { echo "graphloom version --root is not the extracted tree" >&2; exit 1; }
echo "version: $(in_smoke "$installed/bin/graphloom" version) (matches release.json)"

in_smoke "$installed/node/bin/node" "$rel/smoke-preflight.mjs" --root "$installed"

hello=$smoke/hello
mkdir -p "$hello/plugins"
cp "$installed/examples/task.yaml" "$hello/task.yaml"
ln -s "$installed/examples/plugins/hello" "$hello/plugins/hello"
git init -q "$hello/test-repo"
git -C "$hello/test-repo" -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit -q --allow-empty -m "Initialize hello fixture"
(cd "$hello" && in_smoke "$installed/bin/graphloom" check task.yaml >"$smoke/check.json") || { cat "$smoke/check.json"; echo "graphloom check failed" >&2; exit 1; }
echo "check: ok"
(cd "$hello" && in_smoke "$installed/bin/graphloom" rehearse task.yaml --offline >"$smoke/rehearse.json") || { cat "$smoke/rehearse.json"; echo "graphloom rehearse --offline was not-ready" >&2; exit 1; }
verdict=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).verdict' "$smoke/rehearse.json")
echo "rehearse --offline: $verdict"
[ "$verdict" != "not-ready" ] || exit 1

# Checksums (signing arrives with publish, R5).
step "checksums"
(cd "$out" && sha256sum "$(basename "$tarball")" "$(basename "$sdk")" release.json >SHA256SUMS)
cat "$out/SHA256SUMS"
echo
echo "release build $version done in $(($(date +%s) - started))s; assets in $out:"
(cd "$out" && ls -l "$(basename "$tarball")" "$(basename "$sdk")" release.json SHA256SUMS)
