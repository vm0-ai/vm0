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
  'Verified 3 immutable app assets on https://static.test/okou-app/assets' \
  <<< "$output" || fail "verification summary is incorrect"

for relative_path in \
  app-AbCd1234.js \
  app-AbCd1234.js.map \
  nested/logo-EfGh5678.svg; do
  grep -Fq -- \
    "--head --connect-timeout 10 --max-time 30 --retry 6 --retry-delay 2 --retry-max-time 90 --retry-all-errors https://static.test/okou-app/assets/${relative_path}" \
    "$curl_log" || fail "asset was not verified: ${relative_path}"
done

if grep -Fq 'runtime.js.map' "$curl_log"; then
  fail "unhashed source map reached the public verifier"
fi

missing_url='https://static.test/okou-app/assets/app-AbCd1234.js'
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

echo "verify okou app assets tests passed"
