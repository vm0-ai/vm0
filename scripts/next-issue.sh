#!/bin/bash
# Next Issue — find the next actionable issue for a label
# Usage:
#   scripts/next-issue.sh <label>
#
# Output: JSON object of the next issue, or empty if none found
# Filters: excludes PR-linked, picks lowest number

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

[[ $# -lt 1 ]] && { echo "Usage: $0 <label>" >&2; exit 1; }

LABEL="$1"
ME=$(gh api user --jq '.login')

# Issues assigned to me
ASSIGNED=$(gh issue list --repo "$REPO" --label "$LABEL" --assignee "$ME" --state open \
  --json number,title,labels,closedByPullRequestsReferences --limit 50)

# Issues authored by me with no assignee
AUTHORED=$(gh issue list --repo "$REPO" --label "$LABEL" --author "$ME" --state open \
  --json number,title,labels,closedByPullRequestsReferences,assignees --limit 50 \
  --jq '[.[] | select(.assignees | length == 0) | del(.assignees)]')

# Merge, dedup, filter, pick first actionable issue
ISSUE=$(jq -n --argjson a "$ASSIGNED" --argjson b "$AUTHORED" '
  [$a[], $b[]]
  | group_by(.number)
  | map(.[0])
  | [.[]
      | select(.closedByPullRequestsReferences | length == 0)
    ]
  | sort_by(.number)
  | .[0]
  // empty
')

[[ -z "$ISSUE" ]] && exit 0

ISSUE_NUMBER=$(echo "$ISSUE" | jq -r '.number')

# Verify no open PR already covers this issue
OPEN_PR=$(gh pr list --repo "$REPO" --state open --json number,title --limit 100 \
  --jq "[.[] | select(.title | contains(\"#${ISSUE_NUMBER}\"))] | length")

if [[ "$OPEN_PR" -gt 0 ]]; then
  exit 0
fi

# Output the issue with cleaned-up labels
echo "$ISSUE" | jq '{number, title, labels: [.labels[].name]}'
