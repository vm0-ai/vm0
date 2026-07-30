#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  echo "usage: $0 <canonical-dist> <empty-pages-dist> [preview-api-origin]" >&2
  exit 1
fi

canonical_dist="$1"
pages_dist="$2"
preview_api_origin="${3:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pages_config_dir="${script_dir}/../pages/okou-app"

if [[ ! -f "${canonical_dist}/index.html" ]]; then
  echo "canonical app artifact must contain index.html" >&2
  exit 1
fi

if [[ ! -d "$pages_dist" ]] || [[ -n "$(find "$pages_dist" -mindepth 1 -print -quit)" ]]; then
  echo "Pages output directory must exist and be empty: $pages_dist" >&2
  exit 1
fi

cp -a "${canonical_dist}/." "$pages_dist/"

if [[ -n "$preview_api_origin" ]]; then
  if [[ ! "$preview_api_origin" =~ ^https://(staging|pr-[0-9]+)-api\.vm6\.ai$ ]]; then
    echo "invalid preview API origin: ${preview_api_origin}" >&2
    exit 1
  fi

  runtime_config_marker='<meta name="vm0-api-origin" content="" />'
  if ! grep -Fq "$runtime_config_marker" "${pages_dist}/index.html"; then
    echo "canonical app artifact is missing the API origin marker" >&2
    exit 1
  fi
  sed -i \
    "s|${runtime_config_marker}|<meta name=\"vm0-api-origin\" content=\"${preview_api_origin}\" />|" \
    "${pages_dist}/index.html"
fi

find "$pages_dist" -type f -name '*.map' -delete
rm -f \
  "${pages_dist}/.gitkeep" \
  "${pages_dist}/dist.tar.gz" \
  "${pages_dist}/manifest.json" \
  "${pages_dist}/ready.json"
cp -a "${pages_config_dir}/." "$pages_dist/"
