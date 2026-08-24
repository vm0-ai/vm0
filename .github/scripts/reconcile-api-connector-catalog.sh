#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: reconcile-api-connector-catalog.sh DEPLOYMENT_URL strict|allow-legacy" >&2
  exit 2
fi

deployment_url=${1%/}
response_mode=$2

if [ -z "$deployment_url" ]; then
  echo "deployment URL is required" >&2
  exit 2
fi
if [ "$response_mode" != "strict" ] && [ "$response_mode" != "allow-legacy" ]; then
  echo "response mode must be strict or allow-legacy" >&2
  exit 2
fi
: "${CRON_SECRET:?CRON_SECRET is required}"

headers=(-H "Authorization: Bearer ${CRON_SECRET}")
if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
  headers+=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

for attempt in 1 2 3; do
  response=""
  if ! response=$(curl \
    --fail-with-body \
    --show-error \
    --silent \
    --max-time 120 \
    "${headers[@]}" \
    "${deployment_url}/api/cron/sync-connector-catalog"); then
    echo "::warning::Connector catalog reconcile request failed (attempt ${attempt}/3)"
  elif summary=$(jq -ce '
    if type != "object" then
      error("response must be an object")
    else
      {
        outcome: (
          if .outcome == "accepted" or .outcome == "unchanged" or .outcome == "rejected"
          then .outcome
          else "invalid-response"
          end
        ),
        catalogCurrent: (.state == "current"),
        hasActiveCatalog: (.active != null),
        compatibilityCurrent: (
          (.filtering | type) == "object" and .filtering.stale == false
        ),
        filteredAuthMethodCount: (
          if (.filtering.filteredAuthMethods | type) == "array"
          then (.filtering.filteredAuthMethods | length)
          else null
          end
        ),
        runtimeProjection: (
          if has("runtimeProjection") | not then
            "legacy-response"
          elif (.runtimeProjection | type) != "object" then
            "invalid-response"
          elif .runtimeProjection.state == "ready" then
            "ready"
          elif
            .runtimeProjection.state == "not-ready" and
            (
              .runtimeProjection.reason == "schema-unavailable" or
              .runtimeProjection.reason == "projection-not-ready" or
              .runtimeProjection.reason == "unsupported" or
              .runtimeProjection.reason == "compatibility-not-ready" or
              .runtimeProjection.reason == "invalid-compatibility" or
              .runtimeProjection.reason == "incomplete" or
              .runtimeProjection.reason == "identity-changed"
            )
          then .runtimeProjection.reason
          else "invalid-response"
          end
        )
      }
    end
  ' <<<"$response"); then
    echo "Connector catalog reconcile: ${summary}"

    if jq -e --arg response_mode "$response_mode" '
      type == "object" and
      .state == "current" and
      .active != null and
      (.filtering | type) == "object" and
      .filtering.stale == false and
      (
        (
          has("runtimeProjection") and
          (.runtimeProjection | type) == "object" and
          .runtimeProjection.state == "ready"
        ) or
        (
          (has("runtimeProjection") | not) and
          $response_mode == "allow-legacy"
        )
      )
    ' <<<"$response" >/dev/null; then
      exit 0
    fi
    echo "::warning::Connector catalog is not ready (attempt ${attempt}/3)"
  else
    echo "::warning::Connector catalog reconcile returned invalid JSON (attempt ${attempt}/3)"
  fi

  if [ "$attempt" -lt 3 ]; then
    sleep 2
  fi
done

echo "::error::Connector catalog reconcile did not produce a current ready projection"
exit 1
