#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/verify-okou-app-runtime.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
assets_directory="${test_root}/assets"
fake_bin="${test_root}/bin"
curl_log="${test_root}/curl.log"
html_source="${test_root}/index.html"
mkdir -p "$assets_directory" "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for file_name in \
  app-AbCd1234.js \
  vendor-EfGh5678.js \
  rolldown-runtime-IjKl9012.js \
  shared-database-worker-MnOp3456.js; do
  printf 'javascript\n' > "${assets_directory}/${file_name}"
done

cat > "$html_source" <<'HTML'
<!doctype html>
<script type="module" crossorigin src="https://static.test/okou-app/assets/app-AbCd1234.js"></script>
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/rolldown-runtime-IjKl9012.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-EfGh5678.js">
HTML

cat > "${fake_bin}/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
write_out=""
asset_url="${!#}"
arguments=("$@")
printf '%s\n' "$*" >> "$MOCK_CURL_LOG"
for (( index = 0; index < ${#arguments[@]}; index += 1 )); do
  case "${arguments[index]}" in
    --output) output_file="${arguments[index + 1]}" ;;
    --write-out) write_out="${arguments[index + 1]}" ;;
  esac
done
if [[ "$asset_url" == */sign-up ]]; then
  cp "$MOCK_HTML_SOURCE" "$output_file"
fi
if [[ -n "$write_out" ]]; then
  printf '%s' "${MOCK_WORKER_STATUS:-206}"
fi
BASH
chmod +x "${fake_bin}/curl"

: > "$curl_log"
output="$({
  PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    MOCK_HTML_SOURCE="$html_source" \
    bash "$script" \
      https://app.test \
      https://static.test/okou-app/assets \
      "$assets_directory"
} 2>&1)"

grep -Fq \
  'Verified app runtime: app=https://static.test/okou-app/assets/app-AbCd1234.js vendor=https://static.test/okou-app/assets/vendor-EfGh5678.js runtime=https://static.test/okou-app/assets/rolldown-runtime-IjKl9012.js worker=https://app.test/okou-app/assets/shared-database-worker-MnOp3456.js' \
  <<< "$output" || fail "runtime verification summary is incorrect"
for expected_url in \
  https://app.test/sign-up \
  https://static.test/okou-app/assets/app-AbCd1234.js \
  https://static.test/okou-app/assets/vendor-EfGh5678.js \
  https://static.test/okou-app/assets/rolldown-runtime-IjKl9012.js \
  https://app.test/okou-app/assets/shared-database-worker-MnOp3456.js; do
  grep -Fq "$expected_url" "$curl_log" ||
    fail "runtime verifier did not probe ${expected_url}"
done

if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$html_source" \
  MOCK_WORKER_STATUS=200 \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/worker-failure.log" 2>&1; then
  fail "non-range SharedWorker response did not fail verification"
fi
grep -Fq 'SharedWorker same-origin proxy returned HTTP 200' \
  "${test_root}/worker-failure.log" || fail "worker failure was not identified"

sed -i '/vendor-EfGh5678/d' "$html_source"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$html_source" \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/html-failure.log" 2>&1; then
  fail "missing vendor preload did not fail HTML verification"
fi
grep -Fq 'Expected CDN runtime/vendor modulepreloads' \
  "${test_root}/html-failure.log" || fail "HTML failure was not identified"

echo "verify okou app runtime tests passed"
