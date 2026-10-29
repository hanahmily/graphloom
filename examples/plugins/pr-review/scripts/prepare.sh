#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# Prepare a pr-review task (docs/design-pr-review-graph.md §3.1).
#
#   sh prepare.sh <out-dir> <owner/repo#N | pull request URL> [options]
#
#   --repo <dir>       the operator's review clone (default: the current directory)
#   --remote <name>    its remote that points at the repository on GitHub (default: origin)
#   --base <branch>    the branch the pull request targets (default: the remote's default branch)
#   --config <file>    the profile (default: the plugin's own profiles/<name>.json, where <name>
#                      is the repository's name without a leading "skywalking-")
#
# It fetches refs/pull/N/head and the base branch into
#   refs/graphloom/pr-review-pulls/<owner>/<repo>/<N>/heads/<sha>   (kept, so re-runs find earlier heads)
#   refs/graphloom/pr-review-pulls/<owner>/<repo>/<N>/base  (a sibling of the ledger ref refs/graphloom/pr-review/<owner>/<repo>/<N>, which is a leaf)
# computes the merge base, and writes <out-dir>/<name>-<N>/task.yaml with `base:` set to the merge
# base and the request `Report on owner/repo#N at <sha>.`. The profile is copied beside the task as
# profile.json, and the plugin linked as plugins/pr-review, where a task looks for them.
#
# It runs only `git fetch`, `git ls-remote`, `git merge-base`, `git update-ref`, `git rev-parse` and
# file writes (a copy and a link). No repository code runs: hooks are off (core.hooksPath), no filesystem monitor,
# no submodule recursion, and nothing is checked out.

set -eu

usage() {
  echo "usage: prepare.sh <out-dir> <owner/repo#N | https://github.com/owner/repo/pull/N> [--repo <dir>] [--remote <name>] [--base <branch>] [--config <file>]" >&2
  exit 2
}

fail() {
  echo "prepare.sh: $*" >&2
  exit 1
}

[ $# -ge 2 ] || usage
out=$1
pr=$2
shift 2

repo=.
remote=origin
base_branch=
config=
while [ $# -gt 0 ]; do
  case $1 in
    --repo) [ $# -ge 2 ] || usage; repo=$2; shift 2 ;;
    --remote) [ $# -ge 2 ] || usage; remote=$2; shift 2 ;;
    --base) [ $# -ge 2 ] || usage; base_branch=$2; shift 2 ;;
    --config) [ $# -ge 2 ] || usage; config=$2; shift 2 ;;
    *) usage ;;
  esac
done

# The pull request: owner/repo#N, or its URL.
case $pr in
  https://github.com/*/pull/*)
    path=${pr#https://github.com/}
    owner=${path%%/*}
    rest=${path#*/}
    name=${rest%%/*}
    number=${rest#*/pull/}
    number=${number%%[!0-9]*}
    ;;
  *#*)
    slug=${pr%%#*}
    number=${pr#*#}
    owner=${slug%%/*}
    name=${slug#*/}
    ;;
  *) usage ;;
esac
case $owner in ''|.*|*..*|*[!A-Za-z0-9_.-]*) fail "bad repository owner in $pr" ;; esac
case $name in ''|.*|*..*|*[!A-Za-z0-9_.-]*) fail "bad repository name in $pr" ;; esac
case $number in ''|*[!0-9]*|0*) fail "bad pull request number in $pr" ;; esac
case $remote in ''|-*|*[!A-Za-z0-9_./-]*) fail "bad remote name $remote" ;; esac
case $base_branch in -*|*[!A-Za-z0-9_./-]*) fail "bad base branch $base_branch" ;; esac

repo_dir=$(cd "$repo" 2>/dev/null && pwd -P) || fail "$repo is not a directory"

# Git, with no hook and no filesystem monitor; nothing here runs the repository's code.
g() {
  git -C "$repo_dir" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c fetch.recurseSubmodules=false -c protocol.ext.allow=never "$@"
}

git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1 || fail "$repo_dir is not a Git repository"

ns="refs/graphloom/pr-review-pulls/$owner/$name/$number"

if [ -z "$base_branch" ]; then
  # The remote's default branch: `ref: refs/heads/main	HEAD`.
  base_branch=$(g ls-remote --symref "$remote" HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\(.*\)[[:space:]]HEAD$|\1|p' | head -n 1)
  [ -n "$base_branch" ] || fail "could not read the default branch of $remote; name the pull request's base branch with --base"
fi

g fetch --quiet --no-tags --no-recurse-submodules "$remote" "refs/pull/$number/head" || fail "could not fetch refs/pull/$number/head from $remote"
head=$(g rev-parse --verify "FETCH_HEAD^{commit}") || fail "the fetched head is not a commit"
case $head in *[!0-9a-f]*) fail "unexpected head $head" ;; esac
[ ${#head} -eq 40 ] || fail "unexpected head $head"
g update-ref "$ns/heads/$head" "$head"

g fetch --quiet --no-tags --no-recurse-submodules "$remote" "refs/heads/$base_branch" || fail "could not fetch the base branch $base_branch from $remote"
tip=$(g rev-parse --verify "FETCH_HEAD^{commit}") || fail "the fetched base is not a commit"
g update-ref "$ns/base" "$tip"

merge_base=$(g merge-base "$head" "$tip") || fail "the pull request head and $base_branch share no history"

short=${name#skywalking-}
here=$(cd "$(dirname "$0")/.." && pwd -P)
if [ -z "$config" ]; then
  config="$here/profiles/$short.json"
fi
[ -f "$config" ] || fail "no profile at $config; name one with --config"

# The task names its profile and its plugin relative to the task file, so both sit beside it:
# the profile is copied (a run pins its bytes at intake), the plugin is linked.
dir="$out/$short-$number"
mkdir -p "$dir/plugins"
cp "$config" "$dir/profile.json"
ln -sfn "$here" "$dir/plugins/pr-review"
task="$dir/task.yaml"
{
  echo "graph: pr-review"
  echo "repo: $repo_dir"
  echo "base: $merge_base"
  echo "config: profile.json"
  echo "request: \"Report on $owner/$name#$number at $head.\""
} > "$task"

echo "$task"
echo "head $head, base branch $base_branch at $tip, merge base $merge_base" >&2
