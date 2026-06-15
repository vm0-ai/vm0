#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

require_env HEAD_SHA
require_env JOB_REF
require_env METAL_HOSTS
require_env TARGET
require_env PROFILE

REPO="${GITHUB_REPOSITORY:-${REPO:-}}"
WORKFLOW="${WORKFLOW:-runner-image.yml}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1800}"
POLL_SECONDS="${POLL_SECONDS:-10}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/runner-image-manifest}"
ARTIFACT_NAME="${ARTIFACT_NAME:-runner-image-manifest-${HEAD_SHA}-${JOB_REF}}"
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
cleanup() {
  rm -f "$GH_ERR"
}
trap cleanup EXIT

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
selected_run=""
selected_url=""
selected_run_id=""
selected_artifact=""
artifact_failures=0
list_failures=0

while true; do
  if ! artifacts_json=$(gh api \
    "repos/${REPO}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=100" \
    --jq . 2>"$GH_ERR"); then
    artifact_failures=$((artifact_failures + 1))
    echo "gh api artifacts failed (${artifact_failures}/3) while waiting for ${ARTIFACT_NAME}" >&2
    cat "$GH_ERR" >&2
    if [ "$artifact_failures" -ge 3 ]; then
      exit 1
    fi
    sleep "$POLL_SECONDS"
    continue
  fi
  artifact_failures=0

  selected_artifact=$(jq -c \
    --arg name "$ARTIFACT_NAME" \
    '.artifacts
      | map(select(.name == $name and .expired == false))
      | sort_by(.created_at)
      | reverse
      | .[0] // empty' <<<"$artifacts_json")

  if [ -n "$selected_artifact" ]; then
    selected_run_id=$(jq -r '.workflow_run.id' <<<"$selected_artifact")
    echo "runner image artifact found: name=${ARTIFACT_NAME} run_id=${selected_run_id} head_sha=${HEAD_SHA}"
    rm -rf "${OUTPUT_DIR:?}"/*
    download_ok=false
    download_attempts=0
    while [ "$download_attempts" -lt 5 ]; do
      download_attempts=$((download_attempts + 1))
      if gh run download "$selected_run_id" -n "$ARTIFACT_NAME" -D "$OUTPUT_DIR"; then
        download_ok=true
        break
      fi
      echo "artifact ${ARTIFACT_NAME} is listed but not downloadable yet from run ${selected_run_id}; retrying"
      sleep 5
    done
    if [ "$download_ok" = "true" ]; then
      break
    fi
    echo "artifact ${ARTIFACT_NAME} could not be downloaded from run ${selected_run_id}; continuing to wait"
  fi

  if ! runs_json=$(gh run list \
    --workflow "$WORKFLOW" \
    --commit "$LOOKUP_SHA" \
    --limit 20 \
    --json databaseId,status,conclusion,createdAt,url,headSha 2>"$GH_ERR"); then
    list_failures=$((list_failures + 1))
    echo "gh run list failed (${list_failures}/3) while waiting for ${WORKFLOW} at ${LOOKUP_SHA}" >&2
    cat "$GH_ERR" >&2
    if [ "$list_failures" -ge 3 ]; then
      exit 1
    fi
    sleep "$POLL_SECONDS"
    continue
  fi
  list_failures=0

  selected_run=$(jq -c 'sort_by(.createdAt) | reverse | .[0] // empty' <<<"$runs_json")

  if [ -n "$selected_run" ]; then
    status=$(jq -r '.status' <<<"$selected_run")
    conclusion=$(jq -r '.conclusion // empty' <<<"$selected_run")
    run_id=$(jq -r '.databaseId' <<<"$selected_run")
    selected_url=$(jq -r '.url' <<<"$selected_run")
    selected_run_id="$run_id"
    echo "waiting for runner image artifact: name=${ARTIFACT_NAME} lookup_sha=${LOOKUP_SHA} producer_run=${run_id} status=${status} conclusion=${conclusion} url=${selected_url}"

    if [ "$status" = "completed" ]; then
      if [ "$conclusion" != "success" ]; then
        echo "runner image workflow completed with conclusion=${conclusion}: ${selected_url}" >&2
        exit 1
      fi
    fi
  else
    echo "waiting for runner image artifact ${ARTIFACT_NAME}; no ${WORKFLOW} run found at ${LOOKUP_SHA} yet"
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "timed out waiting for runner image workflow ${WORKFLOW} at ${LOOKUP_SHA} with artifact ${ARTIFACT_NAME}" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done

MANIFEST_PATH="${OUTPUT_DIR}/manifest.json"
if [ ! -f "$MANIFEST_PATH" ]; then
  mapfile -t candidates < <(find "$OUTPUT_DIR" -name manifest.json -type f | sort)
  if [ "${#candidates[@]}" -eq 1 ]; then
    MANIFEST_PATH="${candidates[0]}"
  else
    echo "expected one manifest.json in ${OUTPUT_DIR}, found ${#candidates[@]}" >&2
    exit 1
  fi
fi

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
