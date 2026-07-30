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

# shellcheck source=.github/scripts/runner-guest-binaries.sh
. "${SCRIPT_DIR}/runner-guest-binaries.sh"
# shellcheck source=.github/scripts/runner-binary-build/contract.env
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

printf '%s\n' "$*" >> "$SSH_LOG"

control_path=""
if [ "${1:-}" = "-S" ]; then
  control_path=$2
  shift 2
fi

if [ "${1:-}" = "-n" ]; then
  if [[ " $* " == *" -O check "* ]]; then
    echo "Master running"
    exit 0
  fi
  if [[ " $* " == *" -O exit "* ]]; then
    exit 0
  fi
  if [[ " $* " == *" -M "* ]] \
    && [[ " $* " == *" -N "* ]] \
    && [[ " $* " == *" -f "* ]]; then
    if [ "${SSH_SCENARIO:-healthy}" = "stale-permanent" ]; then
      echo "Permission denied (publickey). --secret super-secret" >&2
      exit 255
    fi
    if [ "${SSH_SCENARIO:-healthy}" = "stale-exhaustion" ]; then
      echo "recovery master lost its websocket --id client-id" >&2
    fi
    exit 0
  fi
fi

remote=$1
shift

if [ "$#" -eq 2 ] && [ "$1" = "uname" ] && [ "$2" = "-m" ]; then
  probe_count_file="${SSH_STATE_DIR}/probe-count"
  probe_count=0
  if [ -f "$probe_count_file" ]; then
    probe_count=$(< "$probe_count_file")
  fi
  probe_count=$((probe_count + 1))
  printf '%s\n' "$probe_count" > "$probe_count_file"

  case "${SSH_SCENARIO:-healthy}" in
    stale-success|stale-permanent)
      if [ -z "$control_path" ]; then
        echo "mux_client_request_session: session request failed --secret super-secret" >&2
        echo "TUNNEL_SERVICE_TOKEN_ID=client-id" >&2
        exit 124
      fi
      ;;
    stale-exhaustion)
      echo "websocket: bad handshake --secret super-secret" >&2
      exit 255
      ;;
    architecture-mismatch)
      echo "x86_64"
      exit 0
      ;;
    healthy)
      ;;
    *)
      echo "unexpected SSH scenario: ${SSH_SCENARIO}" >&2
      exit 2
      ;;
  esac

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
cat > "${TMPDIR}/bin/timeout" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$TIMEOUT_LOG"
if [[ "${1:-}" == --kill-after=* ]]; then
  shift
fi
shift
exec "$@"
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
chmod +x "${TMPDIR}/bin/ssh" "${TMPDIR}/bin/timeout" "${TMPDIR}/bin/sudo" "${TMPDIR}/bin/systemctl"

prepare_remote_case() {
  local case_dir=$1
  mkdir -p "${case_dir}/state" "${case_dir}/ssh-state" "${case_dir}/runner-temp"
  : > "${case_dir}/ssh.log"
  : > "${case_dir}/timeout.log"
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
  local ssh_scenario=${5:-healthy}
  if PATH="${TMPDIR}/bin:${PATH}" \
    SSH_LOG="${case_dir}/ssh.log" \
    SSH_STATE_DIR="${case_dir}/ssh-state" \
    SSH_SCENARIO="$ssh_scenario" \
    TIMEOUT_LOG="${case_dir}/timeout.log" \
    SYSTEMCTL_LOG="${case_dir}/systemctl.log" \
    SYSTEMCTL_STATE_DIR="${case_dir}/state" \
    SYSTEMCTL_LIST_FAILURE="$list_failure" \
    SYSTEMCTL_STOP_FAILURE_UNIT="$stop_failure_unit" \
    SYSTEMCTL_STICKY_UNIT="$sticky_unit" \
    GITHUB_STEP_SUMMARY="${case_dir}/summary" \
    RUNNER_TEMP="${case_dir}/runner-temp" \
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
if grep -q -- '-M -N -f' "${success_case}/ssh.log"; then
  fail "a healthy transport must not create a recovery master"
fi
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

recovery_case="${TMPDIR}/remote-recovery"
prepare_remote_case "$recovery_case"
set_unit_state "$recovery_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$recovery_case" '' '' '' stale-success
recovery_control_path=$(grep -E -- '^-S .*/recovery-1\.sock -n -M -N -f ci@dev-arm-1$' "${recovery_case}/ssh.log" | head -n1 | awk '{print $2}')
[ -n "$recovery_control_path" ] || fail "expected a dedicated recovery control path"
[ "$(grep -Fxc -- 'ci@dev-arm-1 uname -m' "${recovery_case}/ssh.log")" -eq 1 ] || fail "expected one default transport probe"
if [ "$(grep -Fxc -- "-S ${recovery_control_path} ci@dev-arm-1 uname -m" "${recovery_case}/ssh.log")" -ne 1 ]; then
  cat "${recovery_case}/ssh.log" >&2
  cat "${recovery_case}/out" >&2
  cat "${recovery_case}/err" >&2
  fail "expected one recovery transport probe"
fi
[ "$(grep -Fxc -- "-S ${recovery_control_path} ci@dev-arm-1 bash -s -- /var/lib/vm0-runner/bin/pr-123 /var/lib/vm0-runner/runners/pr-123 pr-123" "${recovery_case}/ssh.log")" -eq 1 ] || fail "expected state-changing preparation to use the recovery transport once"
[ "$(grep -Fxc -- '-n -O exit ci@dev-arm-1' "${recovery_case}/ssh.log")" -eq 1 ] || fail "expected bounded stale default master shutdown"
[ "$(grep -Fxc -- "-S ${recovery_control_path} -n -O exit ci@dev-arm-1" "${recovery_case}/ssh.log")" -eq 1 ] || fail "expected recovery master cleanup"
grep -qF -- "--kill-after=5s 20s ssh ci@dev-arm-1 uname -m" "${recovery_case}/timeout.log" || fail "expected bounded default probe"
grep -qF -- "--kill-after=5s 20s ssh -S ${recovery_control_path} ci@dev-arm-1 uname -m" "${recovery_case}/timeout.log" || fail "expected bounded recovery probe"
grep -qF -- "--kill-after=2s 5s ssh -n -O exit ci@dev-arm-1" "${recovery_case}/timeout.log" || fail "expected bounded stale master shutdown"
grep -q "Cloudflare SSH command-channel probe failed" "${recovery_case}/err" || fail "expected recovery warning"
grep -q 'attempt 1/2 (exit 124)' "${recovery_case}/err" || fail "expected command timeout recovery"
grep -q -- '--secret \[redacted\]' "${recovery_case}/err" || fail "expected probe secret redaction"
grep -q 'TUNNEL_SERVICE_TOKEN_ID=\[redacted\]' "${recovery_case}/err" || fail "expected probe token redaction"
if grep -RqE 'super-secret|client-id' "${recovery_case}/out" "${recovery_case}/err"; then
  fail "recovery diagnostics must not expose credentials"
fi

recovery_exhaustion_case="${TMPDIR}/remote-recovery-exhaustion"
prepare_remote_case "$recovery_exhaustion_case"
set_unit_state "$recovery_exhaustion_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$recovery_exhaustion_case" '' '' '' stale-exhaustion
[ "$(grep -c 'uname -m$' "${recovery_exhaustion_case}/ssh.log")" -eq 2 ] || fail "expected exactly two bounded probes before exhaustion"
if grep -q 'bash -s --' "${recovery_exhaustion_case}/ssh.log"; then
  fail "probe exhaustion must prevent state-changing SSH"
fi
if grep -q '^mutate ' "${recovery_exhaustion_case}/systemctl.log"; then
  fail "probe exhaustion must prevent shared-path mutation"
fi
grep -q "::error title=Cloudflare SSH command-channel probe failed::" "${recovery_exhaustion_case}/err" || fail "expected final probe error"
grep -q 'recovery master lost its websocket --id \[redacted\]' "${recovery_exhaustion_case}/err" || fail "expected redacted recovery master diagnostics"
if grep -RqE 'super-secret|client-id' "${recovery_exhaustion_case}/out" "${recovery_exhaustion_case}/err"; then
  fail "exhausted recovery diagnostics must remain redacted"
fi

architecture_mismatch_case="${TMPDIR}/remote-architecture-mismatch"
prepare_remote_case "$architecture_mismatch_case"
run_remote_case "$architecture_mismatch_case" '' '' '' architecture-mismatch
grep -q 'expects remote architecture aarch64, but dev-arm-1 reported x86_64' "${architecture_mismatch_case}/err" || fail "expected direct architecture mismatch"
if grep -q -- '-M -N -f' "${architecture_mismatch_case}/ssh.log"; then
  fail "a successful architecture mismatch must not reconnect"
fi
if grep -q 'bash -s --' "${architecture_mismatch_case}/ssh.log"; then
  fail "architecture mismatch must prevent state-changing SSH"
fi

permanent_recovery_case="${TMPDIR}/remote-permanent-recovery"
prepare_remote_case "$permanent_recovery_case"
run_remote_case "$permanent_recovery_case" '' '' '' stale-permanent
[ "$(grep -c -- '-M -N -f ci@dev-arm-1$' "${permanent_recovery_case}/ssh.log")" -eq 1 ] || fail "permanent recovery failure must not consume transient retries"
if grep -q 'bash -s --' "${permanent_recovery_case}/ssh.log"; then
  fail "permanent recovery failure must prevent state-changing SSH"
fi
grep -q 'permanent connection failure' "${permanent_recovery_case}/err" || fail "expected permanent recovery classification"
if grep -Rq 'super-secret' "${permanent_recovery_case}/out" "${permanent_recovery_case}/err"; then
  fail "permanent recovery diagnostics must remain redacted"
fi

no_primary_case="${TMPDIR}/remote-no-primary"
prepare_remote_case "$no_primary_case"
set_unit_state "$no_primary_case" "vm0-runner-pr-123-exec.service" active
run_remote_case "$no_primary_case"
if grep -q '^stop ' "${no_primary_case}/systemctl.log"; then
  fail "preparation without a primary runner must not stop auxiliary services"
fi
grep -q '^mutate rm ' "${no_primary_case}/systemctl.log" || fail "preparation without a primary runner must continue"

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
