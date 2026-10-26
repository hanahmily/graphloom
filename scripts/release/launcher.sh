#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# bin/graphloom in a release tree (docs/design-release.md §2.3): runs the CLI
# on the tree's bundled Node, from the real path of its version directory, so
# a process keeps loading its own version even if a `current` link moves.
# The bundled Node is not put on PATH.
set -e
self=$(readlink -f "$0")
root=$(dirname "$(dirname "$self")")
exec "$root/node/bin/node" "$root/apps/graphloom/dist/main.js" "$@"
