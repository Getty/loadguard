#!/bin/sh
# Rebuild every entry (the "build" script, outdir overridden: the last
# --outdir wins) into a temp dir and compare it byte for byte with the
# committed dist/. Exit 1 on any difference, a missing or an extra file.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bun run build --outdir="$tmp" >/dev/null
rc=0
for name in $( (ls "$tmp"; ls dist) | sort -u); do
    cmp "$tmp/$name" "dist/$name" || rc=1
done
[ "$rc" = 0 ] && echo "dist/ matches a fresh build"
exit "$rc"
