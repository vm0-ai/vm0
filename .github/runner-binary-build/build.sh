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

target="${TARGET_TRIPLE:-}"
case "$target" in
  aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
  "") echo "missing runner binary target" >&2; exit 2 ;;
  *) echo "unsupported runner binary target: ${target}" >&2; exit 2 ;;
esac

revision="${RUNNER_BINARY_GIT_REVISION:-HEAD}"
cargo_target_dir="${CARGO_TARGET_DIR:-${REPO_ROOT}/crates/target}"
if [[ "$cargo_target_dir" != /* ]]; then
  cargo_target_dir="${REPO_ROOT}/${cargo_target_dir}"
fi
context_root="${RUNNER_BINARY_CONTEXT_ROOT:-${RUNNER_TEMP:-${cargo_target_dir}}/runner-binary-build-context-${target}}"
case "$context_root" in
  /|"$REPO_ROOT")
    echo "refusing unsafe runner binary context path: ${context_root}" >&2
    exit 2
    ;;
esac

materialize() {
  rm -rf "$context_root"
  mkdir -p "${context_root}/crates" "${context_root}/.github/runner-binary-build"
  git -C "$REPO_ROOT" archive "${revision}:crates" \
    | tar -xf - -C "${context_root}/crates"
  git -C "$REPO_ROOT" archive "${revision}:.github/runner-binary-build" \
    | tar -xf - -C "${context_root}/.github/runner-binary-build"
  emit "context-root" "$context_root"
}

build() {
  local actual_toolchain_image="${RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE:-}"
  if [ -z "$actual_toolchain_image" ]; then
    echo "missing required env: RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE" >&2
    exit 2
  fi
  if [ "$actual_toolchain_image" != "$RUNNER_BINARY_TOOLCHAIN_IMAGE" ]; then
    echo "runner binary toolchain mismatch: ${actual_toolchain_image} != ${RUNNER_BINARY_TOOLCHAIN_IMAGE}" >&2
    exit 2
  fi

  local metadata_path="${RUNNER_BINARY_METADATA_PATH:-${REPO_ROOT}/runner-binary-fresh/metadata.json}"
  if [[ "$metadata_path" != /* ]]; then
    metadata_path="${REPO_ROOT}/${metadata_path}"
  fi
  mkdir -p "$(dirname "$metadata_path")"

  local digest_output binary_input_digest
  digest_output=$(RUNNER_BINARY_GIT_REVISION="$revision" "${SCRIPT_DIR}/digest.sh" "$target")
  binary_input_digest=$(sed -n 's/^binary-input-digest=//p' <<<"$digest_output")
  if [[ ! "$binary_input_digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid runner binary input digest: ${binary_input_digest}" >&2
    exit 1
  fi

  materialize
  TARGET_TRIPLE="$target" \
  CARGO_TARGET_DIR="$cargo_target_dir" \
  RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE="$actual_toolchain_image" \
  RUNNER_BINARY_INPUT_DIGEST="$binary_input_digest" \
  RUNNER_BINARY_METADATA_PATH="$metadata_path" \
    "${context_root}/.github/runner-binary-build/compile.sh"

  emit "binary-input-digest" "$binary_input_digest"
  emit "runner-path" "${cargo_target_dir}/${target}/${RUNNER_BINARY_PROFILE}/runner"
  emit "metadata-path" "$metadata_path"
}

case "${1:-build}" in
  materialize) materialize ;;
  build) build ;;
  *) echo "usage: build.sh [build|materialize]" >&2; exit 2 ;;
esac
