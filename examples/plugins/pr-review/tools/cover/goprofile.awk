# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# awk -f goprofile.awk -v mp=<module path> -v root=<module root, repository-relative or .> spec.txt cover.out
#
# Reads the coverage spec (the `fn <path> <start> <end>` lines of formatSpec) and a Go coverprofile, and prints
# the graphloom-coverage-v1 facts (src/metrics/coverage.ts): a `B` line for every block that starts in a changed
# function's line range, and a `seen` line for every file the profile knows. File names in the profile start with
# the module path; they are made repository-relative. With several test binaries `go test` appends one profile
# after another, so a block can occur once per binary: in set mode it is covered when any occurrence is, and is
# printed once.

FNR == NR {
  if ($1 == "fn" && NF >= 4) {
    n[$2]++
    lo[$2, n[$2]] = $3 + 0
    hi[$2, n[$2]] = $4 + 0
  }
  next
}

/^mode:/ { next }

{
  i = match($1, /:[0-9]+\.[0-9]+,[0-9]+\.[0-9]+$/)
  if (i == 0) next
  name = substr($1, 1, i - 1)
  loc = substr($1, i + 1)
  split(loc, a, /[.,]/)
  if (mp != "" && index(name, mp "/") == 1) {
    name = substr(name, length(mp) + 2)
    if (root != "." && root != "") name = root "/" name
  }
  seen[name] = 1
  for (k = 1; k <= n[name]; k++) {
    if (a[1] + 0 >= lo[name, k] && a[1] + 0 <= hi[name, k]) {
      key = name ":" a[1] "." a[2] "," a[3] "." a[4]
      stmts[key] = $2 + 0
      if (!(key in count) || $3 + 0 > count[key]) count[key] = $3 + 0
      break
    }
  }
}

END {
  for (key in count) printf "B %s %s %s\n", key, stmts[key], count[key]
  for (f in seen) print "seen " f
}
