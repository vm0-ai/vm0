#!/usr/bin/env bash
set -euo pipefail

credentials="${1:?Usage: runner-pi-bootstrap.bash <credentials-file>}"
token=$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")
api_url=$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")
echo "::add-mask::$token"

headers=(-H "Authorization: Bearer ${token}" -H "Content-Type: application/json")
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
    headers+=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

policy_payload=$(jq -nc '{
    policies: [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null
      }
    ]
}')
curl -fsS "${headers[@]}" \
    -X PUT \
    -d "$policy_payload" \
    "${api_url}/api/okou/model-policies" \
    >/dev/null
curl -fsS "${headers[@]}" \
    -X PUT \
    -d '{"selectedModel":null,"serviceTier":null}' \
    "${api_url}/api/okou/user-model-preference" \
    >/dev/null

curl -fsS "${headers[@]}" \
    -X POST \
    -d '{"switches":{"realAgentInPreview":true,"piLoop":true}}' \
    "${api_url}/api/okou/feature-switches" \
    | jq -e '
        .effectiveSwitches.realAgentInPreview == true and
        .effectiveSwitches.piLoop == true
      ' \
    >/dev/null
