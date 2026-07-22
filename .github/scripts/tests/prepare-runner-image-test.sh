#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREPARE="${SCRIPT_DIR}/prepare-runner-image.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE='' \
  "$PREPARE" >"${TMPDIR}/empty.out" 2>"${TMPDIR}/empty.err"; then
  fail "expected empty target to fail"
fi
grep -q "missing runner image target" "${TMPDIR}/empty.err" || fail "expected missing target message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=powerpc-unknown-linux-musl \
  "$PREPARE" >"${TMPDIR}/unsupported.out" 2>"${TMPDIR}/unsupported.err"; then
  fail "expected unsupported target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/unsupported.err" || fail "expected unsupported target message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=' ,  ' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/empty-hosts.out" 2>"${TMPDIR}/empty-hosts.err"; then
  fail "expected empty metal hosts to fail"
fi
grep -q "METAL_HOSTS is empty" "${TMPDIR}/empty-hosts.err" || fail "expected empty metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='bad/host' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-hosts.out" 2>"${TMPDIR}/invalid-hosts.err"; then
  fail "expected invalid metal hosts to fail"
fi
grep -q "invalid METAL_HOSTS entry: bad/host" "${TMPDIR}/invalid-hosts.err" || fail "expected invalid metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='user@host' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-user-host.out" 2>"${TMPDIR}/invalid-user-host.err"; then
  fail "expected user-qualified metal host to fail"
fi
grep -q "invalid METAL_HOSTS entry: user@host" "${TMPDIR}/invalid-user-host.err" || fail "expected user-qualified metal host message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='host-' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-alias.out" 2>"${TMPDIR}/invalid-alias.err"; then
  fail "expected invalid metal host alias to fail"
fi
grep -qF "invalid METAL_HOSTS entry: host-" "${TMPDIR}/invalid-alias.err" || fail "expected invalid metal host alias message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='dev-1, dev-1' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/duplicate-hosts.out" 2>"${TMPDIR}/duplicate-hosts.err"; then
  fail "expected duplicate metal hosts to fail"
fi
grep -q "duplicate METAL_HOSTS entry: dev-1" "${TMPDIR}/duplicate-hosts.err" || fail "expected duplicate metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='Dev-1, dev-1' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/duplicate-hosts-case.out" 2>"${TMPDIR}/duplicate-hosts-case.err"; then
  fail "expected case-insensitive duplicate metal hosts to fail"
fi
grep -q "duplicate METAL_HOSTS entry: dev-1" "${TMPDIR}/duplicate-hosts-case.err" || fail "expected case-insensitive duplicate metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH='' \
  "$PREPARE" >"${TMPDIR}/arch-empty.out" 2>"${TMPDIR}/arch-empty.err"; then
  fail "expected empty expected remote arch to fail"
fi
grep -q "EXPECTED_REMOTE_ARCH is empty" "${TMPDIR}/arch-empty.err" || fail "expected empty expected remote arch message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=x86_64 \
  "$PREPARE" >"${TMPDIR}/arch-mismatch.out" 2>"${TMPDIR}/arch-mismatch.err"; then
  fail "expected expected remote arch mismatch to fail"
fi
grep -q "EXPECTED_REMOTE_ARCH mismatch: aarch64-unknown-linux-musl maps to aarch64, got x86_64" "${TMPDIR}/arch-mismatch.err" || fail "expected expected remote arch mismatch message"

if grep -q 'runner-binary-build/build.sh' "$PREPARE"; then
  fail "host preparation must not invoke the runner binary build"
fi

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/missing-runner.out" 2>"${TMPDIR}/missing-runner.err"; then
  fail "expected a missing supplied runner to fail"
fi
grep -q "missing required env: RUNNER_PATH" "${TMPDIR}/missing-runner.err" || fail "expected missing runner path message"

. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${SCRIPT_DIR}/runner-binary-build/contract.env"
runner_guest_binaries_load
runner="${TMPDIR}/runner"
printf 'prepared runner fixture\n' > "$runner"
runner_sha=$(sha256sum "$runner" | awk '{print $1}')
runner_size=$(stat -c '%s' "$runner")
input_digest=$(printf 'a%.0s' {1..64})
guest_json='{}'
for guest in "${RUNNER_GUEST_BINARIES[@]}"; do
  guest_sha=$(printf '%s' "$guest" | sha256sum | awk '{print $1}')
  guest_json=$(jq -c --arg guest "$guest" --arg sha "$guest_sha" '. + {($guest): $sha}' <<<"$guest_json")
done
metadata="${TMPDIR}/metadata.json"
jq -n \
  --arg digest "$input_digest" \
  --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
  --arg sha "$runner_sha" \
  --argjson size "$runner_size" \
  --argjson guests "$guest_json" '
    {
      schemaVersion: 1,
      binaryInputDigest: $digest,
      target: "aarch64-unknown-linux-musl",
      toolchainImage: $toolchain,
      runnerSha256: $sha,
      runnerSizeBytes: $size,
      guestSha256: $guests
    }
  ' > "$metadata"

printf 'wrong bytes\n' > "${TMPDIR}/wrong-runner"
if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  RUNNER_PATH="${TMPDIR}/wrong-runner" \
  FRESH_METADATA_PATH="$metadata" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$PREPARE" >"${TMPDIR}/wrong-bytes.out" 2>"${TMPDIR}/wrong-bytes.err"; then
  fail "expected mismatched supplied runner bytes to fail"
fi
grep -q "fresh runner size mismatch" "${TMPDIR}/wrong-bytes.err" || fail "expected supplied runner validation message"

ln -s "$metadata" "${TMPDIR}/metadata-link.json"
if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  RUNNER_PATH="$runner" \
  FRESH_METADATA_PATH="${TMPDIR}/metadata-link.json" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$PREPARE" >"${TMPDIR}/metadata-link.out" 2>"${TMPDIR}/metadata-link.err"; then
  fail "expected symlinked supplied metadata to fail"
fi
grep -q "fresh runner metadata is not a regular file" "${TMPDIR}/metadata-link.err" || fail "expected metadata symlink validation message"

mkdir -p "${TMPDIR}/bin"
cat > "${TMPDIR}/bin/ssh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

remote=$1
shift
{
  printf '%s' "$remote"
  printf ' %s' "$@"
  printf '\n'
} >> "$SSH_LOG"

if [ "$#" -eq 2 ] && [ "$1" = "uname" ] && [ "$2" = "-m" ]; then
  echo "aarch64"
  exit 0
fi

if [ "${1:-}" = "bash" ] && [ "${2:-}" = "-s" ]; then
  "$@"
  # Keep this test scoped to remote preparation. A successful preparation
  # stops at the next SSH boundary instead of emulating binary installation.
  exit 42
fi

exit 42
BASH
cat > "${TMPDIR}/bin/sudo" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

command=$1
shift
case "$command" in
  systemctl)
    exec systemctl "$@"
    ;;
  rm|mkdir|find)
    {
      printf 'mutate %s' "$command"
      printf ' %s' "$@"
      printf '\n'
    } >> "$SYSTEMCTL_LOG"
    ;;
  *)
    echo "unexpected sudo command: ${command}" >&2
    exit 1
    ;;
esac
BASH
cat > "${TMPDIR}/bin/systemctl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

command=$1
shift
case "$command" in
  list-units)
    echo "list-units" >> "$SYSTEMCTL_LOG"
    if [ -n "${SYSTEMCTL_LIST_FAILURE:-}" ]; then
      echo "mock list-units failure" >&2
      exit 1
    fi
    for state_path in "${SYSTEMCTL_STATE_DIR}"/*; do
      [ -f "$state_path" ] || continue
      unit=${state_path##*/}
      state=$(< "$state_path")
      printf '%s loaded %s fixture fixture\n' "$unit" "$state"
    done
    ;;
  stop)
    {
      printf 'stop'
      printf ' %s' "$@"
      printf '\n'
    } >> "$SYSTEMCTL_LOG"
    for unit in "$@"; do
      if [ "$unit" = "${SYSTEMCTL_STOP_FAILURE_UNIT:-}" ]; then
        echo "mock stop failure for ${unit}" >&2
        exit 1
      fi
    done
    for unit in "$@"; do
      if [ "$unit" != "${SYSTEMCTL_STICKY_UNIT:-}" ]; then
        printf 'inactive\n' > "${SYSTEMCTL_STATE_DIR}/${unit}"
      fi
    done
    ;;
  show)
    unit=${*: -1}
    echo "show ${unit}" >> "$SYSTEMCTL_LOG"
    if [ -f "${SYSTEMCTL_STATE_DIR}/${unit}" ]; then
      cat "${SYSTEMCTL_STATE_DIR}/${unit}"
    else
      echo "inactive"
    fi
    ;;
  reset-failed)
    {
      printf 'reset-failed'
      printf ' %s' "$@"
      printf '\n'
    } >> "$SYSTEMCTL_LOG"
    ;;
  *)
    echo "unexpected systemctl command: ${command}" >&2
    exit 1
    ;;
esac
BASH
chmod +x "${TMPDIR}/bin/ssh" "${TMPDIR}/bin/sudo" "${TMPDIR}/bin/systemctl"

prepare_remote_case() {
  local case_dir=$1
  mkdir -p "${case_dir}/state"
  : > "${case_dir}/ssh.log"
  : > "${case_dir}/systemctl.log"
}

set_unit_state() {
  local case_dir=$1
  local unit=$2
  local state=$3
  printf '%s\n' "$state" > "${case_dir}/state/${unit}"
}

run_remote_case() {
  local case_dir=$1
  local list_failure=${2:-}
  local stop_failure_unit=${3:-}
  local sticky_unit=${4:-}
  if PATH="${TMPDIR}/bin:${PATH}" \
    SSH_LOG="${case_dir}/ssh.log" \
    SYSTEMCTL_LOG="${case_dir}/systemctl.log" \
    SYSTEMCTL_STATE_DIR="${case_dir}/state" \
    SYSTEMCTL_LIST_FAILURE="$list_failure" \
    SYSTEMCTL_STOP_FAILURE_UNIT="$stop_failure_unit" \
    SYSTEMCTL_STICKY_UNIT="$sticky_unit" \
    JOB_REF=pr-123 \
    HEAD_SHA=abc \
    METAL_HOSTS=dev-arm-1 \
    METAL_USER=ci \
    TARGET_TRIPLE=aarch64-unknown-linux-musl \
    EXPECTED_REMOTE_ARCH=aarch64 \
    RUNNER_PATH="$runner" \
    FRESH_METADATA_PATH="$metadata" \
    EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
    "$PREPARE" >"${case_dir}/out" 2>"${case_dir}/err"; then
    fail "expected mocked post-preparation SSH boundary to fail"
  fi
}

success_case="${TMPDIR}/remote-success"
prepare_remote_case "$success_case"
set_unit_state "$success_case" "vm0-runner-pr-123-2.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-7.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-exec.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-keepalive.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-cancel.service" active
run_remote_case "$success_case"
grep -q 'ci@dev-arm-1 uname -m' "${success_case}/ssh.log" || fail "valid supplied runner must reach the SSH boundary"
grep -Eq '^stop .*vm0-runner-pr-123-2\.service([[:space:]]|$)' "${success_case}/systemctl.log" || fail "expected primary runner suffix 2 to stop"
grep -Eq '^stop .*vm0-runner-pr-123-7\.service([[:space:]]|$)' "${success_case}/systemctl.log" || fail "expected primary runner suffix 7 to stop"
if grep '^stop ' "${success_case}/systemctl.log" | grep -Eq 'vm0-runner-pr-123-(exec|keepalive|cancel)\.service'; then
  fail "auxiliary runner services must not stop"
fi
if grep '^stop ' "${success_case}/systemctl.log" | grep -q 'vm0-runner-pr-123-1\.service'; then
  fail "architecture-subset index must not determine the stopped service"
fi
[ "$(< "${success_case}/state/vm0-runner-pr-123-2.service")" = "inactive" ] || fail "expected primary runner suffix 2 to be inactive"
[ "$(< "${success_case}/state/vm0-runner-pr-123-7.service")" = "inactive" ] || fail "expected primary runner suffix 7 to be inactive"
[ "$(< "${success_case}/state/vm0-runner-pr-123-exec.service")" = "active" ] || fail "expected auxiliary runner to remain active"
last_show_line=$(grep -n '^show ' "${success_case}/systemctl.log" | tail -n1 | cut -d: -f1)
first_mutation_line=$(grep -n '^mutate ' "${success_case}/systemctl.log" | head -n1 | cut -d: -f1)
[ -n "$last_show_line" ] || fail "expected post-stop state verification"
[ -n "$first_mutation_line" ] || fail "expected shared-path mutation after verification"
[ "$last_show_line" -lt "$first_mutation_line" ] || fail "shared paths must not change before state verification"

discovery_failure_case="${TMPDIR}/remote-discovery-failure"
prepare_remote_case "$discovery_failure_case"
set_unit_state "$discovery_failure_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$discovery_failure_case" 1
if grep -q '^mutate ' "${discovery_failure_case}/systemctl.log"; then
  fail "discovery failure must prevent shared-path mutation"
fi
grep -q 'mock list-units failure' "${discovery_failure_case}/out" || fail "expected discovery failure output"

stop_failure_case="${TMPDIR}/remote-stop-failure"
prepare_remote_case "$stop_failure_case"
set_unit_state "$stop_failure_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$stop_failure_case" '' "vm0-runner-pr-123-2.service"
if grep -q '^mutate ' "${stop_failure_case}/systemctl.log"; then
  fail "stop failure must prevent shared-path mutation"
fi
grep -q 'mock stop failure for vm0-runner-pr-123-2.service' "${stop_failure_case}/out" || fail "expected stop failure output"

verification_failure_case="${TMPDIR}/remote-verification-failure"
prepare_remote_case "$verification_failure_case"
set_unit_state "$verification_failure_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$verification_failure_case" '' '' "vm0-runner-pr-123-2.service"
if grep -q '^mutate ' "${verification_failure_case}/systemctl.log"; then
  fail "verification failure must prevent shared-path mutation"
fi
grep -q 'runner service vm0-runner-pr-123-2.service is active after stop' "${verification_failure_case}/out" || fail "expected verification failure output"

echo "prepare-runner-image-test: ok"
