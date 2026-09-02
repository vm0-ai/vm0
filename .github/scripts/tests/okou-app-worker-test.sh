#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp "${repo_root}/turbo/apps/app-worker/src/worker.js" "${tmp_dir}/worker.mjs"
node "${repo_root}/.github/scripts/tests/okou-app-worker-test.mjs" \
  "${tmp_dir}/worker.mjs" \
  "${repo_root}/turbo/apps/platform/index.html" \
  "${repo_root}/turbo/apps/platform/public/manifest.webmanifest"
