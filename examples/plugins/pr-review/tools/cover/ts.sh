#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# ts.sh <n> <spec chunk>...   (runs inside the Docker sandbox, in the head checkout)
#
# Statement coverage of the changed files of one TypeScript workspace (docs/design-code-quality-metrics.md §2.3):
# the repository's own `vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=json` with
# `--coverage.reportsDirectory` under the sandbox's /tmp and `--coverage.include` of the changed files, then
# `coverage-final.json` reduced to the changed functions' line ranges (dist/metrics/tscover-cli.js) and written,
# with the facts of the run, to $GRAPHLOOM_REPORT_FILE as graphloom-coverage-v1. A failing test does not void
# coverage. The script never installs the provider into the repository's declarations: when the checkout has no
# node_modules, it installs the repository's own locked dependencies with `--offline --ignore-scripts` from the
# operator's npm cache (mounted read-only), into the checkout's ignored node_modules. Always exits 0 once it
# has written a report; the report says what happened.

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
root=$(pwd -P)
ws=$(sed -n 's/^ws //p' "$tmp/spec.txt" | head -n 1)
[ -n "$ws" ] || ws=.

say() { printf '%s\n' "$1" >> "$rep"; }
: > "$rep"
say "graphloom-coverage-v1 typescript"

findbin() {
  for c in "$ws/node_modules/.bin/vitest" "node_modules/.bin/vitest"; do
    if [ -x "$root/$c" ]; then
      printf '%s' "$root/$c"
      return 0
    fi
  done
  return 1
}

bin=$(findbin)
if [ -z "$bin" ]; then
  if [ -f package-lock.json ]; then
    npm ci --offline --ignore-scripts --include=dev --no-audit --no-fund > "$tmp/npm.out" 2>&1
  else
    npm install --offline --ignore-scripts --include=dev --no-audit --no-fund --no-package-lock > "$tmp/npm.out" 2>&1
  fi
  rc=$?
  bin=$(findbin)
  if [ -z "$bin" ]; then
    say "exit $rc"
    say "fail the repository's dependencies could not be installed offline from the operator's npm cache"
    tail -n 6 "$tmp/npm.out" | cut -c1-200 | sed 's/^/note /' >> "$rep"
    cat "$tmp/npm.out"
    exit 0
  fi
fi

set -- run --coverage.enabled --coverage.provider=v8 --coverage.reporter=json "--coverage.reportsDirectory=$tmp/cov" --reporter=dot
for f in $(sed -n 's/^file //p' "$tmp/spec.txt"); do
  if [ "$ws" != . ]; then p="${f#"$ws"/}"; else p="$f"; fi
  set -- "$@" "--coverage.include=$p"
done
(cd "$ws" && "$bin" "$@") > "$tmp/vitest.out" 2>&1
rc=$?
say "exit $rc"
grep -E '^ *(Test Files|Tests|FAIL) ' "$tmp/vitest.out" | cut -c1-200 | head -n 40 | sed 's/^/test /' >> "$rep"
if [ -f "$tmp/cov/coverage-final.json" ]; then
  node "$here/../../dist/metrics/tscover-cli.js" --root "$root" --workspace "$ws" --coverage "$tmp/cov/coverage-final.json" --spec "$tmp/spec.txt" >> "$rep" || say "fail the coverage report could not be reduced"
else
  say "fail vitest wrote no coverage report (exit $rc)"
  tail -n 6 "$tmp/vitest.out" | cut -c1-200 | sed 's/^/note /' >> "$rep"
fi
tail -n 30 "$tmp/vitest.out"
exit 0
