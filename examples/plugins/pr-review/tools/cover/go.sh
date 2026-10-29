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
worst=0

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
  (cd "$r" && go test -coverprofile="$tmp/c.$k" -covermode=set -coverpkg="$cp" $pkgs) > "$tmp/t.$k" 2>&1
  rc=$?
  [ "$rc" -gt "$worst" ] && worst=$rc
  tail -n 25 "$tmp/t.$k" >> "$tmp/log"
  grep -E '^(ok|FAIL|\?|---|panic:|#)' "$tmp/t.$k" | tr '\t' ' ' | cut -c1-200 | head -n 80 | sed 's/^/test /' >> "$tmp/tests"
  if [ -s "$tmp/c.$k" ]; then
    mp=$(cd "$r" && go list -m 2>/dev/null | head -n 1)
    awk -f "$here/goprofile.awk" -v mp="$mp" -v root="$r" "$tmp/spec.txt" "$tmp/c.$k" >> "$tmp/prof"
  else
    printf 'fail go test wrote no coverage profile for module %s (exit %s)\n' "$r" "$rc" >> "$tmp/fails"
  fi
done

{
  echo "graphloom-coverage-v1 go"
  echo "exit $worst"
  cat "$tmp/tests" "$tmp/fails"
  sort "$tmp/prof"
} > "$rep"
cat "$tmp/log"
exit 0
