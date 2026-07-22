#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <job-ref> <cloudflare-preview-domain>" >&2
  exit 1
fi

job_ref="$1"
cloudflare_preview_domain="$2"

: "${job_ref:?job ref is required}"
: "${cloudflare_preview_domain:?Cloudflare preview domain is required}"

if [[ ! "$job_ref" =~ ^pr-[0-9]+$ && "$job_ref" != "staging" ]]; then
  echo "unsupported app preview job ref: $job_ref" >&2
  exit 1
fi

printf 'https://%s-app.%s\n' "$job_ref" "$cloudflare_preview_domain"
