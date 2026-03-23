#!/bin/bash
# Coding Dashboard — consolidated view of CI, merge queue, lanes, and recent merges
# Usage:
#   scripts/coding-dashboard.sh [max_workers]
#
# Output: formatted text dashboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

MAX_WORKERS="${1:-4}"
ME=$(gh api user --jq '.login')
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Parallel data gathering ---

FIRST_LANE=$(printf "vm%02d" 1)
LAST_LANE=$(printf "vm%02d" "$MAX_WORKERS")

"$SCRIPT_DIR/pipeline-status.sh" > "$WORK_DIR/pipeline.json" &

"$SCRIPT_DIR/lane-status.sh" "${FIRST_LANE}-${LAST_LANE}" --user "$ME" > "$WORK_DIR/lanes.json" &

# Merged PRs across all lanes
for i in $(seq 1 "$MAX_WORKERS"); do
  LANE=$(printf "vm%02d" "$i")
  gh pr list --repo "$REPO" --label "$LANE" --state merged \
    --json number,title,mergedAt,labels --limit 20 \
    --jq ".[] | {number, title, mergedAt, lane: \"$LANE\"}" \
    >> "$WORK_DIR/merged_raw.jsonl" &
done

wait

# --- Render: CI Pipeline ---

echo "---"
echo "📊 CI Pipeline (last 10 runs on main)"

CI_LINE=$(jq -r '
  [.ci_runs[] | if .conclusion == "success" then "✅" elif .conclusion == "failure" then "🔴" else "⏳" end]
  | join("")
' "$WORK_DIR/pipeline.json")
echo "$CI_LINE"

# Find most recent failure
FAILURE_INFO=$(jq -r '
  .ci_runs | to_entries
  | map(select(.value.conclusion == "failure"))
  | if length == 0 then "none"
    else .[0] | "\(.key + 1)|\(.value.url)|\(.value.createdAt)"
    end
' "$WORK_DIR/pipeline.json")

if [[ "$FAILURE_INFO" == "none" ]]; then
  echo ""
  echo "No failures"
else
  IFS='|' read -r FAIL_POS FAIL_URL FAIL_TIME <<< "$FAILURE_INFO"
  SUCCESS_SINCE=$((FAIL_POS - 1))

  # Calculate time elapsed
  if command -v gdate &>/dev/null; then
    DATE_CMD="gdate"
  else
    DATE_CMD="date"
  fi
  FAIL_EPOCH=$($DATE_CMD -d "$FAIL_TIME" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$FAIL_TIME" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$($DATE_CMD +%s)
  DIFF_SECS=$((NOW_EPOCH - FAIL_EPOCH))
  DIFF_HOURS=$((DIFF_SECS / 3600))
  DIFF_MINS=$(( (DIFF_SECS % 3600) / 60 ))

  echo ""
  echo "Last failure: #${FAIL_POS}/10"
  echo "  Run: ${FAIL_URL}"

  # Get failed job names
  RUN_ID=$(echo "$FAIL_URL" | grep -oE '[0-9]+$')
  FAILED_JOBS=$(gh run view "$RUN_ID" --repo "$REPO" --json jobs --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join(", ")' 2>/dev/null || echo "unknown")
  echo "  Failed jobs: ${FAILED_JOBS}"
  echo "  Success since: ${SUCCESS_SINCE}"
  echo "  Elapsed: ${DIFF_HOURS}h ${DIFF_MINS}m"
fi

# --- Render: Merge Queue ---

echo ""
echo "🚦 Merge Queue"

QUEUE_COUNT=$(jq '.merge_queue | length' "$WORK_DIR/pipeline.json")
if [[ "$QUEUE_COUNT" == "0" ]]; then
  echo "  (empty)"
else
  jq -r '
    .merge_queue[] |
    (if .ci_state == "SUCCESS" then "✅"
     elif .ci_state == "FAILURE" or .ci_state == "ERROR" then "🔴"
     else "⏳" end) as $emoji |
    "- \($emoji) #\(.number) — \(.title) (\(.author))"
  ' "$WORK_DIR/pipeline.json"
fi

# --- Render: Release Status ---

RELEASE_NULL=$(jq '.release == null' "$WORK_DIR/pipeline.json")
if [[ "$RELEASE_NULL" == "false" ]]; then
  echo ""
  echo "📦 Release Status"

  HAS_PR=$(jq '.release.open_pr != null' "$WORK_DIR/pipeline.json")
  if [[ "$HAS_PR" == "true" ]]; then
    PR_NUM=$(jq '.release.open_pr.number' "$WORK_DIR/pipeline.json")
    echo "  Open PR: #${PR_NUM}"
    jq -r '.release.open_pr.changes[]? | gsub("\\[(?<x>[^]]+)\\]\\([^)]+\\)"; .x) | gsub(", closes #[0-9]+"; "") | "  - \(.)"' "$WORK_DIR/pipeline.json"
  fi

  HAS_RUN=$(jq '.release.in_progress_run != null' "$WORK_DIR/pipeline.json")
  if [[ "$HAS_RUN" == "true" ]]; then
    echo ""
    echo "  🚀 Release in progress"
  fi
fi

# --- Render: Lane Status ---

echo ""
echo "📋 Lane Status"

jq -r '
  .[] |
  "\n\(.lane)" as $header |
  if (.issue_count + .pr_count) == 0 then
    "\($header)\n  -- idle"
  else
    [ $header ] +
    [ .issues[] | "  - \(if .pending then "[Pending] " else "" end)Issue #\(.number) — \(.title)" ] +
    [ .prs[] | "  - \(if .pending then "[Pending] " else "" end)PR #\(.number) — \(.title)" ] |
    join("\n")
  end
' "$WORK_DIR/lanes.json"

# --- Render: Recently Merged PRs ---

echo ""
echo "---"
echo "📝 Recently Merged (top 20)"

if [[ -s "$WORK_DIR/merged_raw.jsonl" ]]; then
  jq -rs 'sort_by(.mergedAt) | reverse | .[0:20][] |
    (.mergedAt | split("T") | .[0] | split("-") | .[1] + "/" + .[2]) as $date |
    (.mergedAt | split("T") | .[1] | split(":") | .[0] + ":" + .[1]) as $time |
    "- \($date) \($time) #\(.number) \(.lane) — \(.title)"
  ' "$WORK_DIR/merged_raw.jsonl"
else
  echo "  (none)"
fi

echo "---"
