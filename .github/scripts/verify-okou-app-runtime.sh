#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <app-url> <public-assets-url> <assets-directory>" >&2
  exit 1
fi

app_url="${1%/}"
public_assets_url="${2%/}"
assets_directory="${3%/}"
canonical_document="$(dirname "$assets_directory")/index.html"
document_max_attempts="${OKOU_APP_RUNTIME_MAX_ATTEMPTS:-1}"

if [[ ! -d "$assets_directory" ]]; then
  echo "app assets directory does not exist: $assets_directory" >&2
  exit 1
fi
if [[ ! -f "$canonical_document" ]]; then
  echo "canonical app document does not exist: $canonical_document" >&2
  exit 1
fi
if [[ ! "$document_max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "OKOU_APP_RUNTIME_MAX_ATTEMPTS must be a positive integer" >&2
  exit 1
fi

layout_files="$(mktemp)"
document_body="$(mktemp)"
curl_error="$(mktemp)"
probe_evidence="$(mktemp)"
trap 'rm -f "$layout_files" "$document_body" "$curl_error" "$probe_evidence"' EXIT

declare -a app_files=()
declare -a stylesheet_files=()
declare -a vendor_files=()
declare -a runtime_files=()
declare -a worker_files=()
find "$assets_directory" -type f \( -name '*.js' -o -name '*.css' \) -print0 > "$layout_files"
while IFS= read -r -d '' source_path; do
  relative_path="${source_path#"$assets_directory"/}"
  case "$relative_path" in
    index-*.css) stylesheet_files+=("$relative_path") ;;
    vendor-*.js) vendor_files+=("$relative_path") ;;
    rolldown-runtime-*.js) runtime_files+=("$relative_path") ;;
    shared-database-worker-*.js) worker_files+=("$relative_path") ;;
    *.js) app_files+=("$relative_path") ;;
  esac
done < "$layout_files"

if ((
  ${#app_files[@]} != 1 ||
  ${#stylesheet_files[@]} != 1 ||
  ${#vendor_files[@]} != 1 ||
  ${#runtime_files[@]} != 1 ||
  ${#worker_files[@]} != 1
)); then
  echo "Expected exactly one app stylesheet plus one app, vendor, Rolldown runtime, and SharedWorker JavaScript asset" >&2
  exit 1
fi

app_asset_url="${public_assets_url}/${app_files[0]}"
stylesheet_asset_url="${public_assets_url}/${stylesheet_files[0]}"
vendor_asset_url="${public_assets_url}/${vendor_files[0]}"
runtime_asset_url="${public_assets_url}/${runtime_files[0]}"
worker_asset_url="${app_url}/okou-app/assets/${worker_files[0]}"
document_url="${app_url}/sign-up"
document_retry_delay_seconds=10
document_wait_started=$SECONDS
document_wait_deadline=$((document_wait_started + 600))

for ((attempt = 1; attempt <= document_max_attempts; attempt++)); do
  : >"$curl_error"
  : >"$probe_evidence"
  if curl \
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
    "$document_url" 2>"$curl_error"; then
    if python3 - \
      "$document_body" \
      "$canonical_document" \
      "$app_asset_url" \
      "$runtime_asset_url" \
      "$vendor_asset_url" \
      "$stylesheet_asset_url" 2>"$probe_evidence" <<'PY'
from html.parser import HTMLParser
from pathlib import Path
import json
import re
import sys

COMMIT_SHA_META_NAME = "okou-app-git-commit-sha"
VERSION_META_NAME = "okou-app-version"
RUNTIME_META_NAMES = {COMMIT_SHA_META_NAME, VERSION_META_NAME}
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
AFTER_FIRST_PAINT_SCRIPT_ID = "vm0-after-first-paint"
DEFERRED_RESOURCES_SCRIPT_ID = "vm0-deferred-application-resources"


class AppDocumentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.module_scripts: list[str] = []
        self.module_preloads: list[str] = []
        self.after_first_paint_script_count = 0
        self.deferred_resource_scripts: list[str] = []
        self.capturing_deferred_resources = False
        self.runtime_metadata: dict[str, list[str | None]] = {
            name: [] for name in RUNTIME_META_NAMES
        }

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attributes = dict(attrs)
        if tag == "script" and attributes.get("id") == AFTER_FIRST_PAINT_SCRIPT_ID:
            self.after_first_paint_script_count += 1
        if (
            tag == "script"
            and attributes.get("id") == DEFERRED_RESOURCES_SCRIPT_ID
            and attributes.get("type") == "application/json"
        ):
            self.deferred_resource_scripts.append("")
            self.capturing_deferred_resources = True
        if tag == "script" and attributes.get("type") == "module":
            source = attributes.get("src")
            if source:
                self.module_scripts.append(source)
        if tag == "link" and attributes.get("rel") == "modulepreload":
            href = attributes.get("href")
            if href:
                self.module_preloads.append(href)
        if tag == "meta" and attributes.get("name") in RUNTIME_META_NAMES:
            name = attributes["name"]
            if name is not None:
                self.runtime_metadata[name].append(attributes.get("content"))

    def handle_data(self, data: str) -> None:
        if self.capturing_deferred_resources:
            self.deferred_resource_scripts[-1] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.capturing_deferred_resources:
            self.capturing_deferred_resources = False


def parse_document(path: str) -> AppDocumentParser:
    parser = AppDocumentParser()
    parser.feed(Path(path).read_text())
    return parser


def runtime_metadata(parser: AppDocumentParser, label: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for name in RUNTIME_META_NAMES:
        values = parser.runtime_metadata[name]
        if len(values) != 1 or values[0] is None:
            raise RuntimeError(
                f"Expected exactly one {label} {name} meta tag with content, got {values}"
            )
        metadata[name] = values[0]
    commit_sha = metadata[COMMIT_SHA_META_NAME]
    version = metadata[VERSION_META_NAME]
    if COMMIT_SHA_PATTERN.fullmatch(commit_sha) is None:
        raise RuntimeError(f"Invalid {label} app commit SHA: {commit_sha}")
    if not version.strip():
        raise RuntimeError(f"Invalid {label} app version: {version}")
    return metadata


def deferred_resources(parser: AppDocumentParser, label: str) -> dict[str, object]:
    scripts = parser.deferred_resource_scripts
    if len(scripts) != 1:
        raise RuntimeError(
            f"Expected exactly one {label} deferred resource metadata script, got {len(scripts)}"
        )
    resources = json.loads(scripts[0])
    if not isinstance(resources, dict):
        raise RuntimeError(f"Invalid {label} deferred resource metadata")
    return resources


parser = parse_document(sys.argv[1])
canonical_parser = parse_document(sys.argv[2])
expected_metadata = runtime_metadata(canonical_parser, "canonical")
observed_metadata = runtime_metadata(parser, "served")
if observed_metadata != expected_metadata:
    raise RuntimeError(
        f"Expected runtime build metadata {expected_metadata}, got {observed_metadata}"
    )

expected_script = sys.argv[3]
expected_stylesheet = sys.argv[6]
expected_resources = {
    "applicationModule": expected_script,
    "modulePreloads": [sys.argv[4], sys.argv[5]],
    "stylesheet": expected_stylesheet,
}
for document_parser, label in (
    (canonical_parser, "canonical"),
    (parser, "served"),
):
    if document_parser.after_first_paint_script_count != 1:
        raise RuntimeError(
            f"Expected exactly one {label} after-first-paint scheduler, "
            f"got {document_parser.after_first_paint_script_count}"
        )
    if document_parser.module_scripts:
        raise RuntimeError(
            f"Expected no statically discovered {label} app modules, "
            f"got {document_parser.module_scripts}"
        )
    if document_parser.module_preloads:
        raise RuntimeError(
            f"Expected no statically discovered {label} module preloads, "
            f"got {document_parser.module_preloads}"
        )
    observed_resources = deferred_resources(document_parser, label)
    if observed_resources != expected_resources:
        raise RuntimeError(
            f"Expected {label} deferred resources {expected_resources}, "
            f"got {observed_resources}"
        )
PY
    then
      break
    fi
  else
    curl_status=$?
    {
      printf 'Transport probe failed for %s (curl exit %s)\n' \
        "$document_url" \
        "$curl_status"
      cat "$curl_error"
    } >"$probe_evidence"
  fi

  if ((attempt == document_max_attempts || SECONDS >= document_wait_deadline)); then
    elapsed_seconds=$((SECONDS - document_wait_started))
    printf \
      'App runtime document did not converge for %s after probe %s/%s (%ss); final probe evidence:\n' \
      "$app_url" \
      "$attempt" \
      "$document_max_attempts" \
      "$elapsed_seconds" \
      >&2
    cat "$probe_evidence" >&2
    exit 1
  fi

  printf \
    '::warning title=Waiting for app runtime convergence::%s has not converged (attempt %s/%s)\n' \
    "$document_url" \
    "$attempt" \
    "$document_max_attempts" \
    >&2
  remaining_seconds=$((document_wait_deadline - SECONDS))
  sleep_seconds=$document_retry_delay_seconds
  if ((remaining_seconds < sleep_seconds)); then
    sleep_seconds=$remaining_seconds
  fi
  sleep "$sleep_seconds"
done

for asset_url in \
  "$stylesheet_asset_url" \
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

printf 'Verified app runtime: stylesheet=%s app=%s vendor=%s runtime=%s worker=%s\n' \
  "$stylesheet_asset_url" \
  "$app_asset_url" \
  "$vendor_asset_url" \
  "$runtime_asset_url" \
  "$worker_asset_url"
