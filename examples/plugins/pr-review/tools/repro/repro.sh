#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# repro.sh <n> <spec chunk>...   (runs inside the Docker sandbox, in the head checkout)
#
# One reproducing test of one finding (docs/design-pr-review-graph.md 8.2): the reviewer's test file, run twice against the
# head, and the outcome of each run written to $GRAPHLOOM_REPORT_FILE as graphloom-repro-v1. The test text arrives as
# base64 in the spec and is written under $GRAPHLOOM_REPRO_TMP (default /tmp/repro), never into the checkout.
#
#   Go: go test -overlay <tmp>/overlay.json -run '^<name>$' -count=1 -timeout <s>s -json ./<dir>, twice.
#       overlay.json maps <module>/<dir>/graphloom_repro_<F>_test.go, a path absent from the head, to the scratch file, so the
#       test compiles into its package (it may reach unexported code) and the checkout is not written. Two separate
#       invocations instead of -count=2: a panic ends a test binary, so a second run in the same binary would never happen.
#   TypeScript: vitest on the scratch file <tmp>/graphloom-repro-<F>.test.ts, with the workspace's own config; the generated
#       config (tools/repro/vitest.config.mjs, a template) prepends a resolveId hook that resolves every import of the scratch
#       file as if it were imported from <dir>/graphloom-repro-<F>.test.ts; vitest-summary.mjs reads each run's json report.
#       Twice, --retry=0.
#
# The report's lines: `graphloom-repro-v1 <go|typescript>`, `finding`, `sha256` (of the decoded test), `file` (the test's
# base name), then per run n (1 or 2): `run n <failed|passed|build-failed|timeout|killed>`, `at n <file>:<line>` (a failing
# assertion of the test itself), `frame n <path>:<line>` (a panic's frame in the repository), `message n <text>` (at most 2000
# characters, newlines as a return symbol). `setup-fail <why>` instead of runs when the test could not be set up (the
# dependencies could not be installed offline, a bad spec). Always exits 0 once it has written a report.

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
tmp="${GRAPHLOOM_REPRO_TMP:-/tmp/repro}"
rm -rf "$tmp"
mkdir -p "$tmp"
printf '%s' "$spec" > "$tmp/spec.txt"
root=$(pwd -P)

say() { printf '%s\n' "$1" >> "$rep"; }
: > "$rep"
val() { sed -n "s/^$1 //p" "$tmp/spec.txt" | head -n 1; }

lang=$(val lang)
finding=$(val finding)
dir=$(val dir)
expect=$(val expect)
secs=$(val timeout)
ws=$(val ws)
name=$(val name | base64 -d 2>/dev/null)
[ -n "$ws" ] || ws=.

bad=""
case "$lang" in go|ts) ;; *) bad="lang" ;; esac
printf '%s' "$finding" | grep -Eq '^F[0-9]+$' || bad="finding"
printf '%s' "$dir" | grep -Eq '^[A-Za-z0-9._@+/-]+$' || bad="dir"
case "/$dir/" in *"/../"*|*"//"*) bad="dir" ;; esac
printf '%s' "$ws" | grep -Eq '^[A-Za-z0-9._@+/-]+$' || bad="ws"
case "/$ws/" in *"/../"*) bad="ws" ;; esac
printf '%s' "$secs" | grep -Eq '^[0-9]{1,5}$' || bad="timeout"
case "$expect" in assertion|panic) ;; *) bad="expect" ;; esac
if [ "$lang" = go ]; then printf '%s' "$name" | grep -Eq '^Test[A-Za-z0-9_]*$' || bad="name"; fi
if [ -n "$bad" ]; then
  say "graphloom-repro-v1 go"
  say "setup-fail the spec has a bad $bad"
  exit 0
fi

# The TypeScript workspace: the nearest directory at or above <dir> whose package.json declares vitest, unless the spec names one.
if [ "$lang" = ts ] && [ "$ws" = auto ]; then
  ws="$dir"
  found=""
  while :; do
    if [ -f "$root/$ws/package.json" ] && grep -q '"vitest"' "$root/$ws/package.json"; then found=1; break; fi
    [ "$ws" = . ] && break
    case "$ws" in */*) ws="${ws%/*}" ;; *) ws=. ;; esac
  done
  if [ -z "$found" ]; then
    say "graphloom-repro-v1 typescript"
    say "setup-fail no package.json at or above $dir declares vitest"
    exit 0
  fi
fi

language=go
[ "$lang" = go ] || language=typescript
say "graphloom-repro-v1 $language"
say "finding $finding"
val file | base64 -d > "$tmp/test.txt" 2>/dev/null
say "sha256 $(sha256sum "$tmp/test.txt" | cut -d' ' -f1)"

# The text of an `output` event's Output field, JSON escapes undone well enough to read.
unescape() { sed -e 's/\\n$//' -e 's/\\t/	/g' -e 's/\\"/"/g' -e 's/\\\\/\\/g'; }
# A multi-line text as one line.
oneline() { tr '\n' '@' | sed 's/@/⏎/g'; }

# ---------------------------------------------------------------------------- Go
if [ "$lang" = go ]; then
  file="graphloom_repro_${finding}_test.go"
  say "file $file"
  cp "$tmp/test.txt" "$tmp/$file"
  # The module that holds the package: the nearest go.mod at or above <dir>.
  mod="$dir"
  while [ ! -f "$root/$mod/go.mod" ] && [ "$mod" != . ]; do
    case "$mod" in */*) mod="${mod%/*}" ;; *) mod=. ;; esac
  done
  if [ "$mod" = . ]; then rel="$dir"; elif [ "$mod" = "$dir" ]; then rel=.; else rel="${dir#"$mod"/}"; fi
  printf '{"Replace":{"%s":"%s"}}\n' "$root/$dir/$file" "$tmp/$file" > "$tmp/overlay.json"
  i=1
  while [ "$i" -le 2 ]; do
    out="$tmp/out.$i"
    (cd "$root/$mod" && timeout "$((secs + 30))" go test -overlay "$tmp/overlay.json" -run "^${name}\$" -count=1 -timeout "${secs}s" -json "./$rel") > "$out" 2> "$tmp/err.$i"
    rc=$?
    mine="$tmp/mine.$i"
    grep "\"Test\":\"$name\"" "$out" > "$mine" 2>/dev/null
    term=$(grep -o '"Action":"\(pass\|fail\|skip\)"' "$mine" | tail -n 1)
    if grep -q 'panic: test timed out' "$out" "$tmp/err.$i" 2>/dev/null || [ "$rc" = 124 ]; then
      say "run $i timeout"
    elif [ "$term" = '"Action":"fail"' ]; then
      say "run $i failed"
      grep '"Action":"output"' "$mine" | sed -n 's/.*"Output":"\(.*\)"}$/\1/p' | unescape > "$tmp/lines.$i"
      at=$(sed -n "s/^ *\\(graphloom_repro_${finding}_test\\.go:[0-9][0-9]*\\): .*/\\1/p" "$tmp/lines.$i" | head -n 1)
      [ -z "$at" ] || say "at $i $at"
      # A panic's frames in the repository: a tab, then an absolute path under the checkout, without the test's own file.
      sed -n "s|^	$root/\\([^ ]*\\.go\\):\\([0-9][0-9]*\\).*|\\1:\\2|p" "$tmp/lines.$i" | grep -v "$file" | head -n 12 | while read -r fr; do say "frame $i $fr"; done
      msg=$(grep -v -e '^=== ' -e '^--- ' -e '^FAIL' -e '^exit status' "$tmp/lines.$i" | oneline | cut -c1-2000)
      say "message $i $msg"
    elif [ "$term" = '"Action":"pass"' ] || [ "$term" = '"Action":"skip"' ]; then
      say "run $i passed"
    else
      say "run $i build-failed"
      msg=$( { cat "$tmp/err.$i"; sed -n 's/.*"Output":"\(.*\)"}$/\1/p' "$out" | unescape; } | grep -v -e '^FAIL' -e '^ok ' | head -n 8 | oneline | cut -c1-1000)
      [ -n "$msg" ] || msg="the named test did not run"
      say "message $i $msg"
    fi
    i=$((i + 1))
  done
  tail -n 20 "$tmp/out.2"
  exit 0
fi

# ---------------------------------------------------------------------------- TypeScript
file="graphloom-repro-${finding}.test.ts"
say "file $file"
scratch="$tmp/$file"
cp "$tmp/test.txt" "$scratch"

# Where the repository installs its dependencies, as coverage's ts.sh does it: the workspace's own lockfile when it has one.
if [ -f "$ws/package-lock.json" ]; then ir="$ws"; elif [ -f package-lock.json ]; then ir=.; else ir="$ws"; fi
findbin() {
  for c in "$ws/node_modules/.bin/vitest" "$ir/node_modules/.bin/vitest" "node_modules/.bin/vitest"; do
    if [ -x "$root/$c" ]; then printf '%s' "$root/$c"; return 0; fi
  done
  return 1
}
bin=$(findbin)
if [ -z "$bin" ]; then
  if [ -f "$ir/package-lock.json" ]; then
    (cd "$ir" && npm ci --offline --ignore-scripts --include=dev --no-audit --no-fund) > "$tmp/npm.out" 2>&1
  else
    (cd "$ir" && npm install --offline --ignore-scripts --include=dev --no-audit --no-fund --no-package-lock) > "$tmp/npm.out" 2>&1
  fi
  bin=$(findbin)
  if [ -z "$bin" ]; then
    say "setup-fail the repository's dependencies could not be installed offline from the operator's npm cache"
    exit 0
  fi
fi

# The workspace's own vitest (or vite) config, which the generated one imports.
base=""
for c in vitest.config.ts vitest.config.mts vitest.config.js vitest.config.mjs vitest.config.cjs vite.config.ts vite.config.mts vite.config.js vite.config.mjs vite.config.cjs; do
  if [ -f "$root/$ws/$c" ]; then base="$root/$ws/$c"; break; fi
done
if [ -n "$base" ]; then
  sed -e "s|@BASE@|$base|" -e "s|@SCRATCH@|$scratch|" -e "s|@VIRTUAL@|$root/$dir/$file|" -e "s|@TMP@|$tmp|" -e "s|@WS@|$root/$ws|" -e "s|@ROOT@|$root|" "$here/vitest.config.mjs" > "$tmp/vitest.config.mjs"
else
  sed -e '/@BASE@/d' -e 's|baseModule.default ?? {}|{}|' -e "s|@SCRATCH@|$scratch|" -e "s|@VIRTUAL@|$root/$dir/$file|" -e "s|@TMP@|$tmp|" -e "s|@WS@|$root/$ws|" -e "s|@ROOT@|$root|" "$here/vitest.config.mjs" > "$tmp/vitest.config.mjs"
fi
nameb64=$(printf '%s' "$name" | base64 | tr -d '\n')
i=1
while [ "$i" -le 2 ]; do
  (cd "$root/$ws" && timeout "$((secs + 30))" "$bin" run --config "$tmp/vitest.config.mjs" --root "$root/$ws" --retry=0 --reporter=json "--outputFile=$tmp/r$i.json") > "$tmp/out.$i" 2>&1
  rc=$?
  if [ "$rc" = 124 ]; then
    say "run $i timeout"
  elif [ -s "$tmp/r$i.json" ]; then
    node "$here/vitest-summary.mjs" "$tmp/r$i.json" "$i" "$file" "$root" "$nameb64" >> "$rep" || say "run $i killed"
  else
    say "run $i build-failed"
    say "message $i $(tail -n 8 "$tmp/out.$i" | cut -c1-200 | oneline | cut -c1-1000)"
  fi
  i=$((i + 1))
done
tail -n 20 "$tmp/out.2"
exit 0
