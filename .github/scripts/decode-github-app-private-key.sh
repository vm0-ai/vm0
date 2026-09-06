#!/usr/bin/env bash
set -euo pipefail

decoded_key="$(base64 --decode)"
decoded_key="${decoded_key//$'\r'/}"

if [[ -z "$decoded_key" ]]; then
  echo "GitHub App private key decoded to an empty value" >&2
  exit 1
fi

if ! printf '%s\n' "$decoded_key" |
  openssl pkey -check -noout >/dev/null 2>&1; then
  echo "GitHub App private key is not a valid PEM key" >&2
  exit 1
fi

printf '%s' "${decoded_key//$'\n'/\\n}"
