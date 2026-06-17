#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

firewalls_dir="turbo/packages/connectors/src/firewalls"
allowed_firewalls_file="$firewalls_dir/index.ts"
firewall_metadata_dir="turbo/packages/connectors/src/firewall-metadata"

tracked_disallowed_firewalls="$(
  git ls-files -z -- "$firewalls_dir" |
    while IFS= read -r -d "" tracked_file; do
      case "$tracked_file" in
        "$allowed_firewalls_file") ;;
        *) printf '%s\n' "$tracked_file" ;;
      esac
    done
)"

tracked_disallowed_firewall_metadata="$(
  git ls-files -z -- "$firewall_metadata_dir" |
    while IFS= read -r -d "" tracked_file; do
      case "$tracked_file" in
        "$firewall_metadata_dir"/*.generated.ts | "$firewall_metadata_dir"/.details-* | "$firewall_metadata_dir"/.details-*/* | "$firewall_metadata_dir/details/"*) printf '%s\n' "$tracked_file" ;;
      esac
    done
)"

if [ -z "$tracked_disallowed_firewalls" ] && [ -z "$tracked_disallowed_firewall_metadata" ]; then
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Generated connector firewall files must not be committed" >&2
else
  echo "ERROR: Generated connector firewall files must not be committed:" >&2
fi

if [ -n "$tracked_disallowed_firewalls" ]; then
  echo "" >&2
  echo "Only $allowed_firewalls_file may be committed under $firewalls_dir:" >&2
  echo "$tracked_disallowed_firewalls" | sed 's/^/  /' >&2
fi

if [ -n "$tracked_disallowed_firewall_metadata" ]; then
  echo "" >&2
  echo "Generated firewall metadata files may not be committed under $firewall_metadata_dir:" >&2
  echo "$tracked_disallowed_firewall_metadata" | sed 's/^/  /' >&2
fi

echo "" >&2
echo "Firewall files and metadata are produced by @vm0/firewalls-generator during install/generation." >&2
echo "Fix: git rm --cached -- <file>" >&2

exit 1
