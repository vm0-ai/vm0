#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../../.." && pwd)
WORKER="$REPO_ROOT/.github/scripts/runner-behavior-agent-ready-benchmark-remote.sh"

assert_contains() {
  local file=$1
  local expected=$2

  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_count() {
  local file=$1
  local expected=$2
  local value=$3
  local actual=""

  actual=$(grep -Fc -- "$value" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${value} ${expected} time(s); got ${actual}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_value() {
  local file=$1
  local expected=$2
  local actual=""

  actual=$(<"$file")
  if [ "$actual" != "$expected" ]; then
    echo "expected ${file} to contain ${expected}; got ${actual}" >&2
    exit 1
  fi
}

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"

cat > "$fake_bin/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -euo pipefail

increment() {
  local name=$1
  local file="$TEST_STATE_DIR/$name"
  local value=0

  if [ -f "$file" ]; then
    value=$(<"$file")
  fi
  value=$((value + 1))
  printf '%s\n' "$value" > "$file"
  printf '%s\n' "$value"
}

write_agent_log() {
  local run_id=$1
  local sandbox_reuse=$2
  local workspace_reuse=$3

  printf '%s\n' \
    "run_id=${run_id} agent startup timing sandbox_reuse=${sandbox_reuse} workspace_reuse=${workspace_reuse} shell_spawn_ms=1 agent_ready_ms=2 containment_create_us=3 placement_broker_setup_us=4 shell_spawn_component_us=5 bootstrap_ready_wait_us=6" \
    >> "$TEST_STATE_DIR/journal"
}

if [ "$1" = "journalctl" ]; then
  cat "$TEST_STATE_DIR/journal"
  exit 0
fi

if [ "$1" != "/fake/bin/runner" ] || [ "$2" != "local" ] || [ "$3" != "submit" ]; then
  echo "unexpected sudo invocation: $*" >&2
  exit 2
fi

session_id=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then
    session_id=$2
    break
  fi
  shift
done
[ -n "$session_id" ] || { echo "local submit omitted session ID" >&2; exit 2; }

submit_count=$(increment submit-count)
run_id="run-${submit_count}"

case "$session_id" in
  agent-ready-fresh-*)
    write_agent_log "$run_id" PoolMiss CacheMiss
    ;;
  agent-ready-workspace)
    workspace_reuse=CacheMiss
    if [ -f "$TEST_STATE_DIR/last-promotion" ] \
      && [ "$(<"$TEST_STATE_DIR/last-promotion")" = promoted ]; then
      workspace_reuse=Reused
      if [ "$TEST_SCENARIO" = confirmed-miss ]; then
        workspace_reuse=CacheMiss
      fi
    fi
    write_agent_log "$run_id" PoolMiss "$workspace_reuse"
    printf '%s\n' "$run_id" > "$TEST_STATE_DIR/workspace-run-id"
    ;;
  agent-ready-workspace-evictor)
    evict_count=$(increment evict-count)
    workspace_run_id=$(<"$TEST_STATE_DIR/workspace-run-id")
    promotion=promoted
    if [ "$TEST_SCENARIO" = persistent-contention ] \
      || { [ "$TEST_SCENARIO" = transient-contention ] && [ "$evict_count" -eq 1 ]; }; then
      promotion=busy
    fi
    printf '%s\n' "$promotion" > "$TEST_STATE_DIR/last-promotion"
    if [ "$promotion" = busy ]; then
      printf '%s\n' \
        "run_id=${workspace_run_id} workspace image cache promotion skipped: capacity lock busy" \
        >> "$TEST_STATE_DIR/journal"
    else
      printf '%s\n' \
        "run_id=${workspace_run_id} workspace image cache promoted" \
        >> "$TEST_STATE_DIR/journal"
    fi
    ;;
  agent-ready-exact-reuse)
    exact_count=$(increment exact-count)
    if [ "$exact_count" -eq 1 ]; then
      write_agent_log "$run_id" PoolMiss CacheMiss
    else
      write_agent_log "$run_id" Reused SandboxReused
    fi
    ;;
  *)
    echo "unexpected session ID: $session_id" >&2
    exit 2
    ;;
esac

printf '{"run_id":"%s"}\n' "$run_id"
FAKE_SUDO
chmod +x "$fake_bin/sudo"

LAST_CASE_DIR=""

run_case() {
  local name=$1
  local scenario=$2
  local expected_status=$3
  local sample_count=$4
  local case_dir="$tmp/$name"
  local status=0

  mkdir -p "$case_dir"
  : > "$case_dir/journal"
  set +e
  TEST_SCENARIO="$scenario" \
    TEST_STATE_DIR="$case_dir" \
    PATH="$fake_bin:$PATH" \
    bash "$WORKER" /fake/bin vm0/test invocation-id "$sample_count" \
    > "$case_dir/output" 2>&1
  status=$?
  set -e
  if [ "$status" -ne "$expected_status" ]; then
    echo "expected ${name} status ${expected_status}; got ${status}" >&2
    cat "$case_dir/output" >&2
    exit 1
  fi
  LAST_CASE_DIR=$case_dir
}

run_case direct-success direct-success 0 2
assert_count "$LAST_CASE_DIR/output" 2 '"path":"fresh","success":true'
assert_count "$LAST_CASE_DIR/output" 2 '"path":"workspace-cache","success":true'
assert_count "$LAST_CASE_DIR/output" 2 '"path":"exact-reuse","success":true'
assert_value "$LAST_CASE_DIR/submit-count" 10

run_case transient-contention transient-contention 0 1
assert_contains "$LAST_CASE_DIR/output" \
  'RETRY: workspace-cache promotion capacity lock was busy for run run-2'
assert_count "$LAST_CASE_DIR/output" 1 '"path":"workspace-cache","success":true'
assert_value "$LAST_CASE_DIR/submit-count" 8

run_case persistent-contention persistent-contention 1 1
assert_contains "$LAST_CASE_DIR/output" \
  'workspace-cache promotion capacity lock remained busy after 4 attempts'
assert_count "$LAST_CASE_DIR/output" 3 \
  'RETRY: workspace-cache promotion capacity lock was busy'
assert_value "$LAST_CASE_DIR/submit-count" 9

run_case confirmed-miss confirmed-miss 1 1
assert_contains "$LAST_CASE_DIR/output" \
  'workspace-cache sample failed after confirmed promotion: expected workspace_reuse=Reused, observed CacheMiss'
assert_value "$LAST_CASE_DIR/submit-count" 4

echo "PASS: Agent-ready benchmark handles workspace-cache promotion contention"
