#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mapfile -t invocations < <(
  rg \
    --line-number \
    --no-heading \
    --fixed-strings \
    --glob '*.yml' \
    --glob '*.yaml' \
    'neonctl connection-string' \
    "${repo_root}/.github/actions" \
    "${repo_root}/.github/workflows"
)

if [[ ${#invocations[@]} -eq 0 ]]; then
  fail "no neonctl connection-string invocations found"
fi

checked=0
for invocation in "${invocations[@]}"; do
  IFS=: read -r file line_number command <<< "$invocation"
  if [[ "$command" =~ ^[[:space:]]*# ]]; then
    continue
  fi

  next_line="$line_number"
  while [[ "$command" =~ \\[[:space:]]*$ ]]; do
    next_line=$((next_line + 1))
    continuation=$(sed -n "${next_line}p" "$file")
    if [[ -z "$continuation" ]]; then
      fail "unterminated neonctl command at ${file}:${line_number}"
    fi
    command+=" ${continuation}"
  done

  if [[ ! "$command" =~ (^|[[:space:]])--ssl[[:space:]]+verify-full([^[:alnum:]_-]|$) ]]; then
    fail "neonctl connection-string must specify --ssl verify-full at ${file}:${line_number}"
  fi
  checked=$((checked + 1))
done

if [[ $checked -eq 0 ]]; then
  fail "no executable neonctl connection-string invocations found"
fi

echo "neon connection-string SSL checks passed (${checked} invocations)"
