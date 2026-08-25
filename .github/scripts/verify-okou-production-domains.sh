#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 2 )); then
  echo "usage: $0 <cloudflare-pages-url> [api-promotion]" >&2
  exit 1
fi

pages_url="$1"
verification_scope="${2:-full}"
if [[ "$verification_scope" != "full" && "$verification_scope" != "api-promotion" ]]; then
  echo "invalid verification scope: $verification_scope" >&2
  exit 1
fi
curl_retry=(
  --retry 12
  --retry-delay 5
  --retry-max-time 120
  --retry-all-errors
)

for url in "$pages_url" "https://app.vm0.ai" "https://app.okou.ai"; do
  curl -fsSL "${curl_retry[@]}" "$url" --output /dev/null
  echo "Production App is serving: $url"
done

verify_auth_redirect() {
  local api_origin="$1"
  local app_origin="$2"
  local path
  local location

  for path in sign-in sign-up; do
    location="$(
      curl -fsS "${curl_retry[@]}" \
        "${api_origin}/${path}" \
        --output /dev/null \
        --write-out '%{redirect_url}'
    )"
    if [[ "$location" != "${app_origin}/${path}" ]]; then
      echo "::error title=Production auth redirect mismatch::${api_origin}/${path} redirected to ${location:-<empty>} instead of ${app_origin}/${path}" >&2
      return 1
    fi
    echo "Production API auth redirect is correct: ${api_origin}/${path} -> $location"
  done
}

verify_api_origin_marker() {
  local app_origin="$1"
  local api_origin="$2"
  local expected_marker
  local html

  expected_marker="<meta name=\"vm0-api-origin\" content=\"${api_origin}\""
  html="$(curl -fsSL "${curl_retry[@]}" "${app_origin}/")"
  if [[ "$html" != *"$expected_marker"* ]]; then
    echo "::error title=Production API origin marker mismatch::${app_origin} does not declare ${api_origin}" >&2
    return 1
  fi
  echo "Production App API origin marker is correct: ${app_origin} -> ${api_origin}"
}

verify_api_cors() {
  local api_origin="$1"
  local app_origin="$2"
  local cors_result
  local -a cors_values

  cors_result="$(
    curl -fsS "${curl_retry[@]}" \
      --request OPTIONS \
      --header "Origin: ${app_origin}" \
      --header "Access-Control-Request-Method: GET" \
      --output /dev/null \
      --write-out $'%{http_code}\n%header{access-control-allow-origin}\n%header{access-control-allow-credentials}' \
      "${api_origin}/api/__brand-smoke__"
  )"
  mapfile -t cors_values <<< "$cors_result"
  if [[ "${cors_values[0]:-}" != "204" ||
        "${cors_values[1]:-}" != "$app_origin" ||
        "${cors_values[2]:-}" != "true" ]]; then
    echo "::error title=Production API CORS mismatch::${api_origin} returned status=${cors_values[0]:-<empty>} allow-origin=${cors_values[1]:-<empty>} allow-credentials=${cors_values[2]:-<empty>} for ${app_origin}" >&2
    return 1
  fi
  echo "Production API CORS is correct: ${app_origin} -> ${api_origin}"
}

verify_auth_redirect "https://api.vm0.ai" "https://app.vm0.ai"
verify_auth_redirect "https://api.okou.ai" "https://app.okou.ai"
if [[ "$verification_scope" == "full" ]]; then
  verify_api_origin_marker "https://app.vm0.ai" "https://api.vm0.ai"
  verify_api_origin_marker "https://app.okou.ai" "https://api.okou.ai"
fi
verify_api_cors "https://api.vm0.ai" "https://app.vm0.ai"
verify_api_cors "https://api.okou.ai" "https://app.okou.ai"
