#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../../.." && pwd)
WORKER="$REPO_ROOT/.github/scripts/runner-storage-baseline-benchmark-remote.sh"
REVISION=dc9bfc7a3c2faf607e2520d80c233792bf8f9249

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

assert_fails_with() {
  local expected=$1
  shift
  local status=0

  set +e
  bash "$WORKER" "$@" >"$tmp/out" 2>"$tmp/err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "worker input unexpectedly succeeded: $*" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$tmp/err"; then
    echo "worker error did not contain: $expected" >&2
    cat "$tmp/err" >&2
    exit 1
  fi
}

assert_fails_with \
  'Source revision must be a full lowercase 40-character Git commit' \
  /bin service vm0/group /runner not-a-revision 1 /bin/true
assert_fails_with \
  'Sample count must be an integer' \
  /bin service vm0/group /runner "$REVISION" nope /bin/true
assert_fails_with \
  'Sample count must be between 1 and 100' \
  /bin service vm0/group /runner "$REVISION" 0 /bin/true
assert_fails_with \
  'Sample count must be between 1 and 100' \
  /bin service vm0/group /runner "$REVISION" 101 /bin/true
assert_fails_with \
  'Report script is not executable' \
  /bin service vm0/group /runner "$REVISION" 1 "$tmp/missing-report"

echo "runner-storage-baseline-benchmark-test: ok"
