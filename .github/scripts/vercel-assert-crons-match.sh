#!/usr/bin/env bash
set -euo pipefail

expected_config="${1:-}"
actual_config="${2:-}"

if [[ -z "$expected_config" || -z "$actual_config" ]]; then
  echo "::error::usage: vercel-assert-crons-match.sh <expected-vercel-json> <actual-build-output-config>" >&2
  exit 1
fi

if [[ ! -f "$expected_config" ]]; then
  echo "::error::expected Vercel config does not exist: ${expected_config}" >&2
  exit 1
fi

if [[ ! -f "$actual_config" ]]; then
  echo "::error::actual Vercel Build Output config does not exist: ${actual_config}" >&2
  exit 1
fi

canonical_crons() {
  jq -c '(.crons // []) | map({ path, schedule }) | sort_by(.path, .schedule)' "$1"
}

expected_crons="$(canonical_crons "$expected_config")"
actual_crons="$(canonical_crons "$actual_config")"

if [[ "$expected_crons" != "$actual_crons" ]]; then
  expected_count="$(jq 'length' <<< "$expected_crons")"
  actual_count="$(jq 'length' <<< "$actual_crons")"
  echo "::error::Vercel cron definitions in ${actual_config} do not match ${expected_config} (expected ${expected_count}, got ${actual_count})" >&2
  exit 1
fi
