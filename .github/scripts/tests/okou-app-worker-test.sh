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
if grep -Fq '"assets"' "$worker_config"; then
  echo "app Worker shell must not depend on the Workers Assets service" >&2
  exit 1
fi

worker_entrypoint="${repo_root}/turbo/apps/app-worker/src/index.ts"
for module_path in \
  '../shell/index.html' \
  '../shell/sw.txt' \
  '../shell/manifest.txt' \
  '../shell/robots.txt' \
  '../shell/icons/icon-192.bin' \
  '../shell/icons/icon-512.bin' \
  '../shell/icons/icon-512-maskable.bin'; do
  if ! grep -Fq "$module_path" "$worker_entrypoint"; then
    echo "app Worker shell module import is missing: ${module_path}" >&2
    exit 1
  fi
done

clerk_stub_dir="${tmp_dir}/node_modules/@clerk/backend"
mkdir -p "$clerk_stub_dir"
printf '%s\n' \
  '{"name":"@clerk/backend","type":"module","exports":"./index.js"}' \
  > "${clerk_stub_dir}/package.json"
printf '%s\n' \
  'export function createClerkClient() {' \
  '  throw new Error("Unexpected default Clerk client invocation");' \
  '}' \
  > "${clerk_stub_dir}/index.js"
core_scope_dir="${tmp_dir}/node_modules/@okouai"
mkdir -p "$core_scope_dir"
ln -s "${repo_root}/turbo/packages/core" "${core_scope_dir}/core"
cp "${repo_root}/turbo/apps/app-worker/src/worker.js" "${tmp_dir}/worker.mjs"

node "${repo_root}/.github/scripts/tests/okou-app-worker-test.mjs" \
  "${tmp_dir}/worker.mjs" \
  "${repo_root}/turbo/apps/platform/index.html" \
  "${repo_root}/turbo/apps/platform/public/manifest.webmanifest"
