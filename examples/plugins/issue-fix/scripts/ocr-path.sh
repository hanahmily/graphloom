#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# The "ocr" environment check: print the absolute path of the open-code-review
# binary the code reviewer runs, after checking that it has delegation mode.
#
#   sh "$GRAPHLOOM_PLUGIN_ROOT/scripts/ocr-path.sh" [path]
#
# The first of these wins:
#   1. the path given as the argument (a profile naming its own ocr);
#   2. $GRAPHLOOM_OCR_BIN (an operator override);
#   3. the copy this plugin bundles: the native binary of the pinned
#      @alibaba-group/open-code-review dependency, found the way Node resolves
#      the package from this plugin's directory;
#   4. `ocr` on PATH.
# An explicit path (1, 2) never falls back. The bundled binary runs directly,
# not through open-code-review's Node launcher, so no Node is needed on PATH
# and the launcher's background update check never runs. Only shell builtins
# are used, so a PATH holding nothing but `sh` is enough.

set -u

pkg="@alibaba-group/open-code-review"
explicit=${1:-${GRAPHLOOM_OCR_BIN:-}}

absolute() {
  case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac
}

parent() {
  case "$1" in /*/*) printf '%s\n' "${1%/*}" ;; *) printf '/\n' ;; esac
}

delegates() {
  "$1" delegate preview --help >/dev/null 2>&1
}

# Every bundled native binary, best first, one per line. Node resolves `$pkg`
# from the plugin directory upward, and its platform package from `$pkg`'s
# directory upward; this does the same. Installed platform packages come
# first (npm installs only the host's), then the binary open-code-review's
# postinstall downloads when no platform package is installed.
candidates() {
  case "$0" in */*) here=${0%/*} ;; *) here=. ;; esac
  dir=$(cd "$here/.." 2>/dev/null && pwd -P) || return 0
  found=
  while :; do
    if [ -f "$dir/node_modules/$pkg/package.json" ]; then
      # By real path, as Node resolves from it: a repair candidate links the
      # package from the installed plugin's tree, where its platform package is.
      found=$(cd "$dir/node_modules/$pkg" && pwd -P) || return 0
      break
    fi
    [ "$dir" = / ] && return 0
    dir=$(parent "$dir")
  done
  dir=$found
  while :; do
    for bin in "$dir"/node_modules/@alibaba-group/ocr-*/bin/opencodereview; do
      if [ -f "$bin" ] && [ -x "$bin" ]; then printf '%s\n' "$bin"; fi
    done
    [ "$dir" = / ] && break
    dir=$(parent "$dir")
  done
  if [ -f "$found/bin/opencodereview" ] && [ -x "$found/bin/opencodereview" ]; then printf '%s\n' "$found/bin/opencodereview"; fi
  return 0
}

if [ -n "$explicit" ]; then
  p=$(absolute "$explicit")
  [ -f "$p" ] && [ -x "$p" ] || { echo "open-code-review is not an executable file at $p" >&2; exit 127; }
  delegates "$p" || { echo "$p has no delegation mode; install open-code-review 1.9 or later there" >&2; exit 1; }
  printf '%s\n' "$p"
  exit 0
fi

# A platform package for another host does not run; the next candidate is tried.
broken=
list=$(candidates)
saved=$IFS
IFS='
'
set -f
for p in $list; do
  if delegates "$p"; then
    printf '%s\n' "$p"
    exit 0
  fi
  broken=${broken:-$p}
done
set +f
IFS=$saved

if q=$(command -v ocr); then
  p=$(absolute "$q")
  delegates "$p" || { echo "$p has no delegation mode; install open-code-review 1.9 or later" >&2; exit 1; }
  printf '%s\n' "$p"
  exit 0
fi
if [ -n "$broken" ]; then
  echo "the plugin's bundled open-code-review ($broken) does not run 'delegate preview --help', and there is no ocr on PATH" >&2
  exit 1
fi
echo "open-code-review (ocr) is not installed: the plugin's bundled $pkg is missing (run npm ci where the plugin is installed), and there is no ocr on PATH" >&2
exit 127
