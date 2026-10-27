#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Hongtao Gao and the GraphLoom contributors

# GraphLoom installer and install-layout manager (docs/design-release.md §4, §5).
#
#   install.sh [--version <v> | --from <tarball>] [--home <dir>] [--bin-dir <dir>]
#              [--require-signature] [--allowed-signers <file>] [--no-switch] [--auto]
#   install.sh upgrade [<v>] [--no-switch] [--home <dir>] [--bin-dir <dir>]
#   install.sh self list|use <v>|rollback|prune [--dry-run] [--force]|uninstall [--purge-config]
#              [--home <dir>] [--shim <path>]
#
# The user shim (~/.local/bin/graphloom) runs `graphloom upgrade` and
# `graphloom self ...` through the install.sh of `current` (falling back to
# `previous`), so these work in POSIX sh even when the current version cannot
# start. Layout under $GRAPHLOOM_HOME (default ${XDG_DATA_HOME:-~/.local/share}/graphloom):
#
#   versions/<v>/   extracted release tree, read-only; only a rename makes it visible
#   current         symlink to versions/<v>, switched by an atomic rename
#   previous        the version current pointed to before the last switch
#   runs/<id>.json  run ownership records (written by the CLI from R3)
#   install.lock    flock held by every install, switch, and prune
#   update/         automatic-update state (§5.4)
#   .staging/       downloads and extractions in progress; never listed
#
# Needs POSIX sh, tar, gzip, sha256sum, flock, and an authenticated gh (not
# with --from). It never writes operator configuration or credentials and
# never needs root.
set -eu

repo=${GRAPHLOOM_RELEASE_REPO:-hanahmily/graphloom}
platform=linux-x64
# The SSH signature identity and namespace of SHA256SUMS.sig (§2.5).
sig_identity=graphloom-release
sig_namespace=graphloom-release
# Exit status when --auto finds install.lock held: retried at the next daily check.
lock_busy=75

script_dir=$(cd "$(dirname "$0")" && pwd -P)
umask 022

home=
bin_dir=
from=
version=
require_sig=0
signers_flag=
no_switch=0
auto=0
dry_run=0
force=0
purge_config=0
shim_path=
mode=install
upgrading=0
sub=
positional=

say() { printf '%s\n' "$*"; }
warn() { printf 'graphloom install: %s\n' "$*" >&2; }
die() {
  warn "$*"
  if [ "$auto" = 1 ] && [ -n "$home" ]; then record_failure "$*"; fi
  exit 1
}
usage() {
  sed -n '7,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# One-line JSON string escaping for update/last-failure.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

record_failure() {
  mkdir -p "$home/update" 2>/dev/null || return 0
  printf '{"version":"%s","reason":"%s","time":"%s"}\n' "$(json_escape "${version:-}")" "$(json_escape "$1")" "$(now_iso)" \
    >"$home/update/last-failure.tmp.$$" 2>/dev/null && mv -f "$home/update/last-failure.tmp.$$" "$home/update/last-failure" 2>/dev/null || true
}

is_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# vercmp A B: prints -1, 0, or 1.
vercmp() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) { if (x[i] + 0 < y[i] + 0) { print -1; exit } if (x[i] + 0 > y[i] + 0) { print 1; exit } }
    print 0 }'
}
older() { [ "$(vercmp "$1" "$2")" = -1 ]; }
# breaking CURRENT NEXT (§3): a new major, or before 1.0 a new minor.
breaking() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".");
    exit !(x[1] + 0 != y[1] + 0 || (x[1] + 0 == 0 && x[2] + 0 != y[2] + 0)) }'
}

# The value of the string field "$2" in the JSON object in file "$1" (flat records only).
json_field() {
  tr -d '\n' <"$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\(\([^"\\]\|\\.\)*\)".*/\1/p' |
    sed 's/\\"/"/g; s/\\\//\//g; s/\\\\/\\/g'
}

write_atomic() { # file content
  printf '%s\n' "$2" >"$1.tmp.$$"
  mv -f "$1.tmp.$$" "$1"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) version=${2:?--version needs a version}; shift 2 ;;
      --from) from=${2:?--from needs a tarball}; shift 2 ;;
      --home) home=${2:?--home needs a directory}; shift 2 ;;
      --bin-dir) bin_dir=${2:?--bin-dir needs a directory}; shift 2 ;;
      --shim) shim_path=${2:?--shim needs a path}; shift 2 ;;
      --require-signature) require_sig=1; shift ;;
      --allowed-signers) signers_flag=${2:?--allowed-signers needs a file}; shift 2 ;;
      --no-switch) no_switch=1; shift ;;
      --auto) auto=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      --force) force=1; shift ;;
      --purge-config) purge_config=1; shift ;;
      -h | --help) usage ;;
      -*) warn "unknown option $1"; usage ;;
      *)
        if [ -n "$positional" ]; then warn "unexpected argument $1"; usage; fi
        positional=$1; shift ;;
    esac
  done
}

case "${1:-}" in
  upgrade) mode=upgrade; shift ;;
  self)
    mode=self
    sub=${2:-}
    [ -n "$sub" ] || usage
    shift 2
    ;;
esac
parse_args "$@"

: "${HOME:?HOME is not set}"
home=${home:-${GRAPHLOOM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/graphloom}}
bin_dir=${bin_dir:-$HOME/.local/bin}
case "$home" in /*) ;; *) home=$(pwd -P)/$home ;; esac
case "$bin_dir" in /*) ;; *) bin_dir=$(pwd -P)/$bin_dir ;; esac

# ---------------------------------------------------------------- the layout

current_version() {
  if [ -L "$home/current" ]; then basename "$(readlink "$home/current")"; fi
}
previous_version() {
  if [ -f "$home/previous" ]; then sed -n '1p' "$home/previous"; fi
}
skipped_version() {
  if [ -f "$home/update/skip" ]; then sed -n '1p' "$home/update/skip"; fi
}
# Installed versions, newest first. Only complete versions are ever renamed into versions/.
installed_versions() {
  [ -d "$home/versions" ] || return 0
  for d in "$home"/versions/*; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    is_version "$n" && printf '%s\n' "$n"
  done | sort -t. -k1,1nr -k2,2nr -k3,3nr
}
is_installed() { [ -d "$home/versions/$1" ] && is_version "$1"; }

lock() { # wait | nowait
  mkdir -p "$home"
  exec 9>>"$home/install.lock"
  if flock -n 9; then return 0; fi
  if [ "$1" = nowait ]; then
    warn "another install holds $home/install.lock; not waiting"
    exit "$lock_busy"
  fi
  warn "waiting for another install to release $home/install.lock"
  flock 9
}

# Under the lock: nothing else is installing, so every staging entry is stale.
clean_staging() {
  if [ -d "$home/.staging" ]; then
    chmod -R u+w "$home/.staging" 2>/dev/null || true
    rm -rf "$home/.staging"
  fi
  mkdir -p "$home/.staging"
}

switch_to() { # version
  target=$1
  is_installed "$target" || die "GraphLoom $target is not installed under $home"
  cur=$(current_version)
  if [ "$cur" = "$target" ]; then
    say "current is already $target"
    return 0
  fi
  if [ -n "$cur" ]; then write_atomic "$home/previous" "$cur"; fi
  ln -s "versions/$target" "$home/.current.tmp.$$"
  mv -fT "$home/.current.tmp.$$" "$home/current"
  say "current -> $target${cur:+ (was $cur)}"
  # Leaving a version for an older one pauses automatic updates for it (§5.4).
  if [ -n "$cur" ] && older "$target" "$cur"; then
    mkdir -p "$home/update"
    write_atomic "$home/update/skip" "$cur"
    say "automatic updates skip $cur until a newer release or graphloom upgrade"
  fi
  skip=$(skipped_version)
  if [ -n "$skip" ] && ! older "$target" "$skip"; then rm -f "$home/update/skip"; fi
}

# Ownership records (§5.1): runs/<id>.json is {"version", "stateDir", "plugin"?}.
# Prints "<runId> <version> <stateDir>" for each record whose state directory still exists.
live_owners() {
  [ -d "$home/runs" ] || return 0
  for rec in "$home"/runs/*.json; do
    [ -f "$rec" ] || continue
    rv=$(json_field "$rec" version)
    rs=$(json_field "$rec" stateDir)
    [ -n "$rv" ] && [ -n "$rs" ] && [ -d "$rs" ] || continue
    printf '%s %s %s\n' "$(basename "$rec" .json)" "$rv" "$rs"
  done
}
# Versions whose directory a live run's plugin link resolves into.
plugin_link_versions() {
  [ -d "$home/runs" ] || return 0
  versions_real=$(cd "$home/versions" 2>/dev/null && pwd -P) || return 0
  for rec in "$home"/runs/*.json; do
    [ -f "$rec" ] || continue
    rs=$(json_field "$rec" stateDir)
    rp=$(json_field "$rec" plugin)
    [ -n "$rs" ] && [ -d "$rs" ] && [ -n "$rp" ] || continue
    real=$(readlink -f "$rp" 2>/dev/null) || continue
    case "$real" in
      "$versions_real"/*) rel=${real#"$versions_real"/}; printf '%s\n' "${rel%%/*}" ;;
    esac
  done
}

# ---------------------------------------------------------------- install

fetch_with_gh() { # version dir
  command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) is not installed; install it, or download the assets another way and use --from"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in; run gh auth login"
  gh repo view "$repo" --json name >/dev/null 2>&1 || die "gh cannot read $repo; ask a maintainer for read access"
  gh release download "v$1" -R "$repo" -D "$2" -p "graphloom-$1-$platform.tar.gz" -p SHA256SUMS >"$2.log" 2>&1 ||
    die "gh cannot download release v$1 from $repo: $(tail -n 1 "$2.log")"
  # Absent until releases are signed (R5); judged by verify_signature.
  gh release download "v$1" -R "$repo" -D "$2" -p SHA256SUMS.sig >/dev/null 2>&1 || true
}

latest_version() {
  command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) is not installed; name a tarball with --from"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in; run gh auth login"
  tag=$(gh release view -R "$repo" --json tagName -q .tagName 2>/dev/null) || die "gh cannot read the latest release of $repo"
  v=${tag#v}
  is_version "$v" || die "the latest release tag of $repo is '$tag', not v<MAJOR.MINOR.PATCH>"
  printf '%s\n' "$v"
}

# The trust anchor comes with the installer that runs (its version tree, or the
# checkout it is in) or from --allowed-signers, never with the download.
allowed_signers() {
  if [ -n "$signers_flag" ]; then
    [ -f "$signers_flag" ] || die "no such allowed signers file: $signers_flag"
    printf '%s\n' "$signers_flag"
    return 0
  fi
  for f in "$script_dir/release/allowed_signers" "$script_dir/../release/allowed_signers"; do
    if [ -f "$f" ]; then printf '%s\n' "$f"; return 0; fi
  done
}

verify_signature() { # dir
  signers=$(allowed_signers) || exit 1
  reason=
  if [ ! -f "$1/SHA256SUMS.sig" ]; then reason="the release has no SHA256SUMS.sig"
  elif ! command -v ssh-keygen >/dev/null 2>&1; then reason="ssh-keygen is not installed"
  elif [ -z "$signers" ]; then reason="this installer carries no release/allowed_signers"
  fi
  if [ -z "$reason" ]; then
    ssh-keygen -Y verify -f "$signers" -I "$sig_identity" -n "$sig_namespace" -s "$1/SHA256SUMS.sig" <"$1/SHA256SUMS" >/dev/null 2>&1 ||
      die "the signature on SHA256SUMS does not verify against $signers"
    say "signature: verified"
    return 0
  fi
  if [ "$require_sig" = 1 ] || [ "$auto" = 1 ]; then die "a verified signature is required, but $reason"; fi
  warn "cannot verify the signature: $reason; relying on the SHA-256 checksum"
}

verify_checksum() { # dir name
  line=$(grep -E "^[0-9a-f]{64} [ *]$2\$" "$1/SHA256SUMS" | head -n 1) || true
  [ -n "$line" ] || die "SHA256SUMS lists no $2"
  (cd "$1" && printf '%s\n' "$line" | sha256sum -c --status -) || die "checksum mismatch for $2; nothing was extracted"
  say "checksum: $2 ok"
}

# Writes the shim if it is absent or older, by an atomic rename (§4.2 step 5).
write_shim() { # version
  src="$home/versions/$1/shim.sh"
  [ -f "$src" ] || { warn "GraphLoom $1 ships no shim.sh; leaving the shim alone"; return 0; }
  case "$home" in *"'"* | *'|'* | *'&'* | *'\'*) die "the install home $home contains a character the shim cannot hold" ;; esac
  mkdir -p "$bin_dir"
  dest="$bin_dir/graphloom"
  new_ver=$(sed -n 's/^GRAPHLOOM_SHIM_VERSION=\([0-9]*\).*/\1/p' "$src")
  sed "s|^graphloom_home_default=.*|graphloom_home_default='$home'|" "$src" >"$dest.tmp.$$"
  chmod 755 "$dest.tmp.$$"
  if [ -f "$dest" ]; then
    old_ver=$(sed -n 's/^GRAPHLOOM_SHIM_VERSION=\([0-9]*\).*/\1/p' "$dest")
    if [ -n "$old_ver" ] && [ "${old_ver:-0}" -gt "${new_ver:-0}" ] || cmp -s "$dest.tmp.$$" "$dest"; then
      rm -f "$dest.tmp.$$"
      return 0
    fi
  fi
  mv -f "$dest.tmp.$$" "$dest"
  say "shim: $dest"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *) say "note: $bin_dir is not on PATH; add it to run graphloom" ;;
  esac
}

# Prints "<release version> <platform> <node version> <running node version>" from the extracted tree.
inspect_tree() { # dir
  [ -x "$1/node/bin/node" ] || die "the tarball has no node/bin/node"
  "$1/node/bin/node" -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log([r.product === "graphloom" ? r.version : "-", r.platform, "v" + (r.node && r.node.version), process.version].join(" "));
  ' "$1/release.json" 2>/dev/null || die "the bundled Node cannot read release.json"
}

do_install() {
  if [ -n "$from" ] && [ -n "$version" ]; then die "--version and --from are mutually exclusive"; fi
  if [ -n "$from" ]; then
    [ -f "$from" ] || die "no such tarball: $from"
    from=$(cd "$(dirname "$from")" && pwd -P)/$(basename "$from")
    base=$(basename "$from")
    version=${base#graphloom-}
    version=${version%-"$platform".tar.gz}
    is_version "$version" && [ "$base" = "graphloom-$version-$platform.tar.gz" ] ||
      die "$base is not named graphloom-<version>-$platform.tar.gz"
    [ -f "$(dirname "$from")/SHA256SUMS" ] || die "no SHA256SUMS beside $from"
  elif [ -z "$version" ]; then
    version=$(latest_version)
  fi
  is_version "$version" || die "version must be MAJOR.MINOR.PATCH, got $version"
  name="graphloom-$version-$platform"

  if [ "$auto" = 1 ]; then lock nowait; else lock wait; fi
  if [ "$auto" = 1 ]; then
    # The worker decided before taking the lock; decide again now that nothing else can switch.
    skip=$(skipped_version)
    if [ -n "$skip" ] && ! older "$skip" "$version"; then
      say "automatic updates skip $skip; not installing $version"
      exit 0
    fi
    cur=$(current_version)
    if [ -z "$cur" ] || ! older "$cur" "$version"; then
      say "current is ${cur:-missing}, not older than $version; not installing"
      exit 0
    fi
    if breaking "$cur" "$version"; then
      say "$version is a breaking release for current $cur; not installing it automatically"
      exit 0
    fi
  fi
  if [ "$upgrading" = 1 ] && [ "$no_switch" = 0 ]; then
    # Under the lock, so a concurrent upgrade cannot have moved current past it since.
    cur=$(current_version)
    if [ -n "$cur" ] && older "$version" "$cur"; then
      say "$version is older than current $cur; installing without switching"
      no_switch=1
    fi
  fi
  clean_staging
  stage=$(mktemp -d "$home/.staging/$version-XXXXXX")
  mkdir -p "$stage/dl" "$stage/tree"

  # 1-2. Download (or copy) and verify, before anything is extracted.
  if [ -n "$from" ]; then
    cp "$from" "$stage/dl/$name.tar.gz"
    cp "$(dirname "$from")/SHA256SUMS" "$stage/dl/SHA256SUMS"
    if [ -f "$(dirname "$from")/SHA256SUMS.sig" ]; then cp "$(dirname "$from")/SHA256SUMS.sig" "$stage/dl/"; fi
  else
    fetch_with_gh "$version" "$stage/dl"
  fi
  verify_signature "$stage/dl"
  verify_checksum "$stage/dl" "$name.tar.gz"
  sha=$(sha256sum "$stage/dl/$name.tar.gz" | cut -d' ' -f1)

  if [ -e "$home/versions/$version" ]; then
    had=$(cat "$home/versions/$version/.graphloom-tarball.sha256" 2>/dev/null || true)
    [ "$had" = "$sha" ] || die "versions/$version already exists with other contents; an installed version is never overwritten"
    say "GraphLoom $version is already installed"
  else
    # 3. Extract into staging; only the final rename makes the version visible.
    tar -xzf "$stage/dl/$name.tar.gz" -C "$stage/tree" || die "cannot extract $name.tar.gz"
    [ "$(ls -A "$stage/tree")" = "$name" ] || die "$name.tar.gz does not hold exactly $name/"
    tree=$stage/tree/$name
    info=$(inspect_tree "$tree") || exit 1
    set -- $info
    [ "$1" = "$version" ] || die "release.json names version $1, not $version"
    [ "$2" = "$platform" ] || die "release.json names platform $2, not $platform"
    [ "$3" = "$4" ] || die "node/bin/node is $4, but release.json pins $3"
    printf '%s\n' "$sha" >"$tree/.graphloom-tarball.sha256"
    find "$tree" -mindepth 1 ! -type l -exec chmod a-w {} +
    mkdir -p "$home/versions"
    mv -T "$tree" "$home/versions/$version"
    chmod a-w "$home/versions/$version"
    say "installed GraphLoom $version"
  fi
  chmod -R u+w "$stage" 2>/dev/null || true
  rm -rf "$stage"

  # 4. Switch current.
  if [ "$no_switch" = 0 ]; then switch_to "$version"; fi
  # 5. The shim.
  write_shim "$version"
  if [ "$auto" = 1 ]; then
    rm -f "$home/update/last-failure"
    prune_versions 3
  fi
  # 6. The doctor and the setup offer; not for --auto or graphloom upgrade.
  if [ "$auto" = 0 ] && [ "$upgrading" = 0 ]; then offer_setup "$version"; fi
}

# §4.2 step 6: run the installed version's doctor, whose failures do not undo
# the install, then offer graphloom setup when stdin and stdout are terminals
# and no runner config exists. The installer itself never writes configuration.
offer_setup() { # version
  bin="$home/versions/$1/bin/graphloom"
  [ -x "$bin" ] || return 0
  # The doctor and setup are not layout operations: release install.lock first.
  exec 9>&-
  say ""
  say "graphloom doctor:"
  "$bin" doctor || warn "graphloom doctor reported a failure; the install is kept (fix it, then run graphloom doctor again)"
  config=${GRAPHLOOM_RUNNER_CONFIG:-$HOME/.config/graphloom/runner.json}
  say ""
  if [ -f "$config" ]; then
    say "A runner config exists at $config; review it with graphloom setup."
    return 0
  fi
  if [ -t 0 ] && [ -t 1 ]; then
    printf 'No runner config yet. Run graphloom setup now? [Y/n] '
    answer=
    read -r answer || answer=n
    case "$answer" in
      "" | y | Y | yes | YES | Yes) "$bin" setup || warn "graphloom setup did not complete; run graphloom setup when ready" ;;
      *) say "Run graphloom setup when ready." ;;
    esac
  else
    say "No runner config yet: run graphloom setup (graphloom setup --yes in scripts)."
  fi
}

# ---------------------------------------------------------------- self

# Removes versions that nothing keeps. keep_newest > 0 also keeps that many newest (auto-prune).
prune_versions() { # keep_newest
  keep_newest=$1
  cur=$(current_version)
  prev=$(previous_version)
  kept=" $cur $prev "
  if [ "$force" = 0 ]; then
    kept="$kept $(live_owners | cut -d' ' -f2 | tr '\n' ' ') $(plugin_link_versions | tr '\n' ' ') "
  fi
  if [ "$keep_newest" -gt 0 ]; then kept="$kept $(installed_versions | head -n "$keep_newest" | tr '\n' ' ') "; fi
  removed=0
  for v in $(installed_versions); do
    case "$kept" in *" $v "*) continue ;; esac
    if [ "$dry_run" = 1 ]; then
      say "would remove $v"
      continue
    fi
    mkdir -p "$home/.staging"
    chmod u+w "$home/versions/$v"
    # Out of versions/ first, so an interrupted prune never leaves a partial version listed.
    gone=$(mktemp -d "$home/.staging/prune-$v-XXXXXX")
    mv -T "$home/versions/$v" "$gone/$v"
    chmod -R u+w "$gone"
    rm -rf "$gone"
    say "removed $v"
    removed=$((removed + 1))
  done
  if [ "$dry_run" = 0 ] && [ "$removed" = 0 ]; then say "nothing to prune"; fi
}

self_list() {
  cur=$(current_version)
  prev=$(previous_version)
  skip=$(skipped_version)
  owners=$(live_owners)
  links=$(plugin_link_versions)
  any=0
  for v in $(installed_versions); do
    any=1
    marks=
    [ "$v" = "$cur" ] && marks="$marks, current"
    [ "$v" = "$prev" ] && marks="$marks, previous"
    [ "$v" = "$skip" ] && marks="$marks, skipped by automatic updates"
    n=$(printf '%s\n' "$owners" | awk -v v="$v" '$2 == v' | grep -c . || true)
    [ "$n" -gt 0 ] && marks="$marks, owns $n run$([ "$n" = 1 ] || echo s)"
    printf '%s\n' "$links" | grep -qx "$v" && marks="$marks, plugin links"
    printf '%s%s\n' "$v" "${marks:+ ($(printf '%s' "$marks" | sed 's/^, //'))}"
  done
  [ "$any" = 1 ] || say "no GraphLoom version is installed under $home"
  if [ -n "$skip" ] && ! is_installed "$skip"; then say "automatic updates skip $skip"; fi
}

self_uninstall() {
  [ -d "$home/versions" ] || [ -f "$home/install.lock" ] || die "$home is not a GraphLoom install home"
  case "$home" in / | "$HOME" | "$HOME/") die "refusing to remove $home" ;; esac
  lock wait
  owners=$(live_owners)
  if [ -n "$owners" ]; then
    say "runs keep their state under their repositories; remove them with graphloom delete:"
    printf '%s\n' "$owners" | while read -r id v dir; do say "  $id ($v) $dir"; done
  fi
  shim=${shim_path:-$bin_dir/graphloom}
  if [ -f "$shim" ] && grep -q '^GRAPHLOOM_SHIM_VERSION=' "$shim"; then
    rm -f "$shim"
    say "removed $shim"
  fi
  chmod -R u+w "$home" 2>/dev/null || true
  rm -rf "$home"
  say "removed $home"
  if [ "$purge_config" = 1 ]; then
    # Where the CLI reads runner.json and supervisor.json (§4.1), whatever XDG_CONFIG_HOME says.
    config=$HOME/.config/graphloom
    rm -rf "$config"
    say "removed $config"
  fi
}

# Runs still owned by a version older than current (§5.3 step 5).
list_older_runs() {
  cur=$(current_version)
  [ -n "$cur" ] || return 0
  node="$home/versions/$cur/node/bin/node"
  header=0
  live_owners | while read -r id v dir; do
    older "$v" "$cur" || continue
    if [ "$header" = 0 ]; then
      say "runs still on older versions (move one with graphloom resume <run> --upgrade):"
      header=1
    fi
    status=$("$node" -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status ?? "unknown") } catch { console.log("unknown") }' "$dir/state.json" 2>/dev/null || echo unknown)
    installed=
    is_installed "$v" || installed=", not installed"
    say "  $id  $v$installed  $status  graphloom resume $id --upgrade"
  done
}

do_upgrade() {
  [ -z "$from" ] || die "graphloom upgrade takes a version, not --from; use install.sh --from"
  version=${positional:-}
  if [ -z "$version" ]; then version=$(latest_version); fi
  is_version "$version" || die "version must be MAJOR.MINOR.PATCH, got $version"
  upgrading=1
  do_install
  rm -f "$home/update/skip"
  list_older_runs
}

case "$mode" in
  install)
    [ -z "$positional" ] || usage
    do_install
    ;;
  upgrade) do_upgrade ;;
  self)
    case "$sub" in
      list) self_list ;;
      use)
        [ -n "$positional" ] || die "usage: graphloom self use <version>"
        lock wait
        switch_to "$positional"
        ;;
      rollback)
        lock wait
        prev=$(previous_version)
        [ -n "$prev" ] || die "no previous version is recorded"
        is_installed "$prev" || die "the previous version $prev is no longer installed"
        switch_to "$prev"
        ;;
      prune)
        lock wait
        prune_versions 0
        ;;
      uninstall) self_uninstall ;;
      upgrade) die "there is no graphloom self upgrade; use graphloom upgrade" ;;
      *) usage ;;
    esac
    ;;
esac
