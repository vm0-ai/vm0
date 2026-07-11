#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WRAPPER="${REPO_ROOT}/scripts/test-rust.sh"
MANIFEST_PATH="${REPO_ROOT}/crates/Cargo.toml"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
FAKE_CARGO="${TEMP_DIR}/cargo"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"$FAKE_CARGO" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

log_dir=${FAKE_CARGO_LOG_DIR:?}
count_file="${log_dir}/count"
count=0
if [ -f "$count_file" ]; then
  read -r count <"$count_file"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
invocation_dir="${log_dir}/$(printf '%02d' "$count")"
mkdir -p "$invocation_dir"
printf '%s\0' "$@" >"${invocation_dir}/args"
printf 'claude=%s\ncodex=%s\n' \
  "${VM0_TEST_GUEST_MOCK_CLAUDE_PATH:-}" \
  "${VM0_TEST_GUEST_MOCK_CODEX_PATH:-}" >"${invocation_dir}/env"

emit_artifact() {
  local name=$1 path=$2
  jq -nc --arg name "$name" --arg path "$path" '{
    reason: "compiler-artifact",
    target: {name: $name, kind: ["bin"]},
    executable: $path
  }'
}

case "${1:-}" in
  build)
    if [ "${FAKE_BUILD_EXIT:-0}" -ne 0 ]; then
      exit "$FAKE_BUILD_EXIT"
    fi
    case "${FAKE_ARTIFACT_MODE:-normal}" in
      normal)
        emit_artifact guest-mock-claude "$FAKE_MOCK_CLAUDE_PATH"
        emit_artifact guest-mock-codex "$FAKE_MOCK_CODEX_PATH"
        ;;
      missing)
        emit_artifact guest-mock-claude "$FAKE_MOCK_CLAUDE_PATH"
        ;;
      duplicate)
        emit_artifact guest-mock-claude "$FAKE_MOCK_CLAUDE_PATH"
        emit_artifact guest-mock-codex "$FAKE_MOCK_CODEX_PATH"
        emit_artifact guest-mock-codex "$FAKE_DUPLICATE_CODEX_PATH"
        ;;
      relative)
        emit_artifact guest-mock-claude relative/guest-mock-claude
        emit_artifact guest-mock-codex "$FAKE_MOCK_CODEX_PATH"
        ;;
      nonexistent)
        emit_artifact guest-mock-claude "$FAKE_NONEXISTENT_CLAUDE_PATH"
        emit_artifact guest-mock-codex "$FAKE_MOCK_CODEX_PATH"
        ;;
      *)
        echo "unknown FAKE_ARTIFACT_MODE: $FAKE_ARTIFACT_MODE" >&2
        exit 98
        ;;
    esac
    ;;
  test)
    exit "${FAKE_TEST_EXIT:-0}"
    ;;
  *)
    echo "unexpected fake Cargo command: $*" >&2
    exit 99
    ;;
esac
SH
chmod +x "$FAKE_CARGO"

assert_args() {
  local args_file=$1
  shift
  local actual=()
  local expected=("$@")
  local index

  mapfile -d '' -t actual <"$args_file"
  [ "${#actual[@]}" -eq "${#expected[@]}" ] ||
    fail "expected ${#expected[@]} args, got ${#actual[@]}"
  for index in "${!expected[@]}"; do
    [ "${actual[$index]}" = "${expected[$index]}" ] ||
      fail "arg ${index}: expected '${expected[$index]}', got '${actual[$index]}'"
  done
}

prepare_case() {
  local name=$1
  CASE_DIR="${TEMP_DIR}/${name}"
  LOG_DIR="${CASE_DIR}/log"
  MOCK_CLAUDE="${CASE_DIR}/guest-mock-claude"
  MOCK_CODEX="${CASE_DIR}/guest-mock-codex"
  DUPLICATE_CODEX="${CASE_DIR}/duplicate-guest-mock-codex"
  mkdir -p "$LOG_DIR"
  touch "$MOCK_CLAUDE" "$MOCK_CODEX" "$DUPLICATE_CODEX"
}

run_wrapper() {
  env \
    CARGO="$FAKE_CARGO" \
    FAKE_CARGO_LOG_DIR="$LOG_DIR" \
    FAKE_MOCK_CLAUDE_PATH="$MOCK_CLAUDE" \
    FAKE_MOCK_CODEX_PATH="$MOCK_CODEX" \
    FAKE_DUPLICATE_CODEX_PATH="$DUPLICATE_CODEX" \
    FAKE_NONEXISTENT_CLAUDE_PATH="${CASE_DIR}/missing-guest-mock-claude" \
    "${extra_env[@]}" \
    "$WRAPPER" "$@"
}

prepare_case split-options
extra_env=()
target_dir="${CASE_DIR}/custom target"
run_wrapper \
  --release \
  --target fake-target \
  --target-dir "$target_dir" \
  --config net.offline=true \
  --locked \
  -p guest-agent \
  --test cli_child_env \
  child_env \
  -- \
  --nocapture \
  --test-threads=1

[ "$(<"${LOG_DIR}/count")" = "2" ] || fail "expected build and test invocations"
assert_args "${LOG_DIR}/01/args" \
  build --manifest-path "$MANIFEST_PATH" \
  -p guest-mock-claude -p guest-mock-codex \
  --release --target fake-target --target-dir "$target_dir" \
  --config net.offline=true --locked \
  --message-format=json-render-diagnostics
assert_args "${LOG_DIR}/02/args" \
  test --manifest-path "$MANIFEST_PATH" \
  --release --target fake-target --target-dir "$target_dir" \
  --config net.offline=true --locked \
  -p guest-agent --test cli_child_env child_env \
  -- --nocapture --test-threads=1
grep -qxF "claude=${MOCK_CLAUDE}" "${LOG_DIR}/02/env" || fail "missing Claude path"
grep -qxF "codex=${MOCK_CODEX}" "${LOG_DIR}/02/env" || fail "missing Codex path"

prepare_case equals-options
extra_env=()
target_dir="${CASE_DIR}/target"
run_wrapper \
  --profile=ci \
  --target=fake-target \
  --target-dir="$target_dir" \
  --config=build.incremental=false \
  --offline \
  --frozen \
  --ignore-rust-version \
  -p guest-agent \
  --test codex_app_server_backend

assert_args "${LOG_DIR}/01/args" \
  build --manifest-path "$MANIFEST_PATH" \
  -p guest-mock-claude -p guest-mock-codex \
  --profile=ci --target=fake-target --target-dir="$target_dir" \
  --config=build.incremental=false --offline --frozen --ignore-rust-version \
  --message-format=json-render-diagnostics

prepare_case missing-artifact
extra_env=(FAKE_ARTIFACT_MODE=missing)
if run_wrapper >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"; then
  fail "expected a missing Codex artifact to fail"
fi
[ "$(<"${LOG_DIR}/count")" = "1" ] || fail "missing artifact should stop before tests"
grep -q "expected one guest-mock-codex executable artifact, found 0" "${CASE_DIR}/err" ||
  fail "missing artifact error not reported"

prepare_case duplicate-artifact
extra_env=(FAKE_ARTIFACT_MODE=duplicate)
if run_wrapper >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"; then
  fail "expected duplicate Codex artifacts to fail"
fi
grep -q "expected one guest-mock-codex executable artifact, found 2" "${CASE_DIR}/err" ||
  fail "duplicate artifact error not reported"

prepare_case relative-artifact
extra_env=(FAKE_ARTIFACT_MODE=relative)
if run_wrapper >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"; then
  fail "expected a relative Claude artifact to fail"
fi
grep -q "Cargo returned a relative guest-mock-claude executable path" "${CASE_DIR}/err" ||
  fail "relative artifact error not reported"

prepare_case nonexistent-artifact
extra_env=(FAKE_ARTIFACT_MODE=nonexistent)
if run_wrapper >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"; then
  fail "expected a nonexistent Claude artifact to fail"
fi
grep -q "guest-mock-claude executable not found" "${CASE_DIR}/err" ||
  fail "nonexistent artifact error not reported"

prepare_case build-failure
extra_env=(FAKE_BUILD_EXIT=23)
set +e
run_wrapper >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"
status=$?
set -e
[ "$status" = "23" ] || fail "expected build status 23, got ${status}"
[ "$(<"${LOG_DIR}/count")" = "1" ] || fail "build failure should stop before tests"

prepare_case test-failure
extra_env=(FAKE_TEST_EXIT=19)
set +e
run_wrapper >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"
status=$?
set -e
[ "$status" = "19" ] || fail "expected test status 19, got ${status}"
[ "$(<"${LOG_DIR}/count")" = "2" ] || fail "test failure should follow one build"

prepare_case managed-manifest
extra_env=()
if run_wrapper --manifest-path elsewhere/Cargo.toml >"${CASE_DIR}/out" 2>"${CASE_DIR}/err"; then
  fail "expected a caller-managed manifest path to fail"
fi
[ ! -f "${LOG_DIR}/count" ] || fail "manifest validation should happen before Cargo"
grep -q -- "--manifest-path is managed by test-rust.sh" "${CASE_DIR}/err" ||
  fail "managed manifest error not reported"

echo "test-rust-wrapper-test: ok"
