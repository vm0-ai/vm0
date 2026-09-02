#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

worker_config="${repo_root}/turbo/apps/app-worker/wrangler.jsonc"
if ! grep -Fq '"global_fetch_strictly_public"' "$worker_config"; then
  echo "app Worker must allow public same-zone fetches" >&2
  exit 1
fi

cp "${repo_root}/turbo/apps/app-worker/src/worker.js" "${tmp_dir}/worker.mjs"
node "${repo_root}/.github/scripts/tests/okou-app-worker-test.mjs" \
  "${tmp_dir}/worker.mjs" \
  "${repo_root}/turbo/apps/platform/index.html" \
  "${repo_root}/turbo/apps/platform/public/manifest.webmanifest"
