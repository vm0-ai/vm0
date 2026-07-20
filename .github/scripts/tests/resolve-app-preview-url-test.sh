#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-app-preview-url.sh"

test "$(bash "$script" pr-22085 vm6.ai omby.ai)" = "https://pr-22085-app.omby.ai"
test "$(bash "$script" staging vm6.ai omby.ai)" = "https://staging-app.vm6.ai"

if bash "$script" pr-22085 vm6.ai '' >/dev/null 2>&1; then
  echo "expected a missing Cloudflare preview domain to be rejected for PR previews" >&2
  exit 1
fi

if bash "$script" '' vm6.ai omby.ai >/dev/null 2>&1; then
  echo "expected a missing job ref to be rejected" >&2
  exit 1
fi

echo "resolve-app-preview-url tests passed"
