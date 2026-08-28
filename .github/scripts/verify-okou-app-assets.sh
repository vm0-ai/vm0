#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <public-assets-url> <assets-directory>" >&2
  exit 1
fi

OKOU_APP_PUBLIC_ASSETS_URL="${1%/}"
OKOU_APP_ASSETS_DIRECTORY="${2%/}"

if [[ ! -d "$OKOU_APP_ASSETS_DIRECTORY" ]]; then
  echo "app assets directory does not exist: $OKOU_APP_ASSETS_DIRECTORY" >&2
  exit 1
fi

verify_app_asset() {
  local source_path=$1
  local relative_path="${source_path#"$OKOU_APP_ASSETS_DIRECTORY"/}"
  local asset_url="${OKOU_APP_PUBLIC_ASSETS_URL}/${relative_path}"

  if curl \
    --fail \
    --silent \
    --location \
    --head \
    --connect-timeout 10 \
    --max-time 30 \
    --retry 6 \
    --retry-delay 2 \
    --retry-max-time 90 \
    --retry-all-errors \
    "$asset_url" >/dev/null; then
    return 0
  fi

  echo "App asset is unavailable: $asset_url" >&2
  return 255
}

export OKOU_APP_PUBLIC_ASSETS_URL OKOU_APP_ASSETS_DIRECTORY
export -f verify_app_asset

pending_assets="$(mktemp)"
sorted_assets="$(mktemp)"
trap 'rm -f "$pending_assets" "$sorted_assets"' EXIT

find "$OKOU_APP_ASSETS_DIRECTORY" -type f -print0 | sort -z > "$sorted_assets"
asset_count=0
while IFS= read -r -d '' source_path; do
  relative_path="${source_path#"$OKOU_APP_ASSETS_DIRECTORY"/}"
  asset_name="${relative_path##*/}"

  if [[ "$relative_path" == *.map ]] &&
    [[ ! "$asset_name" =~ -[[:alnum:]_-]{8,}\.[^.]+\.map$ ]]; then
    echo "Skipping unhashed source map: $relative_path"
    continue
  fi

  printf '%s\0' "$source_path" >> "$pending_assets"
  asset_count=$((asset_count + 1))
done < "$sorted_assets"

if (( asset_count == 0 )); then
  echo "app assets directory has no publishable files: $OKOU_APP_ASSETS_DIRECTORY" >&2
  exit 1
fi

xargs -0 -r -n 1 -P 16 bash -c \
  "set -euo pipefail; verify_app_asset \"\$1\"" _ < "$pending_assets"

echo "Verified ${asset_count} immutable app assets on ${OKOU_APP_PUBLIC_ASSETS_URL}"
