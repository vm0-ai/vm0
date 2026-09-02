#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/prepare-okou-app-worker-shell.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

canonical_dist="${tmp_dir}/canonical"
worker_shell="${tmp_dir}/shell"
mkdir -p "${canonical_dist}/icons" "$worker_shell"

printf '%s\n' \
  '<!doctype html>' \
  '<meta name="vm0-api-origin" content="" />' \
  '<script>window.testPrimary="__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__";</script>' \
  '<script type="module" src="https://static.okou.io/okou-app/assets/app-123.js"></script>' \
  > "${canonical_dist}/index.html"
printf 'service worker\n' > "${canonical_dist}/sw.js"
printf '{"name":"VM0"}\n' > "${canonical_dist}/manifest.webmanifest"
printf 'User-agent: *\nAllow: /\n' > "${canonical_dist}/robots.txt"
printf '192\n' > "${canonical_dist}/icons/icon-192.png"
printf '512\n' > "${canonical_dist}/icons/icon-512.png"
printf 'maskable\n' > "${canonical_dist}/icons/icon-512-maskable.png"
printf 'source map\n' > "${canonical_dist}/app.js.map"

bash "$script" \
  "$canonical_dist" \
  "$worker_shell" \
  "https://pr-23364-api.vm6.ai"

expected_files="$(find "$worker_shell" -type f -printf '%P\n' | sort)"
test "$expected_files" = "$(printf '%s\n' \
  'icons/icon-192.png' \
  'icons/icon-512-maskable.png' \
  'icons/icon-512.png' \
  'index.html' \
  'manifest.webmanifest' \
  'robots.txt' \
  'sw.js')"
grep -Fq \
  '<meta name="vm0-api-origin" content="https://pr-23364-api.vm6.ai" />' \
  "${worker_shell}/index.html"
grep -Fq 'window.testPrimary="app.vm0.ai"' "${worker_shell}/index.html"
grep -Fq 'https://static.okou.io/okou-app/assets/app-123.js' \
  "${worker_shell}/index.html"
test ! -e "${worker_shell}/app.js.map"

cutover_shell="${tmp_dir}/cutover-shell"
mkdir "$cutover_shell"
CLERK_PRODUCTION_PRIMARY_APP_DOMAIN=app.okou.ai \
  bash "$script" "$canonical_dist" "$cutover_shell"
grep -Fq 'window.testPrimary="app.okou.ai"' "${cutover_shell}/index.html"
grep -Fq '<meta name="vm0-api-origin" content="" />' \
  "${cutover_shell}/index.html"

invalid_origin_shell="${tmp_dir}/invalid-origin-shell"
mkdir "$invalid_origin_shell"
if bash "$script" "$canonical_dist" "$invalid_origin_shell" \
  "https://example.com" >/dev/null 2>&1; then
  echo "expected an invalid preview API origin to be rejected" >&2
  exit 1
fi

nonempty_shell="${tmp_dir}/nonempty-shell"
mkdir "$nonempty_shell"
touch "${nonempty_shell}/existing"
if bash "$script" "$canonical_dist" "$nonempty_shell" >/dev/null 2>&1; then
  echo "expected a non-empty Worker shell directory to be rejected" >&2
  exit 1
fi

missing_shell="${tmp_dir}/missing-shell"
missing_dist="${tmp_dir}/missing-dist"
mkdir "$missing_shell" "$missing_dist"
if bash "$script" "$missing_dist" "$missing_shell" >/dev/null 2>&1; then
  echo "expected a canonical artifact with missing shell files to be rejected" >&2
  exit 1
fi

echo "prepare-okou-app-worker-shell tests passed"
