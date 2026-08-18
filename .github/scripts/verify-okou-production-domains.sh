#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <cloudflare-pages-url>" >&2
  exit 1
fi

pages_url="$1"
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

verify_auth_redirect "https://api.vm0.ai" "https://app.vm0.ai"
verify_auth_redirect "https://api.okou.ai" "https://app.okou.ai"
