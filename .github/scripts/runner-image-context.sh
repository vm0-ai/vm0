#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: runner-image-context.sh <resolve|needed|artifact-name>

resolve:
  Computes release skip, canonical job ref, and head SHA from GitHub event env.

needed:
  Computes whether any runner image consumer needs a prepared image from
  workflow change-detection booleans.

artifact-name:
  Computes the GitHub artifact name for a runner image manifest.
USAGE
}

bool() {
  case "${1:-false}" in
    true|True|TRUE|1|yes|YES) echo "true" ;;
    *) echo "false" ;;
  esac
}

is_true() {
  [ "$(bool "${1:-false}")" = "true" ]
}

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

env_value() {
  local name=$1
  printf '%s\n' "${!name}"
}

pr_branch() {
  local pr_number=$1
  if [ -n "${MOCK_PR_BRANCH:-}" ]; then
    printf '%s\n' "$MOCK_PR_BRANCH"
    return 0
  fi
  require_env REPO
  require_env GH_TOKEN
  gh pr view "$pr_number" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true
}

pr_state() {
  local pr_number=$1
  if [ -n "${MOCK_PR_STATE:-}" ]; then
    printf '%s\n' "$MOCK_PR_STATE"
    return 0
  fi
  require_env REPO
  require_env GH_TOKEN
  curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    "https://api.github.com/repos/${REPO}/pulls/${pr_number}" \
    | jq -r .state
}

resolve() {
  require_env EVENT_NAME
  local head_sha="${HEAD_SHA:-${GITHUB_SHA:-}}"
  if [ -z "$head_sha" ]; then
    echo "missing HEAD_SHA or GITHUB_SHA" >&2
    exit 2
  fi

  local job_ref="" release_skip="false" skip_reason=""

  case "$EVENT_NAME" in
    pull_request)
      require_env PR_NUMBER
      local pr_number
      pr_number=$(env_value PR_NUMBER)
      local head_ref="${HEAD_REF:-}"
      if [[ "$head_ref" == release-please--branches--* ]]; then
        release_skip="true"
        skip_reason="release-please-pr"
      elif is_true "${CHECK_PR_OPEN:-false}"; then
        local state
        state=$(pr_state "$pr_number")
        if [ -z "$state" ]; then
          echo "failed to query PR #${pr_number} state" >&2
          exit 1
        fi
        if [ "$state" != "open" ]; then
          release_skip="true"
          skip_reason="pr-${state}"
        fi
      fi
      if [ "$release_skip" != "true" ]; then
        job_ref="pr-${pr_number}"
      fi
      ;;
    merge_group)
      require_env MQ_HEAD_REF
      local pr_number
      pr_number=$(printf '%s\n' "$MQ_HEAD_REF" | grep -oE 'pr-[0-9]+' | head -1 | sed 's/pr-//' || true)
      if [ -z "$pr_number" ]; then
        echo "failed to extract PR number from merge_group head_ref: ${MQ_HEAD_REF}" >&2
        exit 1
      fi
      local branch
      branch=$(pr_branch "$pr_number")
      if [[ "$branch" == release-please--branches--* ]]; then
        release_skip="true"
        skip_reason="release-please-merge-queue"
      else
        job_ref="pr-${pr_number}"
      fi
      ;;
    push)
      if [[ "${COMMIT_MSG:-}" == chore:\ release* ]]; then
        release_skip="true"
        skip_reason="release-please-push"
      else
        job_ref="staging-${head_sha:0:12}"
      fi
      ;;
    *)
      echo "unsupported EVENT_NAME: ${EVENT_NAME}" >&2
      exit 2
      ;;
  esac

  emit "release-skip" "$release_skip"
  emit "skip-reason" "$skip_reason"
  emit "job-ref" "$job_ref"
  emit "head-sha" "$head_sha"
}

needed() {
  local release_skip
  release_skip=$(bool "${RELEASE_SKIP:-false}")

  local metal_hosts="${METAL_HOSTS:-}"
  local has_metal_hosts="false"
  if printf '%s\n' "$metal_hosts" | tr ',' '\n' | grep -q '[^[:space:]]'; then
    has_metal_hosts="true"
  fi

  local turbo_needed="false"
  if [ "${EVENT_NAME:-}" != "push" ] && {
    is_true "${TURBO_WEB_CHANGED:-false}" ||
    is_true "${TURBO_CLI_CHANGED:-false}" ||
    is_true "${TURBO_CRATES_CHANGED:-false}" ||
    is_true "${TURBO_CI_CHANGED:-false}" ||
    is_true "${TURBO_E2E_CHANGED:-false}"
  }; then
    turbo_needed="true"
  fi

  local crates_needed="false"
  if is_true "${CRATES_CI_CHANGED:-false}" ||
    is_true "${CRATES_RUNNER_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_INIT_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_DOWNLOAD_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_AGENT_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_MOCK_CLAUDE_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_MOCK_CODEX_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_RESEED_CHANGED:-false}" ||
    is_true "${CRATES_GUEST_WRITE_FILE_CHANGED:-false}"; then
    crates_needed="true"
  fi

  local image_needed="false"
  if [ "$release_skip" != "true" ] &&
    [ "$has_metal_hosts" = "true" ] &&
    { [ "$turbo_needed" = "true" ] || [ "$crates_needed" = "true" ]; }; then
    image_needed="true"
  fi

  emit "has-metal-hosts" "$has_metal_hosts"
  emit "turbo-runner-needed" "$turbo_needed"
  emit "crates-runner-needed" "$crates_needed"
  emit "runner-image-needed" "$image_needed"
}

artifact_name() {
  require_env HEAD_SHA
  require_env JOB_REF
  local head_sha job_ref
  head_sha=$(env_value HEAD_SHA)
  job_ref=$(env_value JOB_REF)
  emit "artifact-name" "runner-image-manifest-${head_sha}-${job_ref}"
}

cmd="${1:-}"
case "$cmd" in
  resolve) resolve ;;
  needed) needed ;;
  artifact-name) artifact_name ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
