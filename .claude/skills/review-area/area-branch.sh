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
# A file moved into the area keeps its old path in <from>'s tree unless that path is dropped too, and then the
# diff shows it as a new file instead of a rename. Drop the old path of every rename whose new path is in the area,
# counting a split or a rewrite (20% similar): the review then shows what it replaced.
git ls-tree -r --name-only "$to" -- "$@" > "$dir/area-files"
git diff -M20% -l0 --name-status "$from" "$to" |
  awk -F'\t' 'NR == FNR { area[$0] = 1; next } $1 ~ /^R/ && ($3 in area) { print $2 }' "$dir/area-files" - > "$dir/moved"
[ -s "$dir/moved" ] && tr '\n' '\0' < "$dir/moved" | xargs -0 git update-index --force-remove --
git ls-tree -r "$to" -- "$@" | git update-index --index-info
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" -p "$from" -m "Area $area: $(git rev-parse --short "$from")..$(git rev-parse --short "$to")")
git update-ref "refs/heads/area-review/$area" "$commit"
echo "area-review/$area: $(git diff -M -l0 --shortstat "$from" "$commit"), $(wc -l < "$dir/moved" | tr -d ' ') moved in"
