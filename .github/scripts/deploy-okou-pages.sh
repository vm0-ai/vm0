#!/usr/bin/env bash
set -euo pipefail

if (( $# != 4 )); then
  echo "usage: $0 <pages-dist> <project-name> <branch> <commit-sha>" >&2
  exit 1
fi

pages_dist="$1"
project_name="$2"
branch="$3"
commit_sha="$4"

: "${project_name:?Cloudflare Pages project name is required}"
: "${branch:?Cloudflare Pages branch is required}"
: "${commit_sha:?Cloudflare Pages commit SHA is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

if [[ ! -d "$pages_dist" ]]; then
  echo "Cloudflare Pages distribution directory does not exist: $pages_dist" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
retry_delays_seconds=(5 10)
max_attempts=$((${#retry_delays_seconds[@]} + 1))

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  if [[ -n "${WRANGLER_OUTPUT_FILE_PATH:-}" ]]; then
    : >"$WRANGLER_OUTPUT_FILE_PATH"
  fi

  if pnpm --dir "${repo_root}/turbo" \
    --filter @okouai/host-worker \
    exec wrangler pages deploy "$pages_dist" \
    --project-name "$project_name" \
    --branch "$branch" \
    --commit-hash "$commit_sha" \
    --commit-dirty=false; then
    exit 0
  else
    status=$?
  fi

  if (( attempt == max_attempts )); then
    echo "::error::Cloudflare Pages deployment failed after ${max_attempts} attempts" >&2
    exit "$status"
  fi

  retry_delay_seconds="${retry_delays_seconds[$((attempt - 1))]}"
  echo "::warning title=Retrying Cloudflare Pages deployment::Attempt ${attempt}/${max_attempts} failed with exit ${status}; retrying in ${retry_delay_seconds}s" >&2
  sleep "$retry_delay_seconds"
done
