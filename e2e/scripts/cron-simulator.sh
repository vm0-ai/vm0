#!/bin/bash
# Cron simulator for CI environments
# Simulates Vercel's cron job behavior by periodically calling cron endpoints
# This is needed because Vercel cron jobs only run on production deployments, not preview deployments
#
# Usage: ./cron-simulator.sh <api_url> [interval_seconds]
# Example: ./cron-simulator.sh "https://my-preview.vercel.app" 60

set -euo pipefail

API_URL="${1:?Error: API_URL is required as first argument}"
INTERVAL="${2:-60}"

echo "Starting cron simulator..."
echo "  API URL: ${API_URL}"
echo "  Interval: ${INTERVAL}s"

call_cron() {
  local endpoint="$1"
  echo "[$(date -Iseconds)] Calling ${endpoint}..."
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${CRON_SECRET:-}" \
    -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET:-}" \
    "${API_URL}/api/cron/${endpoint}") || true
  echo "[$(date -Iseconds)] ${endpoint}: ${status}"
}

while true; do
  call_cron "sync-skills"
  call_cron "cleanup-sandboxes"
  sleep "$INTERVAL"
done
