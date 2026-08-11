#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 <pages-dist> <pages-url>" >&2
  exit 1
fi

pages_dist="$1"
pages_url="${2%/}"

mapfile -t probe_files < <(
  node .github/scripts/find-okou-pages-probe-assets.mjs "$pages_dist/assets"
)
echo "Checking ${#probe_files[@]} app and Clerk JavaScript assets"

document_body="$(mktemp)"
trap 'rm -f "$document_body"' EXIT
application_url="${pages_url}/sign-up"
probe_curl_args=(
  --output "$document_body"
  --url "$application_url"
)
for probe_file in "${probe_files[@]}"; do
  relative_path="${probe_file#"$pages_dist"/}"
  probe_curl_args+=(
    --output /dev/null
    --url "${pages_url}/${relative_path}"
  )
done

expected_probe_result_count=$((${#probe_files[@]} + 1))
ready_passes=0
append_not_ready() {
  if [[ -n "$not_ready_files" ]]; then
    not_ready_files+=$'\n'
  fi
  not_ready_files+="$1"
}
for attempt in {1..60}; do
  probe_succeeded=false
  if probe_results="$(curl \
    --silent \
    --max-time 10 \
    --parallel \
    --parallel-immediate \
    --parallel-max 16 \
    --write-out $'%{http_code}|%{content_type}|%{url_effective}\n' \
    "${probe_curl_args[@]}" 2>/dev/null)"; then
    probe_succeeded=true
  fi
  probe_result_count=0
  not_ready_files=""
  document_ready=false
  while IFS= read -r probe_result; do
    if [[ "$probe_result" != *"|"* ]]; then
      continue
    fi
    ((probe_result_count += 1))
    IFS='|' read -r status content_type resource_url <<< "$probe_result"
    if [[ "$resource_url" == "$application_url" ]]; then
      if [[ "$status" == 2?? && "$content_type" == *text/html* ]] &&
        grep -Fq 'id="app-bootstrap-skeleton"' "$document_body"; then
        document_ready=true
      fi
    elif [[ "$status" != 2?? || "$content_type" != *javascript* ]]; then
      append_not_ready "${resource_url#"$pages_url/"}"
    fi
  done <<< "$probe_results"
  if ((probe_result_count != expected_probe_result_count)); then
    append_not_ready "incomplete readiness response"
  fi
  if [[ "$probe_succeeded" != true ]]; then
    append_not_ready "incomplete readiness transfer"
  fi
  if [[ "$document_ready" != true ]]; then
    append_not_ready "application document"
  fi

  if [[ -z "$not_ready_files" ]]; then
    ((ready_passes += 1))
  else
    ready_passes=0
    first_not_ready="${not_ready_files%%$'\n'*}"
    not_ready_count="$(wc -l <<< "$not_ready_files")"
    echo "::warning::${not_ready_count} preview resources are not ready (attempt ${attempt}/60); first: ${first_not_ready}"
  fi

  if ((ready_passes >= 2)); then
    echo "Cloudflare Pages deployment is ready"
    exit 0
  fi
  sleep 2
done

echo "::error::Cloudflare Pages deployment did not become ready"
exit 1
