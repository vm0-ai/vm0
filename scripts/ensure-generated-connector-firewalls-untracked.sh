#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

disallowed_firewall_source_dir="turbo/packages/connectors/src/firewalls"
firewall_metadata_dir="turbo/packages/connectors/src/firewall-metadata"

tracked_disallowed_firewall_sources="$(
  git ls-files -- "$disallowed_firewall_source_dir"
)"

tracked_disallowed_firewall_metadata="$(
  git ls-files -z -- "$firewall_metadata_dir" |
    while IFS= read -r -d "" tracked_file; do
      case "$tracked_file" in
        "$firewall_metadata_dir"/*.generated.ts) printf '%s\n' "$tracked_file" ;;
        "$firewall_metadata_dir"/.*.previous-* | "$firewall_metadata_dir"/.*.previous-*/*) printf '%s\n' "$tracked_file" ;;
        "$firewall_metadata_dir"/.metadata-* | "$firewall_metadata_dir"/.metadata-*/*) printf '%s\n' "$tracked_file" ;;
        "$firewall_metadata_dir/permission-details/"*) printf '%s\n' "$tracked_file" ;;
        "$firewall_metadata_dir/details/"*) printf '%s\n' "$tracked_file" ;;
        "$firewall_metadata_dir/routing-details/"*) printf '%s\n' "$tracked_file" ;;
      esac
    done
)"

if [ -z "$tracked_disallowed_firewall_sources" ] && [ -z "$tracked_disallowed_firewall_metadata" ]; then
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Generated connector firewall source and metadata files must not be committed" >&2
else
  echo "ERROR: Generated connector firewall source and metadata files must not be committed:" >&2
fi

if [ -n "$tracked_disallowed_firewall_sources" ]; then
  echo "" >&2
  echo "Connector firewall source files may not be committed under $disallowed_firewall_source_dir:" >&2
  echo "$tracked_disallowed_firewall_sources" | sed 's/^/  /' >&2
fi

if [ -n "$tracked_disallowed_firewall_metadata" ]; then
  echo "" >&2
  echo "Generated firewall metadata files may not be committed under $firewall_metadata_dir:" >&2
  echo "$tracked_disallowed_firewall_metadata" | sed 's/^/  /' >&2
fi

echo "" >&2
echo "Firewall metadata is produced by @vm0/firewalls-generator during install/generation." >&2
echo "Fix: git rm --cached -- <file>" >&2

exit 1
