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

if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[1;33m'
  NC=$'\033[0m'
else
  GREEN=""
  YELLOW=""
  NC=""
fi

MAX_WORKERS="${1:-4}"
ME=$(gh api user --jq '.login')
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Parallel data gathering ---

FIRST_LANE=$(printf "vm%02d" 1)
LAST_LANE=$(printf "vm%02d" "$MAX_WORKERS")

"$SCRIPT_DIR/pipeline-status.sh" > "$WORK_DIR/pipeline.json" &
PID_PIPELINE=$!

"$SCRIPT_DIR/lane-status.sh" "${FIRST_LANE}-${LAST_LANE}" --user "$ME" > "$WORK_DIR/lanes.json" &
PID_LANES=$!

# Merged PRs across all lanes (per-lane files to avoid interleaved writes)
MERGED_PIDS=()
for i in $(seq 1 "$MAX_WORKERS"); do
  LANE=$(printf "vm%02d" "$i")
  gh pr list --repo "$REPO" --label "$LANE" --state merged \
    --json number,title,mergedAt,labels --limit 20 \
    --jq ".[] | {number, title, mergedAt, lane: \"$LANE\"}" \
    > "$WORK_DIR/merged_${LANE}.jsonl" 2>"$WORK_DIR/merged_${LANE}.err" &
  MERGED_PIDS+=($!)
done

# Wait for critical jobs and check exit status
ERRORS=()
wait "$PID_PIPELINE" || ERRORS+=("pipeline-status.sh failed")
wait "$PID_LANES" || ERRORS+=("lane-status.sh failed")
for pid in "${MERGED_PIDS[@]}"; do
  wait "$pid" || ERRORS+=("merged PR fetch (pid $pid) failed")
done

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "Warning: some background jobs failed:" >&2
  for err in "${ERRORS[@]}"; do
    echo "  - $err" >&2
  done
fi

# Validate critical JSON files before rendering
if [[ ! -s "$WORK_DIR/pipeline.json" ]] || ! jq empty "$WORK_DIR/pipeline.json" 2>/dev/null; then
  echo "Error: failed to fetch pipeline data" >&2
  exit 1
fi
if [[ ! -s "$WORK_DIR/lanes.json" ]] || ! jq empty "$WORK_DIR/lanes.json" 2>/dev/null; then
  echo "Error: failed to fetch lane data" >&2
  exit 1
fi

# Combine per-lane merged PR files
cat "$WORK_DIR"/merged_vm*.jsonl > "$WORK_DIR/merged_raw.jsonl" 2>/dev/null || true

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

  if [[ "$FAIL_EPOCH" == "0" ]]; then
    ELAPSED_STR="unknown"
  else
    NOW_EPOCH=$($DATE_CMD +%s)
    DIFF_SECS=$((NOW_EPOCH - FAIL_EPOCH))
    DIFF_HOURS=$((DIFF_SECS / 3600))
    DIFF_MINS=$(( (DIFF_SECS % 3600) / 60 ))
    ELAPSED_STR="${DIFF_HOURS}h ${DIFF_MINS}m"
  fi

  echo ""
  echo "Last failure: #${FAIL_POS}/10"
  echo "  Run: ${FAIL_URL}"

  # Get failed job names
  RUN_ID=$(echo "$FAIL_URL" | grep -oE '[0-9]+$')
  FAILED_JOBS=$(gh run view "$RUN_ID" --repo "$REPO" --json jobs --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join(", ")' 2>/dev/null || echo "unknown")
  echo "  Failed jobs: ${FAILED_JOBS}"
  echo "  Success since: ${SUCCESS_SINCE}"
  echo "  Elapsed: ${ELAPSED_STR}"
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

# Build merge queue PR number set for [Queued] markers
MQ_NUMBERS=$(jq '[.merge_queue[].number]' "$WORK_DIR/pipeline.json")

jq -r --argjson mq "$MQ_NUMBERS" --arg green "$GREEN" --arg yellow "$YELLOW" --arg nc "$NC" '
  .[] |
  "\n\(.lane)" as $header |
  if (.issue_count + .pr_count) == 0 then
    ([$header, "  -- idle"] | join("\n"))
  else
    # Collect all PR numbers linked to any issue
    ([.issues[].linked_prs[]?]) as $linked |
    # Index PRs by number for title lookup
    ([.prs[] | {(.number | tostring): .}] | add // {}) as $pr_map |
    [ $header ] +
    [
      .issues[] |
      # [Queued] if any linked PR is in merge queue
      (if ([.linked_prs[]?] | any(. as $p | $mq | any(. == $p))) then "\($green)[Queued]\($nc) "
       elif .pending then "\($yellow)[Pending]\($nc) "
       else "" end) as $marker |
      "- \($marker)Issue #\(.number) — \(.title)",
      # Show linked PRs indented under their issue
      (.linked_prs[]? as $pr_num |
        ($pr_map[$pr_num | tostring].title // null) as $pr_title |
        if $pr_title then
          "  - PR #\($pr_num) — \($pr_title)"
        else
          "  - PR #\($pr_num)"
        end)
    ] +
    # Standalone PRs (not linked to any issue)
    [ .prs[] | select(.number as $n | $linked | any(. == $n) | not) |
      "- \(if .pending then "\($yellow)[Pending]\($nc) " else "" end)PR #\(.number) — \(.title)" ] |
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
