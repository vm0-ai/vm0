#!/usr/bin/env bash
set -euo pipefail
umask 077

error() {
  echo "::error::$*"
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "$2"
    exit 1
  fi
}

mask_value() {
  if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "$1" ]]; then
    return
  fi

  local value="$1"
  value="${value//'%'/'%25'}"
  value="${value//$'\r'/'%0D'}"
  value="${value//$'\n'/'%0A'}"
  echo "::add-mask::$value"
}

if [[ -z "${VM0_GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  error "VM0_GITHUB_APP_PRIVATE_KEY is required to create a GitHub App token"
  exit 1
fi

if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
  error "GITHUB_OUTPUT is required"
  exit 1
fi

require_tool python3 "python3 is not installed"
require_tool openssl "OpenSSL is not installed"

private_key="$(
  python3 <<'PY'
import base64
import os
import re
import sys

raw = os.environ["VM0_GITHUB_APP_PRIVATE_KEY"]
key = raw.replace("\\n", "\n").replace("\r", "")

if "-----BEGIN " not in key:
    encoded = re.sub(r"\s+", "", key)
    try:
        key = base64.b64decode(encoded, validate=True).decode("utf-8")
    except Exception:
        print(
            "::error::VM0_GITHUB_APP_PRIVATE_KEY must be PEM or base64-encoded PEM",
            file=sys.stderr,
        )
        sys.exit(1)
    key = key.replace("\\n", "\n").replace("\r", "")

match = re.search(
    r"(-----BEGIN [^-]+-----)\s*(.+?)\s*(-----END [^-]+-----)",
    key,
    re.DOTALL,
)
if not match:
    print(
        "::error::VM0_GITHUB_APP_PRIVATE_KEY must contain a PEM private key",
        file=sys.stderr,
    )
    sys.exit(1)

header, body, footer = match.groups()
body = re.sub(r"\s+", "", body)
if not body:
    print(
        "::error::VM0_GITHUB_APP_PRIVATE_KEY PEM body is empty",
        file=sys.stderr,
    )
    sys.exit(1)

body_lines = "\n".join(body[index : index + 64] for index in range(0, len(body), 64))
print(f"{header}\n{body_lines}\n{footer}")
PY
)"

private_key_file="$(mktemp)"
trap 'rm -f "$private_key_file"' EXIT
printf '%s\n' "$private_key" > "$private_key_file"
if ! openssl pkey -in "$private_key_file" -noout >/dev/null 2>&1; then
  error "VM0_GITHUB_APP_PRIVATE_KEY is not a valid PEM private key"
  exit 1
fi

mask_value "$private_key"

{
  echo "private-key<<GITHUB_APP_PRIVATE_KEY"
  printf '%s\n' "$private_key"
  echo "GITHUB_APP_PRIVATE_KEY"
} >> "$GITHUB_OUTPUT"
