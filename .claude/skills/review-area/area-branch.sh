#!/bin/sh
# Make a local branch, area-review/<area>, whose one commit is an area's changes from <from> to <to> and
# nothing else, so /code-review and /ponytail-review can review it like a PR. Never push it.
# Usage: area-branch.sh <area> <from> <to> <path prefix>...
set -eu
[ $# -ge 4 ] || { echo "usage: area-branch.sh <area> <from> <to> <path prefix>..." >&2; exit 2; }
area=$1 from=$2 to=$3
shift 3
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
export GIT_INDEX_FILE="$dir/index"
git read-tree "$from"
git rm -r -q -f --cached --ignore-unmatch -- "$@"
git ls-tree -r "$to" -- "$@" | git update-index --index-info
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" -p "$from" -m "Area $area: $(git rev-parse --short "$from")..$(git rev-parse --short "$to")")
git update-ref "refs/heads/area-review/$area" "$commit"
echo "area-review/$area: $(git diff --shortstat "$from" "$commit")"
