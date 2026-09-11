#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

FAKE_BIN="$TEST_DIR/bin"
MANIFEST_DIR="$TEST_DIR/manifests"
mkdir -p "$FAKE_BIN" "$MANIFEST_DIR"

cat >"$FAKE_BIN/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-n" ]; then
  shift
fi
target="${1#*@}"
case "$target" in
  arm-1|arm-2)
    echo "aarch64"
    ;;
  x86-1)
    echo "x86_64"
    ;;
  *)
    echo "unexpected host: $target" >&2
    exit 1
    ;;
esac
SH
chmod +x "$FAKE_BIN/ssh"

cat >"$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'HTTP/2.0 200 OK\r\n\r\n'
if [[ "$2" == *'/actions/workflows/'* ]]; then
  jq -cn --arg head "$HEAD_SHA" '{
    workflow_runs:[{id:42,head_sha:$head,path:".github/workflows/runner-image.yml",
      repository:{full_name:"vm0-ai/vm0"},status:"in_progress",created_at:"2026-05-11T00:00:00Z",
      html_url:"https://github.com/vm0-ai/vm0/actions/runs/42"}]}'
else
  steps='[]'
  for arch in arm64 x86_64; do
    file="$MANIFEST_DIR/${arch}.json"
    if [ "$arch" = x86_64 ] && [ "${FAKE_X86_MISMATCH:-}" = 1 ]; then file="$MANIFEST_DIR/x86_64-mismatch.json"; fi
    sha=$(sha256sum "$file" | awk '{print $1}')
    steps=$(jq -c --arg sha "$sha" --arg now "$(date -u +%FT%TZ)" \
      '. + [{name:("R2 record " + $sha),status:"completed",conclusion:"success",completed_at:$now}]' <<<"$steps")
  done
  jq -cn --argjson steps "$steps" '{jobs:[{id:1,run_id:42,run_attempt:1,name:"Build",steps:$steps}]}'
fi
SH
cat >"$FAKE_BIN/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
operation=$2
prefix="" key="" destination=""
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix=$2; shift 2 ;;
    --key) key=$2; shift 2 ;;
    --*) shift 2 ;;
    *) destination=$1; shift ;;
  esac
done
if [[ "${prefix}${key}" == *aarch64* ]]; then
  file="$MANIFEST_DIR/arm64.json"
elif [ "${FAKE_X86_MISMATCH:-}" = 1 ]; then
  file="$MANIFEST_DIR/x86_64-mismatch.json"
else
  file="$MANIFEST_DIR/x86_64.json"
fi
case "$operation" in
  list-objects-v2)
    sha=$(sha256sum "$file" | awk '{print $1}')
    jq -cn --arg key "${prefix}1/${sha}.json" --arg now "$(date -u +%FT%TZ)" \
      '{Contents:[{Key:$key,Size:1000,LastModified:$now}]}'
    ;;
  get-object) cp "$file" "$destination" ;;
  *) exit 2 ;;
esac
SH
chmod +x "$FAKE_BIN/gh" "$FAKE_BIN/aws"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test R2_ACCOUNT_ID=test R2_BUCKET_NAME=test

make_manifest() {
  local file="$1"
  local target="$2"
  local bin_dir="$3"
  local runner_dir="$4"
  local runner_sha="$5"
  local hosts_json="$6"

  jq -n \
    --arg head_sha "head-sha" \
    --arg job_ref "job-ref" \
    --arg profile "debug" \
    --arg target "$target" \
    --arg bin_dir "$bin_dir" \
    --arg runner_dir "$runner_dir" \
    --arg runner_sha "$runner_sha" \
    --argjson hosts "$hosts_json" \
    '{
      schemaVersion: 1,
      headSha: $head_sha,
      jobRef: $job_ref,
      profile: $profile,
      target: $target,
      binDir: $bin_dir,
      runnerDir: $runner_dir,
      runnerSha256: $runner_sha,
      guestSha256: {
        "guest-agent": "guest-agent-sha",
        "guest-storage-apply": "guest-storage-apply-sha",
        "guest-init": "guest-init-sha",
        "claude-mock": "claude-mock-sha",
        "codex-mock": "codex-mock-sha",
        "guest-state-restore": "guest-state-restore-sha",
        "guest-tool-exec": "guest-tool-exec-sha",
        "runner-rpc-client": "runner-rpc-client-sha",
        "guest-write-file": "guest-write-file-sha",
        "guest-workspace-mount": "guest-workspace-mount-sha"
      },
      hosts: $hosts
    }' >"$file"
}

make_manifest \
  "$MANIFEST_DIR/arm64.json" \
  "aarch64-unknown-linux-musl" \
  "/var/lib/vm0-runner/bin/job-ref" \
  "/var/lib/vm0-runner/runners/job-ref" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  '{
    "arm-1": {"rootfsHash": "rootfs-arm-1", "snapshotHash": "snapshot-arm-1"},
    "arm-2": {"rootfsHash": "rootfs-arm-2", "snapshotHash": "snapshot-arm-2"}
  }'

make_manifest \
  "$MANIFEST_DIR/x86_64.json" \
  "x86_64-unknown-linux-musl" \
  "/var/lib/vm0-runner/bin/job-ref" \
  "/var/lib/vm0-runner/runners/job-ref" \
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  '{"x86-1": {"rootfsHash": "rootfs-x86-1", "snapshotHash": "snapshot-x86-1"}}'

make_manifest \
  "$MANIFEST_DIR/x86_64-mismatch.json" \
  "x86_64-unknown-linux-musl" \
  "/var/lib/vm0-runner/bin/other-job-ref" \
  "/var/lib/vm0-runner/runners/job-ref" \
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  '{"x86-1": {"rootfsHash": "rootfs-x86-1", "snapshotHash": "snapshot-x86-1"}}'

run_wait_groups() {
  local output_file="$1"

  PATH="$FAKE_BIN:$PATH" \
    AWS_METAL_RUNNER_HOSTS="arm-1,arm-2,x86-1" \
    METAL_USER="ci" \
    HEAD_SHA="head-sha" \
    JOB_REF="job-ref" \
    LOOKUP_SHA="head-sha" \
    PROFILE="debug" \
    REPO="vm0-ai/vm0" \
    MANIFEST_DIR="$MANIFEST_DIR" \
    OUTPUT_DIR="$TEST_DIR/output-dir" \
    GITHUB_OUTPUT="$output_file" \
    "$SCRIPT_DIR/wait-runner-image-groups.sh"
}

assert_output_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -Fq "$pattern" "$file"; then
    echo "expected output to contain $pattern" >&2
    cat "$file" >&2
    exit 1
  fi
}

output_file="$TEST_DIR/output"
run_wait_groups "$output_file"

assert_output_contains "$output_file" 'bin-dir=/var/lib/vm0-runner/bin/job-ref'
assert_output_contains "$output_file" 'runner-dir=/var/lib/vm0-runner/runners/job-ref'
assert_output_contains "$output_file" 'runner-sha-map={"aarch64-unknown-linux-musl":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","x86_64-unknown-linux-musl":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
assert_output_contains "$output_file" '"arm-1":"rootfs-arm-1"'
assert_output_contains "$output_file" '"arm-2":"rootfs-arm-2"'
assert_output_contains "$output_file" '"x86-1":"rootfs-x86-1"'
assert_output_contains "$output_file" '"arm-1":"snapshot-arm-1"'
assert_output_contains "$output_file" '"x86-1":"snapshot-x86-1"'

mismatch_output="$TEST_DIR/mismatch-output"
if FAKE_X86_MISMATCH=1 run_wait_groups "$mismatch_output" 2>"$TEST_DIR/mismatch.err"; then
  echo "expected mismatched bin-dir to fail" >&2
  exit 1
fi

if ! grep -Fq "manifests disagree on bin-dir" "$TEST_DIR/mismatch.err"; then
  echo "expected bin-dir mismatch error" >&2
  cat "$TEST_DIR/mismatch.err" >&2
  exit 1
fi

echo "wait-runner-image-groups-test: ok"
