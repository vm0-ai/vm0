#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/prepare-okou-pages-dist.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

canonical_dist="${tmp_dir}/canonical"
pages_dist="${tmp_dir}/pages"
mkdir -p "${canonical_dist}/assets" "$pages_dist"

printf '%s\n' \
  '<!doctype html>' \
  '<head>' \
  '  <meta name="vm0-api-origin" content="" />' \
  '</head>' > "${canonical_dist}/index.html"
printf 'console.log("app");\n' > "${canonical_dist}/assets/app-123.js"
printf '{"version":3}\n' > "${canonical_dist}/assets/app-123.js.map"
printf '{"version":1}\n' > "${canonical_dist}/manifest.json"
printf '{"version":1}\n' > "${canonical_dist}/ready.json"
touch "${canonical_dist}/.gitkeep"

bash "$script" "$canonical_dist" "$pages_dist"

test -f "${pages_dist}/index.html"
test -f "${pages_dist}/assets/app-123.js"
test -f "${pages_dist}/assets/404.html"
test -f "${pages_dist}/_headers"
test ! -e "${pages_dist}/404.html"
test ! -e "${pages_dist}/assets/app-123.js.map"
test ! -e "${pages_dist}/manifest.json"
test ! -e "${pages_dist}/ready.json"
test ! -e "${pages_dist}/.gitkeep"
grep -Fxq '/assets/*' "${pages_dist}/_headers"
grep -Fq 'Cache-Control: public, max-age=31536000, immutable' \
  "${pages_dist}/_headers"
grep -Fq '<title>Not Found</title>' "${pages_dist}/assets/404.html"
grep -Fq '<meta name="vm0-api-origin" content="" />' \
  "${pages_dist}/index.html"

preview_pages_dist="${tmp_dir}/preview-pages"
mkdir -p "$preview_pages_dist"
bash "$script" \
  "$canonical_dist" \
  "$preview_pages_dist" \
  "https://pr-23364-api.vm6.ai"
grep -Fq \
  '<meta name="vm0-api-origin" content="https://pr-23364-api.vm6.ai" />' \
  "${preview_pages_dist}/index.html"

invalid_origin_dist="${tmp_dir}/invalid-origin"
mkdir -p "$invalid_origin_dist"
if bash \
  "$script" \
  "$canonical_dist" \
  "$invalid_origin_dist" \
  "https://example.com" >/dev/null 2>&1; then
  echo "expected an invalid preview API origin to be rejected" >&2
  exit 1
fi

nonempty_dist="${tmp_dir}/nonempty"
mkdir -p "$nonempty_dist"
touch "${nonempty_dist}/existing"
if bash "$script" "$canonical_dist" "$nonempty_dist" >/dev/null 2>&1; then
  echo "expected a non-empty Pages output directory to be rejected" >&2
  exit 1
fi

missing_index="${tmp_dir}/missing-index"
mkdir -p "$missing_index"
if bash "$script" "$missing_index" "${tmp_dir}/unused" >/dev/null 2>&1; then
  echo "expected an artifact without index.html to be rejected" >&2
  exit 1
fi

echo "prepare-okou-pages-dist tests passed"
