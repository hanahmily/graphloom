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
# key of the setup lines, the Go version and the inventory of the checkout's files and symbolic links (path, type and mode,
# and the content's SHA-256 or the link's target; without .git) before setup. A later job on the same checkout (each job has
# its own disposable checkout) then reproduces the setup's effect instead of running the steps again (SETUP_RESTORED=1): it
# extracts the entries the setup added or changed (kept as a tar, so links and modes survive) and removes those it deleted,
# found by comparing the inventories before and after the steps (never timestamps). A failure is reported again without
# running them.

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

# setup_inventory <out>: one line per regular file and symbolic link of the checkout but .git, sorted by path:
# `./<path><TAB><raw mode in hex: type and permissions><TAB><sha256 of the content | -> link target>`. A change of content,
# of link target, of type or of permission bits changes the line. `stat -c %f` and `readlink` are in coreutils and busybox.
setup_inventory() {
  (
    cd "$su_root" || exit 1
    find . -path ./.git -prune -o \( -type f -o -type l \) -exec stat -c '%f %n' {} + > "$su_work/inv-mode" 2>/dev/null
    find . -path ./.git -prune -o -type f -exec sha256sum {} + > "$su_work/inv-hash" 2>/dev/null
    find . -path ./.git -prune -o -type l -print 2>/dev/null | while IFS= read -r su_p; do printf '%s\t-> %s\n' "$su_p" "$(readlink "$su_p")"; done > "$su_work/inv-link"
    awk -v hash="$su_work/inv-hash" -v link="$su_work/inv-link" '
      BEGIN {
        while ((getline l < hash) > 0) c[substr(l, 67)] = substr(l, 1, 64)
        while ((getline l < link) > 0) { i = index(l, "\t"); c[substr(l, 1, i - 1)] = substr(l, i + 1) }
      }
      { p = substr($0, index($0, " ") + 1); print p "\t" $1 "\t" ((p in c) ? c[p] : "?") }
    ' "$su_work/inv-mode"
  ) | LC_ALL=C sort > "$1"
}

# setup_save <failed 0|1>: keeps this outcome in the cache, best effort (a full disk only means the next job runs the steps).
setup_save() {
  [ -n "$su_cache" ] || return 0
  su_part="$GRAPHLOOM_SETUP_CACHE/.part.$$.$(date +%s)"
  rm -rf "$su_part"
  mkdir -p "$su_part" 2>/dev/null || return 0
  cp "$su_work/setup-ok" "$su_part/ok" || { rm -rf "$su_part"; return 0; }
  : > "$su_part/deleted"
  if [ "$1" = 1 ]; then
    printf '%s %s\n' "$SETUP_FAIL_ID" "$SETUP_FAIL_RC" > "$su_part/fail"
    printf '%s\n' "$SETUP_FAIL_FIRST" > "$su_part/first"
    cp "$su_work/setup-fail.out" "$su_part/out"
  else
    setup_inventory "$su_work/setup-after" || { rm -rf "$su_part"; return 0; }
    # Added or changed (content, link target, type or mode): an inventory line after that was not there before. Deleted: a
    # path before that is gone after. The changed paths are kept as a tar of the checkout's own entries, so a symbolic link
    # stays a link and a mode stays the mode.
    LC_ALL=C comm -13 "$su_work/setup-before" "$su_work/setup-after" | cut -f1 > "$su_work/setup-files"
    cut -f1 "$su_work/setup-before" > "$su_work/setup-paths-before"
    cut -f1 "$su_work/setup-after" > "$su_work/setup-paths-after"
    LC_ALL=C comm -23 "$su_work/setup-paths-before" "$su_work/setup-paths-after" > "$su_part/deleted"
    (cd "$su_root" && tar -cf "$su_part/files.tar" -T "$su_work/setup-files") 2>/dev/null || { rm -rf "$su_part"; return 0; }
  fi
  : > "$su_part/done"
  if [ -e "$su_cache" ]; then rm -rf "$su_part"; else mv "$su_part" "$su_cache" 2>/dev/null || rm -rf "$su_part"; fi
}

# setup_restore: the kept setup's effect on this checkout; non-zero when it did not complete.
setup_restore() {
  # Modes as recorded (-p, not the umask), owned by whoever restores (-o: --no-same-owner).
  (cd "$su_root" && tar -xopf "$su_cache/files.tar") 2>/dev/null || return 1
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
