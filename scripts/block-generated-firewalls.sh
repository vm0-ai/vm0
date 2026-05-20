#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

generated_firewalls_pathspec="turbo/packages/connectors/src/firewalls/*.generated.ts"

tracked_generated_firewalls="$(git ls-files -- "$generated_firewalls_pathspec")"

if [ -z "$tracked_generated_firewalls" ]; then
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Generated firewall files must not be committed" >&2
else
  echo "ERROR: Generated firewall files must not be committed:" >&2
fi

echo "$tracked_generated_firewalls" | sed 's/^/  /' >&2
echo "" >&2
echo "These files are produced by @vm0/firewalls-generator during install/generation." >&2
echo "Fix: git rm --cached -- <file>" >&2

exit 1
