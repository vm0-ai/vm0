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
printf '%s\n' "$*" >> "$SSH_LOG"
exit 42
BASH
chmod +x "${TMPDIR}/bin/ssh"
: > "${TMPDIR}/ssh.log"
if PATH="${TMPDIR}/bin:${PATH}" \
  SSH_LOG="${TMPDIR}/ssh.log" \
  JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  RUNNER_PATH="$runner" \
  FRESH_METADATA_PATH="$metadata" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$PREPARE" >"${TMPDIR}/valid-input.out" 2>"${TMPDIR}/valid-input.err"; then
  fail "expected mocked SSH boundary to fail"
fi
grep -q 'ci@dev-1 uname -m' "${TMPDIR}/ssh.log" || fail "valid supplied runner must reach the SSH boundary"

echo "prepare-runner-image-test: ok"
