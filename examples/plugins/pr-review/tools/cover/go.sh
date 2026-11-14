#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# go.sh <n> <spec chunk>...   (runs inside the Docker sandbox, in the head checkout)
#
# Statement coverage of the changed Go packages (docs/design-code-quality-metrics.md §2.3):
#   go test -coverprofile=<tmp>/c.out -covermode=set -coverpkg=<touched packages> <touched packages>
# once per Go module that holds a touched package, then the profile reduced to the changed functions' line ranges
# (goprofile.awk) and written, with the facts of the run, to $GRAPHLOOM_REPORT_FILE as graphloom-coverage-v1.
# A failing test does not void coverage: `go test` still writes the profile of what ran, and the exit status is
# recorded as a fact. The script always exits 0 once it has written a report; the report says what happened.
#
# Sandboxed setup first: the `setup <id> <_base64 argument>...` lines of the spec (profile metrics.sandbox.go.setup)
# run in order in the checkout's root, in this same container configuration (no network, read-only mounts), before any
# `go test`: code generation the repository does not commit (design-pr-review-graph.md 12.2). The first one to fail
# ends the run with `setup-fail <id> <exit> <output tail>` and no coverage; the report says why. Setup never runs
# on the host.
#
# Build tags: a `tags <a,b>` line of the spec (profile metrics.sandbox.go.buildTags, the tags the repository's own CI
# passes) becomes `-tags=a,b` on `go test` and on nothing else; the setup commands never get them. The profile validates
# each tag as [A-Za-z0-9_.]+; this script refuses anything else again rather than pass it on.
#
# Timeout: a `timeout <seconds>` line of the spec (the profile's sandbox wall clock less a margin for setup and profile
# collection) is the budget of all `go test` runs together, counted from the start of this script (setup included):
# every `go test` gets `-timeout=<seconds left>s` (at least 1s: 0 would turn the timeout off), so the container's wall
# clock, not go test's default 10 minutes, is the limit. Go starts that clock when a test binary starts, after it was
# compiled or waited its turn, so each binary is also launched through `-exec` by a wrapper that appends
# `-test.timeout=<seconds left at launch>s` (the last one wins): a slow build cannot push a test past the deadline
# before its timeout report and the coverage profile are written. Anything but 1 to 86400 digits is ignored (go
# test's default).
#
# Ginkgo: a `ginkgo <label filter>` line of the spec (profile metrics.sandbox.go.ginkgoLabelFilter, the filter the
# repository's CI passes) reaches only the test binaries that use Ginkgo: a plain test binary refuses the flag. The
# touched packages of a module are split by `go list`, offline, into those whose tests (internal or external) import
# github.com/onsi/ginkgo/v2 and the rest; the rest run as before, the Ginkgo ones with `-args -ginkgo.label-filter=<filter>`,
# each group with its own coverprofile, and the profiles are merged (set mode: a block's largest count) before the
# processing. Without the line there is the one invocation. The filter is passed as one quoted argument, after a
# re-check of its characters ([A-Za-z0-9_.!&|() ,/-], at most 200).
#
# Failures: when `go test` exits non-zero, the failing tests are named in dedicated report lines, from the output with
# colour codes stripped: `failed --- FAIL: <Test>` (Go), `failed [FAIL] <spec>` (Ginkgo's summary) and `failed FAIL <pkg>`
# (at most 15 tests and 5 packages per module, each line cut to 300 characters), and `build-error <first compiler error line>`; a test binary that hit the timeout (`panic: test timed out after 10m0s`) also
# gets `timeout <pkg> <duration> [<TestA,TestB>]` (the tests under `running tests:`, at most 5; at most 5 lines).
#
# The environment is the sandbox's own: GOFLAGS=-mod=readonly, GOPROXY=off, GOTOOLCHAIN=local, a read-only
# module cache, a GOCACHE under the run's scratch, no network.

set -u
here=$(dirname "$0")
n="$1"
shift
spec=""
while [ "$n" -gt 0 ]; do
  spec="$spec$1"
  shift
  n=$((n - 1))
done
rep="${GRAPHLOOM_REPORT_FILE:-/dev/stdout}"
tmp="${TMPDIR:-/tmp}/gl-cover"
rm -rf "$tmp"
mkdir -p "$tmp"
printf '%s' "$spec" > "$tmp/spec.txt"
: > "$tmp/pk"
: > "$tmp/fails"
: > "$tmp/tests"
: > "$tmp/prof"
: > "$tmp/log"
: > "$tmp/failed"
: > "$tmp/builderr"
: > "$tmp/timeouts"
t0=$(date +%s)
worst=0
root0=$(pwd -P)

# decode_run <id> <token>...: the argument tokens are `_` and the base64 of each argv element.
decode_run() {
  sid="$1"
  shift
  count=$#
  while [ "$count" -gt 0 ]; do
    tok="$1"
    shift
    dec=$(printf '%s' "${tok#_}" | base64 -d 2>/dev/null; printf x)
    set -- "$@" "${dec%x}"
    count=$((count - 1))
  done
  [ "$#" -gt 0 ] || return 127
  (cd "$root0" && "$@") < /dev/null > "$tmp/setup.$sid" 2>&1
}

: > "$tmp/setup-ok"
while IFS= read -r line; do
  case "$line" in "setup "*) ;; *) continue ;; esac
  set -f
  # shellcheck disable=SC2086
  set -- $line
  set +f
  shift
  sid="$1"
  shift
  decode_run "$sid" "$@"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    why=$(tail -n 6 "$tmp/setup.$sid" | tr '\n\t' '  ' | sed 's/ *$//' | cut -c1-240)
    {
      echo "graphloom-coverage-v1 go"
      sed 's/^/setup /; s/$/ ok/' "$tmp/setup-ok"
      echo "setup-fail $sid $rc $why"
    } > "$rep"
    tail -n 25 "$tmp/setup.$sid"
    exit 0
  fi
  echo "$sid" >> "$tmp/setup-ok"
done < "$tmp/spec.txt"

tags=$(sed -n 's/^tags //p' "$tmp/spec.txt" | head -n 1)
case "$tags" in *[!A-Za-z0-9_.,]*) tags="" ;; esac
tagarg=""
[ -n "$tags" ] && tagarg="-tags=$tags"
esc=$(printf '\033')

tmo=$(sed -n 's/^timeout //p' "$tmp/spec.txt" | head -n 1)
case "$tmo" in
  "" | *[!0-9]*) tmo="" ;;
  *) [ "${#tmo}" -le 5 ] && [ "$tmo" -ge 1 ] && [ "$tmo" -le 86400 ] || tmo="" ;;
esac
lbl=$(sed -n 's/^ginkgo //p' "$tmp/spec.txt" | head -n 1)
if [ -n "$lbl" ]; then
  if [ "${#lbl}" -gt 200 ] || ! printf '%s' "$lbl" | grep -Eq '^[A-Za-z0-9_.!&|() ,/-]+$'; then lbl=""; fi
fi

# The -exec wrapper: the budget left at the moment a test binary starts, appended last.
if [ -n "$tmo" ]; then
  cat > "$tmp/launch" << 'LAUNCH'
left=$((GRAPHLOOM_COVER_DEADLINE - $(date +%s)))
[ "$left" -ge 1 ] || left=1
exec "$@" "-test.timeout=${left}s"
LAUNCH
  GRAPHLOOM_COVER_DEADLINE=$((t0 + tmo))
  export GRAPHLOOM_COVER_DEADLINE
fi

# gotest <module root> <coverprofile> <output file> <1 for Ginkgo binaries> <package>...: one `go test`, the budget left on the clock.
gotest() {
  g_root="$1"
  g_prof="$2"
  g_out="$3"
  g_ink="$4"
  shift 4
  g_tmo=""
  g_exec=""
  if [ -n "$tmo" ]; then
    g_left=$((t0 + tmo - $(date +%s)))
    [ "$g_left" -ge 1 ] || g_left=1
    g_tmo="-timeout=${g_left}s"
    g_exec="sh $tmp/launch"
  fi
  if [ "$g_ink" = 1 ]; then
    (cd "$g_root" && go test ${tagarg:+"$tagarg"} ${g_tmo:+"$g_tmo"} -coverprofile="$g_prof" -covermode=set -coverpkg="$cp" ${g_exec:+-exec} ${g_exec:+"$g_exec"} "$@" -args "-ginkgo.label-filter=$lbl") > "$g_out" 2>&1
  else
    (cd "$g_root" && go test ${tagarg:+"$tagarg"} ${g_tmo:+"$g_tmo"} -coverprofile="$g_prof" -covermode=set -coverpkg="$cp" ${g_exec:+-exec} ${g_exec:+"$g_exec"} "$@") > "$g_out" 2>&1
  fi
}

# isginkgo <module root> <package>: whether the package's tests import Ginkgo v2 (offline: go list reads the sources and go.mod).
isginkgo() {
  (cd "$1" && go list ${tagarg:+"$tagarg"} -f '{{join .TestImports "\n"}}{{"\n"}}{{join .XTestImports "\n"}}' "$2" 2> /dev/null) | grep -qx 'github.com/onsi/ginkgo/v2'
}

# mergeprofiles <out> <profile>...: one set-mode profile, a block's largest count.
mergeprofiles() {
  m_out="$1"
  shift
  awk 'BEGIN { print "mode: set" } /^mode:/ { next } NF >= 3 { k = $1 " " $2; if (!(k in c)) { o[++n] = k; c[k] = $3 + 0 } else if ($3 + 0 > c[k]) c[k] = $3 + 0 } END { for (i = 1; i <= n; i++) print o[i], c[o[i]] }' "$@" > "$m_out"
}

# failures <output file>: the failing tests and packages, then the first compiler error, as report lines.
failures() {
  sed "s/${esc}\[[0-9;]*[A-Za-z]//g" "$1" | tr '\t\r' '  ' > "$tmp/clean"
  {
    sed -n 's/^ *\(--- FAIL: .*\)$/failed \1/p; s/^ *\(\[FAIL\] .*\)$/failed \1/p' "$tmp/clean" | awk '!seen[$0]++' | head -n 15
    sed -n 's/^\(FAIL  *[^ ].*\)$/failed \1/p' "$tmp/clean" | awk '!seen[$0]++' | head -n 5
  } | cut -c1-307
  awk '
    /^panic: test timed out after / { if (pend) print "timeout - " d (tests != "" ? " " tests : ""); d = $6; pend = (d ~ /^[0-9][0-9.hms]*$/); nt = 0; inrun = 0; tests = ""; next }
    pend && /^ *running tests:/ { inrun = 1; next }
    pend && inrun && /^ +[^ ]+ \([0-9.hms]+\)$/ { if (nt < 5) { tests = tests (nt ? "," : "") $1; nt++ } next }
    pend && inrun { inrun = 0 }
    pend && /^FAIL +[^ ]/ { print "timeout " $2 " " d (tests != "" ? " " tests : ""); pend = 0 }
    END { if (pend) print "timeout - " d (tests != "" ? " " tests : "") }
  ' "$tmp/clean" | head -n 5 | cut -c1-400
  # Go's own refusal when go.mod asks for a newer Go than the image has (GOTOOLCHAIN=local) comes before any compiler error.
  {
    sed -n 's/^\(go: .*requires go >= [^ ]* (running go [^ ;]*; GOTOOLCHAIN=local)\)$/build-error \1/p' "$tmp/clean" | head -n 1
    sed -n 's/^\([^ ][^ ]*\.go:[0-9][0-9]*\(:[0-9][0-9]*\)\{0,1\}: .*\)$/build-error \1/p' "$tmp/clean" | head -n 1
  } | head -n 1 | cut -c1-312
}

modroot() {
  r="$1"
  while :; do
    if [ -f "$r/go.mod" ]; then
      printf '%s' "$r"
      return 0
    fi
    [ "$r" = . ] && return 1
    r=$(dirname "$r")
  done
}

for d in $(sed -n 's/^pkg //p' "$tmp/spec.txt"); do
  if r=$(modroot "$d"); then
    printf '%s %s\n' "$r" "$d" >> "$tmp/pk"
  else
    printf 'fail no go.mod at or above %s\n' "$d" >> "$tmp/fails"
  fi
done

k=0
for r in $(cut -d' ' -f1 "$tmp/pk" | sort -u); do
  k=$((k + 1))
  pkgs=""
  cp=""
  for d in $(awk -v r="$r" '$1 == r { print $2 }' "$tmp/pk"); do
    if [ "$d" = "$r" ]; then
      p=.
    elif [ "$r" = . ]; then
      p="./$d"
    else
      p="./${d#"$r"/}"
    fi
    pkgs="$pkgs $p"
    cp="${cp:+$cp,}$p"
  done
  # shellcheck disable=SC2086
  set -- $pkgs
  if [ -z "$lbl" ]; then
    gotest "$r" "$tmp/c.$k" "$tmp/t.$k" 0 "$@"
    rc=$?
  else
    plain=""
    ink=""
    for p in "$@"; do
      if isginkgo "$r" "$p"; then ink="$ink $p"; else plain="$plain $p"; fi
    done
    rc=0
    : > "$tmp/t.$k"
    : > "$tmp/c.$k"
    rm -f "$tmp/c.$k.plain" "$tmp/c.$k.ink"
    if [ -n "$plain" ]; then
      # shellcheck disable=SC2086
      set -- $plain
      gotest "$r" "$tmp/c.$k.plain" "$tmp/t.$k.plain" 0 "$@"
      rc=$?
      cat "$tmp/t.$k.plain" >> "$tmp/t.$k"
    fi
    if [ -n "$ink" ]; then
      # shellcheck disable=SC2086
      set -- $ink
      gotest "$r" "$tmp/c.$k.ink" "$tmp/t.$k.ink" 1 "$@"
      irc=$?
      [ "$irc" -gt "$rc" ] && rc=$irc
      cat "$tmp/t.$k.ink" >> "$tmp/t.$k"
    fi
    have=""
    for f in "$tmp/c.$k.plain" "$tmp/c.$k.ink"; do
      [ -s "$f" ] && have="$have $f"
    done
    # shellcheck disable=SC2086
    [ -n "$have" ] && mergeprofiles "$tmp/c.$k" $have
  fi
  [ "$rc" -gt "$worst" ] && worst=$rc
  tail -n 25 "$tmp/t.$k" >> "$tmp/log"
  if [ "$rc" -ne 0 ]; then
    failures "$tmp/t.$k" > "$tmp/f.$k"
    grep '^failed ' "$tmp/f.$k" >> "$tmp/failed"
    grep '^build-error ' "$tmp/f.$k" | head -n 1 >> "$tmp/builderr"
    grep '^timeout ' "$tmp/f.$k" >> "$tmp/timeouts"
  fi
  grep -E '^(ok|FAIL|\?|---|panic:|#)' "$tmp/t.$k" | tr '\t' ' ' | cut -c1-200 | head -n 80 | sed 's/^/test /' >> "$tmp/tests"
  if [ -s "$tmp/c.$k" ]; then
    # The module's own path, from its go.mod: in a go.work workspace `go list -m` lists every module.
    gm=$(cd "$r" && go env GOMOD 2>/dev/null)
    mp=$(awk '$1 == "module" { gsub(/"/, "", $2); print $2; exit }' "$gm" 2>/dev/null)
    awk -f "$here/goprofile.awk" -v mp="$mp" -v root="$r" "$tmp/spec.txt" "$tmp/c.$k" >> "$tmp/prof"
  else
    printf 'fail go test wrote no coverage profile for module %s (exit %s)\n' "$r" "$rc" >> "$tmp/fails"
  fi
done

{
  echo "graphloom-coverage-v1 go"
  sed 's/^/setup /; s/$/ ok/' "$tmp/setup-ok"
  echo "exit $worst"
  cat "$tmp/tests" "$tmp/fails"
  head -n 20 "$tmp/failed"
  head -n 1 "$tmp/builderr"
  head -n 5 "$tmp/timeouts"
  sort "$tmp/prof"
} > "$rep"
cat "$tmp/log"
exit 0
