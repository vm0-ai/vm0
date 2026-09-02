#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  echo "usage: $0 <canonical-dist> <empty-worker-shell> [preview-api-origin]" >&2
  exit 1
fi

canonical_dist="$1"
worker_shell="$2"
preview_api_origin="${3:-}"
production_primary_app_domain="${CLERK_PRODUCTION_PRIMARY_APP_DOMAIN:-app.vm0.ai}"

case "$production_primary_app_domain" in
  app.vm0.ai | app.okou.ai) ;;
  *)
    echo "invalid Clerk production primary app domain: ${production_primary_app_domain}" >&2
    exit 1
    ;;
esac

required_files=(
  index.html
  sw.js
  manifest.webmanifest
  robots.txt
  icons/icon-192.png
  icons/icon-512.png
  icons/icon-512-maskable.png
)
for relative_path in "${required_files[@]}"; do
  if [[ ! -f "${canonical_dist}/${relative_path}" ]]; then
    echo "canonical app artifact is missing ${relative_path}" >&2
    exit 1
  fi
done

if [[ ! -d "$worker_shell" ]] ||
  [[ -n "$(find "$worker_shell" -mindepth 1 -print -quit)" ]]; then
  echo "Worker shell directory must exist and be empty: $worker_shell" >&2
  exit 1
fi

if [[ -n "$preview_api_origin" ]] &&
  [[ ! "$preview_api_origin" =~ ^https://(staging|pr-[0-9]+)-api\.vm6\.ai$ ]]; then
  echo "invalid preview API origin: ${preview_api_origin}" >&2
  exit 1
fi

for relative_path in "${required_files[@]}"; do
  destination="${worker_shell}/${relative_path}"
  mkdir -p "$(dirname "$destination")"
  cp "${canonical_dist}/${relative_path}" "$destination"
done

clerk_primary_app_domain_marker="__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__"
if grep -Fq "$clerk_primary_app_domain_marker" "${worker_shell}/index.html"; then
  sed -i \
    "s|${clerk_primary_app_domain_marker}|${production_primary_app_domain}|g" \
    "${worker_shell}/index.html"
fi

if [[ -n "$preview_api_origin" ]]; then
  runtime_config_marker='<meta name="vm0-api-origin" content="" />'
  if ! grep -Fq "$runtime_config_marker" "${worker_shell}/index.html"; then
    echo "canonical app artifact is missing the API origin marker" >&2
    exit 1
  fi
  sed -i \
    "s|${runtime_config_marker}|<meta name=\"vm0-api-origin\" content=\"${preview_api_origin}\" />|" \
    "${worker_shell}/index.html"
fi
