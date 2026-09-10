#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/verify-okou-app-assets.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
assets_directory="${test_root}/assets"
fake_bin="${test_root}/bin"
curl_log="${test_root}/curl.log"
mkdir -p "$assets_directory/nested" "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

printf 'javascript\n' > "${assets_directory}/app-AbCd1234.js"
printf '{}\n' > "${assets_directory}/app-AbCd1234.js.map"
printf 'lazy\n' > "${assets_directory}/lazy-Lazy1234.js"
printf 'vendor\n' > "${assets_directory}/vendor-EfGh5678.js"
printf '{}\n' > "${assets_directory}/vendor-EfGh5678.js.map"
printf 'runtime\n' > "${assets_directory}/rolldown-runtime-IjKl9012.js"
printf 'worker\n' > "${assets_directory}/shared-database-worker-MnOp3456.js"
printf 'clerk ui\n' > "${assets_directory}/clerk-ui-AbCd123456789012.js"
printf '{}\n' > "${assets_directory}/shared-database-worker-MnOp3456.js.map"
printf 'svg\n' > "${assets_directory}/nested/logo-EfGh5678.svg"
printf '{}\n' > "${assets_directory}/runtime.js.map"

cat > "${fake_bin}/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

asset_url="${!#}"
printf '%s\n' "$*" >> "$MOCK_CURL_LOG"
if [[ "$asset_url" == "${MOCK_CURL_FAIL_URL:-}" ]]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
BASH
chmod +x "${fake_bin}/curl"

: > "$curl_log"
output="$({
  PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    bash "$script" \
      https://static.test/okou-app/assets/ \
      "$assets_directory"
} 2>&1)"

grep -Fq 'Skipping unhashed source map: runtime.js.map' <<< "$output" ||
  fail "unhashed source map was not reported as skipped"
grep -Fq \
  'App bundle layout: app=app-AbCd1234.js vendor=vendor-EfGh5678.js runtime=rolldown-runtime-IjKl9012.js worker=shared-database-worker-MnOp3456.js clerk-ui=clerk-ui-AbCd123456789012.js' \
  <<< "$output" || fail "bundle layout was not reported"
grep -Fq \
  'Verified 10 immutable app assets on https://static.test/okou-app/assets' \
  <<< "$output" || fail "verification summary is incorrect"

for relative_path in \
  app-AbCd1234.js \
  app-AbCd1234.js.map \
  lazy-Lazy1234.js \
  vendor-EfGh5678.js \
  vendor-EfGh5678.js.map \
  rolldown-runtime-IjKl9012.js \
  shared-database-worker-MnOp3456.js \
  shared-database-worker-MnOp3456.js.map \
  clerk-ui-AbCd123456789012.js \
  nested/logo-EfGh5678.svg; do
  grep -Fq -- \
    "--head --connect-timeout 10 --max-time 30 --retry 6 --retry-delay 2 --retry-max-time 90 --retry-all-errors https://static.test/okou-app/assets/${relative_path}" \
    "$curl_log" || fail "asset was not verified: ${relative_path}"
done

if grep -Fq 'runtime.js.map' "$curl_log"; then
  fail "unhashed source map reached the public verifier"
fi

missing_url='https://static.test/okou-app/assets/clerk-ui-AbCd123456789012.js'
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_CURL_FAIL_URL="$missing_url" \
  bash "$script" \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/failure.log" 2>&1; then
  fail "missing public asset did not fail verification"
fi
grep -Fq "App asset is unavailable: $missing_url" \
  "${test_root}/failure.log" || fail "missing asset was not identified"

mv "${assets_directory}/clerk-ui-AbCd123456789012.js" "${test_root}/clerk-ui.js"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  bash "$script" \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/ui-layout-failure.log" 2>&1; then
  fail "missing optional UI did not fail layout verification"
fi
grep -Fq 'clerk-ui=none' "${test_root}/ui-layout-failure.log" ||
  fail "missing optional UI was not identified"
mv "${test_root}/clerk-ui.js" "${assets_directory}/clerk-ui-AbCd123456789012.js"

rm "${assets_directory}/rolldown-runtime-IjKl9012.js"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  bash "$script" \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/layout-failure.log" 2>&1; then
  fail "missing Rolldown runtime did not fail layout verification"
fi
grep -Fq \
  'Expected exactly one app, vendor, Rolldown runtime, SharedWorker, and optional Clerk UI JavaScript asset' \
  "${test_root}/layout-failure.log" || fail "layout failure was not identified"

echo "verify okou app assets tests passed"
