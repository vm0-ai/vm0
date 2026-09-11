#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAIT="${SCRIPT_DIR}/wait-runner-image.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "${TMPDIR}/bin"
cat > "${TMPDIR}/manifest.json" <<'JSON'
{
  "schemaVersion": 1,
  "headSha": "build-sha",
  "jobRef": "pr-123",
  "target": "aarch64-unknown-linux-musl",
  "profile": "vm0/default",
  "binDir": "/var/lib/vm0-runner/bin/pr-123",
  "runnerDir": "/var/lib/vm0-runner/runners/pr-123",
  "runnerSha256": "runner-sha",
  "guestSha256": {
    "guest-agent": "a",
    "guest-storage-apply": "b",
    "guest-init": "c",
    "claude-mock": "d",
    "codex-mock": "e",
    "guest-state-restore": "f",
    "guest-tool-exec": "h",
    "runner-rpc-client": "i",
    "guest-write-file": "g",
    "guest-workspace-mount": "j"
  },
  "hosts": {
    "dev-1": {
      "rootfsHash": "rootfs-1",
      "snapshotHash": "snapshot-1",
      "completedAt": "2026-05-11T00:00:00Z"
    }
  }
}
JSON
sed 's/aarch64-unknown-linux-musl/x86_64-unknown-linux-musl/' "${TMPDIR}/manifest.json" > "${TMPDIR}/manifest-x86.json"

cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

now=$(date +%s)
printf '%s %s\n' "$now" "$*" >> "${GH_ARGS_LOG}"

respond_error() {
  printf 'HTTP/2.0 %s Error\r\n' "$1"
  printf '%b\r\n' "$2"
  printf '{"message":"%s"}\n' "$3"
  printf 'gh: %s (HTTP %s)\n' "$3" "$1" >&2
  exit 1
}

if [ "$1" = "api" ]; then
  [[ "$*" == *' --include' ]] || exit 1
  case "${FAKE_MODE:-record}" in
    primary)
      if [ "$now" -lt 1007 ]; then
        respond_error 403 'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1006\r\n' 'API rate limit exceeded for installation'
      fi
      ;;
    retry-after)
      if [ "$now" -lt 1012 ]; then
        respond_error 429 'rEtRy-AfTeR: 7\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1011\r\n' 'rate limited'
      fi
      ;;
    headerless)
      count=$(wc -l <"$GH_ARGS_LOG")
      if [ "$count" -le 4 ]; then respond_error 403 '' 'API rate limit exceeded for installation'; fi
      ;;
    invalid-headers)
      if [ "$now" -lt 1060 ]; then
        respond_error 429 'Retry-After: invalid\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: invalid\r\n' 'rate limited'
      fi
      ;;
    beyond-deadline)
      respond_error 403 'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 4000\r\n' 'API rate limit exceeded for installation'
      ;;
    forbidden)
      respond_error 403 'X-RateLimit-Remaining: 42\r\n' 'Resource not accessible by integration'
      ;;
    unauthorized)
      respond_error 401 '' 'Bad credentials'
      ;;
    unavailable)
      respond_error 503 '' 'Service unavailable'
      ;;
    transient)
      if [ "$now" -lt 1060 ]; then respond_error 502 '' 'Bad gateway'; fi
      ;;
  esac

  if [[ "$2" == *'/actions/workflows/'* ]]; then
    if [[ "${FAKE_MODE:-record}" == workflow-rate* ]] && [ "$now" -lt 1007 ]; then
      respond_error 403 'Retry-After: 7\r\n' 'secondary rate limit'
    fi
    printf 'HTTP/2.0 200 OK\r\n\r\n'
    if [ "${FAKE_MODE:-record}" = "no-producer" ]; then
      printf '{"workflow_runs":[]}\n'
    else
      status=in_progress
      conclusion=null
      if [ "${FAKE_MODE:-record}" = "failed-run" ] ||
        [ "${FAKE_MODE:-record}" = "workflow-rate-failure" ] || {
        [ "${FAKE_MODE:-record}" = "later-failure" ] && [ "$now" -ge 1060 ]
      }; then
        status=completed
        conclusion='"failure"'
      fi
      printf '{"workflow_runs":[{"id":42,"status":"%s","conclusion":%s,"created_at":"2026-05-11T00:00:00Z","html_url":"https://example.test/run/42","head_sha":"head-sha","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"}}]}\n' "$status" "$conclusion"
    fi
    exit 0
  fi

  [[ "$2" == *'/jobs?filter=all&per_page=100&page='* ]] || exit 1
  printf 'HTTP/2.0 200 OK\r\n\r\n'
  sha=$(sha256sum "$FAKE_MANIFEST" | awk '{print $1}')
  jq -cn --arg sha "$sha" '{jobs:[{id:1,run_id:42,run_attempt:1,name:"Build image",
    steps:[{name:("R2 record " + $sha),status:"completed",conclusion:"success",completed_at:"1970-01-01T00:16:40Z"}]}]}'
  exit 0
fi

echo "unexpected gh call: $*" >&2
exit 1
BASH
chmod +x "${TMPDIR}/bin/gh"
cat >"${TMPDIR}/bin/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
now=$(date +%s)
printf '%s %s\n' "$now" "$*" >>"$AWS_ARGS_LOG"
key="" prefix="" destination=""
operation=$2
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) key=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    --*) shift 2 ;;
    *) destination=$1; shift ;;
  esac
done
case "$operation" in
  list-objects-v2)
    if [ "${FAKE_MODE:-}" = failed-run ] || [ "${FAKE_MODE:-}" = later-failure ] ||
      [ "$now" -lt "${AVAILABLE_AT:-0}" ]; then
      printf '{"Contents":[]}\n'
    else
      sha=$(sha256sum "$FAKE_MANIFEST" | awk '{print $1}')
      jq -cn --arg key "${prefix}1/${sha}.json" \
        '{Contents:[{Key:$key,Size:1000,LastModified:"1970-01-01T00:16:40Z"}]}'
    fi
    ;;
  get-object)
    if [ "${FAKE_MODE:-}" = download-unavailable ]; then exit 1; fi
    if [ "${FAKE_MODE:-}" = download-transient ] && [ "$now" -lt 1060 ]; then exit 1; fi
    cp "$FAKE_MANIFEST" "$destination"
    ;;
  *) exit 2 ;;
esac
BASH
chmod +x "${TMPDIR}/bin/aws"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test R2_ACCOUNT_ID=test R2_BUCKET_NAME=test
export AWS_ARGS_LOG="${TMPDIR}/aws-args.log"

# Control the external clock and sleep commands so real cooldowns can be tested
# without waiting minutes or replacing any production script functions.
cat > "${TMPDIR}/bin/date" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = '+%s' ]; then cat "$CLOCK_FILE"; else /usr/bin/date "$@"; fi
BASH
cat > "${TMPDIR}/bin/sleep" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
now=$(cat "$CLOCK_FILE")
echo "$((now + $1))" >"$CLOCK_FILE"
printf '%s\n' "$1" >>"$SLEEP_LOG"
BASH
chmod +x "${TMPDIR}/bin/date" "${TMPDIR}/bin/sleep"
export CLOCK_FILE="${TMPDIR}/clock" SLEEP_LOG="${TMPDIR}/sleep.log"
echo 1000 >"$CLOCK_FILE"

out=$(PATH="${TMPDIR}/bin:${PATH}" \
  GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
  FAKE_MANIFEST="${TMPDIR}/manifest.json" \
  EXPECTED_RECORD_NAME=runner-image-manifest-aarch64-unknown-linux-musl-build-sha-pr-123 \
  REPO=vm0-ai/vm0 \
  HEAD_SHA=build-sha \
  LOOKUP_SHA=head-sha \
  JOB_REF=pr-123 \
  METAL_HOSTS=dev-1 \
  TARGET=aarch64-unknown-linux-musl \
  PROFILE=vm0/default \
  OUTPUT_DIR="${TMPDIR}/out" \
  POLL_SECONDS=0 \
  "$WAIT")

grep -q -- '/actions/workflows/runner-image.yml/runs?head_sha=head-sha' "${TMPDIR}/gh-args.log" || fail "must verify the canonical producer"
grep -q -- '/jobs?filter=all' "${TMPDIR}/gh-args.log" || fail "must authenticate the record hash against all job attempts"
grep -q -- 'runner-image-manifest-aarch64-unknown-linux-musl-build-sha-pr-123/42/' "$AWS_ARGS_LOG" || fail "must read the exact target and run prefix"
grep -qxF 'producer-run-id=42' <<<"$out" || fail "expected producer-run-id output"
grep -qxF 'bin-dir=/var/lib/vm0-runner/bin/pr-123' <<<"$out" || fail "expected manifest outputs"

: > "${TMPDIR}/gh-args.log"
out=$(PATH="${TMPDIR}/bin:${PATH}" \
  GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
  FAKE_MANIFEST="${TMPDIR}/manifest-x86.json" \
  EXPECTED_RECORD_NAME=runner-image-manifest-x86_64-unknown-linux-musl-build-sha-pr-123 \
  REPO=vm0-ai/vm0 \
  HEAD_SHA=build-sha \
  LOOKUP_SHA=head-sha \
  JOB_REF=pr-123 \
  METAL_HOSTS=dev-1 \
  TARGET=x86_64-unknown-linux-musl \
  PROFILE=vm0/default \
  OUTPUT_DIR="${TMPDIR}/out-x86" \
  POLL_SECONDS=0 \
  "$WAIT")
grep -q -- "runner-image-manifest-x86_64-unknown-linux-musl-build-sha-pr-123/42/" "$AWS_ARGS_LOG" || fail "expected x86 record lookup"
grep -qxF 'producer-run-id=42' <<<"$out" || fail "expected x86 producer-run-id output"

: > "${TMPDIR}/gh-args.log"
if PATH="${TMPDIR}/bin:${PATH}" \
  GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
  FAKE_MANIFEST="${TMPDIR}/manifest.json" \
  REPO=vm0-ai/vm0 \
  HEAD_SHA=build-sha \
  LOOKUP_SHA=head-sha \
  JOB_REF=pr-123 \
  METAL_HOSTS=dev-1 \
  TARGET=powerpc-unknown-linux-musl \
  PROFILE=vm0/default \
  OUTPUT_DIR="${TMPDIR}/unsupported-out" \
  POLL_SECONDS=0 \
  "$WAIT" >"${TMPDIR}/unsupported.out" 2>"${TMPDIR}/unsupported.err"; then
  fail "expected unsupported target to fail"
fi
[ ! -s "${TMPDIR}/gh-args.log" ] || fail "expected unsupported target to fail before gh calls"
grep -q -- 'unsupported runner image target: powerpc-unknown-linux-musl' "${TMPDIR}/unsupported.err" || fail "expected unsupported target message"

: > "${TMPDIR}/gh-args.log"
if PATH="${TMPDIR}/bin:${PATH}" \
  GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
  FAKE_MODE=failed-run \
  FAKE_MANIFEST="${TMPDIR}/manifest.json" \
  EXPECTED_RECORD_NAME=runner-image-manifest-aarch64-unknown-linux-musl-build-sha-pr-123 \
  REPO=vm0-ai/vm0 \
  HEAD_SHA=build-sha \
  LOOKUP_SHA=head-sha \
  JOB_REF=pr-123 \
  METAL_HOSTS=dev-1 \
  TARGET=aarch64-unknown-linux-musl \
  PROFILE=vm0/default \
  OUTPUT_DIR="${TMPDIR}/failed-out" \
  POLL_SECONDS=0 \
  "$WAIT" >"${TMPDIR}/failed.out" 2>"${TMPDIR}/failed.err"; then
  fail "expected failed producer run without record to fail"
fi
grep -q -- '/actions/workflows/runner-image.yml/runs?head_sha=head-sha&per_page=20' "${TMPDIR}/gh-args.log" || fail "expected failed path to query producer run by LOOKUP_SHA"
grep -q -- 'runner image workflow completed with conclusion=failure' "${TMPDIR}/failed.err" || fail "expected producer failure message"

run_wait() {
  echo 1000 >"$CLOCK_FILE"
  : >"$SLEEP_LOG"
  : >"${TMPDIR}/gh-args.log"
  : >"$AWS_ARGS_LOG"
  env PATH="${TMPDIR}/bin:${PATH}" \
    GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
    FAKE_MANIFEST="${TMPDIR}/manifest.json" \
    EXPECTED_RECORD_NAME=runner-image-manifest-aarch64-unknown-linux-musl-build-sha-pr-123 \
    REPO=vm0-ai/vm0 HEAD_SHA=build-sha LOOKUP_SHA=head-sha JOB_REF=pr-123 \
    METAL_HOSTS=dev-1 TARGET=aarch64-unknown-linux-musl PROFILE=vm0/default \
    OUTPUT_DIR="${TMPDIR}/out" "$@" "$WAIT" >"${TMPDIR}/case.out" 2>"${TMPDIR}/case.err"
}

expect_success() {
  if ! run_wait "$@"; then
    cat "${TMPDIR}/case.err" >&2
    fail "expected successful manifest: $*"
  fi
  grep -qxF 'bin-dir=/var/lib/vm0-runner/bin/pr-123' "${TMPDIR}/case.out" || fail "expected validated manifest outputs"
}

expect_failure() {
  if run_wait "$@"; then fail "expected failure: $*"; fi
  if grep -q '^bin-dir=' "${TMPDIR}/case.out"; then fail "failed wait must not publish manifest outputs"; fi
}

expect_success FAKE_MODE=primary
[ "$(cat "$SLEEP_LOG")" = 7 ] || fail "expected primary quota reset plus boundary second"
grep -q '^1007 s3api get-object ' "$AWS_ARGS_LOG" || fail "expected download after primary reset"

expect_success FAKE_MODE=retry-after
[ "$(cat "$SLEEP_LOG")" = 12 ] || fail "expected later of Retry-After and quota reset"

expect_success FAKE_MODE=headerless
[ "$(paste -sd, "$SLEEP_LOG")" = '60,120,240,300' ] || fail "expected capped exponential cooldown beyond three responses"

expect_success FAKE_MODE=invalid-headers
[ "$(cat "$SLEEP_LOG")" = 60 ] || fail "expected cooldown for unusable headers"

expect_success FAKE_MODE=workflow-rate AVAILABLE_AT=1007
grep -q '^1007 api .*workflows/' "${TMPDIR}/gh-args.log" || fail "expected producer request after Retry-After"

expect_success FAKE_MODE=workflow-rate-failure AVAILABLE_AT=1007
grep -q '^1007 s3api get-object ' "$AWS_ARGS_LOG" || fail "expected record uploaded during status cooldown to take priority"

expect_success FAKE_MODE=download-transient
[ "$(paste -sd, "$SLEEP_LOG")" = "30,30" ] || fail "expected bounded R2 delivery recovery"

expect_success FAKE_MODE=transient
[ "$(paste -sd, "$SLEEP_LOG")" = '30,30' ] || fail "expected transient metadata recovery"

for mode in forbidden unauthorized beyond-deadline; do
  expect_failure FAKE_MODE="$mode"
  [ ! -s "$SLEEP_LOG" ] || fail "expected immediate permanent failure or unsatisfiable deadline"
  [ "$(wc -l <"${TMPDIR}/gh-args.log")" -eq 1 ] || fail "must not retry permanent failures or before quota reset"
done
grep -q 'cannot retry within runner image wait deadline' "${TMPDIR}/case.err" || fail "expected deadline diagnosis"

expect_failure FAKE_MODE=unavailable
[ "$(wc -l <"${TMPDIR}/gh-args.log")" -eq 3 ] || fail "expected bounded transient error attempts"

expect_failure FAKE_MODE=headerless TIMEOUT_SECONDS=100
[ "$(cat "$SLEEP_LOG")" = 60 ] || fail "must not shorten cooldown to fit deadline"

expect_failure FAKE_MODE=no-producer TIMEOUT_SECONDS=60
grep -q 'cannot retry within runner image wait deadline' "${TMPDIR}/case.err" || fail "expected bounded producer discovery"

expect_failure TIMEOUT_SECONDS=0
[ ! -s "${TMPDIR}/gh-args.log" ] || fail "must not start requests after deadline"

expect_failure FAKE_MODE=download-unavailable TIMEOUT_SECONDS=10 POLL_SECONDS=5
[ "$(cat "$SLEEP_LOG")" = 5 ] || fail "expected download retry budget bounded by deadline"

expect_success AVAILABLE_AT=1090
[ "$(grep -c '/actions/workflows/' "${TMPDIR}/gh-args.log")" -eq 2 ] || fail "expected fewer producer status requests"
grep -q '^1060 api .*workflows/' "${TMPDIR}/gh-args.log" || fail "expected producer refresh after 60 seconds"
grep -q '^1090 s3api get-object ' "$AWS_ARGS_LOG" || fail "expected record readiness between producer checks"

expect_failure FAKE_MODE=later-failure
grep -q 'workflow completed with conclusion=failure' "${TMPDIR}/case.err" || fail "expected refreshed producer failure"

expect_failure HEAD_SHA=wrong-sha EXPECTED_RECORD_NAME=runner-image-manifest-aarch64-unknown-linux-musl-wrong-sha-pr-123
grep -q 'headSha mismatch' "${TMPDIR}/case.err" || fail "expected exact manifest identity validation"

echo "wait-runner-image-test: ok"
