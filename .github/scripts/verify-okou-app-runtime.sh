#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <app-url> <public-assets-url> <assets-directory>" >&2
  exit 1
fi

app_url="${1%/}"
public_assets_url="${2%/}"
assets_directory="${3%/}"

if [[ ! -d "$assets_directory" ]]; then
  echo "app assets directory does not exist: $assets_directory" >&2
  exit 1
fi

layout_files="$(mktemp)"
document_body="$(mktemp)"
trap 'rm -f "$layout_files" "$document_body"' EXIT

declare -a app_files=()
declare -a vendor_files=()
declare -a runtime_files=()
declare -a worker_files=()
find "$assets_directory" -type f -name '*.js' -print0 > "$layout_files"
while IFS= read -r -d '' source_path; do
  relative_path="${source_path#"$assets_directory"/}"
  case "$relative_path" in
    vendor-*.js) vendor_files+=("$relative_path") ;;
    rolldown-runtime-*.js) runtime_files+=("$relative_path") ;;
    shared-database-worker-*.js) worker_files+=("$relative_path") ;;
    *.js) app_files+=("$relative_path") ;;
  esac
done < "$layout_files"

if ((
  ${#app_files[@]} != 1 ||
  ${#vendor_files[@]} != 1 ||
  ${#runtime_files[@]} != 1 ||
  ${#worker_files[@]} != 1
)); then
  echo "Expected exactly one app, vendor, Rolldown runtime, and SharedWorker JavaScript asset" >&2
  exit 1
fi

app_asset_url="${public_assets_url}/${app_files[0]}"
vendor_asset_url="${public_assets_url}/${vendor_files[0]}"
runtime_asset_url="${public_assets_url}/${runtime_files[0]}"
worker_asset_url="${app_url}/okou-app/assets/${worker_files[0]}"

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 6 \
  --retry-delay 2 \
  --retry-max-time 90 \
  --retry-all-errors \
  --output "$document_body" \
  "${app_url}/sign-up"

python3 - \
  "$document_body" \
  "$app_asset_url" \
  "$runtime_asset_url" \
  "$vendor_asset_url" <<'PY'
from html.parser import HTMLParser
from pathlib import Path
import sys


class EntrypointParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.module_scripts: list[str] = []
        self.module_preloads: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attributes = dict(attrs)
        if tag == "script" and attributes.get("type") == "module":
            source = attributes.get("src")
            if source:
                self.module_scripts.append(source)
        if tag == "link" and attributes.get("rel") == "modulepreload":
            href = attributes.get("href")
            if href:
                self.module_preloads.append(href)


parser = EntrypointParser()
parser.feed(Path(sys.argv[1]).read_text())
expected_script = [sys.argv[2]]
expected_preloads = {sys.argv[3], sys.argv[4]}
if parser.module_scripts != expected_script:
    raise RuntimeError(
        f"Expected one CDN app module script {expected_script}, got {parser.module_scripts}"
    )
if len(parser.module_preloads) != 2 or set(parser.module_preloads) != expected_preloads:
    raise RuntimeError(
        f"Expected CDN runtime/vendor modulepreloads {sorted(expected_preloads)}, "
        f"got {parser.module_preloads}"
    )
PY

for asset_url in \
  "$app_asset_url" \
  "$vendor_asset_url" \
  "$runtime_asset_url"; do
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --head \
    --connect-timeout 10 \
    --max-time 30 \
    --retry 6 \
    --retry-delay 2 \
    --retry-max-time 90 \
    --retry-all-errors \
    "$asset_url" >/dev/null
done

worker_status="$(curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --range 0-0 \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 6 \
  --retry-delay 2 \
  --retry-max-time 90 \
  --retry-all-errors \
  --output /dev/null \
  --write-out '%{http_code}' \
  "$worker_asset_url")"
if [[ "$worker_status" != "206" ]]; then
  echo "SharedWorker same-origin proxy returned HTTP ${worker_status}: ${worker_asset_url}" >&2
  exit 1
fi

printf 'Verified app runtime: app=%s vendor=%s runtime=%s worker=%s\n' \
  "$app_asset_url" \
  "$vendor_asset_url" \
  "$runtime_asset_url" \
  "$worker_asset_url"
