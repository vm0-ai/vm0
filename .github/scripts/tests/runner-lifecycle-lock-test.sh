#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
barrier_script="${repo_root}/.github/scripts/cancel-superseded-merge-group-runs.sh"
lock_script="${repo_root}/.github/scripts/with-runner-lifecycle-lock.sh"
namespace_cleanup_script="${repo_root}/.github/scripts/cleanup-turbo-runner-namespace.sh"
tmp_dir=$(mktemp -d)
background_pids=()

cleanup() {
  local pid
  for pid in "${background_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

fake_bin="${tmp_dir}/bin"
lock_root="${tmp_dir}/locks"
mkdir -p "$fake_bin" "$lock_root"

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

endpoint=""
for argument in "$@"; do
  case "$argument" in
    repos/*) endpoint=$argument ;;
  esac
done

case "$endpoint" in
  repos/vm0-ai/vm0/pulls/42)
    printf 'feature/late-approval\tvm0-ai/vm0\n'
    ;;
  repos/vm0-ai/vm0/actions/runs)
    printf '[{"workflow_runs":[]}]\n'
    ;;
  *)
    echo "unexpected gh endpoint: ${endpoint}" >&2
    exit 1
    ;;
esac
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

remote=$1
host=${remote#*@}
if [ -n "${MOCK_SSH_ATTEMPT_FIFO:-}" ]; then
  printf '%s\n' "${MOCK_OWNER:-unknown}" >"$MOCK_SSH_ATTEMPT_FIFO"
fi
mkdir -p "$MOCK_LOCK_ROOT"
lock_file="${MOCK_LOCK_ROOT}/${host}-${JOB_REF}.lock"
exec flock --exclusive --timeout 5 "$lock_file" \
  bash -c 'printf "%s\n" VM0_RUNNER_LIFECYCLE_LOCK_ACQUIRED; cat >/dev/null'
SH

cat >"${fake_bin}/ansible-playbook" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'cleanup-entered\n' >"$MOCK_CLEANUP_READY_FIFO"
IFS= read -r release <"$MOCK_CLEANUP_RELEASE_FIFO"
[ "$release" = "release" ]
printf 'delete\n' >>"$MOCK_ORDER_LOG"
SH

cat >"${fake_bin}/late-start-critical" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'start\n' >>"$MOCK_ORDER_LOG"
SH
chmod +x "${fake_bin}/gh" "${fake_bin}/ssh" \
  "${fake_bin}/ansible-playbook" "${fake_bin}/late-start-critical"

barrier_output=$(
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=vm0-ai/vm0 \
    GITHUB_RUN_ID=900 \
    PR_NUMBER=42 \
    RUNNER_OWNER_SCOPE=closed-pr-cleanup \
    SUPERSEDED_RUN_POLL_SECONDS=0 \
    SUPERSEDED_RUN_TIMEOUT_SECONDS=5 \
    bash "$barrier_script"
)
grep -q "No active runner-owner CI runs found for PR #42" <<<"$barrier_output" ||
  fail "expected the stabilized discovery barrier to return an empty owner set"

cleanup_ready_fifo="${tmp_dir}/cleanup-ready"
cleanup_release_fifo="${tmp_dir}/cleanup-release"
late_attempt_fifo="${tmp_dir}/late-attempt"
order_log="${tmp_dir}/order.log"
mkfifo "$cleanup_ready_fifo" "$cleanup_release_fifo" "$late_attempt_fifo"
: >"$order_log"

PATH="${fake_bin}:$PATH" \
  JOB_REF=pr-42 \
  GH_TOKEN=test-token \
  GITHUB_REPOSITORY=vm0-ai/vm0 \
  GITHUB_RUN_ID=900 \
  METAL_HOSTS=metal-a.example.test \
  METAL_USER=runner \
  PR_NUMBER=42 \
  MOCK_CLEANUP_READY_FIFO="$cleanup_ready_fifo" \
  MOCK_CLEANUP_RELEASE_FIFO="$cleanup_release_fifo" \
  MOCK_LOCK_ROOT="$lock_root" \
  MOCK_ORDER_LOG="$order_log" \
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
  "$lock_script" "$namespace_cleanup_script" \
  >"${tmp_dir}/cleanup.out" 2>"${tmp_dir}/cleanup.err" &
cleanup_pid=$!
background_pids+=("$cleanup_pid")

cleanup_ready=$(
  # shellcheck disable=SC2016
  timeout 5 bash -c 'IFS= read -r line <"$1"; printf "%s\n" "$line"' \
    bash "$cleanup_ready_fifo"
) || {
  sed 's/^/  /' "${tmp_dir}/cleanup.err" >&2
  fail "cleanup did not enter its locked critical section"
}
[ "$cleanup_ready" = "cleanup-entered" ] ||
  fail "cleanup readiness marker was invalid"

# Model approval after the empty discovery snapshot: the late Turbo start now
# tries to acquire the same namespace while cleanup still owns deletion.
PATH="${fake_bin}:$PATH" \
  JOB_REF=pr-42 \
  METAL_HOSTS=metal-a.example.test \
  METAL_USER=runner \
  MOCK_LOCK_ROOT="$lock_root" \
  MOCK_ORDER_LOG="$order_log" \
  MOCK_OWNER=late-start \
  MOCK_SSH_ATTEMPT_FIFO="$late_attempt_fifo" \
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
  "$lock_script" "$fake_bin/late-start-critical" \
  >"${tmp_dir}/late.out" 2>"${tmp_dir}/late.err" &
late_pid=$!
background_pids+=("$late_pid")

late_attempt=$(
  # shellcheck disable=SC2016
  timeout 5 bash -c 'IFS= read -r line <"$1"; printf "%s\n" "$line"' \
    bash "$late_attempt_fifo"
) || fail "late-approved start did not attempt to acquire the lifecycle lock"
[ "$late_attempt" = "late-start" ] || fail "late start attempt marker was invalid"
kill -0 "$late_pid" 2>/dev/null || fail "late start exited instead of waiting for cleanup"
[ ! -s "$order_log" ] || fail "late start entered while cleanup still held the namespace lock"

printf 'release\n' >"$cleanup_release_fifo"
wait "$cleanup_pid" || {
  sed 's/^/  /' "${tmp_dir}/cleanup.err" >&2
  fail "locked cleanup failed"
}
wait "$late_pid" || {
  sed 's/^/  /' "${tmp_dir}/late.err" >&2
  fail "late start failed after cleanup released the namespace"
}
background_pids=()

[ "$(cat "$order_log")" = $'delete\nstart' ] ||
  fail "cleanup and late start did not serialize in ownership order"

echo "runner-lifecycle-lock-test: ok"
