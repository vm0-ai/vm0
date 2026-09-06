#!/usr/bin/env bash
set -euo pipefail

pem_input="$(cat)"
pem_input="${pem_input//$'\r'/}"

begin_pattern='^(-----BEGIN [^-]+-----)'
end_pattern='(-----END [^-]+-----)$'

if [[ ! "$pem_input" =~ $begin_pattern ]]; then
  echo "GitHub App private key is missing a PEM header" >&2
  exit 1
fi
header="${BASH_REMATCH[1]}"

if [[ ! "$pem_input" =~ $end_pattern ]]; then
  echo "GitHub App private key is missing a PEM footer" >&2
  exit 1
fi
footer="${BASH_REMATCH[1]}"

begin_type="${header#-----BEGIN }"
begin_type="${begin_type%-----}"
end_type="${footer#-----END }"
end_type="${end_type%-----}"
if [[ "$begin_type" != "$end_type" ]]; then
  echo "GitHub App private key PEM header and footer do not match" >&2
  exit 1
fi

body="${pem_input#"$header"}"
body="${body%"$footer"}"
body_compact="${body//[[:space:]]/}"
body_pattern='^[A-Za-z0-9+/]+={0,2}$'
if [[ -z "$body_compact" || ! "$body_compact" =~ $body_pattern ]]; then
  echo "GitHub App private key contains an invalid PEM body" >&2
  exit 1
fi

wrapped_body="$(printf '%s' "$body_compact" | fold -w 64)"
normalized_key="${header}"$'\n'"${wrapped_body}"$'\n'"${footer}"
if ! printf '%s\n' "$normalized_key" |
  openssl pkey -check -noout >/dev/null 2>&1; then
  echo "GitHub App private key is not a valid PEM key" >&2
  exit 1
fi

printf '%s' "${normalized_key//$'\n'/\\n}"
