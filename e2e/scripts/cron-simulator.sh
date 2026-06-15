#!/bin/bash
# Cron simulator for CI environments
# Simulates Vercel's cron job behavior by periodically calling the cleanup-sandboxes endpoint
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

while true; do
  echo "[$(date -Iseconds)] Calling cleanup-sandboxes endpoint..."

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${CRON_SECRET:-}" \
    -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET:-}" \
    "${API_URL}/api/cron/cleanup-sandboxes") || true

  echo "[$(date -Iseconds)] Response status: ${HTTP_STATUS}"

  sleep "$INTERVAL"
done
