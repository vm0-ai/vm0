#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DRIVER="$REPO_ROOT/.github/scripts/runner-behavior-balloon.sh"
REMOTE_WORKER="$REPO_ROOT/.github/scripts/runner-behavior-balloon-remote.sh"

assert_contains() {
  local file="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_value() {
  local file="$1"
  local expected="$2"
  local actual

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
state_dir="$tmp/state"
runner_temp="$tmp/runner-temp"
mkdir -p "$fake_bin" "$state_dir" "$runner_temp"

cat > "$fake_bin/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -euo pipefail

increment() {
  local name="$1"
  local file="$FAKE_SSH_STATE_DIR/$name"
  local value=0

  if [ -f "$file" ]; then
    value=$(<"$file")
  fi
  value=$((value + 1))
  printf '%s\n' "$value" > "$file"
  printf '%s\n' "$value"
}

if [ "$#" -eq 2 ] && [[ "$2" == *"runner config"* ]]; then
  increment config-count >/dev/null
  exit 0
fi

if [ "$#" -eq 2 ] && [[ "$2" == *"worker.XXXXXX"* ]]; then
  cmp - "$EXPECTED_REMOTE_WORKER"
  increment stage-count >/dev/null
  exit 0
fi

if [ "$#" -eq 2 ] && [[ "$2" == "cat -- "* ]]; then
  increment fetch-count >/dev/null
  printf '%s\n' "durable balloon output"
  exit 0
fi

if [ "$#" -eq 11 ] && [ "$2" = "bash" ] && [ "$3" = "-s" ]; then
  cat > "$FAKE_SSH_STATE_DIR/launch-script"
  launch_attempt=$(increment launch-attempt-count)
  if [ ! -f "$FAKE_SSH_STATE_DIR/started" ]; then
    touch "$FAKE_SSH_STATE_DIR/started"
    increment execution-count >/dev/null
  fi
  if [ "$launch_attempt" -eq 1 ]; then
    exit 255
  fi
  exit 0
fi

if [ "$#" -eq 6 ] && [ "$2" = "bash" ] && [ "$3" = "-s" ]; then
  case "$5" in
    */status)
      cat > "$FAKE_SSH_STATE_DIR/state-script"
      state_attempt=$(increment state-attempt-count)
      case "$state_attempt" in
        1)
          exit 255
          ;;
        2)
          echo "pending"
          ;;
        *)
          echo "done:37"
          ;;
      esac
      exit 0
      ;;
    *)
      cat > "$FAKE_SSH_STATE_DIR/remove-script"
      increment remove-count >/dev/null
      exit 0
      ;;
  esac
fi

echo "unexpected ssh invocation: $*" >&2
exit 2
FAKE_SSH
chmod +x "$fake_bin/ssh"

cat > "$fake_bin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SLEEP_INVOCATIONS"
FAKE_SLEEP
chmod +x "$fake_bin/sleep"

cat > "$fake_bin/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -euo pipefail
exec "$@"
FAKE_SUDO
chmod +x "$fake_bin/sudo"

cat > "$fake_bin/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail

case " $* " in
  *" --property=LoadState "*)
    printf '37\n' > "$RACE_STATUS_FILE"
    echo "loaded"
    ;;
  *" --property=ActiveState "*)
    echo "inactive"
    ;;
  *)
    echo "unexpected systemctl invocation: $*" >&2
    exit 2
    ;;
esac
FAKE_SYSTEMCTL
chmod +x "$fake_bin/systemctl"

status=0
PATH="$fake_bin:$PATH" \
  FAKE_SLEEP_INVOCATIONS="$state_dir/sleep-invocations" \
  FAKE_SSH_STATE_DIR="$state_dir" \
  EXPECTED_REMOTE_WORKER="$REMOTE_WORKER" \
  RUNNER_TEMP="$runner_temp" \
  METAL_USER="metal" \
  HOST="runner.example.test" \
  BIN_DIR="/opt/vm0" \
  JOB_REF="behavior-a" \
  DEFAULT_ROOTFS_HASH="rootfs" \
  DEFAULT_SNAPSHOT_HASH="snapshot" \
  OFFICIAL_RUNNER_SECRET="test-secret" \
  GITHUB_RUN_ID="30429172938" \
  GITHUB_RUN_ATTEMPT="1" \
  bash "$DRIVER" > "$state_dir/stdout" 2> "$state_dir/stderr" || status=$?

[ "$status" -eq 37 ] || {
  echo "expected driver to propagate exit 37; got ${status}" >&2
  cat "$state_dir/stdout" >&2
  cat "$state_dir/stderr" >&2
  exit 1
}

assert_value "$state_dir/config-count" "1"
assert_value "$state_dir/stage-count" "1"
assert_value "$state_dir/launch-attempt-count" "2"
assert_value "$state_dir/execution-count" "1"
assert_value "$state_dir/state-attempt-count" "3"
assert_value "$state_dir/fetch-count" "1"
assert_value "$state_dir/remove-count" "1"
assert_contains "$state_dir/launch-script" "flock 9"
assert_contains "$state_dir/launch-script" "systemd-run"
assert_contains "$state_dir/launch-script" "--collect"
assert_contains "$state_dir/launch-script" "--expand-environment=no"
assert_contains "$state_dir/stdout" "durable balloon output"
assert_contains "$state_dir/stderr" "Lost SSH launch response"
assert_contains "$state_dir/stderr" "Transient SSH failure while observing balloon result"

race_status="$state_dir/race-status"
RACE_STATUS_FILE="$race_status" PATH="$fake_bin:$PATH" \
  bash "$state_dir/state-script" "$race_status" "race-unit" \
  > "$state_dir/race-state"
assert_value "$state_dir/race-state" "done:37"

if find "$runner_temp" -mindepth 1 -print -quit | grep -q .; then
  echo "expected driver to remove its local result file" >&2
  find "$runner_temp" -mindepth 1 -print >&2
  exit 1
fi

echo "runner-behavior-balloon-test: ok"
