#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-app-preview-url.sh"

test "$(bash "$script" pr-22085 omby.ai)" = "https://pr-22085-app.omby.ai"
test "$(bash "$script" staging omby.ai)" = "https://staging-app.omby.ai"

if bash "$script" pr-22085 '' >/dev/null 2>&1; then
  echo "expected a missing Cloudflare preview domain to be rejected" >&2
  exit 1
fi

if bash "$script" production omby.ai >/dev/null 2>&1; then
  echo "expected an unsupported job ref to be rejected" >&2
  exit 1
fi

if bash "$script" '' omby.ai >/dev/null 2>&1; then
  echo "expected a missing job ref to be rejected" >&2
  exit 1
fi

echo "resolve-app-preview-url tests passed"
