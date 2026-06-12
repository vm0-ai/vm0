#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(git rev-parse --show-toplevel)
cd "$ROOT_DIR"

failed=0

while IFS= read -r package_json; do
  case "$package_json" in
    turbo/apps/api/package.json | turbo/packages/db/package.json)
      continue
      ;;
  esac

  if jq -e '
    [
      (.dependencies // {}),
      (.devDependencies // {}),
      (.peerDependencies // {}),
      (.optionalDependencies // {})
    ] | any(has("@vm0/db"))
  ' "$package_json" >/dev/null; then
    echo "::error file=$package_json::Only turbo/apps/api and turbo/packages/db may depend on @vm0/db."
    failed=1
  fi
done < <(find turbo -name package.json -not -path "*/node_modules/*" | sort)

db_import_pattern="from ['\"]@vm0/db(/|['\"])|require\\(['\"]@vm0/db(/|['\"])|import\\(['\"]@vm0/db(/|['\"])"
if matches=$(git grep -n -E "$db_import_pattern" -- \
  turbo \
  ':!turbo/apps/api' \
  ':!turbo/packages/db' \
  ':!turbo/apps/web/custom-eslint'); then
  echo "::error::Only turbo/apps/api and turbo/packages/db may import @vm0/db."
  echo "$matches"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "DB ownership boundary validated."
