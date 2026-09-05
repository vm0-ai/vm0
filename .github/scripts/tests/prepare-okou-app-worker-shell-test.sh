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

env -u CLERK_PRODUCTION_PRIMARY_APP_DOMAIN \
  bash "$script" "$canonical_dist" "$worker_shell"

expected_files="$(find "$worker_shell" -type f -printf '%P\n' | sort)"
test "$expected_files" = "$(printf '%s\n' \
  'icons/icon-192.bin' \
  'icons/icon-192.png' \
  'icons/icon-512-maskable.bin' \
  'icons/icon-512-maskable.png' \
  'icons/icon-512.bin' \
  'icons/icon-512.png' \
  'index.html' \
  'manifest.txt' \
  'manifest.webmanifest' \
  'robots.txt' \
  'sw.js' \
  'sw.txt')"
grep -Fq 'window.testPrimary="app.okou.ai"' "${worker_shell}/index.html"
grep -Fq 'https://static.okou.io/okou-app/assets/app-123.js' \
  "${worker_shell}/index.html"
test ! -e "${worker_shell}/app.js.map"

empty_shell="${tmp_dir}/empty-shell"
mkdir "$empty_shell"
CLERK_PRODUCTION_PRIMARY_APP_DOMAIN='' \
  bash "$script" "$canonical_dist" "$empty_shell"
grep -Fq 'window.testPrimary="app.okou.ai"' "${empty_shell}/index.html"

for primary_app_domain in app.okou.ai app.vm0.ai; do
  explicit_shell="${tmp_dir}/${primary_app_domain}-shell"
  mkdir "$explicit_shell"
  CLERK_PRODUCTION_PRIMARY_APP_DOMAIN="$primary_app_domain" \
    bash "$script" "$canonical_dist" "$explicit_shell"
  grep -Fq "window.testPrimary=\"${primary_app_domain}\"" \
    "${explicit_shell}/index.html"
done

for prepared_shell in "$worker_shell" "$empty_shell" \
  "${tmp_dir}/app.okou.ai-shell" "${tmp_dir}/app.vm0.ai-shell"; do
  if grep -Fq '__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__' \
    "${prepared_shell}/index.html"; then
    echo "expected the primary app domain marker to be replaced: $prepared_shell" >&2
    exit 1
  fi
done

invalid_shell="${tmp_dir}/invalid-shell"
mkdir "$invalid_shell"
if CLERK_PRODUCTION_PRIMARY_APP_DOMAIN=app.okou.ia \
  bash "$script" "$canonical_dist" "$invalid_shell" \
  > "${tmp_dir}/invalid.log" 2>&1; then
  echo "expected an invalid primary app domain to be rejected" >&2
  exit 1
fi
grep -Fq 'invalid Clerk production primary app domain: app.okou.ia' \
  "${tmp_dir}/invalid.log"
test -z "$(find "$invalid_shell" -mindepth 1 -print -quit)"

nonempty_shell="${tmp_dir}/nonempty-shell"
mkdir "$nonempty_shell"
touch "${nonempty_shell}/existing"
if env -u CLERK_PRODUCTION_PRIMARY_APP_DOMAIN \
  bash "$script" "$canonical_dist" "$nonempty_shell" > /dev/null 2>&1; then
  echo "expected a non-empty Worker shell directory to be rejected" >&2
  exit 1
fi

missing_shell="${tmp_dir}/missing-shell"
missing_dist="${tmp_dir}/missing-dist"
mkdir "$missing_shell" "$missing_dist"
if env -u CLERK_PRODUCTION_PRIMARY_APP_DOMAIN \
  bash "$script" "$missing_dist" "$missing_shell" > /dev/null 2>&1; then
  echo "expected a canonical artifact with missing shell files to be rejected" >&2
  exit 1
fi

echo "prepare-okou-app-worker-shell tests passed"
