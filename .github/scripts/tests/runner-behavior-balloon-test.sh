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

assert_count() {
  local file="$1"
  local expected="$2"
  local value="$3"
  local actual

  actual=$(grep -Fc -- "$value" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${value} ${expected} time(s); got ${actual}" >&2
    cat "$file" >&2
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
  mkdir -p "$FAKE_REMOTE_DIR"
  cat > "$FAKE_REMOTE_WORKER" <<'FAKE_REMOTE_WORKER_SCRIPT'
#!/usr/bin/env bash
while [ ! -f "$FAKE_WORKER_RELEASE" ]; do
  /bin/sleep 0.01
done
echo "durable balloon output"
exit 37
FAKE_REMOTE_WORKER_SCRIPT
  chmod +x "$FAKE_REMOTE_WORKER"
  increment stage-count >/dev/null
  exit 0
fi

if [ "$#" -eq 2 ] && [[ "$2" == "cat -- "* ]]; then
  increment fetch-count >/dev/null
  [ -f "$FAKE_REMOTE_STATUS" ]
  [ ! -e "${FAKE_REMOTE_STATUS}.tmp" ]
  touch "$FAKE_SSH_STATE_DIR/atomic-status-observed"
  cat "$FAKE_REMOTE_LOG"
  exit 0
fi

if [ "$#" -eq 11 ] && [ "$2" = "bash" ] && [ "$3" = "-s" ]; then
  cat > "$FAKE_SSH_STATE_DIR/launch-script"
  launch_attempt=$(increment launch-attempt-count)
  launch_status=0
  (
    cd "$FAKE_REMOTE_CWD"
    HOME="$FAKE_REMOTE_HOME" bash "$FAKE_SSH_STATE_DIR/launch-script" \
      "$FAKE_REMOTE_DIR" "$FAKE_REMOTE_WORKER" "$FAKE_REMOTE_LOG" \
      "$FAKE_REMOTE_STATUS" "$9" "${10}" "${11}"
  ) || launch_status=$?
  if [ "$launch_status" -ne 0 ]; then
    exit "$launch_status"
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
      if [ "$state_attempt" -eq 1 ]; then
        exit 255
      fi
      bash "$FAKE_SSH_STATE_DIR/state-script" "$FAKE_REMOTE_STATUS" "$6"
      ;;
    *)
      cat > "$FAKE_SSH_STATE_DIR/remove-script"
      increment remove-count >/dev/null
      bash "$FAKE_SSH_STATE_DIR/remove-script" "$FAKE_REMOTE_DIR" "$6"
      ;;
  esac
  exit 0
fi

echo "unexpected ssh invocation ($# args): $*" >&2
exit 2
FAKE_SSH
chmod +x "$fake_bin/ssh"

cat > "$fake_bin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SLEEP_INVOCATIONS"
if [ "$*" = "2" ]; then
  touch "$FAKE_WORKER_RELEASE"
fi
/bin/sleep 0.01
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

case "${FAKE_SYSTEMCTL_MODE:-runtime}: $*" in
  "runtime: "*" stop "*)
    touch "$FAKE_WORKER_RELEASE"
    rm -f "$FAKE_SYSTEMD_ACTIVE"
    ;;
  "runtime: "*" --property=LoadState "*)
    if [ -f "$FAKE_SYSTEMD_ACTIVE" ]; then
      echo "loaded"
    else
      echo "not-found"
    fi
    ;;
  "runtime: "*" --property=ActiveState "*)
    if [ -f "$FAKE_SYSTEMD_ACTIVE" ]; then
      echo "active"
    else
      echo "inactive"
    fi
    ;;
  "publication-race: "*" --property=LoadState "*)
    printf '37\n' > "$RACE_STATUS_FILE"
    echo "loaded"
    ;;
  "publication-race: "*" --property=ActiveState "*)
    echo "inactive"
    ;;
  *)
    echo "unexpected systemctl invocation: $*" >&2
    exit 2
    ;;
esac
FAKE_SYSTEMCTL
chmod +x "$fake_bin/systemctl"

cat > "$fake_bin/systemd-run" <<'FAKE_SYSTEMD_RUN'
#!/usr/bin/env bash
set -euo pipefail

count=0
if [ -f "$FAKE_SYSTEMD_RUN_COUNT_FILE" ]; then
  count=$(<"$FAKE_SYSTEMD_RUN_COUNT_FILE")
fi
printf '%s\n' "$((count + 1))" > "$FAKE_SYSTEMD_RUN_COUNT_FILE"
printf '%s\n' "$@" > "$FAKE_SYSTEMD_RUN_ARGS_FILE"

while [ "$#" -gt 0 ] && [ "$1" != "/bin/bash" ]; do
  shift
done
if [ "$#" -eq 0 ]; then
  echo "systemd-run command not found" >&2
  exit 2
fi

touch "$FAKE_SYSTEMD_ACTIVE"
(
  exec 9>&-
  command_status=0
  "$@" || command_status=$?
  printf '%s\n' "$command_status" > "$FAKE_SYSTEMD_COMMAND_STATUS_FILE"
  rm -f "$FAKE_SYSTEMD_ACTIVE"
) &
FAKE_SYSTEMD_RUN
chmod +x "$fake_bin/systemd-run"

fake_remote_dir="$state_dir/remote"
fake_remote_worker="$fake_remote_dir/worker.sh"
fake_remote_log="$fake_remote_dir/output.log"
fake_remote_status="$fake_remote_dir/status"
fake_remote_home="$state_dir/home"
fake_remote_cwd="$state_dir/cwd"
mkdir -p "$fake_remote_home" "$fake_remote_cwd"

status=0
PATH="$fake_bin:$PATH" \
  FAKE_SLEEP_INVOCATIONS="$state_dir/sleep-invocations" \
  FAKE_SSH_STATE_DIR="$state_dir" \
  EXPECTED_REMOTE_WORKER="$REMOTE_WORKER" \
  FAKE_REMOTE_DIR="$fake_remote_dir" \
  FAKE_REMOTE_WORKER="$fake_remote_worker" \
  FAKE_REMOTE_LOG="$fake_remote_log" \
  FAKE_REMOTE_STATUS="$fake_remote_status" \
  FAKE_REMOTE_HOME="$fake_remote_home" \
  FAKE_REMOTE_CWD="$fake_remote_cwd" \
  FAKE_WORKER_RELEASE="$state_dir/release-worker" \
  FAKE_SYSTEMCTL_MODE="runtime" \
  FAKE_SYSTEMD_ACTIVE="$state_dir/systemd-active" \
  FAKE_SYSTEMD_RUN_COUNT_FILE="$state_dir/execution-count" \
  FAKE_SYSTEMD_RUN_ARGS_FILE="$state_dir/systemd-run-args" \
  FAKE_SYSTEMD_COMMAND_STATUS_FILE="$state_dir/systemd-command-status" \
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
assert_value "$state_dir/systemd-command-status" "37"
test -f "$state_dir/atomic-status-observed"
test ! -e "$fake_remote_dir"
test ! -e "$state_dir/systemd-active"
assert_contains "$state_dir/launch-script" "flock 9"
assert_contains "$state_dir/systemd-run-args" "--collect"
assert_contains "$state_dir/systemd-run-args" "--expand-environment=no"
assert_contains "$state_dir/systemd-run-args" "--uid=$(id -u)"
assert_contains "$state_dir/systemd-run-args" "--gid=$(id -g)"
assert_contains "$state_dir/systemd-run-args" "--working-directory=$fake_remote_cwd"
assert_contains "$state_dir/systemd-run-args" "--setenv=HOME=$fake_remote_home"
assert_count "$state_dir/stdout" "1" "durable balloon output"
assert_contains "$state_dir/stderr" "Lost SSH launch response"
assert_contains "$state_dir/stderr" "Transient SSH failure while observing balloon result"

success_dir="$state_dir/success"
success_worker="$success_dir/worker.sh"
success_log="$success_dir/output.log"
success_status="$success_dir/status"
success_active="$success_dir/active"
success_count="$success_dir/execution-count"
success_args="$success_dir/systemd-run-args"
success_command_status="$success_dir/command-status"
mkdir -p "$success_dir"
cat > "$success_worker" <<'SUCCESS_WORKER'
#!/usr/bin/env bash
echo "successful balloon output"
SUCCESS_WORKER
chmod +x "$success_worker"

for _ in 1 2; do
  (
    cd "$fake_remote_cwd"
    HOME="$fake_remote_home" \
      FAKE_SYSTEMCTL_MODE="runtime" \
      FAKE_SYSTEMD_ACTIVE="$success_active" \
      FAKE_SYSTEMD_RUN_COUNT_FILE="$success_count" \
      FAKE_SYSTEMD_RUN_ARGS_FILE="$success_args" \
      FAKE_SYSTEMD_COMMAND_STATUS_FILE="$success_command_status" \
      FAKE_WORKER_RELEASE="$success_dir/release-worker" \
      PATH="$fake_bin:$PATH" \
      bash "$state_dir/launch-script" \
        "$success_dir" "$success_worker" "$success_log" "$success_status" \
        "success-unit" "/opt/vm0" "behavior-a"
  )
  for _ in $(seq 1 100); do
    if [ -f "$success_status" ] \
      && [ -f "$success_command_status" ] \
      && [ ! -e "$success_active" ]; then
      break
    fi
    /bin/sleep 0.01
  done
  test -f "$success_status"
  test -f "$success_command_status"
  test ! -e "$success_active"
done
assert_value "$success_count" "1"
assert_value "$success_status" "0"
assert_value "$success_command_status" "0"
test ! -e "${success_status}.tmp"
assert_count "$success_log" "1" "successful balloon output"

race_status="$state_dir/race-status"
FAKE_SYSTEMCTL_MODE="publication-race" RACE_STATUS_FILE="$race_status" \
  PATH="$fake_bin:$PATH" \
  bash "$state_dir/state-script" "$race_status" "race-unit" \
  > "$state_dir/race-state"
assert_value "$state_dir/race-state" "done:37"

launch_race_dir="$state_dir/launch-race"
launch_race_status="$launch_race_dir/status"
replay_marker="$launch_race_dir/replayed"
mkdir -p "$launch_race_dir"
launch_race_result=0
FAKE_SYSTEMCTL_MODE="publication-race" RACE_STATUS_FILE="$launch_race_status" \
  FAKE_SYSTEMD_ACTIVE="$launch_race_dir/active" \
  FAKE_SYSTEMD_RUN_COUNT_FILE="$replay_marker" \
  FAKE_SYSTEMD_RUN_ARGS_FILE="$launch_race_dir/args" \
  FAKE_SYSTEMD_COMMAND_STATUS_FILE="$launch_race_dir/command-status" \
  PATH="$fake_bin:$PATH" \
  bash "$state_dir/launch-script" \
    "$launch_race_dir" "$launch_race_dir/worker.sh" \
    "$launch_race_dir/output.log" "$launch_race_status" \
    "race-unit" "/opt/vm0" "behavior-a" || launch_race_result=$?
if [ "$launch_race_result" -ne 0 ]; then
  echo "expected launch retry to accept the concurrently published result" >&2
  exit 1
fi
if [ -e "$replay_marker" ]; then
  echo "expected launch retry not to replay a completed worker" >&2
  exit 1
fi

if find "$runner_temp" -mindepth 1 -print -quit | grep -q .; then
  echo "expected driver to remove its local result file" >&2
  find "$runner_temp" -mindepth 1 -print >&2
  exit 1
fi

echo "runner-behavior-balloon-test: ok"
