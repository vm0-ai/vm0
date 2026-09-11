#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="${SCRIPT_DIR}/runner-ci-record.sh"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_failure() { if "$@" >"${TEST_DIR}/failure.out" 2>&1; then fail "expected failure: $*"; fi; }
mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/store"
ln -s "${SCRIPT_DIR}/tests/fixtures/runner-ci-aws.sh" "${TEST_DIR}/bin/aws"
cat >"${TEST_DIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *'/jobs?filter=all&per_page=100' ]] || exit 2
jq -s '.' "$JOBS_FILE"
BASH
chmod +x "${TEST_DIR}/bin/gh"
export PATH="${TEST_DIR}/bin:$PATH" AWS_STORE="${TEST_DIR}/store" AWS_LOG="${TEST_DIR}/aws.log"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test R2_ACCOUNT_ID=test R2_BUCKET_NAME=test
export REPO=vm0-ai/vm0 RECORD_NAME=runner-image-manifest-arm64-test-pr-123
export PRODUCER_RUN_ID=42 PRODUCER_RUN_ATTEMPT=1 JOBS_FILE="${TEST_DIR}/jobs.json"
export GITHUB_OUTPUT="${TEST_DIR}/outputs"
prefix="runner-ci/v1/${REPO}/${RECORD_NAME}/42"
printf '{"ready":true}\n' >"${TEST_DIR}/manifest.json"
sha=$(sha256sum "${TEST_DIR}/manifest.json" | awk '{print $1}')
key="${prefix}/1/${sha}.json"
MANIFEST_PATH="${TEST_DIR}/manifest.json" "$RECORD" publish >/dev/null
grep -qxF "record-sha=${sha}" "$GITHUB_OUTPUT" || fail "publication must expose verified hash"
cmp "${TEST_DIR}/manifest.json" "${AWS_STORE}/${key}"
# Conditional publication accepts an existing object only after readback.
MANIFEST_PATH="${TEST_DIR}/manifest.json" "$RECORD" publish >/dev/null

now=$(date -u +%FT%TZ)
jq -n --arg key "$key" --arg now "$now" \
  '{Contents:[{Key:$key,Size:15,LastModified:$now}]}' >"${AWS_STORE}/index.json"
jq -n --arg sha "$sha" --arg now "$now" '{jobs:[{
  id:1,run_id:42,run_attempt:1,name:"Build arm64",steps:[{
    name:("R2 record " + $sha),status:"completed",conclusion:"success",completed_at:$now
  }]
}]}' >"$JOBS_FILE"
MANIFEST_PATH="${TEST_DIR}/download.json" "$RECORD" fetch
cmp "${TEST_DIR}/manifest.json" "${TEST_DIR}/download.json"

# Failed-only reruns may leave this successful producer on the first attempt.
jq '.jobs += [{id:2,run_id:42,run_attempt:2,name:"Build x86",steps:[]}]' "$JOBS_FILE" >"${TEST_DIR}/other-rerun.json"
JOBS_FILE="${TEST_DIR}/other-rerun.json" MANIFEST_PATH="${TEST_DIR}/download.json" "$RECORD" fetch
# Rerunning this producer invalidates its previous receipt, even on failure.
jq '.jobs += [{id:3,run_id:42,run_attempt:2,name:"Build arm64",steps:[]}]' "$JOBS_FILE" >"${TEST_DIR}/producer-rerun.json"
expect_failure env JOBS_FILE="${TEST_DIR}/producer-rerun.json" MANIFEST_PATH="${TEST_DIR}/download.json" "$RECORD" fetch

for change in '.jobs[0].steps[0].conclusion="failure"' \
  '.jobs[0].steps[0].status="in_progress"' '.jobs[0].run_id=43' \
  '.jobs[0].steps[0].name="R2 record forged"' \
  '.jobs[0].steps[0].completed_at="2000-01-01T00:00:00Z"'; do
  jq "$change" "$JOBS_FILE" >"${TEST_DIR}/invalid-jobs.json"
  expect_failure env JOBS_FILE="${TEST_DIR}/invalid-jobs.json" MANIFEST_PATH="${TEST_DIR}/download.json" "$RECORD" fetch
done

# Replacing bytes under an attested key must not authorize the replacement.
printf '{"ready":false}\n' >"${AWS_STORE}/${key}"
expect_failure env MANIFEST_PATH="${TEST_DIR}/download.json" "$RECORD" fetch
: >"$GITHUB_OUTPUT"
expect_failure env MANIFEST_PATH="${TEST_DIR}/manifest.json" "$RECORD" publish
[ ! -s "$GITHUB_OUTPUT" ] || fail "failed readback must not advertise readiness"
cp "${TEST_DIR}/manifest.json" "${AWS_STORE}/${key}"
expect_failure env AWS_MODE=record-get-fail MANIFEST_PATH="${TEST_DIR}/manifest.json" "$RECORD" publish
expect_failure env AWS_MODE=put-fail PRODUCER_RUN_ATTEMPT=2 MANIFEST_PATH="${TEST_DIR}/manifest.json" "$RECORD" publish
if grep -q supersecret "${TEST_DIR}/failure.out"; then fail "publication leaked request material"; fi

jq '.Contents[0].LastModified="2000-01-01T00:00:00Z"' "${AWS_STORE}/index.json" >"${TEST_DIR}/old-index.json"
cp "${TEST_DIR}/old-index.json" "${AWS_STORE}/index.json"
expect_failure env MANIFEST_PATH="${TEST_DIR}/download.json" "$RECORD" fetch

# Cleanup reads successive pages (recent entries must not hide old keys),
# removes only scoped old metadata, and leaves binaries/unrelated keys intact.
old_key="runner-ci/v1/${REPO}/runner-binary-asset-arm64-test/41/1/${sha}.json"
outside_key="runner-ci/v1/another/repo/runner-image-manifest-arm64/41/1/${sha}.json"
invalid_key="runner-ci/v1/${REPO}/unrelated/41/1/${sha}.json"
for object in "$old_key" "$outside_key" "$invalid_key"; do
  mkdir -p "${AWS_STORE}/$(dirname "$object")"
  cp "${TEST_DIR}/manifest.json" "${AWS_STORE}/${object}"
done
jq -n --arg key "$key" --arg now "$now" '{Contents:[{Key:$key,LastModified:$now}],IsTruncated:true,NextContinuationToken:"2"}' >"${AWS_STORE}/index.json"
jq -n --arg old "$old_key" --arg outside "$outside_key" --arg invalid "$invalid_key" \
  '{Contents:[$old,$outside,$invalid] | map({Key:.,LastModified:"2000-01-01T00:00:00Z"}),IsTruncated:false}' >"${AWS_STORE}/index2.json"
DRY_RUN=true "$RECORD" cleanup >"${TEST_DIR}/cleanup.out"
[ -f "${AWS_STORE}/${old_key}" ] || fail "dry-run deleted metadata"
grep -q 'Would delete expired Runner CI record' "${TEST_DIR}/cleanup.out" || fail "dry-run must report expired metadata"
expect_failure env AWS_MODE=partial-delete DRY_RUN=false "$RECORD" cleanup
DRY_RUN=false "$RECORD" cleanup >"${TEST_DIR}/cleanup.out"
[ ! -e "${AWS_STORE}/${old_key}" ] || fail "expired metadata was retained"
for object in "$key" "$outside_key" "$invalid_key"; do
  [ -f "${AWS_STORE}/${object}" ] || fail "cleanup exceeded its scope: $object"
done
expect_failure env AWS_MODE=list-fail "$RECORD" cleanup

# The cache planner owns a shorter process-group deadline than individual
# transfers. Cancelling that owner must also interrupt a nested AWS operation.
mkdir "${TEST_DIR}/cancel-bin"
mkfifo "${TEST_DIR}/ready" "${TEST_DIR}/terminated" "${TEST_DIR}/block"
export CANCEL_READY="${TEST_DIR}/ready" CANCEL_TERMINATED="${TEST_DIR}/terminated" CANCEL_BLOCK="${TEST_DIR}/block"
exec {ready_fd}<>"$CANCEL_READY" {terminated_fd}<>"$CANCEL_TERMINATED"
cat >"${TEST_DIR}/cancel-bin/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
trap 'printf "terminated\n" >"$CANCEL_TERMINATED"; exit 143' TERM
exec 3<>"$CANCEL_BLOCK"
printf '%s\n' "$BASHPID" >"$CANCEL_READY"
read -r blocked <&3
BASH
chmod +x "${TEST_DIR}/cancel-bin/aws"
timeout --kill-after=5s 60s env PATH="${TEST_DIR}/cancel-bin:$PATH" \
  MANIFEST_PATH="${TEST_DIR}/manifest.json" "$RECORD" publish >"${TEST_DIR}/cancel.out" 2>&1 &
owner_pid=$!
if ! read -r -t 10 aws_pid <&"$ready_fd"; then
  kill -TERM "$owner_pid"
  wait "$owner_pid" || true
  fail "AWS operation did not reach the cancellation boundary"
fi
kill -TERM "$owner_pid"
if ! read -r -t 5 state <&"$terminated_fd"; then
  kill -TERM "$aws_pid"
  wait "$owner_pid" || true
  fail "owner cancellation left the nested AWS operation running"
fi
wait "$owner_pid" && fail "cancelled owner unexpectedly succeeded"
[ "$state" = terminated ] || fail "AWS operation did not acknowledge termination"
echo "runner-ci-record-test: ok"
