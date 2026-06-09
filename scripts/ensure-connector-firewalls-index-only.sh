#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

firewalls_dir="turbo/packages/connectors/src/firewalls"
allowed_firewalls_file="$firewalls_dir/index.ts"

tracked_disallowed_firewalls="$(
  git ls-files -z -- "$firewalls_dir" |
    while IFS= read -r -d "" tracked_file; do
      case "$tracked_file" in
        "$allowed_firewalls_file") ;;
        *) printf '%s\n' "$tracked_file" ;;
      esac
    done
)"

if [ -z "$tracked_disallowed_firewalls" ]; then
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Only $allowed_firewalls_file may be committed under $firewalls_dir" >&2
else
  echo "ERROR: Only $allowed_firewalls_file may be committed under $firewalls_dir:" >&2
fi

echo "$tracked_disallowed_firewalls" | sed 's/^/  /' >&2
echo "" >&2
echo "Firewall files under $firewalls_dir are produced by @vm0/firewalls-generator during install/generation." >&2
echo "Fix: git rm --cached -- <file>" >&2

exit 1
