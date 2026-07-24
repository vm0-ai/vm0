#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env GH_TOKEN
require_env GITHUB_REPOSITORY
require_env GITHUB_RUN_ID
require_env GITHUB_SHA
require_env MERGE_GROUP_HEAD_REF

if [[ ! "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "invalid GITHUB_RUN_ID: ${GITHUB_RUN_ID}" >&2
  exit 2
fi

pr_number=$(
  printf '%s\n' "$MERGE_GROUP_HEAD_REF" |
    grep -oE 'pr-[0-9]+' |
    head -1 |
    sed 's/pr-//' || true
)
if [ -z "$pr_number" ]; then
  echo "failed to extract PR number from merge_group head_ref: ${MERGE_GROUP_HEAD_REF}" >&2
  exit 2
fi

pr_head=$(
  gh api --method GET \
    "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" \
    --jq '[.head.ref, .head.repo.full_name] | @tsv'
)
IFS=$'\t' read -r pr_head_ref pr_head_repository <<<"$pr_head"
if [ -z "$pr_head_ref" ] || [ -z "$pr_head_repository" ]; then
  echo "failed to resolve head repository and ref for PR #${pr_number}" >&2
  exit 1
fi

poll_seconds=${SUPERSEDED_RUN_POLL_SECONDS:-2}
timeout_seconds=${SUPERSEDED_RUN_TIMEOUT_SECONDS:-180}
if [[ ! "$poll_seconds" =~ ^[0-9]+$ || ! "$timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "superseded run polling values must be non-negative integers" >&2
  exit 2
fi

discover_superseded_runs() {
  local active_statuses=(queued in_progress pending waiting requested)
  local status

  for status in "${active_statuses[@]}"; do
    gh api --method GET \
      "repos/${GITHUB_REPOSITORY}/actions/runs" \
      -f "status=${status}" \
      -f per_page=100 \
      --paginate \
      --slurp
  done |
    jq -r \
      --argjson current_run_id "$GITHUB_RUN_ID" \
      --arg current_head_sha "$GITHUB_SHA" \
      --argjson pr_number "$pr_number" \
      --arg pr_head_ref "$pr_head_ref" \
      --arg pr_head_repository "$pr_head_repository" '
        .[] | .workflow_runs[]?
        | select(.id < $current_run_id)
        | select(.head_sha != $current_head_sha)
        | select(
            .path == ".github/workflows/turbo.yml" or
            .path == ".github/workflows/crates.yml" or
            .path == ".github/workflows/runner-image.yml"
          )
        | select(
            (
              .event == "merge_group" and
              ((.head_branch // "") | test("(^|/)pr-" + ($pr_number | tostring) + "-"))
            ) or
            (
              .event == "pull_request" and
              (
                any(.pull_requests[]?; .number == $pr_number) or
                (
                  ((.head_branch // "") == $pr_head_ref) and
                  ((.head_repository.full_name // "") == $pr_head_repository)
                )
              )
            )
          )
        | [.id, .name, .status, .event, .head_sha, .html_url]
        | @tsv
      ' |
    sort -n -u
}

previous_run_ids=""
have_previous_run_ids=false
discovery_started_at=$SECONDS
# Each status filter is a separate API snapshot. Require the selected run IDs
# to stabilize so a run changing statuses cannot fall between those snapshots.
while true; do
  discovered_runs=$(discover_superseded_runs)
  discovered_run_ids=$(printf '%s\n' "$discovered_runs" | cut -f1)

  if $have_previous_run_ids; then
    if [ "$discovered_run_ids" = "$previous_run_ids" ]; then
      superseded_runs=$discovered_runs
      break
    fi

    if ((SECONDS - discovery_started_at >= timeout_seconds)); then
      echo "::error::Timed out waiting for superseded CI run discovery to stabilize" >&2
      exit 1
    fi
  fi

  previous_run_ids=$discovered_run_ids
  have_previous_run_ids=true
done

if [ -z "$superseded_runs" ]; then
  echo "No superseded CI runs found for PR #${pr_number}."
  exit 0
fi

echo "Cancelling superseded CI runs for PR #${pr_number}:"
printf '%s\n' "$superseded_runs"

run_ids=()
while IFS= read -r run_record; do
  run_id=${run_record%%$'\t'*}
  run_ids+=("$run_id")
  if ! cancel_error=$(
    gh api --method POST \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/cancel" 2>&1
  ); then
    current_status=$(
      gh api --method GET \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}" \
        --jq '.status'
    )
    if [ "$current_status" != "completed" ]; then
      echo "failed to cancel superseded run ${run_id}: ${cancel_error}" >&2
      exit 1
    fi
  fi
done <<<"$superseded_runs"

started_at=$SECONDS
while true; do
  pending_runs=()
  for run_id in "${run_ids[@]}"; do
    current_status=$(
      gh api --method GET \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}" \
        --jq '.status'
    )
    if [ "$current_status" != "completed" ]; then
      pending_runs+=("${run_id}:${current_status}")
    fi
  done

  if [ "${#pending_runs[@]}" -eq 0 ]; then
    echo "All superseded CI runs completed before shared resources were reused."
    exit 0
  fi

  if ((SECONDS - started_at >= timeout_seconds)); then
    echo "::error::Timed out waiting for superseded CI runs to complete: ${pending_runs[*]}" >&2
    exit 1
  fi

  echo "Waiting for superseded CI runs: ${pending_runs[*]}"
  sleep "$poll_seconds"
done
