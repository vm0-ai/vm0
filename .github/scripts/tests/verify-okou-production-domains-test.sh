#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/verify-okou-production-domains.sh"
test_root="$(mktemp -d)"
fake_bin="${test_root}/bin"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat > "${fake_bin}/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

request=GET
origin=""
url=""
write_out=""

while (( $# > 0 )); do
  case "$1" in
    --request)
      request="$2"
      shift 2
      ;;
    --header)
      if [[ "$2" == "Origin: "* ]]; then
        origin="${2#Origin: }"
      fi
      shift 2
      ;;
    --write-out)
      write_out="$2"
      shift 2
      ;;
    --output | --retry | --retry-delay | --retry-max-time)
      shift 2
      ;;
    --retry-all-errors | -fsS | -fsSL)
      shift
      ;;
    https://*)
      url="$1"
      shift
      ;;
    *)
      echo "unexpected curl argument: $1" >&2
      exit 1
      ;;
  esac
done

: "${MOCK_CURL_LOG:?}"

if [[ -z "$write_out" ]]; then
  printf 'serve\t%s\n' "$url" >> "$MOCK_CURL_LOG"
  exit 0
fi

if [[ "$write_out" == '%{redirect_url}' ]]; then
  case "$url" in
    https://api.vm0.ai/sign-in) redirect=https://app.vm0.ai/sign-in ;;
    https://api.vm0.ai/sign-up) redirect=https://app.vm0.ai/sign-up ;;
    https://api.okou.ai/sign-in) redirect=https://app.okou.ai/sign-in ;;
    https://api.okou.ai/sign-up) redirect=https://app.okou.ai/sign-up ;;
    *)
      echo "unexpected auth redirect request: $url" >&2
      exit 1
      ;;
  esac
  printf 'auth\t%s\t%s\n' "$url" "$redirect" >> "$MOCK_CURL_LOG"
  printf '%s' "$redirect"
  exit 0
fi

if [[ "$request" == "OPTIONS" ]]; then
  case "$url:$origin" in
    https://api.vm0.ai/api/__brand-smoke__:https://app.vm0.ai | \
      https://api.okou.ai/api/__brand-smoke__:https://app.okou.ai) ;;
    *)
      echo "unexpected CORS request: $url from $origin" >&2
      exit 1
      ;;
  esac
  printf 'cors\t%s\t%s\n' "$url" "$origin" >> "$MOCK_CURL_LOG"
  printf '204\n%s\ntrue' "$origin"
  exit 0
fi

echo "unexpected curl request: $request $url" >&2
exit 1
BASH
chmod +x "${fake_bin}/curl"

expected_log() {
  local pages_url="$1"

  printf 'serve\t%s\n' "$pages_url"
  printf '%s\n' \
    $'serve\thttps://app.vm0.ai' \
    $'serve\thttps://app.okou.ai' \
    $'auth\thttps://api.vm0.ai/sign-in\thttps://app.vm0.ai/sign-in' \
    $'auth\thttps://api.vm0.ai/sign-up\thttps://app.vm0.ai/sign-up' \
    $'auth\thttps://api.okou.ai/sign-in\thttps://app.okou.ai/sign-in' \
    $'auth\thttps://api.okou.ai/sign-up\thttps://app.okou.ai/sign-up' \
    $'cors\thttps://api.vm0.ai/api/__brand-smoke__\thttps://app.vm0.ai' \
    $'cors\thttps://api.okou.ai/api/__brand-smoke__\thttps://app.okou.ai'
}

verify_run() {
  local name="$1"
  local pages_url="$2"
  shift 2
  local curl_log="${test_root}/${name}.curl.log"
  local expected="${test_root}/${name}.expected.log"

  PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    bash "$script" "$pages_url" "$@" > "${test_root}/${name}.output"

  expected_log "$pages_url" > "$expected"
  if ! diff -u "$expected" "$curl_log"; then
    fail "$name run did not verify both brand auth redirects and CORS pairs"
  fi
}

verify_run default https://preview-default.test

extra_argument_log="${test_root}/extra-argument.curl.log"
: > "$extra_argument_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$extra_argument_log" \
  bash "$script" https://preview-extra.test unexpected \
    > "${test_root}/extra-argument.output" 2>&1; then
  fail "extra argument succeeded"
fi
grep -Fq 'usage:' "${test_root}/extra-argument.output" ||
  fail "extra argument did not print usage"
[[ ! -s "$extra_argument_log" ]] || fail "extra argument reached curl"

missing_log="${test_root}/missing.curl.log"
: > "$missing_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$missing_log" \
  bash "$script" > "${test_root}/missing.output" 2>&1; then
  fail "missing arguments succeeded"
fi
grep -Fq 'usage:' "${test_root}/missing.output" ||
  fail "missing arguments did not print usage"
[[ ! -s "$missing_log" ]] || fail "missing arguments reached curl"

echo "verify okou production domains tests passed"
