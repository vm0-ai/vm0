#!/bin/bash
# Lane Status — parallel query of issues + PRs per worker lane
# Usage:
#   scripts/lane-status.sh <label>              # single lane
#   scripts/lane-status.sh <label1-labelN>      # range (e.g., vm01-vm04)
#   scripts/lane-status.sh <label> --user LOGIN  # explicit user
#
# Output: JSON array of lane objects with issues, prs, counts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
  echo "Usage: $0 <label|range> [--user LOGIN]" >&2
  exit 1
}

[[ $# -lt 1 ]] && usage

LABEL_ARG="$1"
shift
USER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [[ -z "$USER" ]]; then
  USER=$(gh api user --jq '.login')
fi

# Parse label arg into array of lanes
LANES=()
if [[ "$LABEL_ARG" =~ ^([a-zA-Z]+)([0-9]+)-([a-zA-Z]+)([0-9]+)$ ]] && [[ "${BASH_REMATCH[1]}" == "${BASH_REMATCH[3]}" ]]; then
  PREFIX="${BASH_REMATCH[1]}"
  START="${BASH_REMATCH[2]}"
  END="${BASH_REMATCH[4]}"
  START=$((10#$START))
  END=$((10#$END))
  for ((i=START; i<=END; i++)); do
    LANES+=("$(printf "%s%02d" "$PREFIX" "$i")")
  done
else
  LANES+=("$LABEL_ARG")
fi

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

query_lane() {
  local lane="$1"
  local dir="$WORK_DIR/$lane"
  mkdir -p "$dir"

  # Issues assigned to user
  gh issue list --repo "$REPO" --label "$lane" --assignee "$USER" --state open \
    --json number,title,labels,closedByPullRequestsReferences --limit 50 \
    > "$dir/issues_assignee.json" &

  # Issues authored by user (for dashboard dedup)
  gh issue list --repo "$REPO" --label "$lane" --author "$USER" --state open \
    --json number,title,labels,closedByPullRequestsReferences --limit 50 \
    > "$dir/issues_author.json" &

  # PRs authored by user
  gh pr list --repo "$REPO" --label "$lane" --author "$USER" --state open \
    --json number,title,labels,mergeable,headRefOid,headRefName --limit 50 \
    > "$dir/prs.json" &

  # Gist log for this lane
  local gist_name="coding-loop-log-${lane}"
  (
    gist_id=$(gh gist list --limit 100 2>/dev/null | awk -v name="$gist_name" '$0 ~ name {print $1; exit}' || true)
    if [ -n "$gist_id" ]; then
      gh api "gists/$gist_id" --jq '{content: .files[].content, updated_at: .updated_at}' > "$dir/gist.json" 2>/dev/null || echo '{}' > "$dir/gist.json"
    else
      echo '{}' > "$dir/gist.json"
    fi
  ) &

  wait
}

# Launch all lane queries in parallel
for lane in "${LANES[@]}"; do
  query_lane "$lane" &
done
wait

# Merge results into JSON
build_output() {
  echo "["
  local first=true
  for lane in "${LANES[@]}"; do
    local dir="$WORK_DIR/$lane"
    $first && first=false || echo ","

    # Deduplicate issues (assignee + author), transform
    local issues
    issues=$(jq -s '
      [.[0][], .[1][]]
      | group_by(.number)
      | map(.[0])
      | map({
          number,
          title,
          pending: ([.labels[].name] | any(. == "pending")),
          linked_prs: [.closedByPullRequestsReferences[].number]
        })
      | sort_by(.number)
    ' "$dir/issues_assignee.json" "$dir/issues_author.json")

    # Transform PRs
    local prs
    prs=$(jq '
      map({
        number,
        title,
        pending: ([.labels[].name] | any(. == "pending")),
        mergeable,
        head: (.headRefOid[:7]),
        branch: .headRefName
      })
      | sort_by(.number)
    ' "$dir/prs.json")

    local issue_count pr_count
    issue_count=$(echo "$issues" | jq 'length')
    pr_count=$(echo "$prs" | jq 'length')

    local gist
    gist=$(cat "$dir/gist.json")

    jq -n \
      --arg lane "$lane" \
      --argjson issues "$issues" \
      --argjson prs "$prs" \
      --argjson issue_count "$issue_count" \
      --argjson pr_count "$pr_count" \
      --argjson gist "$gist" \
      '{
        lane: $lane,
        issues: $issues,
        prs: $prs,
        issue_count: $issue_count,
        pr_count: $pr_count,
        total: ($issue_count + $pr_count),
        gist: $gist
      }'
  done
  echo "]"
}

build_output
