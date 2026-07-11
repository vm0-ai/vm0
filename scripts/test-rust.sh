#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MANIFEST_PATH="${REPO_ROOT}/crates/Cargo.toml"
CARGO_BIN="${CARGO:-cargo}"
TEST_MOCK_CLAUDE_PATH_ENV="VM0_TEST_GUEST_MOCK_CLAUDE_PATH"
TEST_MOCK_CODEX_PATH_ENV="VM0_TEST_GUEST_MOCK_CODEX_PATH"

fail() {
  echo "test-rust: $1" >&2
  exit 2
}

command -v "$CARGO_BIN" >/dev/null 2>&1 || fail "Cargo executable not found: ${CARGO_BIN}"
command -v jq >/dev/null 2>&1 || fail "jq is required"

original_args=("$@")
build_args=()
index=0

while [ "$index" -lt "${#original_args[@]}" ]; do
  arg="${original_args[$index]}"
  if [ "$arg" = "--" ]; then
    break
  fi

  case "$arg" in
    -r | --release | --locked | --offline | --frozen | --ignore-rust-version)
      build_args+=("$arg")
      ;;
    --profile | --target | --target-dir | --config)
      index=$((index + 1))
      if [ "$index" -ge "${#original_args[@]}" ] || [ -z "${original_args[$index]}" ]; then
        fail "${arg} requires a value"
      fi
      build_args+=("$arg" "${original_args[$index]}")
      ;;
    --profile=* | --target=* | --target-dir=* | --config=*)
      [ -n "${arg#*=}" ] || fail "${arg%%=*} requires a value"
      build_args+=("$arg")
      ;;
    --manifest-path | --manifest-path=*)
      fail "--manifest-path is managed by test-rust.sh"
      ;;
  esac

  index=$((index + 1))
done

build_messages="$(mktemp "${TMPDIR:-/tmp}/vm0-rust-test-build.XXXXXX")"
cleanup() {
  rm -f "$build_messages"
}
trap cleanup EXIT

set +e
"$CARGO_BIN" build \
  --manifest-path "$MANIFEST_PATH" \
  -p guest-mock-claude \
  -p guest-mock-codex \
  "${build_args[@]}" \
  --message-format=json-render-diagnostics >"$build_messages"
build_status=$?
set -e

jq -r 'select(.reason == "compiler-message") | .message.rendered // empty' \
  "$build_messages" >&2

if [ "$build_status" -ne 0 ]; then
  exit "$build_status"
fi

resolve_mock_path() {
  local target_name=$1
  local paths=()
  local path

  mapfile -t paths < <(
    jq -r --arg target_name "$target_name" '
      select(
        .reason == "compiler-artifact"
        and .target.name == $target_name
        and ((.target.kind // []) | index("bin"))
        and .executable != null
      )
      | .executable
    ' "$build_messages" | sort -u
  )

  if [ "${#paths[@]}" -ne 1 ]; then
    fail "expected one ${target_name} executable artifact, found ${#paths[@]}"
  fi

  path="${paths[0]}"
  [ -n "$path" ] || fail "Cargo returned an empty ${target_name} executable path"
  [[ "$path" = /* ]] || fail "Cargo returned a relative ${target_name} executable path: ${path}"
  [ -f "$path" ] || fail "${target_name} executable not found at ${path}"

  printf '%s\n' "$path"
}

mock_claude_path="$(resolve_mock_path guest-mock-claude)"
mock_codex_path="$(resolve_mock_path guest-mock-codex)"

cleanup
trap - EXIT

export "$TEST_MOCK_CLAUDE_PATH_ENV=$mock_claude_path"
export "$TEST_MOCK_CODEX_PATH_ENV=$mock_codex_path"

exec "$CARGO_BIN" test --manifest-path "$MANIFEST_PATH" "${original_args[@]}"
