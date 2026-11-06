#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# A local stand-in for the GitHub CLI (docs/design-release.md §6, phase R5).
# `release.sh publish --dry-run` puts it first on PATH to rehearse the
# published install path against the local assets, and the release tests use
# it in place of GitHub. It serves releases from $GRAPHLOOM_STUB_GH_RELEASES/<tag>/
# (one directory of assets per release; a `.draft` or `.prerelease` file marks
# one) and appends each call to $GRAPHLOOM_STUB_GH_LOG when that is set.
# Supported: auth status, auth token, repo view, release list|view|download|create,
# and pr create. Anything else fails.
set -eu

rel=${GRAPHLOOM_STUB_GH_RELEASES:?GRAPHLOOM_STUB_GH_RELEASES is not set}
if [ -n "${GRAPHLOOM_STUB_GH_LOG:-}" ]; then printf '%s\n' "$*" >>"$GRAPHLOOM_STUB_GH_LOG"; fi

# Tags of published releases, newest last (no drafts or prereleases).
published() {
  for d in "$rel"/v*; do
    [ -d "$d" ] && [ ! -f "$d/.draft" ] && [ ! -f "$d/.prerelease" ] && basename "$d"
  done | sort -V
}

case "${1:-} ${2:-}" in
  "auth status") exit "${GRAPHLOOM_STUB_GH_AUTH_STATUS:-0}" ;;
  "auth token") echo "stub-token"; exit 0 ;;
  "repo view") echo '{"name":"graphloom"}'; exit 0 ;;
  "release list")
    printf '['
    sep=
    for d in "$rel"/v*; do
      [ -d "$d" ] || continue
      draft=false
      pre=false
      [ -f "$d/.draft" ] && draft=true
      [ -f "$d/.prerelease" ] && pre=true
      printf '%s{"tagName":"%s","isDraft":%s,"isPrerelease":%s}' "$sep" "$(basename "$d")" "$draft" "$pre"
      sep=,
    done
    printf ']\n'
    exit 0
    ;;
  "release view")
    t=$(published | tail -n 1)
    case "${3:-}" in v*) t=$3; [ -d "$rel/$t" ] || t= ;; esac
    [ -n "$t" ] || { echo "release not found" >&2; exit 1; }
    echo "$t"
    exit 0
    ;;
  "release download")
    tag=$3
    shift 3
    dest=.
    pats=
    while [ $# -gt 0 ]; do
      case "$1" in
        -R | --repo) shift 2 ;;
        -D | --dir) dest=$2; shift 2 ;;
        -p | --pattern) pats="$pats $2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -d "$rel/$tag" ] || { echo "release not found" >&2; exit 1; }
    mkdir -p "$dest"
    n=0
    for f in "$rel/$tag"/*; do
      [ -f "$f" ] || continue
      b=$(basename "$f")
      if [ -z "$pats" ]; then cp "$f" "$dest/"; n=$((n + 1)); continue; fi
      set -f
      for p in $pats; do
        case "$b" in $p) cp "$f" "$dest/"; n=$((n + 1)) ;; esac
      done
      set +f
    done
    [ "$n" -gt 0 ] || { echo "no assets match the file pattern" >&2; exit 1; }
    exit 0
    ;;
  "release create")
    tag=$3
    shift 3
    notes=
    assets=
    while [ $# -gt 0 ]; do
      case "$1" in
        -R | --repo | -t | --title | --target) shift 2 ;;
        -F | --notes-file) notes=$2; shift 2 ;;
        --verify-tag | --latest) shift ;;
        -*) echo "stub gh: unsupported release create option $1" >&2; exit 1 ;;
        *) assets="$assets
$1"; shift ;;
      esac
    done
    [ ! -e "$rel/$tag" ] || { echo "a release with tag $tag already exists" >&2; exit 1; }
    mkdir -p "$rel/$tag"
    printf '%s\n' "$assets" | while IFS= read -r a; do [ -z "$a" ] || cp "$a" "$rel/$tag/"; done
    if [ -n "$notes" ]; then cp "$notes" "$rel/$tag/.notes"; fi
    echo "https://github.com/stub/releases/tag/$tag"
    exit 0
    ;;
  "pr create")
    # Keep the body, so a test can read what the PR says.
    if [ -n "${GRAPHLOOM_STUB_GH_LOG:-}" ]; then
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then cat "$2" >"$GRAPHLOOM_STUB_GH_LOG.pr-body"; fi
        shift
      done
    fi
    echo "https://github.com/stub/pull/1"; exit 0 ;;
esac
echo "stub gh: unsupported: $*" >&2
exit 1
