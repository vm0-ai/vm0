#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
. "${SCRIPT_DIR}/contract.env"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

target="${1:-${TARGET_TRIPLE:-}}"
case "$target" in
  aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
  "") echo "missing runner binary target" >&2; exit 2 ;;
  *) echo "unsupported runner binary target: ${target}" >&2; exit 2 ;;
esac

revision="${RUNNER_BINARY_GIT_REVISION:-HEAD}"
crates_tree=$(git -C "$REPO_ROOT" rev-parse "${revision}:crates")
contract_tree=$(git -C "$REPO_ROOT" rev-parse "${revision}:.github/runner-binary-build")
binary_input_digest=$(
  printf '%s\0%s\0%s\0%s\0' \
    "$RUNNER_BINARY_INPUT_SCHEMA_VERSION" \
    "$target" \
    "$crates_tree" \
    "$contract_tree" \
    | sha256sum \
    | awk '{print $1}'
)

emit "binary-input-digest" "$binary_input_digest"
emit "crates-tree" "$crates_tree"
emit "contract-tree" "$contract_tree"
emit "toolchain-image" "$RUNNER_BINARY_TOOLCHAIN_IMAGE"
