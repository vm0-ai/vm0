#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
verify_script="${repo_root}/.github/scripts/verify-okou-cli-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

create_artifact() {
  local artifact_dir="$1"
  local include_worker="$2"
  local include_wasm="$3"
  local package_root="${artifact_dir}/contents/package"

  mkdir -p "$package_root"
  printf '%s\n' \
    '{"name":"@okouai/cli","private":true,"bin":{"okou":"okou.js"}}' \
    >"${package_root}/package.json"
  printf 'okou\n' >"${package_root}/okou.js"
  if [[ "$include_worker" == "true" ]]; then
    printf 'worker\n' >"${package_root}/image-resize-worker.js"
  fi
  if [[ "$include_wasm" == "true" ]]; then
    printf 'wasm\n' >"${package_root}/photon_rs_bg.wasm"
  fi

  tar -czf "${artifact_dir}/package.tgz" \
    -C "${artifact_dir}/contents" package
  local package_sha256
  package_sha256="$(sha256sum "${artifact_dir}/package.tgz" | cut -d ' ' -f 1)"
  local package_size
  package_size="$(wc -c <"${artifact_dir}/package.tgz" | tr -d '[:space:]')"
  jq -n \
    --arg commit_sha "$commit_sha" \
    --arg package_sha256 "$package_sha256" \
    --argjson package_size "$package_size" \
    '{
      version: 1,
      commitSha: $commit_sha,
      package: {
        path: "package.tgz",
        sha256: $package_sha256,
        size: $package_size
      }
    }' >"${artifact_dir}/manifest.json"
  local manifest_sha256
  manifest_sha256="$(sha256sum "${artifact_dir}/manifest.json" | cut -d ' ' -f 1)"
  jq -n \
    --arg commit_sha "$commit_sha" \
    --arg manifest_sha256 "$manifest_sha256" \
    '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha256}' \
    >"${artifact_dir}/ready.json"
}

complete_artifact="${tmp_dir}/complete"
mkdir -p "$complete_artifact"
create_artifact "$complete_artifact" true true
bash "$verify_script" "$complete_artifact" "$commit_sha" >/dev/null

missing_worker_artifact="${tmp_dir}/missing-worker"
mkdir -p "$missing_worker_artifact"
create_artifact "$missing_worker_artifact" false true
missing_worker_output="${tmp_dir}/missing-worker.txt"
if bash "$verify_script" "$missing_worker_artifact" "$commit_sha" \
  >"$missing_worker_output" 2>&1; then
  echo "Verifier accepted an artifact without the image resize worker" >&2
  exit 1
fi
grep -Fq "CLI package is missing image-resize-worker.js" \
  "$missing_worker_output"

missing_wasm_artifact="${tmp_dir}/missing-wasm"
mkdir -p "$missing_wasm_artifact"
create_artifact "$missing_wasm_artifact" true false
missing_wasm_output="${tmp_dir}/missing-wasm.txt"
if bash "$verify_script" "$missing_wasm_artifact" "$commit_sha" \
  >"$missing_wasm_output" 2>&1; then
  echo "Verifier accepted an artifact without the Photon WASM" >&2
  exit 1
fi
grep -Fq "CLI package is missing photon_rs_bg.wasm" "$missing_wasm_output"

echo "verify-okou-cli-artifact tests passed"
