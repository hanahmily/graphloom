#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# Fill the two caches that apps/graphloom/test/pr-review-coverage-docker.test.ts reads offline.
#
# pr-review's coverage sandbox has no network by design: it mounts the operator's Go module cache
# (`go env GOMODCACHE`) and npm cache (`npm config get cache`) read-only. A fresh machine has both
# empty, so the test's Go and TypeScript fixtures could not be built. This script, run WITH network
# before the tests, puts exactly what those fixtures need into the caches the test and the sandbox
# resolve, then proves the offline use works:
#
#   Go   the fixture's module (github.com/google/uuid v1.2.0), by running the fixture's own `go mod tidy` online.
#   npm  vitest and @vitest/coverage-v8 at the version installed in this repository's node_modules (as the test
#        reads it), with every tarball of their dependency tree, by a real install in a throwaway directory;
#        then an offline lockfile and an offline `npm ci` in a fresh directory must succeed.
#
# Usage (after `npm ci` at the repository root, with `go` and `npm` on PATH):
#   scripts/ci/warm-coverage-caches.sh
# To leave your own caches alone, point them elsewhere first; both tools and the test honour these:
#   GOMODCACHE=/tmp/gomod npm_config_cache=/tmp/npm scripts/ci/warm-coverage-caches.sh
# and run the test with the same two variables. CI additionally sets GRAPHLOOM_REQUIRE_DOCKER_TESTS=1
# so a cache that is still missing fails the test instead of skipping it.

set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/gl-warm-XXXXXX")
trap 'chmod -R u+w "$work" 2>/dev/null || true; rm -rf "$work"' EXIT

# ---- Go
mkdir "$work/go"
printf 'module example.com/fx\n\ngo 1.25\n\nrequire github.com/google/uuid v1.2.0\n' >"$work/go/go.mod"
printf 'package calc\n\nimport "github.com/google/uuid"\n\nfunc ID() string { return uuid.Nil.String() }\n' >"$work/go/f.go"
echo "warm: Go module cache $(cd / && go env GOMODCACHE)"
(cd "$work/go" && GOFLAGS=-mod=mod GOTOOLCHAIN=local go mod tidy)
# The test's own offline step.
(cd "$work/go" && GOFLAGS=-mod=mod GOPROXY=off GOTOOLCHAIN=local go mod tidy)

# ---- npm
version=$(node -p "require('$root/node_modules/vitest/package.json').version")
echo "warm: npm cache $(npm config get cache), vitest $version"
mkdir "$work/npm"
printf '{"name":"fx","private":true,"type":"module","devDependencies":{"vitest":"%s","@vitest/coverage-v8":"%s"}}\n' "$version" "$version" >"$work/npm/package.json"
(cd "$work/npm" && npm install --include=dev --ignore-scripts --no-audit --no-fund)
# What the test does, offline, in a fresh directory, and what the sandbox then does with that lockfile.
mkdir "$work/npm-offline"
cp "$work/npm/package.json" "$work/npm-offline/"
(cd "$work/npm-offline" && npm install --package-lock-only --offline --include=dev --ignore-scripts)
(cd "$work/npm-offline" && npm ci --offline --include=dev --ignore-scripts --no-audit --no-fund)
echo "warm: caches ready"
