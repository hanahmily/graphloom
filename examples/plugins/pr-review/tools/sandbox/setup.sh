# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# setup.sh: sourced (`. setup.sh`) by tools/cover/go.sh and tools/repro/repro.sh, inside the Docker sandbox, in the head
# checkout. It runs the profile's sandboxed setup (metrics.sandbox.go.setup, docs/design-pr-review-graph.md 6.8 and 8.2):
# the spec's `setup <id> <_base64 argument>...` lines, in order, in the checkout's root, in the caller's own container
# configuration (no network, read-only mounts). Setup never runs on the host.
#
#   setup_run <spec file> <work dir> [<seconds>]
#
# Returns 0 when there is no setup or every step succeeded (the ids that did are in <work dir>/setup-ok, one per line) and 1
# when a step failed: SETUP_FAIL_ID, SETUP_FAIL_RC, SETUP_FAIL_FIRST (the first line of the step's whole output that reads as
# an error, else its last line) are set, and <work dir>/setup-fail.out holds the output's tail. <seconds>, when given, bounds
# all the steps together (a step still running then is stopped and fails with exit 124).
#
# Once per head: when GRAPHLOOM_SETUP_CACHE names a writable directory (the run's scratch), the outcome is kept there under a
# key of the setup lines, the Go version and the inventory of the checkout's files (path and SHA-256, without .git) before
# setup. A later job on the same checkout (each job has its own disposable checkout) then reproduces the setup's effect
# instead of running the steps again (SETUP_RESTORED=1): it copies the files the setup added or changed and removes those it
# deleted, found by comparing the inventories before and after the steps (contents, never timestamps). A failure is
# reported again without running them.

# setup_decode <id> <token>...: runs one step, its argument tokens being `_` and the base64 of each argv element.
setup_decode() {
  su_sid="$1"
  shift
  su_count=$#
  while [ "$su_count" -gt 0 ]; do
    su_tok="$1"
    shift
    su_dec=$(printf '%s' "${su_tok#_}" | base64 -d 2>/dev/null; printf x)
    set -- "$@" "${su_dec%x}"
    su_count=$((su_count - 1))
  done
  [ "$#" -gt 0 ] || return 127
  if [ -n "$su_deadline" ]; then
    su_left=$((su_deadline - $(date +%s)))
    [ "$su_left" -ge 1 ] || return 124
    (cd "$su_root" && timeout -k 10 "$su_left" "$@") < /dev/null > "$su_work/setup.$su_sid" 2>&1
  else
    (cd "$su_root" && "$@") < /dev/null > "$su_work/setup.$su_sid" 2>&1
  fi
}

# setup_first <file>: the first line of the whole file that reads as an error, else its last non-empty line, on one line of at
# most 240 characters.
setup_first() {
  su_line=$(sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g" "$1" | tr '\t\r' '  ' | grep -E '[Ee]rror|ERROR|[Ff]ail|FAIL|[Cc]annot|[Nn]ot found|[Nn]o such|[Dd]enied|panic:|requires go >=' | head -n 1)
  [ -n "$su_line" ] || su_line=$(tr '\t\r' '  ' < "$1" | grep -v '^ *$' | tail -n 1)
  printf '%s' "$su_line" | sed 's/^ *//; s/ *$//' | cut -c1-240
}

# setup_inventory <out>: `<sha256>  ./<path>` of every file of the checkout but .git, sorted.
setup_inventory() {
  (cd "$su_root" && find . -path ./.git -prune -o -type f -exec sha256sum {} + 2>/dev/null) | LC_ALL=C sort > "$1"
}

# setup_save <failed 0|1>: keeps this outcome in the cache, best effort (a full disk only means the next job runs the steps).
setup_save() {
  [ -n "$su_cache" ] || return 0
  su_part="$GRAPHLOOM_SETUP_CACHE/.part.$$.$(date +%s)"
  rm -rf "$su_part"
  mkdir -p "$su_part/files" 2>/dev/null || return 0
  cp "$su_work/setup-ok" "$su_part/ok" || { rm -rf "$su_part"; return 0; }
  : > "$su_part/deleted"
  if [ "$1" = 1 ]; then
    printf '%s %s\n' "$SETUP_FAIL_ID" "$SETUP_FAIL_RC" > "$su_part/fail"
    printf '%s\n' "$SETUP_FAIL_FIRST" > "$su_part/first"
    cp "$su_work/setup-fail.out" "$su_part/out"
  else
    setup_inventory "$su_work/setup-after" || { rm -rf "$su_part"; return 0; }
    # Added or changed: an inventory line after that was not there before. Deleted: a path before that is gone after.
    LC_ALL=C comm -13 "$su_work/setup-before" "$su_work/setup-after" | cut -c67- > "$su_work/setup-files"
    cut -c67- "$su_work/setup-before" | LC_ALL=C sort > "$su_work/setup-paths-before"
    cut -c67- "$su_work/setup-after" | LC_ALL=C sort > "$su_work/setup-paths-after"
    LC_ALL=C comm -23 "$su_work/setup-paths-before" "$su_work/setup-paths-after" > "$su_part/deleted"
    while IFS= read -r su_f; do
      su_d=$(dirname "$su_f")
      mkdir -p "$su_part/files/$su_d" && cp "$su_root/$su_f" "$su_part/files/$su_f" || { rm -rf "$su_part"; return 0; }
    done < "$su_work/setup-files"
  fi
  : > "$su_part/done"
  if [ -e "$su_cache" ]; then rm -rf "$su_part"; else mv "$su_part" "$su_cache" 2>/dev/null || rm -rf "$su_part"; fi
}

# setup_restore: the kept setup's effect on this checkout; non-zero when it did not complete.
setup_restore() {
  cp -R "$su_cache/files/." "$su_root/" 2>/dev/null || return 1
  while IFS= read -r su_f; do
    rm -f "$su_root/$su_f" || return 1
  done < "$su_cache/deleted"
}

setup_run() {
  su_spec="$1"
  su_work="$2"
  su_secs="${3:-}"
  su_root=$(pwd -P)
  su_deadline=""
  case "$su_secs" in "" | *[!0-9]*) ;; *) [ "${#su_secs}" -le 5 ] && [ "$su_secs" -ge 1 ] && su_deadline=$(($(date +%s) + su_secs)) ;; esac
  SETUP_FAIL_ID=""
  SETUP_FAIL_RC=""
  SETUP_FAIL_FIRST=""
  SETUP_RESTORED=""
  : > "$su_work/setup-ok"
  grep '^setup ' "$su_spec" > "$su_work/setup-lines" 2>/dev/null || return 0

  su_cache=""
  if [ -n "${GRAPHLOOM_SETUP_CACHE:-}" ] && [ -d "$GRAPHLOOM_SETUP_CACHE" ] && [ -w "$GRAPHLOOM_SETUP_CACHE" ]; then
    setup_inventory "$su_work/setup-before"
    su_key=$({
      cat "$su_work/setup-lines"
      go version 2>/dev/null
      cat "$su_work/setup-before"
    } | sha256sum | cut -c1-32)
    su_cache="$GRAPHLOOM_SETUP_CACHE/$su_key"
  fi
  if [ -n "$su_cache" ] && [ -f "$su_cache/done" ]; then
    if [ -f "$su_cache/fail" ]; then
      cp "$su_cache/ok" "$su_work/setup-ok"
      read -r SETUP_FAIL_ID SETUP_FAIL_RC < "$su_cache/fail"
      SETUP_FAIL_FIRST=$(head -n 1 "$su_cache/first")
      cp "$su_cache/out" "$su_work/setup-fail.out"
      SETUP_RESTORED=1
      return 1
    fi
    if setup_restore; then
      cp "$su_cache/ok" "$su_work/setup-ok"
      SETUP_RESTORED=1
      return 0
    fi
    # A restore that did not complete leaves the tree uncertain: the steps run again over it, and nothing is kept.
    su_cache=""
  fi

  while IFS= read -r su_l; do
    set -f
    # shellcheck disable=SC2086
    set -- $su_l
    set +f
    shift
    su_id="$1"
    shift
    setup_decode "$su_id" "$@"
    su_rc=$?
    if [ "$su_rc" -ne 0 ]; then
      SETUP_FAIL_ID="$su_id"
      SETUP_FAIL_RC="$su_rc"
      # The tail is for the record; the reason is read from the step's whole output.
      tail -n 25 "$su_work/setup.$su_id" > "$su_work/setup-fail.out"
      if [ "$su_rc" = 124 ] && [ -n "$su_deadline" ]; then
        SETUP_FAIL_FIRST="did not finish within ${su_secs}s"
      else
        SETUP_FAIL_FIRST=$(setup_first "$su_work/setup.$su_id")
      fi
      [ -n "$SETUP_FAIL_FIRST" ] || SETUP_FAIL_FIRST="exited $su_rc with no output"
      setup_save 1
      return 1
    fi
    echo "$su_id" >> "$su_work/setup-ok"
  done < "$su_work/setup-lines"
  setup_save 0
  return 0
}
