#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <job-ref> <preview-domain> <cloudflare-preview-domain>" >&2
  exit 1
fi

job_ref="$1"
preview_domain="$2"
cloudflare_preview_domain="$3"

: "${job_ref:?job ref is required}"
: "${preview_domain:?preview domain is required}"

if [[ "$job_ref" =~ ^pr-[0-9]+$ ]]; then
  : "${cloudflare_preview_domain:?Cloudflare preview domain is required for PR app previews}"
  printf 'https://%s-app.%s\n' "$job_ref" "$cloudflare_preview_domain"
else
  printf 'https://%s-app.%s\n' "$job_ref" "$preview_domain"
fi
