#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# The GraphLoom user shim, ~/.local/bin/graphloom (docs/design-release.md §4.1,
# §4.3, §5.4). install.sh writes it from the installed version's shim.sh,
# filling in graphloom_home_default. It is stable across versions:
#
# - `graphloom upgrade` and `graphloom self ...` run in sh, through the
#   install.sh of `current` (or of `previous` when current is missing), so
#   they work even when the current version cannot start.
# - Every other command execs the real path of current's bin/graphloom, whose
#   launcher loads every module from its own version directory.
# - Before that exec, it prints a pending update notice (only to a terminal,
#   never with --json or inside an --on-stop hook) and, at most once a day,
#   starts the detached automatic-update check. Neither changes the
#   command's output or exit code.
GRAPHLOOM_SHIM_VERSION=1
graphloom_home_default=''

home=${GRAPHLOOM_HOME:-${graphloom_home_default:-${XDG_DATA_HOME:-$HOME/.local/share}/graphloom}}
case "$home" in /*) ;; *) home=$(pwd -P)/$home ;; esac
self=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")

installer() {
  if [ -f "$home/current/install.sh" ]; then
    printf '%s\n' "$home/current/install.sh"
    return 0
  fi
  prev=$(sed -n '1p' "$home/previous" 2>/dev/null || true)
  if [ -n "$prev" ] && [ -f "$home/versions/$prev/install.sh" ]; then
    printf '%s\n' "$home/versions/$prev/install.sh"
    return 0
  fi
  echo "graphloom: no installed version under $home has an install.sh; reinstall with install.sh" >&2
  return 1
}

case "${1:-}" in
  upgrade)
    shift
    inst=$(installer) || exit 1
    exec sh "$inst" upgrade --home "$home" --bin-dir "$(dirname "$self")" "$@"
    ;;
  self)
    shift
    case "${1:-}" in
      upgrade)
        echo "graphloom: there is no 'self upgrade'; use graphloom upgrade [<version>]" >&2
        exit 2
        ;;
      list | use | rollback | prune | uninstall) ;;
      *)
        echo "usage: graphloom self list | use <version> | rollback | prune [--dry-run] [--force] | uninstall [--purge-config]" >&2
        exit 2
        ;;
    esac
    inst=$(installer) || exit 1
    exec sh "$inst" self "$@" --home "$home" --bin-dir "$(dirname "$self")" --shim "$self"
    ;;
esac

current=$(readlink -f "$home/current" 2>/dev/null || true)
if [ -z "$current" ] || [ ! -x "$current/bin/graphloom" ]; then
  echo "graphloom: no current version under $home; see graphloom self list, or reinstall with install.sh" >&2
  exit 1
fi

# The notice from the last check: once, to a terminal, never in machine output or a hook.
notice=$home/update/notice
if [ -f "$notice" ] && [ -t 1 ] && [ -t 2 ] && [ -z "${GRAPHLOOM_RUN_ID:-}" ]; then
  json=0
  for arg in "$@"; do
    [ "$arg" = --json ] && json=1
  done
  if [ "$json" = 0 ]; then
    cat "$notice" >&2 2>/dev/null || true
    rm -f "$notice"
  fi
fi

# The daily check: detached, output appended to update/log, never waited for.
if [ "${GRAPHLOOM_DISABLE_AUTOUPDATE:-}" != 1 ] && [ "${1:-}" != __auto-update ]; then
  last=$home/update/last-check
  if [ ! -f "$last" ] || [ -n "$(find "$last" -mtime +0 2>/dev/null)" ]; then
    if mkdir -p "$home/update" 2>/dev/null && touch "$last" 2>/dev/null; then
      detach=
      command -v setsid >/dev/null 2>&1 && detach=setsid
      (
        # The worker runs from /, so a relative runner config path is resolved here.
        case "${GRAPHLOOM_RUNNER_CONFIG:-/}" in /*) ;; *) GRAPHLOOM_RUNNER_CONFIG=$(pwd -P)/$GRAPHLOOM_RUNNER_CONFIG; export GRAPHLOOM_RUNNER_CONFIG ;; esac
        cd / || exit 0
        GRAPHLOOM_HOME=$home GRAPHLOOM_SHIM=$self exec $detach "$current/bin/graphloom" __auto-update \
          </dev/null >>"$home/update/log" 2>&1
      ) &
    fi
  fi
fi

exec "$current/bin/graphloom" "$@"
