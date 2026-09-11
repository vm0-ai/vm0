#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"
. "${SCRIPT_DIR}/runner-ci-record.sh"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

: "${HEAD_SHA:?missing required env: HEAD_SHA}"
: "${JOB_REF:?missing required env: JOB_REF}"
: "${METAL_HOSTS:?missing required env: METAL_HOSTS}"
: "${TARGET:?missing required env: TARGET}"
: "${PROFILE:?missing required env: PROFILE}"

runner_image_validate_target "$TARGET"

REPO="${GITHUB_REPOSITORY:-${REPO:-}}"
WORKFLOW="${WORKFLOW:-runner-image.yml}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1800}"
POLL_SECONDS="${POLL_SECONDS:-30}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/runner-image-manifest}"
DEFAULT_RECORD_NAME=$(runner_image_record_name "$TARGET" "$HEAD_SHA" "$JOB_REF")
RECORD_NAME="${RECORD_NAME:-$DEFAULT_RECORD_NAME}"
LOOKUP_SHA="${LOOKUP_SHA:-$HEAD_SHA}"

if [ -z "$REPO" ]; then
  echo "missing required env: GITHUB_REPOSITORY or REPO" >&2
  exit 2
fi

if [ "$OUTPUT_DIR" = "/" ]; then
  echo "refusing unsafe OUTPUT_DIR=/" >&2
  exit 2
fi
mkdir -p "$OUTPUT_DIR"

GH_ERR=$(mktemp)
GH_RESPONSE=$(mktemp)
cleanup() {
  rm -f "$GH_ERR" "$GH_RESPONSE"
}
trap cleanup EXIT

runner_ci_config
RUNNER_CI_DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
deadline=$RUNNER_CI_DEADLINE

check_deadline() {
  WAIT_REMAINING_SECONDS=$((deadline - $(date +%s)))
  if [ "$WAIT_REMAINING_SECONDS" -le 0 ]; then
    echo "timed out waiting for runner image workflow ${WORKFLOW} at ${LOOKUP_SHA} with record ${RECORD_NAME}" >&2
    exit 1
  fi
}

wait_with_deadline() {
  local seconds=$1
  check_deadline
  if [ "$seconds" -ge "$((deadline - $(date +%s)))" ]; then
    echo "cannot retry within runner image wait deadline: required delay=${seconds}s record=${RECORD_NAME}" >&2
    exit 1
  fi
  sleep "$seconds"
}

response_header() {
  awk -v name="$1" '
    /^\r?$/ { exit }
    tolower($1) == name ":" { sub(/\r$/, "", $2); print $2; exit }
  ' "$GH_RESPONSE"
}

api_get() {
  local endpoint=$1 failures=0 backoff=60
  local status retry_after remaining reset delay now
  while true; do
    check_deadline
    if timeout --foreground --kill-after=5s "${WAIT_REMAINING_SECONDS}s" gh api "$endpoint" --include >"$GH_RESPONSE" 2>"$GH_ERR"; then
      sed '1,/^\r\{0,1\}$/d' "$GH_RESPONSE"
      return
    fi
    cat "$GH_ERR" >&2
    status=$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$GH_RESPONSE")
    retry_after=$(response_header retry-after)
    remaining=$(response_header x-ratelimit-remaining)
    reset=$(response_header x-ratelimit-reset)
    if [ "$status" = "429" ] || {
      [ "$status" = "403" ] && {
        [ -n "$retry_after" ] || [ "$remaining" = "0" ] ||
          grep -qi 'rate limit' "$GH_RESPONSE" "$GH_ERR"
      }
    }; then
      # GitHub requires waiting for the declared recovery time. Without usable
      # headers, wait at least a minute and back off instead of spending the
      # ordinary transport-error retry budget on a shared quota cooldown.
      delay=0
      now=$(date +%s)
      if [[ "$retry_after" =~ ^[0-9]+$ ]]; then
        delay=$((10#$retry_after))
      fi
      if [ "$remaining" = "0" ] && [[ "$reset" =~ ^[0-9]+$ ]] &&
        [ "$((10#$reset - now + 1))" -gt "$delay" ]; then
        delay=$((10#$reset - now + 1))
      fi
      if [ "$delay" -le 0 ]; then
        delay=$backoff
      fi
      echo "GitHub API rate limited: status=${status} remaining=${remaining:-unknown} reset=${reset:-unknown}; retrying in ${delay}s" >&2
      wait_with_deadline "$delay"
      backoff=$((backoff * 2))
      if [ "$backoff" -gt 300 ]; then backoff=300; fi
      continue
    fi
    if [[ "$status" == 4* ]]; then
      echo "GitHub API request failed with HTTP ${status}: ${endpoint}" >&2
      exit 1
    fi
    failures=$((failures + 1))
    echo "GitHub API request failed (${failures}/3): ${endpoint}" >&2
    if [ "$failures" -ge 3 ]; then exit 1; fi
    wait_with_deadline "$POLL_SECONDS"
  done
}

selected_run=""
selected_url=""
selected_run_id=""
next_run_check=0
producer_failure_url=""

while true; do
  check_deadline
  if [ "$(date +%s)" -ge "$next_run_check" ]; then
    runs_json=$(api_get "repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${LOOKUP_SHA}&per_page=20")
    selected_run=$(jq -c --arg repo "$REPO" --arg workflow ".github/workflows/${WORKFLOW}" \
      --arg head "$LOOKUP_SHA" '
      [.workflow_runs[] | select(.repository.full_name == $repo and .path == $workflow and .head_sha == $head)] |
      sort_by(.created_at, .id) | reverse | .[0] // empty
    ' <<<"$runs_json")
    next_run_check=$(( $(date +%s) + 60 ))
  fi

  if [ -n "$selected_run" ]; then
    selected_run_id=$(jq -r '.id' <<<"$selected_run")
    selected_url=$(jq -r '.html_url' <<<"$selected_run")
    # Resolve the latest execution of each job, not just the workflow's latest
    # attempt: failed-only reruns need the successful, untouched producer jobs.
    jobs='[]'
    page=1
    while true; do
      response=$(api_get "repos/${REPO}/actions/runs/${selected_run_id}/jobs?filter=all&per_page=100&page=${page}")
      jobs=$(jq -c --argjson response "$response" '. + [$response]' <<<"$jobs")
      [ "$(jq '.jobs | length' <<<"$response")" -eq 100 ] || break
      page=$((page + 1))
    done
    if runner_ci_record_fetch "$RECORD_NAME" "$selected_run_id" "$jobs" "${OUTPUT_DIR}/manifest.json"; then
      echo "runner image record ready: name=${RECORD_NAME} run_id=${selected_run_id} head_sha=${HEAD_SHA}"
      break
    fi

    status=$(jq -r '.status' <<<"$selected_run")
    conclusion=$(jq -r '.conclusion // empty' <<<"$selected_run")
    if [ -n "$producer_failure_url" ]; then
      echo "runner image workflow completed with conclusion=${conclusion}: ${producer_failure_url}" >&2
      exit 1
    fi
    if [ "$status" = completed ] && [ "$conclusion" != success ]; then
      # A sibling architecture can fail while this target's receipt becomes
      # visible. Recheck its readiness once before reporting producer failure.
      producer_failure_url=$selected_url
      continue
    fi
    echo "waiting for runner image record: name=${RECORD_NAME} producer_run=${selected_run_id} status=${status} url=${selected_url}"
  else
    echo "waiting for runner image record ${RECORD_NAME}; no ${WORKFLOW} run found at ${LOOKUP_SHA} yet"
  fi
  wait_with_deadline "$POLL_SECONDS"
done

MANIFEST_PATH="${OUTPUT_DIR}/manifest.json"
MANIFEST_PATH="$MANIFEST_PATH" \
HEAD_SHA="$HEAD_SHA" \
JOB_REF="$JOB_REF" \
TARGET="$TARGET" \
PROFILE="$PROFILE" \
METAL_HOSTS="$METAL_HOSTS" \
SELECTED_HOST="${SELECTED_HOST:-}" \
"$(dirname "$0")/runner-image-manifest.sh" validate

emit "producer-run-id" "$selected_run_id"
emit "producer-run-url" "$selected_url"
