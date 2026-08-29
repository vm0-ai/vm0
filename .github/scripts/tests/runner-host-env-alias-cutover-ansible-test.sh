#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"
inventory="$script_dir/fixtures/runner-promotion-local.ini"
promote_playbook="$repo_root/ansible/playbooks/promote-runner.yml"
cutover_helper="$repo_root/ansible/files/runner-host-env-alias-cutover.py"

if ! command -v ansible-playbook >/dev/null; then
  echo "ansible-playbook is required" >&2
  exit 1
fi

fail() {
  echo "$*" >&2
  exit 1
}

assert_file_equals() {
  local expected=$1
  local actual=$2
  if ! cmp -s "$expected" "$actual"; then
    echo "expected exact file equality: $expected $actual" >&2
    diff -u "$expected" "$actual" >&2 || true
    exit 1
  fi
}

assert_no_backup() {
  if [ -e "$backup_file" ]; then
    fail "host env cutover backup was not finalized"
  fi
}

case "$(uname -m)" in
  x86_64)
    runner_target=x86_64-unknown-linux-musl
    ;;
  aarch64)
    runner_target=aarch64-unknown-linux-musl
    ;;
  *)
    fail "unsupported test architecture: $(uname -m)"
    ;;
esac

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

test_home="$tmp/home"
test_bin="$tmp/bin"
data_dir="$tmp/vm0-runner"
runner_release=v999.0.0
runner_bin_dir="$data_dir/bin/$runner_release"
host_env_file="$data_dir/host.env"
backup_file="$data_dir/.host.env.okou-alias-cutover-backup"
invocation_log="$data_dir/runner-invocations"
mkdir -p \
  "$test_home" \
  "$test_bin" \
  "$data_dir/locks" \
  "$data_dir/runners/$runner_release" \
  "$runner_bin_dir"

fake_systemctl="$test_bin/systemctl"
cat >"$fake_systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  list-units)
    printf '%s\n' 'vm0-runner-v998.0.0.service loaded active running old runner'
    ;;
  list-unit-files)
    ;;
  *)
    echo "unexpected systemctl invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$fake_systemctl"

fake_runner="$runner_bin_dir/runner"
cat >"$fake_runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

data_dir="$(cd "$(dirname "$0")/../.." && pwd)"
host_env_file="$data_dir/host.env"
invocation_log="$data_dir/runner-invocations"

alias_state=absent
if [ -f "$host_env_file" ]; then
  if grep -Eq '^[[:space:]]*VM0_RUNNER_(CONCURRENCY_FACTOR|DISK_BANDWIDTH_MIB_PER_SEC|DISK_IOPS|NET_RX_MIB_PER_SEC|NET_TX_MIB_PER_SEC)[[:space:]]*=' "$host_env_file"; then
    alias_state=legacy
  elif grep -Eq '^[[:space:]]*OKOU_RUNNER_(CONCURRENCY_FACTOR|DISK_BANDWIDTH_MIB_PER_SEC|DISK_IOPS|NET_RX_MIB_PER_SEC|NET_TX_MIB_PER_SEC)[[:space:]]*=' "$host_env_file"; then
    alias_state=canonical
  fi
fi
printf '%s|%s\n' "$*" "$alias_state" >>"$invocation_log"

case "${1:-}" in
  service)
    case "${2:-}" in
      install)
        [ "$alias_state" != legacy ] || exit 1
        [ ! -e "$data_dir/fail-install" ] || exit 1
        touch "$data_dir/target-installed"
        exit 0
        ;;
      wait-running)
        [ -e "$data_dir/target-installed" ] || exit 1
        [ ! -e "$data_dir/fail-wait" ] || exit 1
        exit 0
        ;;
      stop)
        touch "$data_dir/target-stopped"
        [ ! -e "$data_dir/fail-stop" ] || exit 1
        exit 0
        ;;
      drain)
        [ -e "$data_dir/target-healthy" ] || exit 1
        exit 0
        ;;
    esac
    ;;
  doctor)
    if [ ! -e "$data_dir/target-healthy" ] && [ -e "$data_dir/fail-health" ]; then
      exit 1
    fi
    touch "$data_dir/target-healthy"
    exit 0
    ;;
  gc)
    [ "$*" = "gc --keep-latest 6 --protect-version v999.0.0" ] || exit 1
    exit 0
    ;;
esac

echo "unexpected runner invocation: $*" >&2
exit 1
EOF
chmod +x "$fake_runner"

HOME="$test_home" \
  ANSIBLE_CONFIG="$ansible_config" \
  ANSIBLE_NOCOLOR=1 \
  ansible-playbook -i "$inventory" --syntax-check "$promote_playbook" >/dev/null

reset_scenario() {
  rm -f \
    "$data_dir"/fail-install \
    "$data_dir"/fail-wait \
    "$data_dir"/fail-health \
    "$data_dir"/fail-stop \
    "$data_dir"/target-installed \
    "$data_dir"/target-healthy \
    "$data_dir"/target-stopped \
    "$host_env_file" \
    "$backup_file"
  : >"$invocation_log"
}

run_promotion() {
  local output_file=$1
  PATH="$test_bin:$PATH" \
    HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook \
      -i "$inventory" \
      --limit runner-promotion-a \
      -e "data_dir=$data_dir" \
      -e "runner_host_env_file=$host_env_file" \
      -e "runner_version=999.0.0" \
      -e "runner_target=$runner_target" \
      "$promote_playbook" >"$output_file" 2>&1
}

expect_success() {
  local output_file=$1
  if ! run_promotion "$output_file"; then
    sed -n '1,240p' "$output_file" >&2
    fail "expected runner promotion to succeed"
  fi
}

expect_failure() {
  local output_file=$1
  if run_promotion "$output_file"; then
    sed -n '1,240p' "$output_file" >&2
    fail "expected runner promotion to fail"
  fi
}

reset_scenario
legacy_file="$tmp/legacy.env"
canonical_file="$tmp/canonical.env"
cat >"$legacy_file" <<'EOF'
# Preserve this comment and every blank line.

  VM0_RUNNER_CONCURRENCY_FACTOR = 1.5000
# Preserve the suffix too.
EOF
cat >"$canonical_file" <<'EOF'
# Preserve this comment and every blank line.

  OKOU_RUNNER_CONCURRENCY_FACTOR = 1.5000
# Preserve the suffix too.
EOF
cp "$legacy_file" "$host_env_file"
chmod 0640 "$host_env_file"
metadata_before=$(stat -c '%u:%g:%a' "$host_env_file")
expect_success "$tmp/legacy-success.out"
assert_file_equals "$canonical_file" "$host_env_file"
[ "$(stat -c '%u:%g:%a' "$host_env_file")" = "$metadata_before" ] || \
  fail "host env ownership or mode changed"
assert_no_backup

health_line=$(grep -nF "doctor --name $runner_release|canonical" "$invocation_log" | head -n 1 | cut -d: -f1)
drain_line=$(grep -nF 'service drain --name v998.0.0|canonical' "$invocation_log" | cut -d: -f1)
if [ -z "$health_line" ] || [ -z "$drain_line" ] || [ "$health_line" -ge "$drain_line" ]; then
  fail "target health must succeed before an old service drains"
fi

replay_metadata=$(stat -c '%u:%g:%a:%Y:%i' "$host_env_file")
expect_success "$tmp/canonical-replay.out"
assert_file_equals "$canonical_file" "$host_env_file"
[ "$(stat -c '%u:%g:%a:%Y:%i' "$host_env_file")" = "$replay_metadata" ] || \
  fail "canonical replay edited host.env"
assert_no_backup

reset_scenario
all_legacy_file="$tmp/all-legacy.env"
all_canonical_file="$tmp/all-canonical.env"
cat >"$all_legacy_file" <<'EOF'
VM0_RUNNER_CONCURRENCY_FACTOR=1.5
VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
VM0_RUNNER_DISK_IOPS=200000
VM0_RUNNER_NET_RX_MIB_PER_SEC=1250
VM0_RUNNER_NET_TX_MIB_PER_SEC=1000
EOF
cat >"$all_canonical_file" <<'EOF'
OKOU_RUNNER_CONCURRENCY_FACTOR=1.5
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
OKOU_RUNNER_DISK_IOPS=200000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=1250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=1000
EOF
cp "$all_legacy_file" "$host_env_file"
"$cutover_helper" migrate "$host_env_file" >"$tmp/pending-migration.out"
grep -Fqx 'host_env_alias_cutover=migrated' "$tmp/pending-migration.out" || \
  fail "initial helper migration did not report its fixed state"
assert_file_equals "$all_canonical_file" "$host_env_file"
[ -f "$backup_file" ] || fail "pending migration did not retain its restoration file"
pending_file_identity=$(stat -c '%u:%g:%a:%Y:%i' "$host_env_file")
pending_backup_identity=$(stat -c '%u:%g:%a:%Y:%i' "$backup_file")
"$cutover_helper" migrate "$host_env_file" >"$tmp/pending-replay.out"
grep -Fqx 'host_env_alias_cutover=migrated' "$tmp/pending-replay.out" || \
  fail "pending migration replay did not converge"
[ "$(stat -c '%u:%g:%a:%Y:%i' "$host_env_file")" = "$pending_file_identity" ] || \
  fail "pending migration replay rewrote host.env"
[ "$(stat -c '%u:%g:%a:%Y:%i' "$backup_file")" = "$pending_backup_identity" ] || \
  fail "pending migration replay replaced its restoration file"
expect_success "$tmp/pending-replay-promotion.out"
assert_file_equals "$all_canonical_file" "$host_env_file"
assert_no_backup

reset_scenario
mixed_file="$tmp/mixed.env"
mixed_expected="$tmp/mixed-expected.env"
cat >"$mixed_file" <<'EOF'
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC = 2000
VM0_RUNNER_DISK_IOPS=200000
# NET_RX is intentionally absent.
 VM0_RUNNER_NET_TX_MIB_PER_SEC = 1000
EOF
cat >"$mixed_expected" <<'EOF'
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC = 2000
OKOU_RUNNER_DISK_IOPS=200000
# NET_RX is intentionally absent.
 OKOU_RUNNER_NET_TX_MIB_PER_SEC = 1000
EOF
cp "$mixed_file" "$host_env_file"
expect_success "$tmp/mixed-success.out"
assert_file_equals "$mixed_expected" "$host_env_file"
assert_no_backup
if grep -Fq 'VM0_RUNNER_' "$host_env_file"; then
  fail "present I/O aliases did not move in one file transaction"
fi

reset_scenario
expect_success "$tmp/missing-success.out"
[ ! -e "$host_env_file" ] || fail "missing host.env was created"
assert_no_backup

for conflict_kind in aliases duplicate; do
  reset_scenario
  case "$conflict_kind" in
    aliases)
      cat >"$host_env_file" <<'EOF'
OKOU_RUNNER_CONCURRENCY_FACTOR=canonical-value-must-not-leak
VM0_RUNNER_CONCURRENCY_FACTOR=legacy-value-must-not-leak
EOF
      ;;
    duplicate)
      cat >"$host_env_file" <<'EOF'
VM0_RUNNER_DISK_IOPS=first-value-must-not-leak
VM0_RUNNER_DISK_IOPS=second-value-must-not-leak
EOF
      ;;
  esac
  cp -p "$host_env_file" "$tmp/$conflict_kind-original.env"
  expect_failure "$tmp/$conflict_kind-conflict.out"
  assert_file_equals "$tmp/$conflict_kind-original.env" "$host_env_file"
  assert_no_backup
  [ ! -s "$invocation_log" ] || fail "alias conflict reached target installation"
  grep -Fq 'host_env_alias_cutover=conflict' "$tmp/$conflict_kind-conflict.out" || \
    fail "alias conflict did not report its fixed state"
  if grep -Fq 'value-must-not-leak' "$tmp/$conflict_kind-conflict.out"; then
    fail "configured value leaked into Ansible output"
  fi
done

for failure_point in install wait health; do
  reset_scenario
  cat >"$host_env_file" <<'EOF'
# exact failure restoration
VM0_RUNNER_CONCURRENCY_FACTOR = restoration-value-must-not-leak
EOF
  chmod 0640 "$host_env_file"
  cp -p "$host_env_file" "$tmp/$failure_point-original.env"
  touch "$data_dir/fail-$failure_point"
  if [ "$failure_point" = health ]; then
    touch "$data_dir/fail-stop"
  fi
  expect_failure "$tmp/$failure_point-failure.out"
  assert_file_equals "$tmp/$failure_point-original.env" "$host_env_file"
  [ "$(stat -c '%u:%g:%a' "$host_env_file")" = "$(stat -c '%u:%g:%a' "$tmp/$failure_point-original.env")" ] || \
    fail "failure restoration changed ownership or mode"
  assert_no_backup
  grep -Fq "service stop --name $runner_release --force --cleanup failed-start|canonical" "$invocation_log" || \
    fail "failed target was not stopped before restoration"
  if grep -Fq 'service drain --name' "$invocation_log"; then
    fail "old service drained after target failure"
  fi
  if grep -Fq 'restoration-value-must-not-leak' "$tmp/$failure_point-failure.out"; then
    fail "restored value leaked into Ansible output"
  fi
done

echo "runner-host-env-alias-cutover-ansible-test: ok"
