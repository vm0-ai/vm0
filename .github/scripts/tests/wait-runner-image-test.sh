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
    "guest-download": "b",
    "guest-init": "c",
    "guest-mock-claude": "d",
    "guest-mock-codex": "e",
    "guest-reseed": "f",
    "guest-write-file": "g"
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

cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${GH_ARGS_LOG}"

if [ "$1" = "api" ]; then
  if [ "${FAKE_MODE:-artifact}" = "failed-run" ]; then
    printf '{"artifacts":[]}\n'
    exit 0
  fi
  printf '{"artifacts":[{"id":123,"name":"runner-image-manifest-build-sha-pr-123","expired":false,"created_at":"2026-05-11T00:00:00Z","workflow_run":{"id":42,"head_sha":"head-sha"}}]}\n'
  exit 0
fi

if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  if [ "${FAKE_MODE:-artifact}" = "failed-run" ]; then
    printf '[{"databaseId":42,"status":"completed","conclusion":"failure","createdAt":"2026-05-11T00:00:00Z","url":"https://example.test/run/42","headSha":"head-sha"}]\n'
    exit 0
  fi
  printf '[{"databaseId":42,"status":"completed","conclusion":"success","createdAt":"2026-05-11T00:00:00Z","url":"https://example.test/run/42","headSha":"head-sha"}]\n'
  exit 0
fi

if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  artifact=""
  output_dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -n)
        artifact=$2
        shift 2
        ;;
      -D)
        output_dir=$2
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  [ "$artifact" = "runner-image-manifest-build-sha-pr-123" ] || exit 1
  mkdir -p "$output_dir"
  cp "${FAKE_MANIFEST}" "${output_dir}/manifest.json"
  exit 0
fi

echo "unexpected gh call: $*" >&2
exit 1
BASH
chmod +x "${TMPDIR}/bin/gh"

out=$(PATH="${TMPDIR}/bin:${PATH}" \
  GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
  FAKE_MANIFEST="${TMPDIR}/manifest.json" \
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

grep -q -- 'api repos/vm0-ai/vm0/actions/artifacts?name=runner-image-manifest-build-sha-pr-123&per_page=100 --jq .' "${TMPDIR}/gh-args.log" || fail "expected artifact lookup by exact name"
if grep -q -- 'run list' "${TMPDIR}/gh-args.log"; then
  fail "expected artifact-first path to skip run list after artifact is found"
fi
grep -q -- 'run download 42 -n runner-image-manifest-build-sha-pr-123' "${TMPDIR}/gh-args.log" || fail "expected artifact name to use HEAD_SHA"
grep -qxF 'producer-run-id=42' <<<"$out" || fail "expected producer-run-id output"
grep -qxF 'bin-dir=/var/lib/vm0-runner/bin/pr-123' <<<"$out" || fail "expected manifest outputs"

: > "${TMPDIR}/gh-args.log"
if PATH="${TMPDIR}/bin:${PATH}" \
  GH_ARGS_LOG="${TMPDIR}/gh-args.log" \
  FAKE_MODE=failed-run \
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
  fail "expected failed producer run without artifact to fail"
fi
grep -q -- '--commit head-sha' "${TMPDIR}/gh-args.log" || fail "expected failed path to query producer run by LOOKUP_SHA"
grep -q -- 'runner image workflow completed with conclusion=failure' "${TMPDIR}/failed.err" || fail "expected producer failure message"

echo "wait-runner-image-test: ok"
