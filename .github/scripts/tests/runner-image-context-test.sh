#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="${SCRIPT_DIR}/runner-image-context.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  grep -qxF "$expected" <<<"$output" || fail "expected line '${expected}' in output: ${output}"
}

run_clean() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@"
}

out=$(run_clean EVENT_NAME=pull_request PR_NUMBER=123 HEAD_REF=feature HEAD_SHA=abc "$CONTEXT" resolve)
assert_contains "$out" "release-skip=false"
assert_contains "$out" "job-ref=pr-123"
assert_contains "$out" "head-sha=abc"

out=$(run_clean EVENT_NAME=pull_request PR_NUMBER=123 HEAD_REF=release-please--branches--main HEAD_SHA=abc "$CONTEXT" resolve)
assert_contains "$out" "release-skip=true"
assert_contains "$out" "skip-reason=release-please-pr"
assert_contains "$out" "job-ref="

out=$(run_clean EVENT_NAME=merge_group MQ_HEAD_REF=refs/heads/gh-readonly-queue/main/pr-456-abc MOCK_PR_BRANCH=feature HEAD_SHA=def "$CONTEXT" resolve)
assert_contains "$out" "release-skip=false"
assert_contains "$out" "job-ref=pr-456"

out=$(run_clean EVENT_NAME=merge_group MQ_HEAD_REF=refs/heads/gh-readonly-queue/main/pr-456-abc MOCK_PR_BRANCH=release-please--branches--main HEAD_SHA=def "$CONTEXT" resolve)
assert_contains "$out" "release-skip=true"
assert_contains "$out" "skip-reason=release-please-merge-queue"
assert_contains "$out" "job-ref="

out=$(run_clean EVENT_NAME=push COMMIT_MSG='regular commit' HEAD_SHA=ghi "$CONTEXT" resolve)
assert_contains "$out" "release-skip=false"
assert_contains "$out" "job-ref=staging-ghi"

out=$(run_clean EVENT_NAME=push COMMIT_MSG='chore: release 1.2.3' HEAD_SHA=ghi "$CONTEXT" resolve)
assert_contains "$out" "release-skip=true"
assert_contains "$out" "skip-reason=release-please-push"
assert_contains "$out" "job-ref="

out=$(run_clean \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1,dev-2 \
  TURBO_WEB_CHANGED=true \
  "$CONTEXT" needed)
assert_contains "$out" "turbo-runner-needed=true"
assert_contains "$out" "runner-image-needed=true"

out=$(run_clean \
  EVENT_NAME=push \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  TURBO_WEB_CHANGED=true \
  "$CONTEXT" needed)
assert_contains "$out" "turbo-runner-needed=false"
assert_contains "$out" "runner-image-needed=false"

out=$(run_clean \
  EVENT_NAME=push \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  CRATES_GUEST_AGENT_CHANGED=true \
  "$CONTEXT" needed)
assert_contains "$out" "crates-runner-needed=true"
assert_contains "$out" "runner-image-needed=true"

out=$(run_clean HEAD_SHA=abc JOB_REF=pr-123 "$CONTEXT" artifact-name)
assert_contains "$out" "artifact-name=runner-image-manifest-abc-pr-123"

echo "runner-image-context-test: ok"
