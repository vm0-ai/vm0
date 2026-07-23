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

if [[ ! "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "invalid GITHUB_RUN_ID: ${GITHUB_RUN_ID}" >&2
  exit 2
fi

poll_seconds=${PRODUCTION_DEPLOY_QUEUE_POLL_SECONDS:-20}
timeout_seconds=${PRODUCTION_DEPLOY_QUEUE_TIMEOUT_SECONDS:-21600}
if [[ ! "$poll_seconds" =~ ^[0-9]+$ || ! "$timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "queue polling values must be non-negative integers" >&2
  exit 2
fi

started_at=$SECONDS
active_statuses=(queued in_progress pending waiting requested)

while true; do
  older_runs=$(
    for status in "${active_statuses[@]}"; do
      gh api --method GET \
        "repos/${GITHUB_REPOSITORY}/actions/runs" \
        -f "status=${status}" \
        -f per_page=100 \
        --paginate \
        --slurp
    done |
      jq -r --argjson current_run_id "$GITHUB_RUN_ID" '
        .[] | .workflow_runs[]?
        | select(.id < $current_run_id)
        | select(
            .path == ".github/workflows/release-please.yml" or
            .path == ".github/workflows/rollback-production.yml"
          )
        | [.id, .name, .status, .html_url]
        | @tsv
      ' |
      sort -n -u
  )

  if [ -z "$older_runs" ]; then
    echo "Production deployment queue acquired by run ${GITHUB_RUN_ID}."
    exit 0
  fi

  if (( SECONDS - started_at >= timeout_seconds )); then
    echo "::error::Timed out waiting for older production deployment workflows:" >&2
    printf '%s\n' "$older_runs" >&2
    exit 1
  fi

  echo "Waiting for older production deployment workflows:"
  printf '%s\n' "$older_runs"
  sleep "$poll_seconds"
done
