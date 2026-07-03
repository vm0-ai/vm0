#!/usr/bin/env bash
set -euo pipefail

ref="${1:-HEAD}"
sha="$(git rev-parse --verify "${ref}^{commit}")"

if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::resolved build commit SHA is not a full SHA-1: $sha" >&2
  exit 1
fi

printf '%s\n' "$sha"
