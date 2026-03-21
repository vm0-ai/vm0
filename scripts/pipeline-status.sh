#!/bin/bash
# Pipeline Status — parallel query of CI pipeline + merge queue + release status
# Usage:
#   scripts/pipeline-status.sh
#
# Output: JSON with ci_runs, merge_queue, and release sections

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Run 3 queries in parallel

# 1. CI pipeline (last 10 runs on main)
gh run list --repo "$REPO" --workflow turbo.yml --branch main --limit 10 \
  --json databaseId,conclusion,url,createdAt \
  > "$WORK_DIR/ci_runs.json" &

# 2. Merge queue
gh api graphql -f query='
{
  repository(owner: "vm0-ai", name: "vm0") {
    mergeQueue(branch: "main") {
      entries(first: 20) {
        nodes {
          pullRequest {
            number
            title
            author { login }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup { state }
                }
              }
            }
          }
        }
      }
    }
  }
}' > "$WORK_DIR/merge_queue.json" &

# 3. Release PR
gh pr list --repo "$REPO" --author "app/github-actions" --state open \
  --json number,title,body --limit 5 \
  > "$WORK_DIR/release_prs.json" &

wait

# Process CI runs
CI_RUNS=$(jq '[.[] | {id: .databaseId, conclusion, url, created_at: .createdAt}]' "$WORK_DIR/ci_runs.json")

# Process merge queue
MERGE_QUEUE=$(jq '
  [(.data.repository.mergeQueue.entries.nodes // [])[]
    | .pullRequest
    | {
        number,
        title,
        author: .author.login,
        ci_state: (.commits.nodes[0].commit.statusCheckRollup.state // "PENDING")
      }
  ]
' "$WORK_DIR/merge_queue.json")

# Process release
RELEASE_PR=$(jq '
  [.[] | select(.title == "chore: release main")] | .[0] // empty
' "$WORK_DIR/release_prs.json")

RELEASE="null"
if [[ -n "$RELEASE_PR" && "$RELEASE_PR" != "null" ]]; then
  RELEASE_NUMBER=$(echo "$RELEASE_PR" | jq '.number')
  RELEASE_CHANGES=$(echo "$RELEASE_PR" | jq '
    [.body | split("\n")[] | select(test("^\\* ")) | select(test("workspace dependencies") | not) | ltrimstr("* ")]
    | unique
  ')

  # Check for in-progress release-please run
  IN_PROGRESS_RUN=$(gh run list --repo "$REPO" --workflow release-please.yml --status in_progress --limit 1 \
    --json databaseId,headSha --jq '.[0] // empty')

  if [[ -n "$IN_PROGRESS_RUN" ]]; then
    RELEASE=$(jq -n \
      --argjson number "$RELEASE_NUMBER" \
      --argjson changes "$RELEASE_CHANGES" \
      --argjson run "$IN_PROGRESS_RUN" \
      '{open_pr: {number: $number, changes: $changes}, in_progress_run: {id: $run.databaseId, sha: $run.headSha}}')
  else
    RELEASE=$(jq -n \
      --argjson number "$RELEASE_NUMBER" \
      --argjson changes "$RELEASE_CHANGES" \
      '{open_pr: {number: $number, changes: $changes}, in_progress_run: null}')
  fi
fi

jq -n \
  --argjson ci_runs "$CI_RUNS" \
  --argjson merge_queue "$MERGE_QUEUE" \
  --argjson release "$RELEASE" \
  '{ci_runs: $ci_runs, merge_queue: $merge_queue, release: $release}'
