#!/usr/bin/env bash
set -euo pipefail

config_file="${1:-.vercel/output/config.json}"

if [[ ! -f "$config_file" ]]; then
  echo "::error::Vercel Build Output config does not exist: ${config_file}" >&2
  exit 1
fi

tmp_file="$(mktemp "${config_file}.XXXXXX")"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

jq 'del(.crons)' "$config_file" > "$tmp_file"
mv "$tmp_file" "$config_file"
