#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <canonical-dist> <empty-worker-shell>" >&2
  exit 1
fi

canonical_dist="$1"
worker_shell="$2"

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

for relative_path in "${required_files[@]}"; do
  destination="${worker_shell}/${relative_path}"
  mkdir -p "$(dirname "$destination")"
  cp "${canonical_dist}/${relative_path}" "$destination"
done

# Wrangler uploads these files as text/data modules imported by the standalone
# Worker entrypoint. Keep the public route names above while using extensions
# with unambiguous module types during bundling.
cp "${worker_shell}/sw.js" "${worker_shell}/sw.txt"
cp "${worker_shell}/manifest.webmanifest" "${worker_shell}/manifest.txt"
cp "${worker_shell}/icons/icon-192.png" \
  "${worker_shell}/icons/icon-192.bin"
cp "${worker_shell}/icons/icon-512.png" \
  "${worker_shell}/icons/icon-512.bin"
cp "${worker_shell}/icons/icon-512-maskable.png" \
  "${worker_shell}/icons/icon-512-maskable.bin"

