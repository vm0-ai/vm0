#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
script="$repo_root/ansible/files/vm0-runner-status-collect.py"
playbook="$repo_root/ansible/playbooks/provision-monitoring.yml"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

runners_dir="$tmp_root/runners"
textfile_dir="$tmp_root/textfile"
output_file="$textfile_dir/runner-status.prom"
stderr_file="$tmp_root/stderr.log"

uuid_a="00000000-0000-4000-8000-000000000001"
uuid_b="00000000-0000-4000-8000-000000000002"
uuid_c="00000000-0000-4000-8000-000000000003"
uuid_d="00000000-0000-4000-8000-000000000004"
uuid_e="00000000-0000-4000-8000-000000000005"
uuid_f="00000000-0000-4000-8000-000000000006"
uuid_g="00000000-0000-4000-8000-000000000007"
uuid_h="00000000-0000-4000-8000-000000000008"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

reset_dirs() {
  rm -rf "$runners_dir" "$textfile_dir" "$stderr_file"
  mkdir -p "$textfile_dir"
}

run_collector() {
  VM0_RUNNERS_DIR="$runners_dir" \
    VM0_MONITORING_TEXTFILE_DIR="$textfile_dir" \
    python3 "$script" 2>"$stderr_file"

  [ -f "$output_file" ] || fail "metrics output file was not created"
}

assert_line() {
  local expected="$1"
  grep -qxF "$expected" "$output_file" || fail "missing line: $expected"
}

assert_playbook_contains() {
  local expected="$1"
  grep -qF "$expected" "$playbook" || fail "playbook is missing: $expected"
}

assert_zero_snapshot() {
  local state
  local mode
  local result

  for state in active idle preparing unknown; do
    assert_line "vm0_runner_sandboxes{state=\"$state\"} 0"
  done
  for mode in starting running draining stopping unknown; do
    assert_line "vm0_runner_instances{mode=\"$mode\"} 0"
  done
  for result in included stopped invalid; do
    assert_line "vm0_runner_status_files{result=\"$result\"} 0"
  done
  assert_line "vm0_runner_status_collection_success 1"
}

test_missing_and_empty_runner_roots_emit_zero_metrics() {
  reset_dirs
  run_collector
  assert_zero_snapshot

  mkdir -p "$runners_dir"
  run_collector
  assert_zero_snapshot
}

test_aggregates_current_legacy_and_future_statuses() {
  reset_dirs
  mkdir -p \
    "$runners_dir/current" \
    "$runners_dir/legacy" \
    "$runners_dir/future" \
    "$runners_dir/stopped"

  cat >"$runners_dir/current/status.json" <<EOF
{
  "mode": "running",
  "active_runs": [
    {"sandbox_id": "$uuid_a", "phase": "running"},
    {"sandbox_id": "$uuid_b", "phase": "preparing"},
    {"sandbox_id": "$uuid_b", "phase": "waiting"},
    {"sandbox_id": "$uuid_c", "phase": "waiting"},
    {"sandbox_id": "$uuid_e", "phase": "running"},
    {"sandbox_id": "$uuid_e", "phase": "preparing"}
  ],
  "idle_vms": [
    {"sandbox_id": "$uuid_a", "reuse_key": "overlap"},
    {"sandbox_id": "$uuid_d", "reuse_key": "idle"}
  ]
}
EOF

  cat >"$runners_dir/legacy/status.json" <<EOF
{
  "mode": "draining",
  "active_runs": [
    {"run_id": "legacy-run", "sandbox_id": "$uuid_f"},
    {"run_id": "duplicate-idle", "sandbox_id": "$uuid_d"}
  ],
  "idle_vms": [
    {"sandbox_id": "$uuid_g", "session_id": "legacy-session"}
  ]
}
EOF

  cat >"$runners_dir/future/status.json" <<EOF
{
  "mode": "paused",
  "active_runs": [
    {"sandbox_id": "$uuid_h", "phase": "running"}
  ]
}
EOF

  cat >"$runners_dir/stopped/status.json" <<'EOF'
{
  "mode": "stopped",
  "active_runs": "ignored because the runner is stopped"
}
EOF

  run_collector

  assert_line 'vm0_runner_sandboxes{state="active"} 3'
  assert_line 'vm0_runner_sandboxes{state="idle"} 3'
  assert_line 'vm0_runner_sandboxes{state="preparing"} 1'
  assert_line 'vm0_runner_sandboxes{state="unknown"} 1'
  assert_line 'vm0_runner_instances{mode="running"} 1'
  assert_line 'vm0_runner_instances{mode="draining"} 1'
  assert_line 'vm0_runner_instances{mode="unknown"} 1'
  assert_line 'vm0_runner_status_files{result="included"} 3'
  assert_line 'vm0_runner_status_files{result="stopped"} 1'
  assert_line 'vm0_runner_status_files{result="invalid"} 0'
  assert_line 'vm0_runner_status_collection_success 1'
  if grep -qE "sandbox_id|run_id|reuse_key|session_id|$uuid_a|legacy-run" \
    "$output_file"; then
    fail "identity-level data leaked into metrics"
  fi
}

test_invalid_files_publish_partial_metrics() {
  reset_dirs
  mkdir -p \
    "$runners_dir/valid" \
    "$runners_dir/malformed-json" \
    "$runners_dir/malformed-shape" \
    "$runners_dir/invalid-id"

  cat >"$runners_dir/valid/status.json" <<EOF
{"mode":"starting","active_runs":[{"sandbox_id":"$uuid_a","phase":"preparing"}]}
EOF
  printf '{' >"$runners_dir/malformed-json/status.json"
  printf '%s\n' '{"mode":"running","active_runs":{}}' \
    >"$runners_dir/malformed-shape/status.json"
  printf '%s\n' \
    '{"mode":"running","idle_vms":[{"sandbox_id":"not-a-uuid"}]}' \
    >"$runners_dir/invalid-id/status.json"

  run_collector

  assert_line 'vm0_runner_sandboxes{state="preparing"} 1'
  assert_line 'vm0_runner_instances{mode="starting"} 1'
  assert_line 'vm0_runner_status_files{result="included"} 1'
  assert_line 'vm0_runner_status_files{result="invalid"} 3'
  assert_line 'vm0_runner_status_collection_success 0'
  grep -q 'malformed-json/status.json' "$stderr_file" ||
    fail "malformed JSON diagnostic was not reported"
  grep -q 'malformed-shape/status.json' "$stderr_file" ||
    fail "malformed shape diagnostic was not reported"
  grep -q 'invalid-id/status.json' "$stderr_file" ||
    fail "invalid UUID diagnostic was not reported"
}

test_rejects_runner_and_status_symlinks() {
  reset_dirs
  mkdir -p "$runners_dir" "$tmp_root/outside-runner" "$runners_dir/status-link"
  printf '%s\n' '{"mode":"running"}' >"$tmp_root/outside-runner/status.json"
  ln -s "$tmp_root/outside-runner" "$runners_dir/runner-link"
  ln -s "$tmp_root/outside-runner/status.json" \
    "$runners_dir/status-link/status.json"

  run_collector

  assert_line 'vm0_runner_status_files{result="included"} 0'
  assert_line 'vm0_runner_status_files{result="invalid"} 2'
  assert_line 'vm0_runner_status_collection_success 0'
  grep -q 'runner directory symlink' "$stderr_file" ||
    fail "runner symlink diagnostic was not reported"
  grep -q 'status file symlink' "$stderr_file" ||
    fail "status symlink diagnostic was not reported"
}

test_output_is_deterministic_and_replaced_atomically() {
  reset_dirs
  mkdir -p "$runners_dir/current"
  printf '%s\n' \
    "{\"mode\":\"running\",\"idle_vms\":[{\"sandbox_id\":\"$uuid_a\"}]}" \
    >"$runners_dir/current/status.json"
  printf '%s\n' 'stale output' >"$output_file"

  run_collector
  cp "$output_file" "$tmp_root/first-output.prom"
  run_collector

  cmp -s "$tmp_root/first-output.prom" "$output_file" ||
    fail "collector output changed between identical runs"
  [ "$(stat -c '%a' "$output_file")" = "644" ] ||
    fail "metrics output permissions are not 0644"
  if find "$textfile_dir" -maxdepth 1 -name '.runner-status.prom.*' | grep -q .; then
    fail "temporary metric files were not cleaned up"
  fi
  assert_line 'vm0_runner_sandboxes{state="idle"} 1'
}

test_missing_textfile_dir_fails() {
  rm -rf "$runners_dir" "$textfile_dir"

  if VM0_RUNNERS_DIR="$runners_dir" \
    VM0_MONITORING_TEXTFILE_DIR="$textfile_dir" \
    python3 "$script" 2>"$stderr_file"; then
    fail "expected missing textfile directory to fail"
  fi

  grep -q 'missing textfile directory' "$stderr_file" ||
    fail "missing textfile directory error was not reported"
}

test_playbook_provisions_independent_collector_cadence() {
  assert_playbook_contains 'src: ../files/vm0-runner-status-collect.py'
  assert_playbook_contains 'dest: /usr/local/bin/vm0-runner-status-collect'
  assert_playbook_contains 'ExecStart=/usr/local/bin/vm0-runner-status-collect'
  assert_playbook_contains 'dest: /etc/systemd/system/vm0-runner-status-collect.timer'
  assert_playbook_contains 'OnUnitActiveSec=15s'
  assert_playbook_contains 'AccuracySec=1s'
  assert_playbook_contains 'OnUnitActiveSec=1min'
}

test_missing_and_empty_runner_roots_emit_zero_metrics
test_aggregates_current_legacy_and_future_statuses
test_invalid_files_publish_partial_metrics
test_rejects_runner_and_status_symlinks
test_output_is_deterministic_and_replaced_atomically
test_missing_textfile_dir_fails
test_playbook_provisions_independent_collector_cadence

echo "vm0 runner status collector tests passed"
